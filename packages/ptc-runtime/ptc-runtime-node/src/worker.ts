/** Managed Node process shared by temporary and owner-retained evaluations. */
import { randomUUID } from 'node:crypto'
import { PtcImage } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcOutput } from '@deepseek-ai/dsh-ptc-runtime'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Context } from '@deepseek-ai/cordis'
import { PtcRuntimeError, type PtcRunSpec, type PtcRunResult, type PtcRunSandbox, type PtcRunFailure, type PtcBindingNamespace, type PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'
import { SandboxUnavailableError, classifyRunnerFailure, isRunnerSpawnFailure } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import type { PolicyProcesses } from './policy-processes.ts'
import type { ResolvedConfig } from './config.ts'
import type { ExecutionMode } from './execution.ts'
import { invokeBinding } from './bindings.ts'
import type { BirpcReturn } from 'birpc'
import { createProcessRpc } from './rpc.ts'
import { bootstrapArgs } from './launch.ts'
import { STARTUP_ENVIRONMENT_NAMES } from './environment.ts'
import { decodePtcJsonWire, type PtcImageWire } from './json-wire.ts'
import { OutputLedger } from './output-ledger.ts'
import { drainOutput, terminateProcess } from './output-stream.ts'
import { readProgramResult, PROGRAM_PROTOCOL_VERSION, type ProgramBootData, type ProgramMethods, type HostMethods } from './protocol.ts'
import { StripTimeoutError } from './type-stripper.ts'

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

interface Evaluation {
  settled: boolean
  completion: Promise<ReturnType<typeof readProgramResult>> | undefined
  data: ProgramBootData
  spec: PtcRunSpec
  bindings: Map<string, PtcBindingNamespace>
  invoke: typeof invokeBinding
  pending: number
  pendingBytes: number
  finished: Promise<PtcRunResult>
  canDispatch(): boolean
  admit(entry: PtcOutput): void
  truncateOutput(): void
  finish(error?: PtcRunFailure, value?: PtcJsonValue, discard?: boolean): void
}

/** One managed process; all mutable program state belongs to this process alone. */
export class ProgramWorker {
  private readonly unregister: (() => void) | undefined
  private confined: ConfinedArgv | undefined
  private handle?: SubprocessHandle
  private channel?: BirpcReturn<ProgramMethods, HostMethods>
  private active: Evaluation | undefined
  /** Admission remains reserved until the result includes completed process cleanup. */
  private running = false
  private cleanupPending = false
  private ready = false
  private stderr = ''
  private controlFailure: string | undefined
  private termination: Promise<boolean> | undefined
  private starting?: Promise<void>
  private exitOutcome?: SubprocessOutcome
  private readonly images = new Map<string, PtcImage['attachment']>()
  private readonly controller = new AbortController()
  closed = false

  /** Whether termination succeeded and this process no longer needs cleanup retries. */
  get cleanupComplete(): boolean { return this.closed && !this.cleanupPending }

  /**
   * Own one process under a fixed file policy.
   * @param ctx - Provider execution services.
   * @param config - Validated resource limits and launch selection.
   * @param policy - Authority retained for the lifetime of this process.
   * @param processes - Session policy invalidation and cleanup coordination.
   * @param mode - Evaluator syntax and TypeScript erasure.
   * @param retainsState - Whether this process belongs to an owner and survives completed evaluations.
   * @param pendingInitialization - Type-erased setup source, or undefined when no initialization is required.
   */
  constructor(
    private readonly ctx: Context, private readonly config: ResolvedConfig,
    readonly policy: SandboxExecutionPolicy, processes: PolicyProcesses, private readonly mode: ExecutionMode,
    private readonly retainsState: boolean, private pendingInitialization: string | undefined,
  ) {
    this.unregister = processes.register(policy, () => this.dispose())
  }

  /** Reject reuse until the previous evaluation and required cleanup settle. */
  assertIdle(): void {
    if (this.running) throw new PtcRuntimeError('persistent PTC does not accept concurrent runs for one state owner', 'PTC_RUNTIME_CONFLICT')
    if (this.cleanupPending) throw new PtcRuntimeError('persistent PTC environment cleanup is incomplete; release the owner before running another program', 'PTC_RUNTIME_UNAVAILABLE')
  }

  /**
   * Evaluate a program, retaining this process only for an enabled state owner.
   * @param spec - Resolved program inputs and cancellation.
   * @param bindings - Current host binding implementations.
   * @returns Output after any required process cleanup.
   */
  async run(spec: PtcRunSpec, bindings: Map<string, PtcBindingNamespace>): Promise<PtcRunResult> {
    this.running = true
    const sandbox: PtcRunSandbox = { mode: this.policy.mode, denied: false }
    try {
      const result = await this.evaluate(spec, bindings)
      if (this.confined !== undefined) {
        sandbox.enforcement = this.confined.enforcement
        sandbox.denied ||= result.error?.kind !== 'sandbox-unavailable' && this.confined.denialSignatures.some(signature =>
          result.error?.message.toLowerCase().includes(signature.toLowerCase()))
      }
      return { ...result, sandbox }
    } finally { this.running = false }
  }

  private message(message: string): string {
    return this.retainsState ? `${message}; retained variables were cleared` : message
  }

  private async evaluate(spec: PtcRunSpec, bindings: Map<string, PtcBindingNamespace>): Promise<PtcRunResult> {
    const ledger = new OutputLedger(this.config.maxOutputBytes)
    if (this.exitOutcome !== undefined) {
      const failure: PtcRunFailure = spec.signal?.aborted
        ? { kind: 'abort', message: this.message('execution canceled') }
        : { kind: 'worker-exit', message: this.message(this.exitMessage(this.exitOutcome)) }
      try { await this.terminate() } catch (error: unknown) {
        return ledger.failure([], { kind: 'worker-exit', message: `managed process cleanup failed: ${messageOf(error)}` })
      }
      return ledger.failure([], failure)
    }
    this.stderr = ''
    const output: PtcOutput[] = []
    const result = Promise.withResolvers<PtcRunResult>()
    const strippingController = new AbortController()
    let stripping: Promise<string> | undefined
    const timeoutMs = spec.timeoutMs
    const deadline = timeoutMs === null ? undefined : performance.now() + timeoutMs
    const onTimeout = (budget: number): void => {
      const phase = evaluation.completion !== undefined ? 'during execution' : 'before code started'
      const message = `execution timed out ${phase} (${budget}ms)`
      evaluation.finish({ kind: 'timeout', message }, undefined, !this.ready)
    }
    const timer = timeoutMs === null ? undefined : setTimeout(() => { onTimeout(timeoutMs) }, timeoutMs)
    const onAbort = (): void => {
      evaluation.finish({ kind: 'abort', message: this.retainsState ? 'execution canceled' : messageOf(spec.signal?.reason) }, undefined, !this.ready)
    }
    const evaluation: Evaluation = {
      settled: false,
      completion: undefined,
      finished: result.promise,
      canDispatch: () => {
        if (evaluation.settled) return false
        if (spec.signal?.aborted) onAbort()
        else if (deadline !== undefined && timeoutMs !== null && performance.now() >= deadline) onTimeout(timeoutMs)
        else return true
        return false
      },
      data: {
        code: '', programFormat: this.mode.format, retainsState: this.retainsState,
        ...this.pendingInitialization === undefined ? {} : { initialization: this.pendingInitialization },
        maxOutputBytes: this.config.maxOutputBytes,
        discardCompletion: spec.discardCompletion === true,
        namespaces: [...bindings.values()].map(binding => ({
          global: binding.global, names: Object.keys(binding.functions), ...binding.errorClass ? { errorClass: binding.errorClass } : {},
        })),
      },
      spec, bindings, pending: 0, pendingBytes: 0,
      invoke: AsyncLocalStorage.bind((binding, args) => invokeBinding(binding, args, image => this.registerImage(image))),
      truncateOutput: () => {
        ledger.truncated = true
        const channel = this.channel
        if (evaluation.settled || this.closed || !channel || channel.$closed) return
        void channel.discardOutput().catch((error: unknown) => {
          // Ended evaluations need no notification; channel closure already owns failure reporting.
          if (this.active !== evaluation || evaluation.settled || this.closed || channel.$closed) return
          this.fail('protocol', `failed to send output-discard notification: ${messageOf(error)}`)
        })
      },
      admit: (entry) => {
        if (ledger.truncated) return
        if (!ledger.admit(entry, output)) evaluation.truncateOutput()
      },
      finish: (error, value, discard = false) => {
        if (evaluation.settled) return
        evaluation.settled = true
        clearTimeout(timer)
        spec.signal?.removeEventListener('abort', onAbort)
        strippingController.abort()
        const initializationIncomplete = this.pendingInitialization !== undefined
        if (initializationIncomplete && error?.kind === 'exception') error = { ...error, message: this.message(error.message) }
        const cleanup = async (): Promise<PtcRunResult> => {
          // Completion owns the stripping thread until it has stopped or returned to the idle pool.
          if (stripping !== undefined) await stripping.catch(() => {})
          const interrupted = error?.kind === 'timeout' || error?.kind === 'abort'
          let preserved = this.retainsState && !initializationIncomplete && !discard
          if (preserved && interrupted && evaluation.completion !== undefined) preserved = await this.interruptEvaluation(evaluation)
          let drained = true
          if (!preserved) drained = await this.terminate()
          if (interrupted && this.retainsState && error) {
            error = { ...error, message: `${error.message}; retained variables were ${preserved ? 'preserved' : 'cleared'}` }
          }
          const completed = error ? ledger.failure(output, error) : ledger.success(output, value)
          return drained ? completed : ledger.failure(output, { kind: 'worker-exit', message: 'managed process exited but its output did not drain cleanly' })
        }
        void cleanup().then((completed) => {
          this.active = undefined
          result.resolve(completed)
        }, (failure: unknown) => {
          this.active = undefined
          result.resolve(ledger.failure(output, { kind: 'worker-exit', message: `managed process cleanup failed: ${messageOf(failure)}` }))
        })
      },
    }
    this.active = evaluation
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    if (!evaluation.canDispatch()) return await result.promise
    try {
      const code = this.mode.stripTypes(spec.program, strippingController.signal)
      if (typeof code === 'string') evaluation.data.code = code
      else {
        stripping = code
        evaluation.data.code = await stripping
      }
    } catch (error: unknown) {
      if (evaluation.canDispatch()) {
        if (error instanceof StripTimeoutError) onTimeout(this.config.maxTimeoutMs)
        else evaluation.finish({ kind: 'exception', message: messageOf(error) }, undefined, !this.ready)
      }
      return await result.promise
    } finally {
      stripping = undefined
    }
    if (!evaluation.canDispatch()) return await result.promise
    if (this.ready) this.dispatch(evaluation)
    else {
      this.starting = this.start(evaluation)
      void this.starting.catch((error: unknown) => { this.fail(error instanceof SandboxUnavailableError || (this.confined !== undefined && isRunnerSpawnFailure(error, this.confined.argv[0], spec.cwd)) ? 'sandbox-unavailable' : 'worker-exit', messageOf(error)) })
    }
    return await result.promise
  }

  /** True confirms evaluation settlement with the process still available for reuse. */
  private async interruptEvaluation(evaluation: Evaluation): Promise<boolean> {
    const completion = evaluation.completion
    if (!this.channel || this.channel.$closed || this.closed || !completion) return false
    const deadline = Promise.withResolvers<never>()
    const timer = setTimeout(() => { deadline.reject(new Error(`execution did not settle within ${this.config.stopGraceMs}ms`)) }, this.config.stopGraceMs)
    const abort = (): void => { deadline.reject(new Error('environment disposed during interruption')) }
    this.controller.signal.addEventListener('abort', abort, { once: true })
    try {
      await Promise.race([this.channel.revoke().then(() => completion), deadline.promise])
      this.controller.signal.throwIfAborted()
      return true
    } catch (_error: unknown) {
      // Only a validated run result confirms settlement.
      return false
    } finally {
      clearTimeout(timer)
      this.controller.signal.removeEventListener('abort', abort)
    }
  }

  /** Cancel active work and await managed process termination and output drainage. */
  async dispose(): Promise<void> {
    const evaluation = this.active
    evaluation?.finish({ kind: 'abort', message: 'PTC environment disposed' }, undefined, true)
    try { await this.terminate() } finally { await evaluation?.finished }
  }

  /** Terminate the process; resolve to whether its output pipes drained cleanly. */
  private terminate(): Promise<boolean> {
    if (this.termination) return this.termination
    this.closed = true
    this.images.clear()
    this.cleanupPending = true
    this.controller.abort()
    this.channel?.$close()
    this.termination = (async () => {
      await this.starting?.catch((_error: unknown) => {
        // Evaluation reports startup failure; cleanup still owns any process already created.
      })
      const handle = this.handle
      return handle === undefined || await terminateProcess(handle, this.config.graceMs)
    })().then((drained) => {
      this.unregister?.()
      this.cleanupPending = false
      if (!drained) this.ctx.logger.warn('Node process exited but its output did not drain cleanly')
      return drained
    }, (error: unknown) => { this.termination = undefined; throw error })
    return this.termination
  }

  private fail(kind: PtcRunFailure['kind'], message: string): void {
    if (this.active) this.active.finish({ kind, message: this.message(message) }, undefined, true)
    else {
      if (!this.closed) this.ctx.logger.warn(message)
      void this.terminate().catch((error: unknown) => { this.ctx.logger.warn(messageOf(error)) })
    }
  }

  private dispatch(evaluation: Evaluation): void {
    const completion = this.channel?.run(evaluation.spec.cwd, evaluation.data).then(readProgramResult)
    evaluation.completion = completion
    void completion?.then(({ error, value, outputTruncated }) => {
      if (evaluation.settled) return
      if (this.pendingInitialization !== undefined && error === undefined) {
        this.fail('protocol', 'environment initialization completed without Host acceptance')
        return
      }
      if (outputTruncated) evaluation.truncateOutput()
      // Raw stdio can be queued beside the RPC result on separate pipes.
      setImmediate(() => { evaluation.finish(error, value) })
    }).catch((error: unknown) => {
      if (this.active === evaluation && !evaluation.settled && !this.channel?.$closed) this.fail('protocol', messageOf(error))
    })
  }

  private withControlFailure(message: string): string {
    return this.controlFailure === undefined ? message : `${message}; control channel failed: ${this.controlFailure}`
  }

  private exitMessage(outcome: SubprocessOutcome): string {
    const runtime = this.config.launch.kind === 'bun-script'
      || (this.config.launch.kind === 'embedded' && process.versions.bun !== undefined)
      ? 'Bun'
      : 'Node'
    return this.withControlFailure(`${runtime} process exited (${String(outcome.exitCode)}, signal ${String(outcome.signal)})${this.stderr ? `: ${this.stderr}` : ''}`)
  }

  private registerImage(image: PtcImage): PtcImageWire {
    const id = randomUUID()
    this.images.set(id, image.attachment)
    return { kind: 'image', id, attachmentId: image.attachment.attachmentId, path: image.path, width: image.attachment.width, height: image.attachment.height }
  }

  private async start(evaluation: Evaluation): Promise<void> {
    const { cwd } = evaluation.spec
    const executable = await this.ctx.subprocess.resolveExecutable(this.config.launch.executable, undefined, this.controller.signal)
    if (!evaluation.canDispatch()) return
    const packaged = this.config.launch.kind === 'embedded'
    const heapFlag = `--max-old-space-size=${this.config.maxOldGenerationSizeMb}`
    const nodeScript = this.config.launch.kind === 'node-script'
    const argv = [executable, ...nodeScript ? [heapFlag] : [],
      ...bootstrapArgs(this.ctx.fs, this.config.launch, this.config.maxMessageBytes)]
    const policy = this.policy
    this.confined = policy.mode === 'danger-full-access' ? undefined : await this.ctx.sandbox.confine(argv, { ...policy, mode: policy.mode }, this.controller.signal)
    if (!evaluation.canDispatch()) return
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env)
      .filter(key => !STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase()) && key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE')
      .map(key => [key, undefined]))
    if (packaged) {
      env.DSH_PTC_RUNTIME_NODE = '1'
      if (process.versions.bun === undefined) env.NODE_OPTIONS = `${heapFlag} --experimental-vm-modules`
    }
    const handle = this.ctx.subprocess.spawn({ argv: this.confined?.argv ?? argv, cwd, env, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' }, graceMs: this.config.graceMs })
    this.handle = handle
    if (!handle.control || !handle.stdout || !handle.stderr) throw new Error('subprocess provider did not supply the requested control and output pipes')
    for (const stream of [handle.stdout, handle.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', (text: string) => {
        if (stream === handle.stderr) this.stderr = (this.stderr + text).slice(-this.config.maxOutputBytes)
        this.active?.admit({ type: 'text', text })
      })
      stream.on('error', (error: Error) => { this.fail('worker-exit', error.message) })
    }
    // A rejected wire call closes its endpoint before birpc can answer it.
    const refuse = (message: string): never => { this.fail('protocol', message); throw new Error(message) }
    this.channel = createProcessRpc<ProgramMethods, HostMethods>(handle.control, this.config.maxMessageBytes, {
      ready: (version) => {
        if (version !== PROGRAM_PROTOCOL_VERSION) {
          this.fail('protocol', 'bootstrap protocol mismatch; upgrade launch.bootstrapPath with the host')
          return
        }
        if (this.ready || !this.active) { this.fail('protocol', 'duplicate program readiness'); return }
        if (!this.active.canDispatch()) return
        this.ready = true
        this.dispatch(this.active)
      },
      initialized: () => {
        const evaluation = this.active
        if (!this.ready || !evaluation || this.pendingInitialization === undefined) {
          return refuse('unexpected environment initialization acknowledgement')
        }
        if (evaluation.settled || evaluation.spec.signal?.aborted) {
          throw new Error('PTC evaluation ended before initialization completed')
        }
        this.pendingInitialization = undefined
        return Promise.resolve()
      },
      log: (text: unknown) => {
        if (!this.ready || !this.active || typeof text !== 'string') { this.fail('protocol', 'invalid program log'); return }
        if (!this.active.settled) this.active.admit({ type: 'text', text })
      },
      image: (id: unknown) => {
        const image = typeof id === 'string' ? this.images.get(id) : undefined
        if (!this.ready || !this.active || image === undefined) { this.fail('protocol', 'invalid program image'); return }
        if (!this.active.settled) this.active.admit({ type: 'image', attachment: image })
      },
      outputLimit: () => {
        if (!this.ready || !this.active) { this.fail('protocol', 'idle PTC output limit'); return }
        this.active.truncateOutput()
      },
      invoke: async (global, name, wire) => {
        const evaluation = this.active
        if (!this.ready || !evaluation) return refuse('binding call arrived without an active PTC evaluation')
        if (evaluation.settled) throw new Error('PTC evaluation ended before the binding completed')
        const functions = evaluation.bindings.get(global)?.functions
        const fn = functions !== undefined && Object.hasOwn(functions, name) ? functions[name] : undefined
        if (!this.mode.retainsState && typeof fn !== 'function') return refuse('program requested an undeclared binding')
        const args = decodePtcJsonWire(wire)
        if (args === undefined) return refuse('binding arguments must be lossless JSON')
        const bytes = Buffer.byteLength(JSON.stringify(wire))
        if (evaluation.pending >= this.config.maxPendingCalls || evaluation.pendingBytes + bytes > this.config.maxMessageBytes) {
          return refuse('pending binding calls exceed configured limits')
        }
        evaluation.pending += 1
        evaluation.pendingBytes += bytes
        let value
        try {
          value = await evaluation.invoke(fn, args)
        } catch (error) {
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- The evaluation may settle while the binding is pending.
          if (evaluation.settled) throw new Error('PTC evaluation ended before the binding completed')
          throw error
        } finally {
          evaluation.pending -= 1
          evaluation.pendingBytes -= bytes
        }
        // A late binding result must not fill the pipe shared with the next evaluation.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- The evaluation may settle while the binding is pending.
        if (evaluation.settled) throw new Error('PTC evaluation ended before the binding completed')
        return value
      },
    }, ['revoke', 'discardOutput'], (error, kind) => {
      if (kind === 'protocol') this.fail('protocol', error.message)
      else {
        if (kind === 'io') this.controlFailure = error.message
        setImmediate(() => {
          if (!this.closed && this.exitOutcome === undefined) handle.terminate()
        })
      }
    })
    void handle.done.then(async (outcome) => {
      this.exitOutcome = outcome
      await Promise.all([drainOutput(handle.stdout, this.config.graceMs), drainOutput(handle.stderr, this.config.graceMs)])
      // The RPC result can already be queued when process exit arrives.
      setImmediate(() => {
        if (!this.closed) this.fail(this.confined !== undefined && classifyRunnerFailure(outcome.exitCode, this.stderr, this.confined.runnerFailureRules) !== undefined ? 'sandbox-unavailable' : 'worker-exit', this.exitMessage(outcome))
      })
    }, (error: unknown) => {
      this.fail(this.confined !== undefined && isRunnerSpawnFailure(error, this.confined.argv[0], cwd)
        ? 'sandbox-unavailable' : 'worker-exit', this.withControlFailure(messageOf(error)))
    })
  }

}
