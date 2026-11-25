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

/** A valid program whose bytes exceed the default output buffer of a child process. */
function largeProgram(completion = 'return value0'): string {
  let program = ''
  for (let index = 0; program.length < 2 * 1024 * 1024; index++) program += `const value${index}: number = ${index}\n`
  return program + completion
}

describe.skipIf(process.platform !== 'darwin' || bun === undefined || !built)('built Bun PTC runtime', () => {
  /**
   * Run a Host script under Bun with its home and temporary directory inside `root`.
   * @param path - Directory to put before `PATH`; omitted leaves the Host without any Node executable.
   */
  async function host(root: string, script: string, { path }: { path?: string } = {}) {
    return execa(bun ?? 'bun', ['--config=/dev/null', '--tsconfig-override=/dev/null', '--no-env-file', '--no-install', '-e', script], {
      cwd: pkgDir,
      extendEnv: false,
      env: {
        HOME: root,
        TMPDIR: root,
        DSH_HOME: join(root, 'dsh'),
        DSH_AGENTS_HOME: join(root, 'agents'),
        PATH: (path === undefined ? '' : path + ':') + '/usr/bin:/bin',
      },
      stdin: 'ignore',
      timeout: 55_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
  }

  it.each(['persistent-in-memory', 'per-call', 'vm-script'] as const)('executes %s with the default Bun worker and no Node executable', async (mode) => {
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
      '  await ctx.plugin(NodePtcRuntime, ' + JSON.stringify({ executionMode: mode }) + ')',
      '  const stateOwner = {}',
      '  const run = (program, cwd) => ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ program, bindings: [], cwd, stateOwner }))',
      '  const first = await run(' + JSON.stringify(program1) + ', ' + JSON.stringify(first) + ')',
      '  const second = await run(' + JSON.stringify(program2) + ', ' + JSON.stringify(second) + ')',
      '  console.log(JSON.stringify({ first, second }))',
      '} finally { await ctx.fiber.dispose() }',
    ].join('\n')

    const result = await host(root, script)
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    const outcomes = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as { first: unknown; second: unknown }
    expect(outcomes.first).toMatchObject({ value: { remembered: 11, runtime: 'string', envKeys: [[], [], []] } })
    // Scoped REPL imports retain the first directory as the referrer.
    const scoped = mode === 'persistent-in-memory'
    expect(outcomes.second).toMatchObject({ value: { retained: scoped ? 11 : null, local: scoped ? 11 : 22 } })
  }, 60_000)

  /** Boot a Bun Host that strips and runs the program file in per-call mode with `config`. */
  function stripScript(programPath: string, root: string, config: object, evaluate = 'console.log(JSON.stringify(await run(program)))'): string {
    return [
      "const { Context } = await import('@deepseek-ai/cordis')",
      "const { NodePtcRuntime } = await import('@deepseek-ai/dsh-ptc-runtime-node')",
      "const program = await (await import('node:fs/promises')).readFile(" + JSON.stringify(programPath) + ", 'utf8')",
      'const ctx = new Context()',
      'try {',
      "  for (const name of ['session-projection', 'fs-local', 'subprocess-local', 'sandbox-local']) {",
      "    await ctx.plugin((await import('@deepseek-ai/dsh-' + name)).default, {})",
      '  }',
      "  await ctx.plugin((await import('@deepseek-ai/dsh-sandbox-policy')).default, " + JSON.stringify({ mode: 'read-only', workspaceRoot: root }) + ')',
      '  await ctx.plugin(NodePtcRuntime, ' + JSON.stringify({ executionMode: 'per-call', ...config }) + ')',
      '  const stateOwner = {}',
      '  const run = (program, options = {}) => ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ program, bindings: [], cwd: ' + JSON.stringify(root) + ', stateOwner, ...options }))',
      evaluate,
      '} finally { await ctx.fiber.dispose() }',
    ].join('\n')
  }

  /** Run one program through a Bun Host and return its outcome. */
  async function strip(root: string, program: string, config: object = {}, hostOptions: { path?: string } = {}) {
    const programPath = join(root, 'program.ts')
    await writeFile(programPath, program)
    const result = await host(root, stripScript(programPath, root, config), hostOptions)
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as { value?: unknown; error?: { kind: string; message: string } }
  }

  it.each([
    { name: 'a one-line program beside a one-millisecond stop grace', config: { stopGraceMs: 1 }, program: 'const answer: number = 41\nreturn answer + 1', value: 42 },
    { name: 'a program larger than the default output buffer of a child process', config: {}, program: largeProgram(), value: 0 },
  ])('strips $name in the Bun Host', async ({ config, program, value }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bun-strip-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const outcome = await strip(root, program, config)
    expect(outcome.error).toBeUndefined()
    expect(outcome.value).toBe(value)
  }, 60_000)

  it('starts a Node worker only when launch selects it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bun-strip-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const outcome = await strip(root, 'const answer: number = 41\nreturn { runtime: typeof process.versions.bun, answer: answer + 1 }',
      { launch: { kind: 'node-script', executable: process.execPath } }, { path: dirname(process.execPath) })
    expect(outcome.error).toBeUndefined()
    expect(outcome.value).toEqual({ runtime: 'undefined', answer: 42 })
  }, 60_000)

  it('rejects a worker executable that is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bun-strip-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const programPath = join(root, 'program.ts')
    await writeFile(programPath, 'return 1')
    const result = await host(root, stripScript(programPath, root, { launch: { kind: 'bun-script', executable: '' } }))
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('ptc-runtime-node: launch.executable must be non-empty')
  }, 60_000)

  it('reports TypeScript outside the erasable subset as an exception', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bun-strip-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const outcome = await strip(root, 'enum Color { Red }\nreturn Color.Red')
    expect(outcome.value).toBeUndefined()
    expect(outcome.error).toMatchObject({ kind: 'exception', message: 'TypeScript enum is not supported in strip-only mode' })
  }, 60_000)

  async function exerciseStrip(program: string, config: object, evaluate: string): Promise<unknown> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-bun-strip-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const programPath = join(root, 'program.ts')
    await writeFile(programPath, program)
    const script = stripScript(programPath, root, { ...config, launch: { kind: 'bun-script', executable: bun } }, evaluate)
    const result = await host(root, script)
    expect(result.exitCode, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }

  it('bounds type stripping even when the program has no execution deadline', async () => {
    const result = await exerciseStrip(largeProgram(), { maxTimeoutMs: 1 },
      'console.log(JSON.stringify(await run(program, { timeoutMs: null })))')
    expect(result).toMatchObject({ error: { kind: 'timeout' } })
  }, 60_000)

  it.each(['abort', 'timeout'] as const)('handles %s before a retained worker receives the program and accepts the next call', async (kind) => {
    const result = await exerciseStrip(largeProgram('enum Color { Red }'), { executionMode: 'persistent-in-memory' }, `
      const warm = await run('const previous: number = 41; previous')
      const controller = new AbortController()
      const options = ${JSON.stringify(kind)} === 'abort' ? { signal: controller.signal } : { timeoutMs: 1 }
      const pending = run(program, options)
      const otherOwner = run('6 * 7', { stateOwner: {} })
      if (options.signal) setTimeout(() => controller.abort(), 0)
      const [interrupted, other] = await Promise.all([pending, otherOwner])
      const next = await run('previous + 1')
      console.log(JSON.stringify({ warm, interrupted, other, next }))
    `)
    expect(result).toMatchObject({ warm: { value: 41 }, interrupted: { error: { kind } }, other: { value: 42 }, next: { value: 42 } })
  }, 60_000)

  it('reports initializer syntax errors at registration and runs a corrected initializer', async () => {
    const result = await exerciseStrip('const answer: number = 42', { executionMode: 'persistent-in-memory' }, `
      let message
      try { ctx.ptcRuntime.registerEnvironmentInitializer('enum Color { Red }') } catch (failure) { message = failure.message }
      const dispose = ctx.ptcRuntime.registerEnvironmentInitializer(program)
      try { console.log(JSON.stringify({ message, outcome: await run('answer') })) } finally { await dispose() }
    `)
    expect(result).toMatchObject({ message: 'TypeScript enum is not supported in strip-only mode', outcome: { value: 42 } })
  }, 60_000)

  it('bounds type stripping during synchronous initializer registration', async () => {
    const result = await exerciseStrip(largeProgram('value0'), { executionMode: 'persistent-in-memory', maxTimeoutMs: 1 }, `
      let message
      try { ctx.ptcRuntime.registerEnvironmentInitializer(program) } catch (failure) { message = failure.message }
      console.log(JSON.stringify({ message }))
    `)
    expect(result).toEqual({ message: 'PTC TypeScript initializer stripping timed out (1ms)' })
  }, 60_000)
})
