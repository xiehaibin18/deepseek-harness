import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { compareLockfiles, formatDriftReport, parseBunLockfile, parseJsonc, parsePnpmLockfile } from './verify-lockfile-sync.mjs'

const samplePnpm = `lockfileVersion: '9.0'

patchedDependencies:
  '@botiverse/oar@0.67.0': 65de2ca1966421e30893d8d4fed6a3d88e4247e131e7575fe791246e594538d6

importers:

  .:
    devDependencies:
      '@scope/pkg':
        specifier: ^1.0.0
        version: 1.0.0
      ms:
        specifier: ^2.1.3
        version: 2.1.3

  vendor/hmr:
    dependencies:
      picomatch:
        specifier: ^4.0.3
        version: 4.0.4

  packages/boot/hmr:
    dependencies:
      picomatch:
        specifier: ^4.0.7
        version: 4.0.7

packages:

  '@scope/pkg@1.0.0':
    resolution: {integrity: sha512-aaa==}
    peerDependencies:
      ms: ^2.0.0

  ms@2.1.3:
    resolution: {integrity: sha512-eee==}

  picomatch@4.0.4:
    resolution:
      integrity: sha512-bbb==

  picomatch@4.0.7:
    resolution: {integrity: sha512-ddd==}

  xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz:
    resolution: {integrity: sha512-ccc==, tarball: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz}

snapshots:
  '@scope/pkg@1.0.0(ms@2.1.3)':
    dependencies:
      ms: 2.1.3
      picomatch: 4.0.4
  ms@2.1.3: {}
  picomatch@4.0.4: {}
  picomatch@4.0.7: {}
`

const sampleBun = `{
  "lockfileVersion": 3,
  "patchedDependencies": {
    "@botiverse/oar@0.67.0": "patches/@botiverse__oar@0.67.0.patch",
  },
  "workspaces": {
    "": { "name": "root", "devDependencies": { "@scope/pkg": "^1.0.0", "ms": "^2.1.3" } },
    "vendor/hmr": { "name": "@deepseek-ai/cordis-plugin-hmr", "dependencies": { "picomatch": "^4.0.3" } },
    "packages/boot/hmr": { "name": "@deepseek-ai/dsh-hmr", "dependencies": { "picomatch": "^4.0.7" } },
  },
  "packages": {
    "@scope/pkg": ["@scope/pkg@1.0.0", "", { "dependencies": { "picomatch": "^4.0.3" }, "peerDependencies": { "ms": "^2.0.0" } }, "sha512-aaa=="],
    "ms": ["ms@2.1.3", "", {}, "sha512-eee=="],
    "picomatch": ["picomatch@4.0.4", "", {}, "sha512-bbb=="],
    "@deepseek-ai/dsh-hmr/picomatch": ["picomatch@4.0.7", "", {}, "sha512-ddd=="],
    "xlsx": ["xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz", {}, "sha512-ccc=="],
    "local-ws": ["local-ws@workspace:packages/local-ws"],
  },
}
`

test('parseJsonc strips trailing commas and comments without disturbing strings', () => {
  const parsed = parseJsonc(`{
    // comment
    "url": "https://example.com/a,}",
    /* block */
    "items": [1, 2,],
  }`)
  assert.deepEqual(parsed, { url: 'https://example.com/a,}', items: [1, 2] })
})

test('compareLockfiles reports inSync when packages, hashes, patches, and workspace/transitive edges match', () => {
  const result = compareLockfiles(samplePnpm, sampleBun)
  assert.equal(result.inSync, true)
  assert.equal(result.pnpmPackageCount, 5)
  assert.equal(result.bunPackageCount, 5)
  assert.equal(result.patchCount, 1)
  assert.equal(result.workspaceDepCount, 4)
  assert.equal(result.transitiveEdgeCount, 1)
})

test('compareLockfiles catches workspace version switch when both versions already exist in both lockfiles', () => {
  const switchedPnpm = samplePnpm.replace(
    '  vendor/hmr:\n    dependencies:\n      picomatch:\n        specifier: ^4.0.3\n        version: 4.0.4',
    '  vendor/hmr:\n    dependencies:\n      picomatch:\n        specifier: ^4.0.3\n        version: 4.0.7',
  )
  const result = compareLockfiles(switchedPnpm, sampleBun)
  assert.equal(result.inSync, false)
  assert.deepEqual(result.missingInBun, [])
  assert.deepEqual(result.extraInBun, [])
  assert.deepEqual(result.workspaceMismatches, [
    { workspace: 'vendor/hmr', dep: 'picomatch', pnpm: 'picomatch@4.0.7', bun: 'picomatch@4.0.4' },
  ])
  const report = formatDriftReport(result)
  assert.match(report, /vendor\/hmr -> picomatch/)
  assert.match(report, /rm -f bun\.lock && bun install --lockfile-only --linker isolated/)
})

test('compareLockfiles catches transitive edge added only in pnpm-lock.yaml (e.g. packageExtensions) or only in bun.lock', () => {
  const addedInPnpm = samplePnpm.replace(
    '  picomatch@4.0.7: {}',
    '  picomatch@4.0.7:\n    dependencies:\n      ms: 2.1.3',
  )
  const missingResult = compareLockfiles(addedInPnpm, sampleBun)
  assert.equal(missingResult.inSync, false)
  assert.deepEqual(missingResult.missingTransitiveInBun, [
    { parent: 'picomatch@4.0.7', dep: 'ms', pnpm: 'ms@2.1.3' },
  ])
  assert.match(formatDriftReport(missingResult), /missing in bun\.lock[\s\S]*picomatch@4\.0\.7 -> ms/)

  const addedInBun = sampleBun.replace(
    '"@deepseek-ai/dsh-hmr/picomatch": ["picomatch@4.0.7", "", {}, "sha512-ddd=="],',
    '"@deepseek-ai/dsh-hmr/picomatch": ["picomatch@4.0.7", "", { "dependencies": { "ms": "^2.1.3" } }, "sha512-ddd=="],',
  )
  const extraResult = compareLockfiles(samplePnpm, addedInBun)
  assert.equal(extraResult.inSync, false)
  assert.deepEqual(extraResult.extraTransitiveInBun, [
    { parent: 'picomatch@4.0.7', dep: 'ms', bun: 'ms@2.1.3' },
  ])
  assert.match(formatDriftReport(extraResult), /missing in pnpm-lock\.yaml[\s\S]*picomatch@4\.0\.7 -> ms/)
})

test('compareLockfiles catches transitive dependency version switch when both versions exist', () => {
  const switchedTransitive = samplePnpm.replace(
    "  '@scope/pkg@1.0.0(ms@2.1.3)':\n    dependencies:\n      ms: 2.1.3\n      picomatch: 4.0.4",
    "  '@scope/pkg@1.0.0(ms@2.1.3)':\n    dependencies:\n      ms: 2.1.3\n      picomatch: 4.0.7",
  )
  const result = compareLockfiles(switchedTransitive, sampleBun)
  assert.equal(result.inSync, false)
  assert.deepEqual(result.transitiveMismatches, [
    { parent: '@scope/pkg@1.0.0', dep: 'picomatch', pnpm: 'picomatch@4.0.7', bun: 'picomatch@4.0.4' },
  ])
})

test('compareLockfiles catches integrity hash mismatch and patch drift', () => {
  const mutatedBun = sampleBun
    .replace('sha512-bbb==', 'sha512-tampered==')
    .replace('"@botiverse/oar@0.67.0": "patches/@botiverse__oar@0.67.0.patch",', '')
  const result = compareLockfiles(samplePnpm, mutatedBun)
  assert.equal(result.inSync, false)
  assert.deepEqual(result.integrityMismatches, [
    { spec: 'picomatch@4.0.4', pnpm: 'sha512-bbb==', bun: 'sha512-tampered==' },
  ])
  assert.deepEqual(result.missingPatchesInBun, ['@botiverse/oar@0.67.0'])
})

test('parsers ignore workspace entries without integrity hashes', () => {
  assert.equal(parsePnpmLockfile(samplePnpm).packages.size, 5)
  assert.equal(parseBunLockfile(sampleBun).packages.size, 5)
})

test('documented remigration command actually migrates an updated pnpm-lock.yaml under real Bun', (t) => {
  const bunCheck = spawnSync('bun', ['--version'], { encoding: 'utf8' })
  if (bunCheck.status !== 0) {
    t.skip('bun is not installed on PATH')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remigrate-test-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'root',
      private: true,
      dependencies: { picomatch: '^4.0.3' },
    }))
    const pnpm404 = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      picomatch:
        specifier: ^4.0.3
        version: 4.0.4
packages:
  picomatch@4.0.4:
    resolution: {integrity: sha512-QP88BAKvMam/3NxH6vj2o21R6MjxZUAd6nlwAS/pnGvN9IVLocLHxGYIzFhg6fUQ+5th6P4dv4eW9jX3DSIj7A==}
snapshots:
  picomatch@4.0.4: {}
`
    const pnpm407 = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      picomatch:
        specifier: ^4.0.3
        version: 4.0.7
packages:
  picomatch@4.0.7:
    resolution: {integrity: sha512-qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==}
snapshots:
  picomatch@4.0.7: {}
`
    writeFileSync(join(dir, 'pnpm-lock.yaml'), pnpm404)
    const initial = spawnSync('bun', ['install', '--lockfile-only', '--linker', 'isolated'], { cwd: dir, encoding: 'utf8' })
    assert.equal(initial.status, 0, initial.stdout + initial.stderr)
    assert.equal(compareLockfiles(pnpm404, readFileSync(join(dir, 'bun.lock'), 'utf8')).inSync, true)

    writeFileSync(join(dir, 'pnpm-lock.yaml'), pnpm407)
    assert.equal(compareLockfiles(pnpm407, readFileSync(join(dir, 'bun.lock'), 'utf8')).inSync, false)

    rmSync(join(dir, 'bun.lock'), { force: true })
    const remigrated = spawnSync('bun', ['install', '--lockfile-only', '--linker', 'isolated'], { cwd: dir, encoding: 'utf8' })
    assert.equal(remigrated.status, 0, remigrated.stdout + remigrated.stderr)
    assert.equal(compareLockfiles(pnpm407, readFileSync(join(dir, 'bun.lock'), 'utf8')).inSync, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
