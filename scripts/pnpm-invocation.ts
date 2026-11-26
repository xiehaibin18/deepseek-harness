/** Resolve shell-free child-process invocations for the workspace package manager (Bun or pnpm). */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pnpmCommand } from './release/process.ts'

const defaultWorkspaceRoot = resolve(import.meta.dirname, '..')

function isBunEntrypoint(entrypoint: string): boolean {
  const name = basename(entrypoint.replaceAll('\\', '/')).toLowerCase()
  return name === 'bun' || name === 'bun.exe'
}

function readWorkspaceGlobs(rootDir: string): string[] {
  const manifestPath = join(rootDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('workspaces' in parsed)) return []
  const { workspaces } = parsed as { workspaces?: unknown }
  if (Array.isArray(workspaces)) return workspaces.filter((entry): entry is string => typeof entry === 'string')
  if (typeof workspaces === 'object' && workspaces !== null && 'packages' in workspaces) {
    const { packages } = workspaces as { packages?: unknown }
    if (Array.isArray(packages)) return packages.filter((entry): entry is string => typeof entry === 'string')
  }
  return []
}

function resolveWorkspaceDir(filter: string, rootDir: string): string {
  const direct = resolve(rootDir, filter)
  if (existsSync(join(direct, 'package.json'))) return direct
  const patterns = readWorkspaceGlobs(rootDir).map(pattern => `${pattern.replace(/\/+$/u, '')}/package.json`)
  for (const relativeManifest of globSync(patterns, { cwd: rootDir }).sort()) {
    const manifestPath = resolve(rootDir, relativeManifest)
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
      const { name } = parsed as { name?: unknown }
      if (name === filter) return dirname(manifestPath)
    }
  }
  throw new Error(`pnpm invocation: cannot resolve workspace ${JSON.stringify(filter)} under ${rootDir} for Bun exec`)
}

function translateArgsForBun(args: readonly string[], rootDir: string): string[] {
  if (args[0] === 'exec' && args.length >= 2) {
    return ['run', ...args.slice(1)]
  }
  const filter = args[1]
  if (args[0] === '--filter' && filter !== undefined && args.length >= 4) {
    if (args[2] === 'run') {
      return ['run', '--filter', filter, ...args.slice(3)]
    }
    if (args[2] === 'exec') {
      return ['run', '--cwd', resolveWorkspaceDir(filter, rootDir), ...args.slice(3)]
    }
  }
  return [...args]
}

/**
 * Resolve the package manager executable and arguments from its lifecycle environment.
 * Accepts pnpm entrypoints (JavaScript or native binaries) and Bun entrypoints, translating
 * pnpm `exec`, `--filter <pkg> run`, and `--filter <pkg> exec` arguments to Bun's equivalents
 * while keeping `run` (package script) and `exec` (workspace dependency bin) semantics distinct.
 * @param args - Arguments in pnpm CLI order.
 * @param environment - Lifecycle environment containing `npm_execpath`.
 * @param rootDir - Workspace root used to resolve `--filter <pkg> exec` directories for Bun.
 * @returns A command and argument array suitable for `spawn` or `spawnSync` without a shell.
 */
export function pnpmInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  rootDir: string = defaultWorkspaceRoot,
): { command: string; args: string[] } {
  const entrypoint = environment.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('pnpm invocation: npm_execpath is unavailable; invoke the script through pnpm run.')
  }
  if (isBunEntrypoint(entrypoint)) {
    return { command: entrypoint, args: translateArgsForBun(args, rootDir) }
  }
  if (/\.[cm]?js$/iu.test(entrypoint)) {
    return { command: process.execPath, args: [entrypoint, ...args] }
  }
  return { command: entrypoint, args: [...args] }
}

/**
 * Resolve a shell-free workspace runner invocation for scripts that may be launched via `bun run`,
 * `pnpm run`, or directly with `bun`/`node` without `npm_execpath`.
 * @param args - Arguments in pnpm CLI order (`run ...`, `exec ...`, `--filter <pkg> run|exec ...`).
 * @param environment - Environment inspected for `npm_execpath`.
 * @param rootDir - Workspace root used to resolve `--filter <pkg> exec` directories for Bun.
 * @returns The runner command, translated arguments, and a concise display label.
 */
export function workspaceRunnerInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  rootDir: string = defaultWorkspaceRoot,
): { command: string; args: string[]; displayCommand: string } {
  const entrypoint = environment.npm_execpath
  if (entrypoint !== undefined && entrypoint !== '') {
    if (isBunEntrypoint(entrypoint)) {
      const translated = translateArgsForBun(args, rootDir)
      return { command: entrypoint, args: translated, displayCommand: `bun ${translated.join(' ')}` }
    }
    if (/[\\/]pnpm[\\/]/u.test(entrypoint) || /^pnpm(?:\.exe)?$/iu.test(basename(entrypoint.replaceAll('\\', '/')))) {
      const invocation = pnpmInvocation(args, environment, rootDir)
      return { ...invocation, displayCommand: `pnpm ${args.join(' ')}` }
    }
  }
  if ('bun' in process.versions) {
    const translated = translateArgsForBun(args, rootDir)
    return { command: process.execPath, args: translated, displayCommand: `bun ${translated.join(' ')}` }
  }
  const [command, ...prefix] = pnpmCommand()
  return { command, args: [...prefix, ...args], displayCommand: `pnpm ${args.join(' ')}` }
}
