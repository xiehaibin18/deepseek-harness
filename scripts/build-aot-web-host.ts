/**
 * Build a Bun AOT (`--compile --aot --compile-in-place --aot-allow-code-from-disk`)
 * executable for `dsh web` using the `AOT-thin` external SDK boundary.
 *
 * Official host plugins declared in workspace `cordis(.patch).yml` files are compiled
 * into the binary via lazy `() => import(...)` thunks so unused plugins never evaluate
 * top-level code at startup, while external user plugins and DSP overlays continue to
 * load dynamically from disk and share module singletons across the `--external` SDK.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, globSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'

/** Minimal workspace SDK/contract closure kept `--external` so disk plugins share singletons with AOT. */
export const AOT_THIN_WORKSPACE_EXTERNALS: readonly string[] = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-error',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-util-crypto',
  '@deepseek-ai/dsh-util-values',
  '@deepseek-ai/schemastery',
]

/** Third-party and native/binary packages kept `--external` during AOT compilation. */
export const AOT_EXTRA_EXTERNALS: readonly string[] = [
  'zod',
  '@deepseek-ai/node-addon-system',
  '@deepseek-ai/node-addon-system/flock',
  '@deepseek-ai/node-addon-system/landlock-run',
  'node-pty',
  'koffi',
  'sharp',
  'amaro',
  'node-addon-require-builtin',
  '@deepseek-ai/libreoffice-kit',
  '@deepseek-ai/libreoffice-kit-darwin-arm64',
  '@deepseek-ai/libreoffice-kit-wasm',
  '@xterm/headless',
  '@xterm/addon-serialize',
]

/** Optional official Web plugins mounted via overlays rather than default bundle patches. */
const EXTRA_OFFICIAL_WEB_PLUGINS: readonly string[] = [
  '@deepseek-ai/dsh-host-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
]

/** Packages excluded from the AOT Web Host table on non-matching platforms or non-Web surfaces. */
function excludedPackagesForPlatform(platform: NodeJS.Platform): ReadonlySet<string> {
  const excluded = new Set<string>([
    '@deepseek-ai/dsh-desktop-host',
    '@deepseek-ai/dsh-experimental-webworker-runtime',
    '@deepseek-ai/dsh-experimental-webworker-packer',
    '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice',
    '@deepseek-ai/dsh-experimental-browser-use-stagehand-native',
    '@deepseek-ai/dsh-host-authentication-desktop',
    '@deepseek-ai/dsh-host-directory-picker-native',
  ])
  if (platform !== 'win32') {
    excluded.add('@deepseek-ai/dsh-cua-windows')
    excluded.add('@deepseek-ai/dsh-pwsh-local')
    excluded.add('@deepseek-ai/dsh-pwsh-sandbox')
    excluded.add('@deepseek-ai/dsh-sandbox-windows-acl')
    excluded.add('@deepseek-ai/dsh-tool-pwsh')
    excluded.add('@deepseek-ai/dsh-win32-process')
  }
  if (platform !== 'darwin') {
    excluded.add('@deepseek-ai/dsh-cua-macos')
  }
  return excluded
}

/** Indexed workspace manifest entry used when resolving official plugin exports. */
export interface WorkspacePackageManifest {
  /** Absolute directory containing `package.json`. */
  readonly dir: string
  /** Declared package name. */
  readonly name: string
  /** Optional legacy `main` field. */
  readonly main?: string
  /** Optional ESM `exports` field. */
  readonly exports?: Readonly<Record<string, unknown>>
}

/** One static entry emitted into `builtin-plugins.generated.ts`. */
export interface StaticPluginEntry {
  /** Bare package or subpath specifier as written in Cordis YAML. */
  readonly specifier: string
  /** Relative import path from the generated module directory to the built JS file. */
  readonly importPath: string
}

/**
 * Load all workspace `package.json` manifests under `packages`, `vendor`, and `apps`.
 * @param repoRoot - Repository root directory.
 * @returns Map from package name to manifest metadata.
 */
export function indexWorkspaceManifests(repoRoot: string): Map<string, WorkspacePackageManifest> {
  const manifests = new Map<string, WorkspacePackageManifest>()
  const files = globSync(['packages/*/*/package.json', 'vendor/*/package.json', 'apps/*/package.json'], { cwd: repoRoot })
  for (const rel of files.sort()) {
    const full = join(repoRoot, rel)
    const raw = JSON.parse(readFileSync(full, 'utf8')) as {
      name?: unknown
      main?: unknown
      exports?: unknown
    }
    if (typeof raw.name !== 'string') continue
    manifests.set(raw.name, {
      dir: dirname(full),
      name: raw.name,
      ...(typeof raw.main === 'string' ? { main: raw.main } : {}),
      ...(raw.exports !== null && typeof raw.exports === 'object' && !Array.isArray(raw.exports)
        ? { exports: raw.exports as Record<string, unknown> }
        : {}),
    })
  }
  return manifests
}

function extractExportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const condition of ['bun', 'node', 'import', 'default']) {
      const target = extractExportTarget(record[condition])
      if (target !== undefined) return target
    }
  }
  return undefined
}

/**
 * Resolve an official workspace plugin specifier (root or subpath) to its built JS file on disk.
 * @param specifier - Bare specifier such as `@deepseek-ai/dsh-web` or `@deepseek-ai/dsh-plugin-manager/tools`.
 * @param manifests - Indexed workspace manifests.
 * @returns Absolute path to the existing built target file, or `undefined` if unresolved.
 */
export function resolveWorkspaceExportFile(
  specifier: string,
  manifests: ReadonlyMap<string, WorkspacePackageManifest>,
): string | undefined {
  const parts = specifier.split('/')
  const pkgName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (pkgName === undefined) return undefined
  const subpath = specifier.startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/')
  const manifest = manifests.get(pkgName)
  if (manifest === undefined) return undefined
  const key = subpath === '' ? '.' : `./${subpath}`
  const target = manifest.exports !== undefined ? manifest.exports[key] : (key === '.' ? manifest.main : undefined)
  const relTarget = extractExportTarget(target)
  if (relTarget === undefined) return undefined
  const full = resolve(manifest.dir, relTarget)
  return existsSync(full) ? full : undefined
}

function collectOfficialSpecifiers(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectOfficialSpecifiers(item, out)
    return
  }
  if (node !== null && typeof node === 'object') {
    const record = node as Record<string, unknown>
    if (typeof record.name === 'string' && record.name.startsWith('@deepseek-ai/')) {
      out.add(record.name)
    }
    for (const value of Object.values(record)) collectOfficialSpecifiers(value, out)
  }
}

/**
 * Discover all official scoped plugin specifiers declared across workspace Cordis configs.
 * @param repoRoot - Repository root directory.
 * @returns Sorted unique list of official plugin specifiers.
 */
export function discoverOfficialPluginSpecifiers(repoRoot: string): string[] {
  const specifiers = new Set<string>(EXTRA_OFFICIAL_WEB_PLUGINS)
  const yamlFiles = globSync(['packages/*/*/cordis.patch.yml', 'packages/*/*/cordis.yml'], { cwd: repoRoot }).sort()
  for (const rel of yamlFiles) {
    const parsed = parseEntryYaml(readFileSync(join(repoRoot, rel), 'utf8'))
    collectOfficialSpecifiers(parsed, specifiers)
  }
  return [...specifiers].sort()
}

/**
 * Build the filtered static plugin table entries for AOT compilation.
 * @param repoRoot - Repository root directory.
 * @param stagingDir - Directory where `builtin-plugins.generated.ts` will be written.
 * @param platform - Target platform used to exclude non-host OS plugins.
 * @returns Resolved static entries, specifiers intentionally kept external, and any unresolved specifiers.
 */
export function planStaticPluginEntries(
  repoRoot: string,
  stagingDir: string,
  platform: NodeJS.Platform = process.platform,
): {
  entries: StaticPluginEntry[]
  keptExternal: string[]
  unresolved: string[]
} {
  const manifests = indexWorkspaceManifests(repoRoot)
  const externals = new Set<string>(AOT_THIN_WORKSPACE_EXTERNALS)
  const excluded = excludedPackagesForPlatform(platform)
  const entries: StaticPluginEntry[] = []
  const keptExternal: string[] = []
  const unresolved: string[] = []

  for (const specifier of discoverOfficialPluginSpecifiers(repoRoot)) {
    const pkgName = specifier.split('/').slice(0, 2).join('/')
    if (externals.has(pkgName)) {
      keptExternal.push(specifier)
      continue
    }
    if (excluded.has(pkgName)) continue
    const target = resolveWorkspaceExportFile(specifier, manifests)
    if (target === undefined) {
      unresolved.push(specifier)
      continue
    }
    const relPath = relative(stagingDir, target).replaceAll('\\', '/')
    entries.push({
      specifier,
      importPath: relPath.startsWith('.') ? relPath : `./${relPath}`,
    })
  }
  return { entries, keptExternal, unresolved }
}

/**
 * Render the generated TypeScript module exporting `BUILTIN_PLUGINS`.
 * @param entries - Static plugin entries to emit.
 * @returns TypeScript source text ending with a trailing newline.
 */
export function renderBuiltinPluginsModule(entries: readonly StaticPluginEntry[]): string {
  return [
    "import type { StaticPluginImporter } from '@deepseek-ai/dsh-app-boot'",
    '',
    'export const BUILTIN_PLUGINS: ReadonlyMap<string, StaticPluginImporter> = new Map([',
    ...entries.map(entry => `  [${JSON.stringify(entry.specifier)}, () => import(${JSON.stringify(entry.importPath)})],`),
    '])',
    '',
  ].join('\n')
}

/**
 * Render the AOT entrypoint dispatching embedded PTC worker modes before CLI boot.
 * @param ptcProcessImportPath - Relative path from staging dir to `ptc-runtime-node/lib/process.js`.
 * @returns TypeScript source text ending with a trailing newline.
 */
export function renderAotEntryModule(ptcProcessImportPath: string): string {
  return [
    "import { readFileSync } from 'node:fs'",
    "import { createRequire } from 'node:module'",
    '',
    "if (process.env.DSH_PTC_RUNTIME_NODE === '1') {",
    "  Reflect.deleteProperty(process.env, 'DSH_PTC_RUNTIME_NODE')",
    `  await import(${JSON.stringify(ptcProcessImportPath)})`,
    '} else if (process.env.DSH_PTC_STRIP_INITIALIZER !== undefined) {',
    '  const amaroPath = process.env.DSH_PTC_STRIP_INITIALIZER',
    "  Reflect.deleteProperty(process.env, 'DSH_PTC_STRIP_INITIALIZER')",
    '  const require = createRequire(import.meta.url)',
    '  const { transformSync } = require(amaroPath) as { transformSync(code: string): { code: string } }',
    '  try {',
    "    process.stdout.write(transformSync(readFileSync(0, 'utf8')).code)",
    '  } catch (error) {',
    "    const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : String(error)",
    '    process.stderr.write(message)',
    '    process.exitCode = 2',
    '  }',
    '} else {',
    "  Reflect.set(globalThis, Symbol.for('dsh.ptc.embeddedRuntime'), true)",
    "  const { registerStaticPluginImporters } = await import('@deepseek-ai/dsh-app-boot')",
    "  const { runCli } = await import('../lib/bin.js')",
    "  const { BUILTIN_PLUGINS } = await import('./builtin-plugins.generated.ts')",
    "  const trace = process.env.DSH_AOT_TRACE === '1'",
    '  registerStaticPluginImporters(',
    '    BUILTIN_PLUGINS,',
    '    trace ? (name, source) => { process.stderr.write(`[aot-plugin:${source}] ${name}\\n`) } : undefined,',
    '  )',
    '  await runCli()',
    '}',
    '',
  ].join('\n')
}

/** Options for {@link buildAotWebHost}. */
export interface BuildAotWebHostOptions {
  /** Repository root containing built `lib/` artifacts. */
  readonly repoRoot?: string
  /** Output executable path (defaults to `apps/cli/lib/dsh-web-aot`). */
  readonly outfile?: string
  /** Keep generated staging sources on disk after compilation. */
  readonly keepStaging?: boolean
}

/**
 * Generate the static plugin registry and compile the Bun AOT `dsh web` executable.
 * @param options - Build paths and retention flags.
 * @returns Output executable path and compiled entry counts.
 * @throws When `apps/cli/lib/bin.js` is missing, any expected official plugin is unresolved, or `bun build` fails.
 */
export function buildAotWebHost(options: BuildAotWebHostOptions = {}): {
  outfile: string
  staticEntryCount: number
  keptExternal: string[]
} {
  const repoRoot = resolve(options.repoRoot ?? resolve(import.meta.dirname, '..'))
  const cliBin = join(repoRoot, 'apps/cli/lib/bin.js')
  if (!existsSync(cliBin)) {
    throw new Error(`build-aot-web-host: built CLI entry missing at ${cliBin}; run build:artifacts first`)
  }
  const outfile = resolve(options.outfile ?? join(repoRoot, 'apps/cli/lib/dsh-web-aot'))
  const stagingDir = join(repoRoot, 'apps/cli/.aot-staging')
  rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true })
  mkdirSync(dirname(outfile), { recursive: true })

  try {
    const plan = planStaticPluginEntries(repoRoot, stagingDir)
    if (plan.unresolved.length > 0) {
      throw new Error(
        `build-aot-web-host: ${String(plan.unresolved.length)} official plugin(s) have no built lib artifact: ${plan.unresolved.join(', ')}`,
      )
    }

    const ptcProcessFile = join(repoRoot, 'packages/ptc-runtime/ptc-runtime-node/lib/process.js')
    if (!existsSync(ptcProcessFile)) {
      throw new Error(`build-aot-web-host: built PTC worker entry missing at ${ptcProcessFile}; run build:artifacts first`)
    }
    const ptcProcessRel = relative(stagingDir, ptcProcessFile).replaceAll('\\', '/')
    const ptcProcessImportPath = ptcProcessRel.startsWith('.') ? ptcProcessRel : `./${ptcProcessRel}`

    const tsconfigOverride = join(stagingDir, 'tsconfig.aot.json')
    writeFileSync(tsconfigOverride, '{}\n')
    writeFileSync(join(stagingDir, 'builtin-plugins.generated.ts'), renderBuiltinPluginsModule(plan.entries))
    writeFileSync(join(stagingDir, 'entry.ts'), renderAotEntryModule(ptcProcessImportPath))

    const externalArgs: string[] = []
    for (const pkg of [...AOT_THIN_WORKSPACE_EXTERNALS, ...AOT_EXTRA_EXTERNALS]) {
      externalArgs.push('--external', pkg, '--external', `${pkg}/*`)
    }

    const bunExecutable = process.versions.bun !== undefined ? process.execPath : 'bun'
    const result = spawnSync(bunExecutable, [
      'build',
      '--compile',
      '--aot',
      '--compile-in-place',
      '--aot-allow-code-from-disk',
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig',
      '--target=bun',
      '--tsconfig-override', tsconfigOverride,
      ...externalArgs,
      join(stagingDir, 'entry.ts'),
      '--outfile', outfile,
    ], { cwd: repoRoot, stdio: 'inherit' })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      throw new Error(`build-aot-web-host: bun build exited with status ${String(result.status ?? result.signal)}`)
    }

    return {
      outfile,
      staticEntryCount: plan.entries.length,
      keptExternal: plan.keptExternal,
    }
  } finally {
    if (options.keepStaging !== true) {
      rmSync(stagingDir, { recursive: true, force: true })
    }
  }
}

function isDirectEntrypoint(argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1 === '') return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url))
  } catch (error) {
    // Non-file argv entries (for example eval names) cannot match this script file.
    void error
    return false
  }
}

if (isDirectEntrypoint(process.argv[1])) {
  const { values } = parseArgs({
    options: {
      outfile: { type: 'string' },
      'keep-staging': { type: 'boolean' },
    },
    allowPositionals: false,
  })
  const summary = buildAotWebHost({
    ...(values.outfile === undefined ? {} : { outfile: values.outfile }),
    keepStaging: values['keep-staging'] === true,
  })
  console.log(
    `build-aot-web-host: built ${summary.outfile} (${String(summary.staticEntryCount)} AOT plugins, ${String(summary.keptExternal.length)} external SDK plugins)`,
  )
}
