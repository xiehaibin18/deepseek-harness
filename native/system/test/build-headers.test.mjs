import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NODE_API_HEADERS_ENV, resolveNodeApiHeadersDir } from '../scripts/build.ts';

function createHeaderDir(t, prefix, includeHeader) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (includeHeader) fs.writeFileSync(path.join(dir, 'node_api.h'), '/* stub */\n');
  return dir;
}

test('prefers an explicit DSH_NODE_API_HEADERS override when node_api.h exists', (t) => {
  const overrideDir = createHeaderDir(t, 'dsh-napi-override-', true);
  const runtimeRoot = createHeaderDir(t, 'dsh-napi-runtime-', false);
  fs.mkdirSync(path.join(runtimeRoot, 'include/node'), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'include/node/node_api.h'), '/* runtime */\n');

  assert.equal(resolveNodeApiHeadersDir({
    env: { [NODE_API_HEADERS_ENV]: overrideDir },
    execPath: path.join(runtimeRoot, 'bin/node'),
    resolvePackageHeader: () => undefined,
  }), overrideDir);
});

for (const value of ['', '   ']) {
  test(`rejects an empty DSH_NODE_API_HEADERS override ${JSON.stringify(value)}`, () => {
    assert.throws(() => resolveNodeApiHeadersDir({
      env: { [NODE_API_HEADERS_ENV]: value },
      execPath: '/missing/bin/bun',
      resolvePackageHeader: () => undefined,
    }), new RegExp(`${NODE_API_HEADERS_ENV} is set but empty`));
  });
}

test('fails loudly when DSH_NODE_API_HEADERS does not contain node_api.h', (t) => {
  const emptyDir = createHeaderDir(t, 'dsh-napi-missing-', false);
  assert.throws(() => resolveNodeApiHeadersDir({
    env: { [NODE_API_HEADERS_ENV]: emptyDir },
    execPath: '/missing/bin/bun',
    resolvePackageHeader: () => undefined,
  }), new RegExp(`${NODE_API_HEADERS_ENV} points to .*, but node_api\\.h is missing`));
});

test('uses runtime-adjacent Node headers before falling back to node-api-headers', (t) => {
  const runtimeRoot = createHeaderDir(t, 'dsh-napi-node-', false);
  const nodeInclude = path.join(runtimeRoot, 'include/node');
  fs.mkdirSync(nodeInclude, { recursive: true });
  fs.writeFileSync(path.join(nodeInclude, 'node_api.h'), '/* runtime */\n');
  const packageDir = createHeaderDir(t, 'dsh-napi-pkg-', true);

  assert.equal(resolveNodeApiHeadersDir({
    env: {},
    execPath: path.join(runtimeRoot, 'bin/node'),
    resolvePackageHeader: () => path.join(packageDir, 'node_api.h'),
  }), nodeInclude);
});

test('falls back to node-api-headers when the running binary ships no Node headers', (t) => {
  const bunRoot = createHeaderDir(t, 'dsh-napi-bun-', false);
  const packageDir = createHeaderDir(t, 'dsh-napi-pkg-', true);

  assert.equal(resolveNodeApiHeadersDir({
    env: {},
    execPath: path.join(bunRoot, 'bin/bun'),
    resolvePackageHeader: () => path.join(packageDir, 'node_api.h'),
  }), packageDir);
});

test('resolves the installed node-api-headers package by default when execPath has no Node headers', (t) => {
  const bunRoot = createHeaderDir(t, 'dsh-napi-default-pkg-', false);
  const resolved = resolveNodeApiHeadersDir({
    env: {},
    execPath: path.join(bunRoot, 'bin/bun'),
  });
  assert.equal(fs.existsSync(path.join(resolved, 'node_api.h')), true);
});

test('throws an actionable error when neither runtime headers nor node-api-headers are available', (t) => {
  const bunRoot = createHeaderDir(t, 'dsh-napi-none-', false);
  assert.throws(() => resolveNodeApiHeadersDir({
    env: {},
    execPath: path.join(bunRoot, 'bin/bun'),
    resolvePackageHeader: () => undefined,
  }), /Node-API headers missing/);
});
