import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatTrustedBuildsReport,
  parseBunUntrustedOutput,
  parsePnpmAllowBuilds,
  verifyTrustedBuilds,
} from './verify-trusted-builds.mjs'

const sampleWorkspaceYaml = `packages:
  - packages/*/*

allowBuilds:
  esbuild: true
  '@deepseek-ai/dsh-subprocess-local@file:packages/subprocess/subprocess-local': true
  '@google/genai': false
  protobufjs: false
  '@larksuite/cli@1.0.97': false
`

const samplePackageJson = JSON.stringify({
  name: 'root',
  trustedDependencies: ['esbuild', '@deepseek-ai/dsh-subprocess-local'],
})

const sampleUntrusted = `bun pm untrusted v1.4.5-canary.1 (4ce14ba8b)

./node_modules/.bun/@larksuite+cli@1.0.97/node_modules/@larksuite/cli @1.0.97
 » [postinstall]: node scripts/install.js

./node_modules/.bun/@google+genai@2.21.0+227f48ceeec5b266/node_modules/@google/genai @2.21.0
 » [preinstall]: echo 'preinstall: no-op'

./node_modules/.bun/protobufjs@7.6.5/node_modules/protobufjs @7.6.5
 » [postinstall]: node scripts/postinstall

These dependencies had their lifecycle scripts blocked during install.
`

test('parsePnpmAllowBuilds distinguishes allowed and denied entries including versioned keys', () => {
  const policy = parsePnpmAllowBuilds(sampleWorkspaceYaml)
  assert.ok(policy.allowed.has('esbuild'))
  assert.ok(policy.allowedNames.has('@deepseek-ai/dsh-subprocess-local'))
  assert.ok(policy.denied.has('@google/genai'))
  assert.ok(policy.denied.has('protobufjs'))
  assert.ok(policy.denied.has('@larksuite/cli@1.0.97'))
})

test('verifyTrustedBuilds passes when every blocked script is explicitly denied and trustedDependencies are approved', () => {
  const result = verifyTrustedBuilds({
    untrustedOutput: sampleUntrusted,
    workspaceYaml: sampleWorkspaceYaml,
    packageJsonText: samplePackageJson,
  })
  assert.equal(result.ok, true)
  assert.equal(result.blockedCount, 3)
  assert.equal(result.trustedCount, 2)
})

test('verifyTrustedBuilds fails on an unreviewed new postinstall package or bumped pinned package', () => {
  const withNewAndBumped = `${sampleUntrusted}
./node_modules/.bun/new-native-pkg@2.0.0/node_modules/new-native-pkg @2.0.0
 » [postinstall]: node build.js

./node_modules/.bun/@larksuite+cli@1.0.98/node_modules/@larksuite/cli @1.0.98
 » [postinstall]: node scripts/install.js
`
  const result = verifyTrustedBuilds({
    untrustedOutput: withNewAndBumped,
    workspaceYaml: sampleWorkspaceYaml,
    packageJsonText: samplePackageJson,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.unreviewedBlocked, ['@larksuite/cli@1.0.98', 'new-native-pkg@2.0.0'])
  const report = formatTrustedBuildsReport(result)
  assert.match(report, /new-native-pkg@2\.0\.0/)
  assert.match(report, /@larksuite\/cli@1\.0\.98/)
})

test('verifyTrustedBuilds catches allowBuilds: true missing from trustedDependencies and unapproved trustedDependencies', () => {
  const blockedApproved = `./node_modules/.bun/esbuild@0.28.2/node_modules/esbuild @0.28.2
 » [postinstall]: node install.js
`
  const manifestWithExtra = JSON.stringify({
    name: 'root',
    trustedDependencies: ['esbuild', 'unapproved-pkg'],
  })
  const result = verifyTrustedBuilds({
    untrustedOutput: blockedApproved,
    workspaceYaml: sampleWorkspaceYaml,
    packageJsonText: manifestWithExtra,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.allowedButBlocked, ['esbuild@0.28.2'])
  assert.deepEqual(result.unapprovedTrusted, ['unapproved-pkg'])
})

test('parseBunUntrustedOutput fails loud if Bun reports blocked scripts in an unrecognized format', () => {
  assert.throws(
    () => parseBunUntrustedOutput('something unexpected\nThese dependencies had their lifecycle scripts blocked during install.\n'),
    /Failed to parse blocked dependencies/,
  )
})
