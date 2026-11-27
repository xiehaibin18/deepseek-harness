import { spawnSync } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultParallelism } from './parallelism.ts'

const oxlintCli = fileURLToPath(new URL('../node_modules/oxlint/bin/oxlint', import.meta.url))
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024 * 1024
const FIX_FLAGS = new Set(['--fix', '--fix-dangerously', '--fix-suggestions'])

function isFixInvocation(args: readonly string[]): boolean {
  return args.some(arg => FIX_FLAGS.has(arg))
}

function isBunEntrypoint(entrypoint: string | undefined): boolean {
  if (entrypoint === undefined || entrypoint === '') return false
  const name = basename(entrypoint.replaceAll('\\', '/')).toLowerCase()
  return name === 'bun' || name === 'bun.exe'
}

function hasOutputFormat(args: readonly string[]): boolean {
  return args.some(arg =>
    arg === '-f'
    || arg.startsWith('-f=')
    || arg === '--format'
    || arg.startsWith('--format='))
}

function translateArgsForBunLint(args: readonly string[]): string[] {
  const translated: string[] = ['lint', '--no-script']
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === '--format=default' || arg === '-f=default') {
      translated.push('--format=pretty')
      continue
    }
    if ((arg === '--format' || arg === '-f') && args[index + 1] === 'default') {
      translated.push(arg, 'pretty')
      index += 1
      continue
    }
    translated.push(arg)
  }
  return translated
}

/** Complete Oxlint child-process arguments and environment. */
export interface OxlintInvocation {
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
}

/** Resolved lint command selecting either Bun's built-in linter or Node + Oxlint. */
export interface LintCommand {
  readonly backend: 'bun' | 'oxlint'
  readonly command: string
  readonly args: readonly string[]
}

/**
 * Apply the repository worker bound to both Oxlint backends.
 * `DSH_OXLINT_THREADS` selects the bound; without it, CI keeps Oxlint's own default and other runs use the
 * [local worker budget](./parallelism.ts). A caller's own `--threads` without `DSH_OXLINT_THREADS` passes through.
 * @param args - Oxlint CLI arguments requested by the caller.
 * @param env - Environment inherited by the Oxlint process.
 * @param cpus - CPU count Node reports for this process.
 * @returns the complete CLI arguments and child environment.
 */
export function resolveOxlintInvocation(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cpus: number = availableParallelism(),
): OxlintInvocation {
  const resolvedArgs = [...args]
  if (env.CI === 'true' && !hasOutputFormat(args)) resolvedArgs.push('--format=default')
  const raw = env.DSH_OXLINT_THREADS
  const explicit = raw !== undefined && raw !== ''
  if (explicit) {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
      throw new Error(`run-oxlint: DSH_OXLINT_THREADS must be a positive integer, got ${JSON.stringify(raw)}.`)
    }
  }
  if (args.some(arg => arg === '--threads' || arg.startsWith('--threads='))) {
    if (explicit) throw new Error('run-oxlint: use DSH_OXLINT_THREADS instead of passing --threads directly.')
    return { args: resolvedArgs, env: { ...env } }
  }
  if (!explicit && env.CI === 'true') return { args: resolvedArgs, env: { ...env } }
  const threads = explicit ? raw : String(defaultParallelism(env, cpus))
  return {
    args: [...resolvedArgs, `--threads=${threads}`],
    env: { ...env, GOMAXPROCS: threads },
  }
}

/**
 * Select the lint executable (`bun lint --no-script` when launched under Bun, or Node + `oxlint` otherwise).
 * `DSH_LINT_BACKEND` (`bun` or `oxlint`) overrides automatic detection.
 * @param invocation - Resolved lint arguments and environment from `resolveOxlintInvocation`.
 * @param env - Caller environment inspected for `DSH_LINT_BACKEND` and `npm_execpath`.
 * @param runtime - Runtime metadata override for deterministic testing.
 * @returns The selected lint backend, executable, and CLI arguments.
 */
export function resolveLintCommand(
  invocation: OxlintInvocation,
  env: NodeJS.ProcessEnv = process.env,
  runtime: { readonly isBun: boolean; readonly execPath: string } = {
    isBun: 'bun' in process.versions,
    execPath: process.execPath,
  },
): LintCommand {
  const backendOverride = env.DSH_LINT_BACKEND
  if (backendOverride !== undefined && backendOverride !== '' && backendOverride !== 'bun' && backendOverride !== 'oxlint') {
    throw new Error(`run-oxlint: DSH_LINT_BACKEND must be "bun" or "oxlint", got ${JSON.stringify(backendOverride)}.`)
  }
  const bunExecpath = isBunEntrypoint(env.npm_execpath) ? env.npm_execpath : undefined
  const useBun = backendOverride === 'bun'
    || (backendOverride !== 'oxlint' && (runtime.isBun || bunExecpath !== undefined))
  if (useBun) {
    const command = runtime.isBun ? runtime.execPath : (bunExecpath ?? 'bun')
    return {
      backend: 'bun',
      command,
      args: translateArgsForBunLint(invocation.args),
    }
  }
  return {
    backend: 'oxlint',
    command: runtime.execPath,
    args: [oxlintCli, ...invocation.args],
  }
}

function completeFrom(result: { readonly signal: NodeJS.Signals | null; readonly status: number | null }): void {
  if (result.signal !== null) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exitCode = result.status ?? 1
}

function main(): void {
  const invocation = resolveOxlintInvocation(process.argv.slice(2), process.env)
  const lint = resolveLintCommand(invocation, process.env)
  if (!isFixInvocation(invocation.args)) {
    const result = spawnSync(lint.command, lint.args, {
      env: invocation.env,
      stdio: 'inherit',
    })
    if (result.error !== undefined) throw result.error
    completeFrom(result)
    return
  }

  const first = spawnSync(lint.command, lint.args, {
    encoding: 'utf8',
    env: invocation.env,
    maxBuffer: MAX_CAPTURED_OUTPUT_BYTES,
  })
  if (first.error !== undefined) throw first.error
  if (first.signal !== null) {
    completeFrom(first)
    return
  }
  if (first.status === 0) {
    process.stdout.write(first.stdout)
    process.stderr.write(first.stderr)
    process.exitCode = 0
    return
  }

  // Overlapping JS-plugin fixes can expose one more fixable diagnostic after the first pass.
  const second = spawnSync(lint.command, lint.args, {
    env: invocation.env,
    stdio: 'inherit',
  })
  if (second.error !== undefined) throw second.error
  completeFrom(second)
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) main()
