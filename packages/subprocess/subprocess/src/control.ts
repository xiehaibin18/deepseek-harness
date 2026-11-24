/** Inherited byte-channel protocol shared by subprocess launchers and their children. */

import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { openBunControlSocket } from './control-bun.ts'

/** Child descriptor reserved for the optional subprocess control channel. */
export const SUBPROCESS_CONTROL_FD = 7

/** Private launch marker consumed before a child executes application code. */
export const SUBPROCESS_CONTROL_ENV = 'DSH_SUBPROCESS_CONTROL' as const

/**
 * Consume the launch marker and open the inherited control pipe at fd 7.
 * The returned stream owns the descriptor. Call once before executing untrusted code;
 * messages remain untrusted even though the endpoint was inherited.
 * @returns a connected byte-mode duplex stream owned by the caller.
 * @throws when the marker is missing/invalid or the inherited descriptor cannot be opened.
 */
export function openInheritedControlChannel(): Duplex {
  const marker = process.env[SUBPROCESS_CONTROL_ENV]
  Reflect.deleteProperty(process.env, SUBPROCESS_CONTROL_ENV)
  if (marker !== 'pipe') throw new Error('subprocess control channel was not inherited')
  if (process.platform === 'darwin' && process.versions.bun !== undefined) return openBunControlSocket(SUBPROCESS_CONTROL_FD)
  return new Socket({ fd: SUBPROCESS_CONTROL_FD, readable: true, writable: true, allowHalfOpen: true })
}
