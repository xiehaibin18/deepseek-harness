/**
 * Build this host's declared system binaries. Landlock is a static musl
 * executable; flock uses stable Node-API with separate Linux libc builds.
 * Node-API headers resolve from DSH_NODE_API_HEADERS, the running Node
 * installation, or the bundled node-api-headers package.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** Environment variable naming an explicit directory containing `node_api.h`. */
export const NODE_API_HEADERS_ENV = 'DSH_NODE_API_HEADERS'

/** Inputs controlling how Node-API header lookup resolves `node_api.h`. */
export interface NodeApiHeadersResolutionOptions {
  /** Environment variables inspected for `DSH_NODE_API_HEADERS`. */
  env?: Readonly<Record<string, string | undefined>>
  /** Executable path whose sibling `../include/node` directory is probed first. */
  execPath?: string
  /** Optional resolver returning the path to `node-api-headers/include/node_api.h`. */
  resolvePackageHeader?: () => string | undefined
}

const requireFromScript = createRequire(import.meta.url)

function defaultResolvePackageHeader(): string | undefined {
  try {
    return requireFromScript.resolve('node-api-headers/include/node_api.h')
  } catch (error) {
    // Package fallback is optional when running under Node with local headers or DSH_NODE_API_HEADERS.
    void error
    return undefined
  }
}

/**
 * Resolve the include directory containing `node_api.h` for building Node-API addons.
 * Checks `DSH_NODE_API_HEADERS` first (failing loudly on invalid overrides), then the
 * running executable's sibling `../include/node`, and finally the `node-api-headers` package.
 * @param options - Optional environment, executable path, and package-header resolver overrides.
 * @returns Absolute path to a directory containing `node_api.h`.
 * @throws When an explicit override is invalid or no candidate directory contains `node_api.h`.
 */
export function resolveNodeApiHeadersDir(options: NodeApiHeadersResolutionOptions = {}): string {
  const env = options.env ?? process.env
  const execPath = options.execPath ?? process.execPath
  const override = env[NODE_API_HEADERS_ENV]
  if (override !== undefined) {
    const trimmed = override.trim()
    if (trimmed === '') {
      throw new Error(`build: ${NODE_API_HEADERS_ENV} is set but empty; provide a directory containing node_api.h`)
    }
    const candidate = resolve(trimmed)
    if (!existsSync(join(candidate, 'node_api.h'))) {
      throw new Error(`build: ${NODE_API_HEADERS_ENV} points to ${candidate}, but node_api.h is missing`)
    }
    return candidate
  }

  const runtimeHeaders = resolve(dirname(execPath), '../include/node')
  if (existsSync(join(runtimeHeaders, 'node_api.h'))) return runtimeHeaders

  const resolvePackageHeader = options.resolvePackageHeader ?? defaultResolvePackageHeader
  const packageHeader = resolvePackageHeader()
  if (packageHeader !== undefined && existsSync(packageHeader)) {
    const packageHeadersDir = dirname(packageHeader)
    if (existsSync(join(packageHeadersDir, 'node_api.h'))) return packageHeadersDir
  }

  throw new Error(
    `build: Node-API headers missing at ${runtimeHeaders}; install node-api-headers, set ${NODE_API_HEADERS_ENV}, or use a Node installation with development headers`,
  )
}

interface Binary {
  tool: string
  kind: string
  path: string
  napi?: number
  libc?: string
}

const sources: Record<string, string> = {
  'landlock-run': 'packages/entry/src/main.c',
  flock: 'packages/entry/src/flock.c',
}

function isDirectEntrypoint(argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1 === '') return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url))
  } catch (error) {
    // Non-file argv entries (for example virtual eval names) cannot match this script file.
    void error
    return false
  }
}

function runBuild(): void {
  const root = resolve(import.meta.dirname, '..')
  const { values } = parseArgs({ options: { 'host-addon-only': { type: 'boolean' } }, allowPositionals: false })
  const hostAddonOnly = values['host-addon-only'] === true

  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    if (hostAddonOnly) process.exit(0)
    throw new Error('build: system binaries are built on Linux or macOS; no native target for this host')
  }
  const host = `${process.platform}-${process.arch}`
  const libc = process.platform === 'linux'
    ? ((process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime ? 'glibc' : 'musl')
    : undefined
  let resolvedHeaders: string | undefined
  let built = 0

  for (const name of readdirSync(join(root, 'packages')).sort()) {
    const dir = join(root, 'packages', name)
    const metadata = join(dir, 'prebuilds.json')
    if (!existsSync(metadata)) continue
    const spec = JSON.parse(readFileSync(metadata, 'utf8')) as { platform: string; binaries: Binary[] }
    if (spec.platform !== host) continue

    for (const binary of spec.binaries) {
      if (hostAddonOnly && (binary.kind !== 'node-api' || (binary.libc !== undefined && binary.libc !== libc))) continue
      const source = sources[binary.tool]
      if (source === undefined) throw new Error(`build: unknown tool ${binary.tool}`)
      const output = join(dir, binary.path)
      mkdirSync(dirname(output), { recursive: true })
      let compiler: string
      let flags: string[]

      if (binary.kind === 'static-musl' && process.platform === 'linux' && binary.tool === 'landlock-run') {
        compiler = 'musl-gcc'
        flags = ['-std=c11', '-Os', '-Wall', '-Wextra', '-Werror', '-static', '-s']
      } else if (binary.kind === 'node-api' && binary.tool === 'flock' && binary.napi === 8) {
        resolvedHeaders ??= resolveNodeApiHeadersDir()
        compiler = process.platform === 'linux' && binary.libc === 'musl' ? 'musl-gcc' : 'cc'
        flags = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-fvisibility=hidden', '-DNAPI_VERSION=8', '-I', resolvedHeaders]
        if (process.platform === 'darwin') {
          if (binary.libc !== undefined) throw new Error('build: macOS flock does not select a Linux libc')
          flags.push('-bundle', '-undefined', 'dynamic_lookup', '-mmacosx-version-min=11.0')
        } else {
          if (binary.libc !== 'glibc' && binary.libc !== 'musl') {
            throw new Error('build: Linux flock must select glibc or musl')
          }
          flags.push('-shared')
        }
      } else {
        throw new Error(`build: unsupported ${binary.tool}/${binary.kind} target on ${host}`)
      }

      mkdirSync(join(root, '.release'), { recursive: true })
      const temporary = mkdtempSync(join(root, '.release', 'native-build-'))
      try {
        const pending = join(temporary, basename(output))
        const result = spawnSync(compiler, [...flags, '-o', pending, join(root, source)], { stdio: 'inherit' })
        if (result.error) throw result.error
        if (result.status !== 0) throw new Error(`build: ${compiler} failed for ${binary.path}`)
        // Readers never see a truncated addon when source checks build concurrently.
        renameSync(pending, output)
      } finally {
        rmSync(temporary, { recursive: true, force: true })
      }
      console.log(`build: built ${basename(dir)}/${binary.path}`)
      built++
    }
  }
  if (built === 0) throw new Error(`build: no declared binaries for ${host}`)
}

if (isDirectEntrypoint(process.argv[1])) runBuild()
