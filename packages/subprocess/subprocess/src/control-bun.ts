/** Adapt a Darwin socket inherited by a Bun subprocess into a byte stream. */

import { close, fstatSync, read, write } from 'node:fs'
import { createRequire } from 'node:module'
import { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const readBytes = promisify(read)
const writeBytes = promisify(write)
const closeFd = promisify(close)
const SHUT_WR = 1
const SHUT_RDWR = 2
const READ_CHUNK_BYTES = 64 * 1024
const RETRY_MS = 5

interface BunFfi {
  dlopen(path: string, definitions: {
    shutdown: { args: ['i32', 'i32']; returns: 'i32' }
  }): {
    symbols: { shutdown(fd: number, direction: number): number }
    close(): void
  }
}

async function retrySocketIo<T>(perform: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (;;) {
    signal.throwIfAborted()
    try {
      return await perform()
    } catch (error) {
      if (!(error instanceof Error && 'code' in error
        && (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK'))) throw error
      await delay(RETRY_MS, undefined, { signal })
    }
  }
}

function streamError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Adopt the Darwin socket using file-descriptor I/O and native half-close.
 * @param fd - Connected socket owned by the child.
 * @returns A duplex that closes the descriptor once its outstanding I/O has settled.
 */
export function openBunControlSocket(fd: number): Duplex {
  if (!fstatSync(fd).isSocket()) throw new Error('Bun control channel requires an inherited socket')
  const ffi = createRequire(import.meta.url)('bun:ffi') as BunFfi
  const library = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
    shutdown: { args: ['i32', 'i32'], returns: 'i32' },
  })
  const stopping = new AbortController()
  let reading: ReturnType<typeof readBytes> | undefined
  let writing: Promise<void> | undefined

  const stream = new Duplex({
    allowHalfOpen: true,
    read(size) {
      const chunk = Buffer.allocUnsafe(Math.min(size, READ_CHUNK_BYTES))
      reading = retrySocketIo(() => readBytes(fd, chunk, 0, chunk.length, null), stopping.signal)
      void reading.then(({ bytesRead }) => {
        reading = undefined
        if (!stream.destroyed) stream.push(bytesRead === 0 ? null : chunk.subarray(0, bytesRead))
      }, (error: unknown) => {
        reading = undefined
        if (!stream.destroyed) stream.destroy(streamError(error))
      })
    },
    write(chunk: Buffer, _encoding, callback) {
      writing = writeChunk(chunk)
      void writing.then(() => {
        writing = undefined
        callback()
      }, (error: unknown) => {
        writing = undefined
        callback(streamError(error))
      })
    },
    final(callback) {
      const result = library.symbols.shutdown(fd, SHUT_WR)
      callback(result === 0 ? undefined : new Error('Failed to shut down Bun control channel writes'))
    },
    destroy(error, callback) {
      stopping.abort()
      // Wake blocking syscalls before closing the descriptor so they cannot race its reuse.
      library.symbols.shutdown(fd, SHUT_RDWR)
      void Promise.allSettled([reading, writing]).then(() => closeFd(fd)).then(() => {
        library.close()
        callback(error)
      }, (closeError: unknown) => {
        library.close()
        callback(error ?? streamError(closeError))
      })
    },
  })
  return stream

  async function writeChunk(chunk: Buffer): Promise<void> {
    let offset = 0
    while (offset < chunk.length) {
      const { bytesWritten } = await retrySocketIo(
        () => writeBytes(fd, chunk, offset, chunk.length - offset, null), stopping.signal,
      )
      if (bytesWritten === 0) throw new Error('Bun control channel write made no progress')
      offset += bytesWritten
    }
  }
}
