import { afterEach, describe, expect, it, vi } from 'vitest'

const socket = vi.hoisted(() => vi.fn(function () { return {} }))
const bunSocket = vi.hoisted(() => vi.fn(() => ({})))
vi.mock('node:net', () => ({ Socket: socket }))
vi.mock('../src/control-bun.ts', () => ({ openBunControlSocket: bunSocket }))

import { openInheritedControlChannel, SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_FD } from '../src/control.ts'

const usesDarwinBunSocket = process.platform === 'darwin' && process.versions.bun !== undefined

afterEach(() => {
  vi.unstubAllEnvs()
  socket.mockClear()
  bunSocket.mockClear()
})

describe('inherited control channel', () => {
  it('consumes the provider marker and opens a duplex descriptor before allowing another open', () => {
    vi.stubEnv(SUBPROCESS_CONTROL_ENV, 'pipe')
    openInheritedControlChannel()
    if (usesDarwinBunSocket) {
      expect(bunSocket).toHaveBeenCalledExactlyOnceWith(SUBPROCESS_CONTROL_FD)
      expect(socket).not.toHaveBeenCalled()
    } else {
      expect(socket).toHaveBeenCalledExactlyOnceWith({ fd: SUBPROCESS_CONTROL_FD, readable: true, writable: true, allowHalfOpen: true })
      expect(bunSocket).not.toHaveBeenCalled()
    }
    expect(process.env[SUBPROCESS_CONTROL_ENV]).toBeUndefined()
    expect(() => openInheritedControlChannel()).toThrow('not inherited')
    if (usesDarwinBunSocket) expect(bunSocket).toHaveBeenCalledOnce()
    else expect(socket).toHaveBeenCalledOnce()
  })

  it.each([undefined, 'invalid'])('rejects an absent or invalid launch marker: %s', (marker) => {
    vi.stubEnv(SUBPROCESS_CONTROL_ENV, marker)
    expect(() => openInheritedControlChannel()).toThrow('not inherited')
    expect(process.env[SUBPROCESS_CONTROL_ENV]).toBeUndefined()
    expect(socket).not.toHaveBeenCalled()
    expect(bunSocket).not.toHaveBeenCalled()
  })
})
