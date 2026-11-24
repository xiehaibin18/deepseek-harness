/** Match the real Bun child's inherited socket against the Node parent's stream contract. */

import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { Socket } from 'node:net'
import { finished } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
import { SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_FD } from '../src/control.ts'

const bun = process.env.DSH_TEST_BUN_EXECUTABLE
const control = new URL('../src/control.ts', import.meta.url).href

async function withBunChannel(program: string, exchange: (
  child: ChildProcess, channel: Socket, signal: AbortSignal,
) => Promise<void>): Promise<void> {
  const signal = AbortSignal.timeout(8_000)
  const child = spawn(bun ?? 'bun', ['--no-env-file', '--no-install', '-e',
    'import { openInheritedControlChannel } from ' + JSON.stringify(control) + ';\n'
    + 'const channel = openInheritedControlChannel();\n'
    + program,
  ], {
    env: { [SUBPROCESS_CONTROL_ENV]: 'pipe' },
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'pipe'],
    signal,
    killSignal: 'SIGKILL',
  })
  let diagnostic = ''
  child.stderr?.on('data', (chunk: Buffer) => { diagnostic += chunk.toString() })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('exit', (code, exitSignal) => { resolve({ code, signal: exitSignal }) })
    child.once('error', reject)
  })
  void exited.catch(() => { /* The exchange or its cleanup awaits the same process. */ })
  const closed = new Promise<void>((resolve) => { child.once('close', resolve) })
  const channel = child.stdio.at(SUBPROCESS_CONTROL_FD)
  try {
    if (!(channel instanceof Socket)) throw new Error('Expected a connected control socket')
    channel.allowHalfOpen = true
    await exchange(child, channel, signal)
    const result = await exited
    expect(result.signal, diagnostic).toBeNull()
    expect(result.code, diagnostic).toBe(0)
  } finally {
    if (channel instanceof Socket) channel.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
    await exited.catch(() => { /* A preceding failure owns the diagnostic. */ })
  }
}

describe.skipIf(process.platform !== 'darwin' || bun === undefined)('Bun inherited control channel on macOS', () => {
  it('drains queued binary data after peer half-close and sends EOF back', async () => {
    await withBunChannel(
      [
        'const incoming = [];',
        'channel.on("data", chunk => incoming.push(chunk));',
        'channel.once("end", () => {',
        '  const writable = channel.write(Buffer.concat(incoming));',
        '  process.stdout.write(writable ? "unbuffered" : "backpressured");',
        '  channel.end();',
        '});',
      ].join('\n'),
      async (child, channel, signal) => {
        if (child.stdout === null) throw new Error('Expected child stdout')
        const payload = Buffer.alloc(2 * 1024 * 1024)
        for (let index = 0; index < payload.length; index += 4) payload.writeUInt32BE(index, index)
        const received: Buffer[] = []
        channel.pause()
        channel.on('data', (chunk: Buffer) => { received.push(chunk) })
        const draining = finished(channel, { signal, cleanup: true })
        void draining.catch(() => { /* The exchange or its cleanup awaits the same stream. */ })
        const queued = once(child.stdout, 'data', { signal })
        try {
          channel.end(payload)
          expect(String((await queued)[0])).toBe('backpressured')
          channel.resume()
          await draining
          expect(Buffer.concat(received).equals(payload)).toBe(true)
        } finally {
          channel.destroy()
          await draining.catch(() => { /* A preceding failure owns the diagnostic. */ })
        }
      },
    )
  }, 10_000)

  it('receives after its own half-close and releases an outstanding read on destroy', async () => {
    await withBunChannel(
      [
        'import { fstatSync } from "node:fs";',
        'channel.once("close", () => {',
        '  try { fstatSync(7); } catch (error) { if (error.code === "EBADF") return; throw error; }',
        '  throw new Error("Control descriptor stayed open");',
        '});',
        'channel.once("data", chunk => {',
        '  if (chunk.toString() !== "after EOF") throw new Error("Unexpected control bytes");',
        '  setImmediate(() => { channel.read(0); channel.destroy(); });',
        '});',
        'channel.end("ready");',
      ].join('\n'),
      async (_child, channel, signal) => {
        const received: Buffer[] = []
        channel.on('data', (chunk: Buffer) => { received.push(chunk) })
        await once(channel, 'end', { signal })
        expect(Buffer.concat(received).toString()).toBe('ready')
        await new Promise<void>((resolve, reject) => {
          channel.write('after EOF', (error) => { if (error) reject(error); else resolve() })
        })
      },
    )
  }, 10_000)
})
