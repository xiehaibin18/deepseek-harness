/** Dispatch a workspace package-manager command using the caller's package manager (Bun or pnpm). */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { workspaceRunnerInvocation } from './pnpm-invocation.ts'

/**
 * Resolve and execute a workspace command in pnpm CLI argument order under the active package manager.
 * @param args - Arguments in pnpm CLI order (for example `--filter <pkg> run <script>`).
 * @param environment - Process environment inspected for `npm_execpath`.
 * @returns The child process exit code.
 */
export function runWorkspaceCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const invocation = workspaceRunnerInvocation(args, environment)
  const result = spawnSync(invocation.command, invocation.args, { stdio: 'inherit', env: environment })
  if (result.error !== undefined) throw result.error
  return result.status ?? 1
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('workspace-run: expected package manager arguments (for example --filter <pkg> run <script>)')
    process.exit(1)
  }
  process.exit(runWorkspaceCommand(args))
}
