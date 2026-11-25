import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const built = [
  new URL('../lib/index.js', import.meta.url),
  new URL('../../../ptc-runtime/ptc-runtime-node/lib/index.js', import.meta.url),
  new URL('../../../ptc-runtime/ptc-runtime-node/lib/process.js', import.meta.url),
].every(path => existsSync(path))
const runProgram = promisify(execFile)
const bun = process.platform === 'darwin' ? process.env.DSH_TEST_BUN_EXECUTABLE : undefined
const launches = [
  { runtime: 'Node', host: process.execPath, config: {} },
  ...bun === undefined ? [] : [{
    runtime: 'Bun', host: bun,
    config: { executionMode: 'persistent-in-memory' },
  }],
]

/** Exercise the published Workflow package against the selected PTC child bootstrap. */
describe.skipIf(!built)('built workflow PTC runtime', () => {
  it.each(launches)('runs a structured child and confines direct writes with $runtime', async ({ runtime, host, config }) => {
    const driverRoot = await mkdtemp(join(packageRoot, '.built-runtime-'))
    let root: string | undefined
    try {
      root = await mkdtemp(join(homedir(), '.dsh-built-workflow-'))
      const cwd = join(root, 'workspace')
      const outside = join(root, 'outside.txt')
      await mkdir(cwd)
      await writeFile(outside, 'unchanged')
      const driver = join(driverRoot, 'driver.mjs')
      await writeFile(driver, `
import { Context } from '@deepseek-ai/cordis'
import PtcWorkflowEngine from '@deepseek-ai/dsh-workflow-ptc'
const ctx = new Context()
try {
  for (const name of ['session', 'session-projection', 'agent', 'system-prompt', 'fs-local', 'working-directory', 'subprocess-local', 'sandbox-local']) {
    await ctx.plugin((await import('@deepseek-ai/dsh-' + name)).default, {})
  }
  await ctx.plugin((await import('@deepseek-ai/dsh-sandbox-policy')).default, { mode: 'read-only', workspaceRoot: process.argv[2] })
  await ctx.plugin((await import('@deepseek-ai/dsh-ptc-runtime-node')).default, ${JSON.stringify(config)})
  await ctx.plugin((await import('@deepseek-ai/dsh-subagent')).default, {})
  let selectedStarts = 0
  ctx.subagents.registerProvider({
    name: 'built-selected',
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: false },
    inheritsParentContext: false,
    async start() {
      selectedStarts += 1
      return {
        id: 'built-child',
        result: Promise.resolve({ output: [], structured: { answer: 42 }, stopReason: 'completed' }),
        dispose: () => Promise.resolve(),
      }
    },
  })
  await ctx.plugin(PtcWorkflowEngine, { provider: 'must-not-be-used' })
  const session = ctx.sessions.create(undefined, { meta: { cwd: process.argv[2] } })
  const parent = { id: session.id, ctx, session, options: {}, status: 'idle' }
  ctx.agents.register(parent)
  const run = ctx.workflowEngine.start({
    script: "const proc = globalThis.constructor.constructor('return process')(); try { proc.getBuiltinModule('node:fs').writeFileSync(args.outside, 'changed') } catch {} const value = await agent('answer', { schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] } }); return value.answer",
    args: { outside: process.argv[3] },
    meta: { name: 'built-smoke', description: 'built workflow runtime' },
    subagentProvider: 'built-selected',
    parent,
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed' || result.value !== 42 || selectedStarts !== 1) {
      throw new Error('unexpected result: ' + JSON.stringify(result))
    }
    console.log('built-runtime-smoke-ok')
  } finally { await run.dispose() }
} finally { await ctx.fiber.dispose() }
`, 'utf8')
      const args = runtime === 'Bun'
        ? ['--config=/dev/null', '--tsconfig-override=/dev/null', '--no-env-file', '--no-install', driver, cwd, outside]
        : [driver, cwd, outside]
      const { stdout } = await runProgram(host, args, {
        cwd: packageRoot, timeout: 60_000,
        env: {
          HOME: root, TMPDIR: root, DSH_HOME: join(root, 'dsh'), DSH_AGENTS_HOME: join(root, 'agents'),
          PATH: runtime === 'Bun' ? '/usr/bin:/bin' : dirname(process.execPath) + ':/usr/bin:/bin',
        },
      })
      expect(stdout).toContain('built-runtime-smoke-ok')
      expect(await readFile(outside, 'utf8')).toBe('unchanged')
    } finally {
      await rm(driverRoot, { recursive: true, force: true })
      if (root !== undefined) await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
