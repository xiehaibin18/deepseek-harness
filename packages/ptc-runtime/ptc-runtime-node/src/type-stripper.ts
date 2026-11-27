/** Erase TypeScript with the Host's native API or a bounded Bun worker. */
import { spawnSync } from 'node:child_process'
import * as nodeModule from 'node:module'
import { Worker } from 'node:worker_threads'
import { quietRuntimeCall } from './environment.ts'
import { isEmbeddedPtcRuntime } from './launch.ts'

/** Private env variable telling an embedded AOT executable to strip TypeScript from stdin using `amaro`. */
export const PTC_STRIP_INITIALIZER_ENV = 'DSH_PTC_STRIP_INITIALIZER' as const

interface TypeStripper {
  strip(program: string, signal: AbortSignal): string | Promise<string>
  stripInitializer(program: string): string
  dispose?(): Promise<void>
}

/** The Bun parser exceeded its own ceiling, including on calls without a run deadline. */
export class StripTimeoutError extends Error {}

type StripReply = { code: string } | { error: string }

// Both launch paths load the same resolved peer without inheriting loader flags.
const AMARO_SOURCE = `
function parse(program, transformSync) {
  try { return { code: transformSync(program).code } }
  catch (error) { return { error: error?.message ?? String(error) } }
}
`
const WORKER_SOURCE = AMARO_SOURCE + `
const { parentPort, workerData } = require('node:worker_threads')
const { transformSync } = require(workerData)
parentPort.on('message', program => parentPort.postMessage(parse(program, transformSync)))
`

function readReply(value: unknown): StripReply {
  if (typeof value === 'object' && value !== null) {
    if ('code' in value && typeof value.code === 'string') return { code: value.code }
    if ('error' in value && typeof value.error === 'string') return { error: value.error }
  }
  throw new Error('PTC TypeScript stripper returned an invalid result')
}

function unwrapReply(value: StripReply): string {
  if ('error' in value) throw new SyntaxError(value.error)
  return value.code
}

class StripWorker {
  private readonly worker: Worker
  private active: PromiseWithResolvers<unknown> | undefined
  private ended = false

  constructor(amaroPath: string) {
    const worker = new Worker(WORKER_SOURCE, { eval: true, execArgv: [], env: {}, workerData: amaroPath })
    this.worker = worker
    worker.on('message', (reply: unknown) => this.active?.resolve(reply))
    worker.on('error', (error) => {
      this.ended = true
      this.active?.reject(error)
    })
    worker.on('exit', (code) => {
      this.ended = true
      this.active?.reject(new Error(`PTC TypeScript stripper exited (code ${code})`))
    })
  }

  get available(): boolean { return !this.ended }

  async request(program: string, signal: AbortSignal): Promise<StripReply> {
    signal.throwIfAborted()
    this.worker.ref()
    const active = Promise.withResolvers<unknown>()
    this.active = active
    const abort = (): void => { active.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      this.worker.postMessage(program)
      return readReply(await active.promise)
    } finally {
      this.active = undefined
      signal.removeEventListener('abort', abort)
    }
  }

  idle(): void { this.worker.unref() }

  async dispose(): Promise<void> { await this.worker.terminate() }
}

class BunStripper implements TypeStripper {
  private idle: StripWorker | undefined

  constructor(private readonly amaroPath: string, private readonly maxTimeoutMs: number, private readonly maxOutputBytes: number) {}

  async strip(program: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const deadline = performance.now() + this.maxTimeoutMs
    const previous = this.idle
    this.idle = undefined
    if (previous && !previous.available) await previous.dispose()
    const worker = previous?.available ? previous : new StripWorker(this.amaroPath)
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort() }, Math.max(0, deadline - performance.now()))
    let reusable = false
    let reply: StripReply
    try {
      reply = await worker.request(program, AbortSignal.any([signal, timeout.signal]))
      signal.throwIfAborted()
      if (performance.now() >= deadline) throw new StripTimeoutError()
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- A concurrent request may have returned a worker to the cache.
      reusable = worker.available && this.idle === undefined
    } catch (error) {
      if (!signal.aborted && (timeout.signal.aborted || performance.now() >= deadline)) throw new StripTimeoutError()
      throw error
    } finally {
      clearTimeout(timer)
      if (reusable) {
        worker.idle()
        this.idle = worker
      } else await worker.dispose()
    }
    return unwrapReply(reply)
  }

  stripInitializer(program: string): string {
    // Registration reports syntax errors synchronously. The helper can be killed even while this thread waits.
    const embedded = isEmbeddedPtcRuntime()
    const args = embedded
      ? []
      : [
        '--config=/dev/null', '--tsconfig-override=/dev/null', '--no-env-file', '--no-install', '-e',
        AMARO_SOURCE + `
const { readFileSync } = require('node:fs')
const { transformSync } = require(${JSON.stringify(this.amaroPath)})
const result = parse(readFileSync(0, 'utf8'), transformSync)
if ('error' in result) {
  process.stderr.write(result.error)
  process.exitCode = 2
} else process.stdout.write(result.code)
`,
      ]
    const result = spawnSync(process.execPath, args, {
      input: program, encoding: 'utf8',
      env: embedded ? { [PTC_STRIP_INITIALIZER_ENV]: this.amaroPath } : {},
      timeout: this.maxTimeoutMs, killSignal: 'SIGKILL',
      maxBuffer: Buffer.byteLength(program) + this.maxOutputBytes,
    })
    if (result.error) {
      if ('code' in result.error && result.error.code === 'ETIMEDOUT') {
        throw new Error(`PTC TypeScript initializer stripping timed out (${this.maxTimeoutMs}ms)`, { cause: result.error })
      }
      throw new Error(`PTC TypeScript initializer stripping failed: ${result.error.message}`, { cause: result.error })
    }
    if (result.status === 2) throw new SyntaxError(result.stderr)
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'PTC TypeScript initializer stripper did not exit successfully')
    return result.stdout
  }

  async dispose(): Promise<void> {
    const worker = this.idle
    this.idle = undefined
    await worker?.dispose()
  }
}

/**
 * Select the type stripper and resolve any required runtime peer during provider construction.
 * @param maxTimeoutMs - Bun parsing deadline even for a run without an elapsed deadline.
 * @param maxOutputBytes - Diagnostic budget for synchronous initializer stripping.
 * @returns An isolated Bun stripper or the native Node implementation.
 */
export function resolveTypeStripper(maxTimeoutMs: number, maxOutputBytes: number): TypeStripper {
  const { stripTypeScriptTypes } = nodeModule
  if (typeof stripTypeScriptTypes === 'function') {
    const strip = (program: string): string => quietRuntimeCall(() => stripTypeScriptTypes(program))
    return { strip, stripInitializer: strip }
  }
  try {
    return new BunStripper(nodeModule.createRequire(import.meta.url).resolve('amaro'), maxTimeoutMs, maxOutputBytes)
  } catch (error) {
    throw new Error('ptc-runtime-node: this Host requires the amaro package, an optional peer dependency, for TypeScript stripping', { cause: error })
  }
}
