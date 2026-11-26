import assert from 'node:assert/strict'
import test from 'node:test'
import { ptc, selectScopes, web } from './scope.mjs'

test('a PTC implementation or dependency update does not build the Web application', () => {
  assert.deepEqual(selectScopes(['packages/ptc-runtime/ptc-runtime-node/src/launch.ts', 'pnpm-lock.yaml']), ['ptc'])
  assert.deepEqual(selectScopes(['packages/workflow/workflow-ptc/tests/built-runtime.e2e.ts']), ['ptc'])
  for (const app of ['apps/cli', 'apps/web', 'apps/desktop']) assert.ok(![...ptc.values()].includes(app))
})

test('Web inputs, shared inputs, and mixed changes select the corresponding checks', () => {
  for (const path of ['apps/cli/src/bin.ts', 'apps/web/src/main.ts', 'packages/host/webserver/src/index.ts',
    'packages/client/store/src/index.ts', 'packages/client/tsdown.client.ts']) {
    assert.deepEqual(selectScopes([path]), ['web'])
  }
  for (const paths of [['apps/web/src/main.ts', 'packages/ptc-runtime/ptc-runtime/src/index.ts'],
    ['packages/core/session/src/index.ts'], ['native/system/package.json'], ['pnpm-lock.yaml'], ['bun.lock'], ['bunfig.toml'], ['tsconfig.base.json']]) {
    assert.deepEqual(selectScopes(paths), ['ptc', 'web'])
  }
  assert.ok([...web.values()].includes('apps/cli') && [...web.values()].includes('apps/web'))
  assert.ok(![...web.values()].includes('apps/desktop'))
})

test('documentation and unrelated applications leave the macOS runner idle', () => {
  assert.deepEqual(selectScopes(['docs/development.md', 'packages/ptc-runtime/ptc-runtime-node/README.zh.md',
    'apps/desktop/src/main.ts', 'python/sdk/pyproject.toml']), [])
})
