import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, onTestFinished } from 'vitest'

const bun = process.env.DSH_TEST_BUN_EXECUTABLE
const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const built = ['lib/index.js', 'lib/process.js'].every(file => existsSync(join(pkgDir, file)))

describe.skipIf(process.platform !== 'darwin' || bun === undefined || !built)('built Bun PTC runtime', () => {
  it.each(['persistent-in-memory', 'per-call', 'vm-script'] as const)('executes %s with Node type stripping and workspace-relative imports', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bun-ptc-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const first = join(root, 'first')
    const second = join(root, 'second')
    await Promise.all([first, second].map(directory => mkdir(directory)))
    for (const [directory, value] of [[first, 11], [second, 22]] as const) {
      await writeFile(join(directory, 'fixture.mjs'), 'export const value = ' + String(value))
      await writeFile(join(directory, 'bunfig.toml'), 'preload = ["./preload.mjs"]\n')
      await writeFile(join(directory, 'preload.mjs'), 'throw new Error("PTC must not run workspace preloads")')
      await writeFile(join(directory, '.env'), 'WORKSPACE_PTC_CANARY=unexpected\n')
    }
    const complete = mode === 'per-call' ? 'return ' : ''
    const program1 = 'let remembered: number = (await import("./fixture.mjs")).value; ' + complete
      + '({ remembered, runtime: typeof process.versions.bun, envKeys: [process.env, (await import("node:process")).env, Bun.env].map(x => Object.keys(x)) })'
    const program2 = 'const local: number = (await import("./fixture.mjs")).value; ' + complete
      + '({ retained: typeof remembered === "undefined" ? null : remembered, local })'
    const script = [
      "const { Context } = await import('@deepseek-ai/cordis')",
      "const { NodePtcRuntime } = await import('@deepseek-ai/dsh-ptc-runtime-node')",
      'const ctx = new Context()',
      'try {',
      "  for (const name of ['session-projection', 'fs-local', 'subprocess-local', 'sandbox-local']) {",
      "    await ctx.plugin((await import('@deepseek-ai/dsh-' + name)).default, {})",
      '  }',
      "  await ctx.plugin((await import('@deepseek-ai/dsh-sandbox-policy')).default, " + JSON.stringify({ mode: 'read-only', workspaceRoot: root }) + ')',
      '  await ctx.plugin(NodePtcRuntime, ' + JSON.stringify({ executionMode: mode, launch: { kind: 'bun-script', executable: bun } }) + ')',
      '  const stateOwner = {}',
      '  const run = (program, cwd) => ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ program, bindings: [], cwd, stateOwner }))',
      '  const first = await run(' + JSON.stringify(program1) + ', ' + JSON.stringify(first) + ')',
      '  const second = await run(' + JSON.stringify(program2) + ', ' + JSON.stringify(second) + ')',
      '  console.log(JSON.stringify({ first, second }))',
      '} finally { await ctx.fiber.dispose() }',
    ].join('\n')

    const result = await execa(bun ?? 'bun', ['--config=/dev/null', '--tsconfig-override=/dev/null', '--no-env-file', '--no-install', '-e', script], {
      cwd: pkgDir,
      extendEnv: false,
      env: {
        HOME: root,
        TMPDIR: root,
        DSH_HOME: join(root, 'dsh'),
        DSH_AGENTS_HOME: join(root, 'agents'),
        DSP_NODE_EXECUTABLE: process.execPath,
        PATH: dirname(process.execPath) + ':/usr/bin:/bin',
      },
      stdin: 'ignore',
      timeout: 55_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    const outcomes = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as { first: unknown; second: unknown }
    expect(outcomes.first).toMatchObject({ value: { remembered: 11, runtime: 'string', envKeys: [[], [], []] } })
    expect(outcomes.second).toMatchObject({ value: { retained: mode === 'persistent-in-memory' ? 11 : null, local: 22 } })
  }, 60_000)
})
