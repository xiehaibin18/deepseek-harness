import { expect, it } from 'vitest'
import { bootstrapArgs, EMBEDDED_PTC_RUNTIME_SYMBOL, isEmbeddedPtcRuntime, resolveLaunch } from '../src/launch.ts'

const unmapped = { processPathFromHostPath: () => undefined }
const noMapping = { processPathFromHostPath: () => { throw new Error('must not map a remote worker') } }

it('uses an explicit installed bootstrap without pretending it maps the host file', () => {
  expect(bootstrapArgs(noMapping, { kind: 'node-script', executable: '/remote/node', bootstrapPath: '/remote/process.js' }, 2048))
    .toEqual(['--experimental-vm-modules', '/remote/process.js', '2048'])
})

it('fails when the execution world cannot read the source bootstrap', () => {
  expect(() => bootstrapArgs(unmapped, { kind: 'node-script', executable: process.execPath }, 2048))
    .toThrow('unavailable in the subprocess execution world')
})

it('uses a remote embedded worker when the client runs ordinary Node', () => {
  const launch = resolveLaunch({ kind: 'embedded', executable: '/remote/dsh-ssh-helper' })
  expect(launch).toEqual({ kind: 'embedded', executable: '/remote/dsh-ssh-helper' })
  expect(bootstrapArgs(noMapping, launch, 2048)).toEqual(['2048'])
})

it('resolves the local carrier once while preserving an explicit remote script choice', () => {
  const prior = Object.getOwnPropertyDescriptor(process, 'pkg')
  try {
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    expect(resolveLaunch()).toEqual({ kind: 'embedded', executable: process.execPath })
    const remote = resolveLaunch({ kind: 'node-script', executable: '/remote/node', bootstrapPath: '/remote/process.js' })
    expect(bootstrapArgs(noMapping, remote, 2048)).toEqual(['--experimental-vm-modules', '/remote/process.js', '2048'])
  } finally {
    if (prior === undefined) Reflect.deleteProperty(process, 'pkg')
    else Object.defineProperty(process, 'pkg', prior)
  }
  const expectedKind = process.versions.bun !== undefined ? 'bun-script' : 'node-script'
  expect(resolveLaunch()).toEqual({ kind: expectedKind, executable: process.execPath })
})

it('selects the embedded carrier when the Bun AOT runtime symbol is set', () => {
  const prior: unknown = Reflect.get(globalThis, EMBEDDED_PTC_RUNTIME_SYMBOL)
  try {
    Reflect.set(globalThis, EMBEDDED_PTC_RUNTIME_SYMBOL, true)
    expect(isEmbeddedPtcRuntime()).toBe(true)
    expect(resolveLaunch()).toEqual({ kind: 'embedded', executable: process.execPath })
    expect(bootstrapArgs(noMapping, resolveLaunch(), 2048)).toEqual(['2048'])
  } finally {
    if (prior === undefined) Reflect.deleteProperty(globalThis, EMBEDDED_PTC_RUNTIME_SYMBOL)
    else Reflect.set(globalThis, EMBEDDED_PTC_RUNTIME_SYMBOL, prior)
  }
  expect(isEmbeddedPtcRuntime()).toBe(false)
})

it('selects embedded and script bootstrap arguments', () => {
  expect(bootstrapArgs(noMapping, { kind: 'embedded', executable: '/remote/helper' }, 2048))
    .toEqual(['2048'])
  expect(bootstrapArgs(noMapping, { kind: 'node-script', executable: '/remote/node', bootstrapPath: '/remote/persistent-process.js' }, 2048))
    .toEqual(['--experimental-vm-modules', '/remote/persistent-process.js', '2048'])
})
