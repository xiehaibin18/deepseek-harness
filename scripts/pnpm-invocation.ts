/** Resolve shell-free child-process invocations for the workspace package manager (Bun or pnpm). */

import { basename } from 'node:path'
import { pnpmCommand } from './release/process.ts'

function isBunEntrypoint(entrypoint: string): boolean {
  const name = basename(entrypoint.replaceAll('\\', '/')).toLowerCase()
  return name === 'bun' || name === 'bun.exe'
}

function translateArgsForBun(args: readonly string[]): string[] {
  if (args[0] === 'exec' && args.length >= 2) {
    return ['run', ...args.slice(1)]
  }
  const filter = args[1]
  if (args[0] === '--filter' && filter !== undefined && args.length >= 4 && (args[2] === 'run' || args[2] === 'exec')) {
    return ['run', '--filter', filter, ...args.slice(3)]
  }
  return [...args]
}

/**
 * Resolve the package manager executable and arguments from its lifecycle environment.
 * Accepts pnpm entrypoints (JavaScript or native binaries) and Bun entrypoints, translating
 * pnpm `exec` and `--filter <pkg> run|exec` arguments to Bun's `run` equivalents.
 * @param args - Arguments in pnpm CLI order.
 * @param environment - Lifecycle environment containing `npm_execpath`.
 * @returns A command and argument array suitable for `spawn` or `spawnSync` without a shell.
 */
export function pnpmInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const entrypoint = environment.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('pnpm invocation: npm_execpath is unavailable; invoke the script through pnpm run.')
  }
  if (isBunEntrypoint(entrypoint)) {
    return { command: entrypoint, args: translateArgsForBun(args) }
  }
  if (/\.[cm]?js$/iu.test(entrypoint)) {
    return { command: process.execPath, args: [entrypoint, ...args] }
  }
  return { command: entrypoint, args: [...args] }
}

/**
 * Resolve a shell-free workspace runner invocation for scripts that may be launched via `bun run`,
 * `pnpm run`, or directly with `bun`/`node` without `npm_execpath`.
 * @param args - Arguments in pnpm CLI order (`run ...`, `exec ...`, `--filter <pkg> run ...`).
 * @param environment - Environment inspected for `npm_execpath`.
 * @returns The runner command, translated arguments, and a concise display label.
 */
export function workspaceRunnerInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; displayCommand: string } {
  const entrypoint = environment.npm_execpath
  if (entrypoint !== undefined && entrypoint !== '') {
    if (isBunEntrypoint(entrypoint)) {
      const translated = translateArgsForBun(args)
      return { command: entrypoint, args: translated, displayCommand: `bun ${translated.join(' ')}` }
    }
    if (/[\\/]pnpm[\\/]/u.test(entrypoint) || /^pnpm(?:\.exe)?$/iu.test(basename(entrypoint.replaceAll('\\', '/')))) {
      const invocation = pnpmInvocation(args, environment)
      return { ...invocation, displayCommand: `pnpm ${args.join(' ')}` }
    }
  }
  if ('bun' in process.versions) {
    const translated = translateArgsForBun(args)
    return { command: process.execPath, args: translated, displayCommand: `bun ${translated.join(' ')}` }
  }
  const [command, ...prefix] = pnpmCommand()
  return { command, args: [...prefix, ...args], displayCommand: `pnpm ${args.join(' ')}` }
}
