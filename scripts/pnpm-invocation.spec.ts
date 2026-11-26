import { describe, expect, it } from 'vitest'
import { pnpmInvocation, workspaceRunnerInvocation } from './pnpm-invocation.ts'

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
  ])('translates pnpm exec and filter syntax for Bun entrypoint %j', (entrypoint) => {
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
      args: ['run', '--filter', '@deepseek-ai/dsh-desktop', 'install-electron'],
    })
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
