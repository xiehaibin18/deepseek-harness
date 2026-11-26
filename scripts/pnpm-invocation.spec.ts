import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { pnpmInvocation, workspaceRunnerInvocation } from './pnpm-invocation.ts'

const repoRoot = resolve(import.meta.dirname, '..')
const bunExecutable = process.env.DSH_TEST_BUN_EXECUTABLE

describe('pnpm invocation', () => {
  it.each([
    '/tools/pnpm.js',
    '/tools/pnpm.cjs',
    '/tools/pnpm.mjs',
    '/tools/PNPM.CJS',
    '/tools/with spaces/工具/$pnpm;.mjs',
  ])('runs the JavaScript entrypoint %j through Node', (entrypoint) => {
    expect(pnpmInvocation(['run', 'build'], { npm_execpath: entrypoint })).toEqual({
      command: process.execPath,
      args: [entrypoint, 'run', 'build'],
    })
  })

  it.each([
    '/tools/pnpm',
    '/tools/with spaces/$pnpm;',
    String.raw`C:\Program Files\工具\$pnpm;\pnpm.exe`,
  ])('runs the executable entrypoint %j directly', (entrypoint) => {
    expect(pnpmInvocation(['run', 'build'], { npm_execpath: entrypoint })).toEqual({
      command: entrypoint,
      args: ['run', 'build'],
    })
  })

  it.each([
    '/Users/herbin/.bun/bin/bun',
    String.raw`C:\Users\dev\.bun\bin\bun.exe`,
  ])('keeps workspace run and exec semantics distinct for Bun entrypoint %j', (entrypoint) => {
    expect(pnpmInvocation(['run', 'build:web'], { npm_execpath: entrypoint })).toEqual({
      command: entrypoint,
      args: ['run', 'build:web'],
    })
    expect(pnpmInvocation(['exec', 'tsdown', '--config-loader', 'native'], { npm_execpath: entrypoint })).toEqual({
      command: entrypoint,
      args: ['run', 'tsdown', '--config-loader', 'native'],
    })
    expect(pnpmInvocation(['--filter', '@deepseek-ai/dsh-desktop', 'run', 'bundle'], { npm_execpath: entrypoint })).toEqual({
      command: entrypoint,
      args: ['run', '--filter', '@deepseek-ai/dsh-desktop', 'bundle'],
    })
    expect(pnpmInvocation(['--filter', '@deepseek-ai/dsh-desktop', 'exec', 'install-electron'], { npm_execpath: entrypoint })).toEqual({
      command: entrypoint,
      args: ['run', '--cwd', resolve(repoRoot, 'apps/desktop'), 'install-electron'],
    })
  })

  it('rejects an unknown workspace name when translating Bun workspace exec', () => {
    expect(() => pnpmInvocation(['--filter', '@deepseek-ai/nonexistent-ws', 'exec', 'tool'], {
      npm_execpath: '/Users/herbin/.bun/bin/bun',
    })).toThrow('cannot resolve workspace "@deepseek-ai/nonexistent-ws"')
  })

  it.skipIf(!bunExecutable || process.platform === 'win32')('executes a workspace dependency binary under real Bun', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pnpm-inv-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const wsDir = join(root, 'apps/probe-ws')
    const binDir = join(wsDir, 'node_modules/.bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', private: true, workspaces: ['apps/*'] }))
    writeFileSync(join(wsDir, 'package.json'), JSON.stringify({ name: '@probe/ws', version: '1.0.0' }))
    const binPath = join(binDir, 'probe-bin')
    writeFileSync(binPath, '#!/bin/sh\necho "probe-bin:$*"\n')
    chmodSync(binPath, 0o755)

    const invocation = pnpmInvocation(
      ['--filter', '@probe/ws', 'exec', 'probe-bin', '--version'],
      { npm_execpath: bunExecutable },
      root,
    )
    const result = spawnSync(invocation.command, invocation.args, { cwd: root, encoding: 'utf8' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('probe-bin:--version')
  })

  it.skipIf(!bunExecutable || process.platform === 'win32')('runs root build:web through Bun without invoking pnpm', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-build-web-bun-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const webDir = join(root, 'apps/web')
    mkdirSync(webDir, { recursive: true })
    const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const buildWebScript = rootManifest.scripts['build:web']?.replace(
      'scripts/workspace-run.ts',
      resolve(repoRoot, 'scripts/workspace-run.ts'),
    )
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'root',
      private: true,
      workspaces: ['apps/*'],
      scripts: { 'build:web': buildWebScript },
    }))
    writeFileSync(join(webDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-web-frontend',
      version: '1.0.0',
      scripts: { build: 'node -e "console.log(\'runner:\' + process.env.npm_execpath)"' },
    }))

    const standaloneEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== 'npm_execpath' && !key.startsWith('npm_lifecycle_')),
    )
    const result = spawnSync(bunExecutable, ['run', 'build:web'], { cwd: root, env: standaloneEnv, encoding: 'utf8' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain(`runner:${bunExecutable}`)
    expect(existsSync(join(root, 'node_modules/.pnpm'))).toBe(false)
  })

  it.each([undefined, ''])('rejects an unavailable lifecycle entrypoint', (entrypoint) => {
    expect(() => pnpmInvocation([], { npm_execpath: entrypoint }))
      .toThrow('npm_execpath is unavailable; invoke the script through pnpm run')
  })
})

describe('workspace runner invocation', () => {
  it('selects Bun when npm_execpath points to bun', () => {
    expect(workspaceRunnerInvocation(['--filter', '@deepseek-ai/dsh-desktop', 'run', 'bundle'], {
      npm_execpath: '/Users/herbin/.bun/bin/bun',
    })).toEqual({
      command: '/Users/herbin/.bun/bin/bun',
      args: ['run', '--filter', '@deepseek-ai/dsh-desktop', 'bundle'],
      displayCommand: 'bun run --filter @deepseek-ai/dsh-desktop bundle',
    })
  })

  it('preserves pnpm entrypoints when npm_execpath points to pnpm', () => {
    expect(workspaceRunnerInvocation(['exec', 'tsdown', '--env.DSH_BUILD_FACE', 'host'], {
      npm_execpath: '/tools/pnpm/bin/pnpm.cjs',
    })).toEqual({
      command: process.execPath,
      args: ['/tools/pnpm/bin/pnpm.cjs', 'exec', 'tsdown', '--env.DSH_BUILD_FACE', 'host'],
      displayCommand: 'pnpm exec tsdown --env.DSH_BUILD_FACE host',
    })
  })
})
