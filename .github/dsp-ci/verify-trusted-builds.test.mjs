import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateAllowBuildsInstance,
  formatTrustedBuildsReport,
  parseBunUntrustedOutput,
  parsePnpmAllowBuilds,
  verifyPreInstallTrustedBuilds,
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

const sampleBunLock = `{
  "lockfileVersion": 3,
  "packages": {
    "esbuild": ["esbuild@0.28.2", "", {}, "sha512-aaa=="],
    "@deepseek-ai/dsh-subprocess-local": ["@deepseek-ai/dsh-subprocess-local@workspace:packages/subprocess/subprocess-local"],
    "@google/genai": ["@google/genai@2.21.0", "", {}, "sha512-bbb=="],
    "protobufjs": ["protobufjs@7.6.5", "", {}, "sha512-ccc=="],
    "@larksuite/cli": ["@larksuite/cli@1.0.97", "", {}, "sha512-ddd=="],
  },
}
`

const sampleUntrusted = `bun pm untrusted v1.4.5-canary.1 (4ce14ba8b)

./node_modules/.bun/@larksuite+cli@1.0.97/node_modules/@larksuite/cli @1.0.97
 » [postinstall]: node scripts/install.js

./node_modules/.bun/@google+genai@2.21.0+227f48ceeec5b266/node_modules/@google/genai @2.21.0
 » [preinstall]: echo 'preinstall: no-op'

./node_modules/.bun/protobufjs@7.6.5/node_modules/protobufjs @7.6.5
 » [postinstall]: node scripts/postinstall

These dependencies had their lifecycle scripts blocked during install.

If you trust them and wish to run their scripts, use \`bun pm trust\`.
`

test('parsePnpmAllowBuilds separates unqualified and qualified rules', () => {
  const policy = parsePnpmAllowBuilds(sampleWorkspaceYaml)
  assert.equal(policy.unqualified.get('esbuild'), true)
  assert.equal(policy.unqualified.get('@google/genai'), false)
  assert.equal(
    policy.qualified.get('@deepseek-ai/dsh-subprocess-local')?.get('local:packages/subprocess/subprocess-local'),
    true,
  )
  assert.equal(policy.qualified.get('@larksuite/cli')?.get('ver:1.0.97'), false)
})

test('evaluateAllowBuildsInstance prioritizes denial over approval matching pnpm 11 decideAllowBuild', () => {
  const packageDeniedVersionAllowed = parsePnpmAllowBuilds(`allowBuilds:
  overlap-pkg: false
  'overlap-pkg@1.0.0': true
`)
  assert.equal(
    evaluateAllowBuildsInstance({ name: 'overlap-pkg', qualifier: '1.0.0' }, packageDeniedVersionAllowed),
    'denied',
  )

  const packageAllowedVersionDenied = parsePnpmAllowBuilds(`allowBuilds:
  overlap-pkg: true
  'overlap-pkg@1.0.0': false
`)
  assert.equal(
    evaluateAllowBuildsInstance({ name: 'overlap-pkg', qualifier: '1.0.0' }, packageAllowedVersionDenied),
    'denied',
  )

  const preResult = verifyPreInstallTrustedBuilds({
    workspaceYaml: `allowBuilds:\n  overlap-pkg: false\n  'overlap-pkg@1.0.0': true\n`,
    packageJsonText: JSON.stringify({ name: 'root', trustedDependencies: ['overlap-pkg'] }),
    bunLockText: `{ "packages": { "overlap-pkg": ["overlap-pkg@1.0.0", "", {}, "sha512-x=="] } }`,
  })
  assert.equal(preResult.ok, false)
  assert.deepEqual(preResult.widenedQualifiedTrusted, [
    { trustedSpec: 'overlap-pkg', rejectedInstances: ['overlap-pkg@1.0.0 (denied)'] },
  ])
})

test('verifyTrustedBuilds passes on Bun 1.4.5 verbatim zero-untrusted output', () => {
  const zeroUntrusted = `bun pm untrusted v1.4.5-canary.1 (4ce14ba8b)

Found 0 untrusted dependencies with scripts.

This means all packages with scripts are in "trustedDependencies" or none of your dependencies have scripts.

For more information, visit https://bun.com/docs/install/lifecycle#trusteddependencies
`
  const result = verifyTrustedBuilds({
    untrustedOutput: zeroUntrusted,
    workspaceYaml: sampleWorkspaceYaml,
    packageJsonText: samplePackageJson,
    bunLockText: sampleBunLock,
  })
  assert.equal(result.ok, true)
  assert.equal(result.blockedCount, 0)
})

test('verifyTrustedBuilds accepts an explicitly denied local tarball with parent path and spaces', () => {
  const tgzWorkspaceYaml = `allowBuilds:
  'probe-tgz@file:../spacing probe.tgz': false
`
  const tgzBunLock = `{
  "lockfileVersion": 2,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "probe-tgz": "file:../spacing probe.tgz",
      },
    },
  },
  "packages": {
    "probe-tgz": ["probe-tgz@../spacing probe.tgz", { "hasInstallScript": true }, "sha512-95mRhzgZpdHEj4o1cIAmJcTLChkeErrU+MMWKrNfUF7vjciynEtQEYI/CV/fkjzak+lxZvO/EmbXsBris4RKTA=="],
  },
}
`
  const tgzUntrusted = `bun pm untrusted v1.4.5-canary.1 (4ce14ba8b)

./node_modules/.bun/probe-tgz@..+spacing probe.tgz+f79991873819a5d1/node_modules/probe-tgz @../spacing probe.tgz
 » [postinstall]: echo hi

These dependencies had their lifecycle scripts blocked during install.

If you trust them and wish to run their scripts, use \`bun pm trust\`.
`
  const denied = verifyTrustedBuilds({
    untrustedOutput: tgzUntrusted,
    workspaceYaml: tgzWorkspaceYaml,
    packageJsonText: JSON.stringify({ name: 'app', trustedDependencies: [] }),
    bunLockText: tgzBunLock,
  })
  assert.equal(denied.ok, true)
  assert.equal(denied.blockedCount, 1)

  const unreviewed = verifyTrustedBuilds({
    untrustedOutput: tgzUntrusted,
    workspaceYaml: 'allowBuilds:\n',
    packageJsonText: JSON.stringify({ name: 'app', trustedDependencies: [] }),
    bunLockText: tgzBunLock,
  })
  assert.equal(unreviewed.ok, false)
  assert.deepEqual(unreviewed.unreviewedBlocked, ['probe-tgz@file:../spacing probe.tgz'])
})

test('verifyTrustedBuilds passes when pre-install trust and post-install blocked scripts match allowBuilds', () => {
  const pre = verifyPreInstallTrustedBuilds({
    workspaceYaml: sampleWorkspaceYaml,
    packageJsonText: samplePackageJson,
    bunLockText: sampleBunLock,
  })
  assert.equal(pre.ok, true)

  const post = verifyTrustedBuilds({
    untrustedOutput: sampleUntrusted,
    workspaceYaml: sampleWorkspaceYaml,
    packageJsonText: samplePackageJson,
    bunLockText: sampleBunLock,
  })
  assert.equal(post.ok, true)
  assert.equal(post.blockedCount, 3)
  assert.equal(post.trustedCount, 2)
})

test('verifyPreInstallTrustedBuilds rejects omitted or invalid trustedDependencies before install', () => {
  const omitted = verifyPreInstallTrustedBuilds({
    workspaceYaml: sampleWorkspaceYaml,
    packageJsonText: JSON.stringify({ name: 'root' }),
    bunLockText: sampleBunLock,
  })
  assert.equal(omitted.ok, false)
  assert.match(formatTrustedBuildsReport(omitted), /must explicitly declare "trustedDependencies"/)

  const invalid = verifyPreInstallTrustedBuilds({
    workspaceYaml: sampleWorkspaceYaml,
    packageJsonText: JSON.stringify({ name: 'root', trustedDependencies: 'esbuild' }),
    bunLockText: sampleBunLock,
  })
  assert.equal(invalid.ok, false)
  assert.match(formatTrustedBuildsReport(invalid), /must be an array/)
})

test('verifyPreInstallTrustedBuilds does not widen a qualified allowBuilds approval across multiple resolved instances', () => {
  const dualPolicy = `allowBuilds:
  'dup-pkg@file:./good': true
  'dup-pkg@file:./bad': false
`
  const dualLock = `{
    "lockfileVersion": 3,
    "packages": {
      "dup-pkg": ["dup-pkg@file:good", {}],
      "ws-b/dup-pkg": ["dup-pkg@file:bad", {}],
    },
  }`
  const manifest = JSON.stringify({ name: 'root', trustedDependencies: ['dup-pkg'] })

  const result = verifyPreInstallTrustedBuilds({
    workspaceYaml: dualPolicy,
    packageJsonText: manifest,
    bunLockText: dualLock,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.widenedQualifiedTrusted, [
    { trustedSpec: 'dup-pkg', rejectedInstances: ['dup-pkg@file:bad (denied)'] },
  ])
  assert.match(formatTrustedBuildsReport(result), /dup-pkg@file:bad \(denied\)/)
})

test('verifyPreInstallTrustedBuilds rejects a qualified local approval if bun.lock resolves a different source', () => {
  const alteredLock = sampleBunLock.replace(
    '@deepseek-ai/dsh-subprocess-local@workspace:packages/subprocess/subprocess-local',
    '@deepseek-ai/dsh-subprocess-local@file:vendor/unapproved-copy',
  )
  const result = verifyPreInstallTrustedBuilds({
    workspaceYaml: sampleWorkspaceYaml,
    packageJsonText: samplePackageJson,
    bunLockText: alteredLock,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.widenedQualifiedTrusted, [
    {
      trustedSpec: '@deepseek-ai/dsh-subprocess-local',
      rejectedInstances: ['@deepseek-ai/dsh-subprocess-local@file:vendor/unapproved-copy (unreviewed)'],
    },
  ])
})

test('verifyTrustedBuilds catches unreviewed local package whose source path contains spaces alongside a denied package', () => {
  const dualUntrusted = `bun pm untrusted v1.4.5-canary.1 (4ce14ba8b)

./node_modules/.bun/protobufjs@7.6.5/node_modules/protobufjs @7.6.5
 » [postinstall]: node scripts/postinstall

./node_modules/.bun/pkg-a@file+dir with space+pkg-a/node_modules/pkg-a @dir with space/pkg-a
 » [postinstall]: echo a

These dependencies had their lifecycle scripts blocked during install.

If you trust them and wish to run their scripts, use \`bun pm trust\`.
`
  const result = verifyTrustedBuilds({
    untrustedOutput: dualUntrusted,
    workspaceYaml: sampleWorkspaceYaml,
    packageJsonText: samplePackageJson,
    bunLockText: sampleBunLock,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.unreviewedBlocked, ['pkg-a@file:dir with space/pkg-a'])
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
    bunLockText: sampleBunLock,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.unreviewedBlocked, ['@larksuite/cli@1.0.98', 'new-native-pkg@2.0.0'])
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
    bunLockText: sampleBunLock,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.allowedButBlocked, ['esbuild@0.28.2'])
  assert.deepEqual(result.unapprovedTrusted, ['unapproved-pkg'])
})

test('parseBunUntrustedOutput fails loud on any unrecognized package record line', () => {
  const partiallyMalformed = `bun pm untrusted v1.4.5-canary.1 (4ce14ba8b)

./node_modules/.bun/protobufjs@7.6.5/node_modules/protobufjs @7.6.5
 » [postinstall]: node scripts/postinstall

weird-unrecognized-package-entry without-at-qualifier
 » [postinstall]: echo bad
`
  assert.throws(
    () => parseBunUntrustedOutput(partiallyMalformed),
    /Unrecognized line in `bun pm untrusted` output/,
  )
})
