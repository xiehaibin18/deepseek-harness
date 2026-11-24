/** A Bun Host recomposes a profile without a Node module cache and reports the configuration it applied. */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, onTestFinished } from 'vitest'

const bun = process.env.DSH_TEST_BUN_EXECUTABLE
const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const built = ['lib/index.js', '../app-boot/lib/index.js'].every(file => existsSync(join(pkgDir, file)))

describe.skipIf(process.platform !== 'darwin' || bun === undefined || !built)('built Bun Host profile recomposition', () => {
  it('reports an applied configuration change without a restart reason', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-bun-hmr-')))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const script = [
      'const { mkdirSync, writeFileSync } = await import("node:fs")',
      'const { dirname, join } = await import("node:path")',
      'const { boot, initProfile, readProfilePatches } = await import("@deepseek-ai/dsh-app-boot")',
      'const Timer = (await import("@deepseek-ai/cordis-plugin-timer")).default',
      'const Hmr = (await import("@deepseek-ai/dsh-hmr")).default',
      'const file = (path, source) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source) }',
      'const home = ' + JSON.stringify(root),
      'const dir = join(home, "profiles", "test")',
      'initProfile(dir, ["addon"])',
      'file(join(dir, "cordis.yml"), "[]\\n")',
      'const addon = join(dir, "node_modules", "addon")',
      'file(join(addon, "package.json"), JSON.stringify({ name: "addon", version: "1.0.0", type: "module", exports: "./index.mjs", dsh: { bundle: { patch: "./cordis.patch.yml" } } }))',
      'file(join(addon, "index.mjs"), "export function apply(ctx, config = {}) {\\n  ctx.get(\'reloadTrace\').push(\'start:\' + (config.mode ?? \'-\'))\\n  ctx.effect(() => () => { ctx.get(\'reloadTrace\').push(\'stop\') })\\n}\\n")',
      'const addonPatch = join(addon, "cordis.patch.yml")',
      'const patch = (mode) => "- insert:\\n    - id: addon\\n      name: addon\\n      config: { mode: " + mode + " }\\n"',
      'file(addonPatch, patch("first"))',
      'const profile = { name: "test", dir, patchPath: join(dir, "cordis.patch.yml"), home, cwd: home, installAnchor: join(home, "package.json"), startedBundles: ["addon"], overlayPaths: [], telemetryDisabledEnv: undefined }',
      'file(profile.patchPath, JSON.stringify([{ insert: [{ id: "timer", name: "cordis:timer" }, { id: "hmr", name: "cordis:hmr", config: { root: [] } }] }]))',
      'const trace = []',
      'let ready',
      'const ctx = await boot("test", join(dir, "cordis.yml"), readProfilePatches("test", profile), (host) => {',
      '  host.provide("profileContext", profile)',
      '  host.provide("reloadTrace", trace)',
      '  host.provide("appReady", { onReady(listener) { ready = listener; return () => {} } })',
      '  host.loader.builtins.timer = Timer',
      '  host.loader.builtins.hmr = Hmr',
      '})',
      'try {',
      '  await ctx.loader.await()',
      '  ready?.()',
      '  const reconcile = () => ctx.hmr.runExclusive(() => ctx.hmr.reconcileProfile())',
      '  await ctx.hmr.runExclusive(async () => {})',
      '  const before = await reconcile()',
      '  trace.length = 0',
      '  file(addonPatch, patch("second"))',
      '  const after = await reconcile()',
      '  console.log(JSON.stringify({ runtime: typeof process.versions.bun, before, after, trace }))',
      '} finally { await ctx.fiber.dispose() }',
    ].join('\n')

    const result = await execa(bun ?? 'bun', ['--config=/dev/null', '--tsconfig-override=/dev/null', '--no-env-file', '--no-install', '-e', script], {
      cwd: pkgDir,
      extendEnv: false,
      env: { HOME: root, TMPDIR: root, DSH_HOME: join(root, 'dsh'), DSH_AGENTS_HOME: join(root, 'agents'), PATH: '/usr/bin:/bin' },
      stdin: 'ignore',
      timeout: 55_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    const outcome = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as { runtime?: unknown; before?: unknown; after?: unknown; trace?: unknown }
    expect(outcome.runtime).toBe('string')
    expect(outcome.before).toEqual({ warnings: [], pending: [] })
    // The plugin restarts with the new configuration, and no module comparison claims a pending restart.
    expect(outcome.after).toEqual({ warnings: [], pending: [] })
    expect(outcome.trace).toEqual(['stop', 'start:second'])
  }, 60_000)
})
