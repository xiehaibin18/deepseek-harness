/** Start the built Web CLI under Bun and fetch the frontend that belongs to this checkout. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { execa } from 'execa'
import { createRuntimeResolution } from '../../packages/boot/app-boot/lib/index.js'

const entry = resolve('apps/cli/lib/bin.js')
const built = await readFile('apps/web/dist/index.html', 'utf8')
const asset = /<script\b[^>]*\bsrc="([^"]+)"/.exec(built)?.[1]
assert.ok(asset, 'Web build must emit a script entry')
const home = await mkdtemp(join(tmpdir(), 'dsp-ci-web-'))
try {
  // DSP links the installed plugins into its Bun profile for package resolution.
  const dshHome = join(home, '.dsh')
  const resolution = await createRuntimeResolution({ installAnchor: resolve('apps/cli/package.json'), home: dshHome })
  for (const { name, packageDir } of resolution.entries) {
    const link = join(dshHome, 'profiles/node_modules', name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(await realpath(packageDir), link, 'dir')
  }
  const child = execa(process.env.DSH_TEST_BUN_EXECUTABLE, [
    '--no-install', '--no-env-file', '--tsconfig-override=/dev/null', entry, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open',
  ], {
    cwd: home, extendEnv: false, env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(),
      DSH_HOME: dshHome, DSH_AGENTS_HOME: join(home, '.agents'), DSH_TELEMETRY_DISABLED: '1' },
    timeout: 60_000, forceKillAfterDelay: 2_000, reject: false, stderr: 'inherit',
  })
  try {
    let served = false
    for await (const line of createInterface({ input: child.stdout })) {
      const url = /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*)/.exec(line)?.[1]
      if (!url) continue
      const exchange = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
      assert.equal(exchange.status, 303)
      const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
      const location = exchange.headers.get('location')
      assert.ok(cookie && location, 'Web login must issue a session cookie and redirect')
      const headers = { cookie }
      const page = await fetch(new URL(location, url), { headers, signal: AbortSignal.timeout(10_000) })
      assert.equal(page.status, 200)
      const html = await page.text()
      assert.ok(html.includes('__DSH_BOOT__') && html.includes(asset), 'Web must serve the built page with its boot manifest')
      const script = await fetch(new URL(asset, page.url), { headers, signal: AbortSignal.timeout(10_000) })
      assert.equal(script.status, 200)
      assert.match(script.headers.get('content-type') ?? '', /javascript/)
      assert.ok((await script.arrayBuffer()).byteLength > 0)
      served = true
      console.log('Bun served the built DSP Web page and its JavaScript')
      break
    }
    assert.ok(served, 'Bun Web exited before serving its frontend')
  } finally {
    child.kill('SIGTERM')
    await child
  }
} finally {
  await rm(home, { recursive: true, force: true })
}
