import assert from 'node:assert/strict'
import test from 'node:test'
import { compareLockfiles, formatDriftReport, parseBunLockfile, parseJsonc, parsePnpmLockfile } from './verify-lockfile-sync.mjs'

const samplePnpm = `lockfileVersion: '9.0'

patchedDependencies:
  '@botiverse/oar@0.67.0': 65de2ca1966421e30893d8d4fed6a3d88e4247e131e7575fe791246e594538d6

packages:

  '@scope/pkg@1.0.0':
    resolution: {integrity: sha512-aaa==}

  picomatch@4.0.4:
    resolution:
      integrity: sha512-bbb==

  xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz:
    resolution: {integrity: sha512-ccc==, tarball: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz}

snapshots:
  picomatch@4.0.4: {}
`

const sampleBun = `{
  "lockfileVersion": 3,
  "patchedDependencies": {
    "@botiverse/oar@0.67.0": "patches/@botiverse__oar@0.67.0.patch",
  },
  "packages": {
    "@scope/pkg": ["@scope/pkg@1.0.0", "", {}, "sha512-aaa=="],
    "picomatch": ["picomatch@4.0.4", "", {}, "sha512-bbb=="],
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

test('compareLockfiles reports inSync when packages, integrity hashes, and patches match', () => {
  const result = compareLockfiles(samplePnpm, sampleBun)
  assert.equal(result.inSync, true)
  assert.equal(result.pnpmPackageCount, 3)
  assert.equal(result.bunPackageCount, 3)
  assert.equal(result.patchCount, 1)
})

test('compareLockfiles catches package version drift when only pnpm-lock.yaml is updated', () => {
  const bumpedPnpm = samplePnpm.replace('picomatch@4.0.4:', 'picomatch@4.0.7:')
  const result = compareLockfiles(bumpedPnpm, sampleBun)
  assert.equal(result.inSync, false)
  assert.deepEqual(result.missingInBun, ['picomatch@4.0.7'])
  assert.deepEqual(result.extraInBun, ['picomatch@4.0.4'])
  const report = formatDriftReport(result)
  assert.match(report, /picomatch@4\.0\.7/)
  assert.match(report, /bun install --lockfile-only --linker isolated/)
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
  assert.equal(parsePnpmLockfile(samplePnpm).packages.size, 3)
  assert.equal(parseBunLockfile(sampleBun).packages.size, 3)
})
