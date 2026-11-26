/**
 * Verify that bun.lock stays in sync with pnpm-lock.yaml across:
 * 1. All resolved package specs and integrity hashes (`packages`),
 * 2. All applied patches (`patchedDependencies`),
 * 3. Every workspace's resolved direct dependency versions (`importers` vs `workspaces`/`packages`),
 * 4. Every non-peer transitive dependency edge (`snapshots` vs `packages`).
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * Parse a JSONC document (supporting line/block comments and trailing commas) without external dependencies.
 * @param {string} text - Raw JSONC source.
 * @returns {any} Parsed JavaScript value.
 */
export function parseJsonc(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      if (i < text.length) out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length) {
        const look = text[j]
        const lookNext = text[j + 1]
        if (look === ' ' || look === '\t' || look === '\r' || look === '\n') {
          j += 1
          continue
        }
        if (look === '/' && lookNext === '/') {
          while (j < text.length && text[j] !== '\n') j += 1
          continue
        }
        if (look === '/' && lookNext === '*') {
          j += 2
          while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j += 1
          j += 2
          continue
        }
        break
      }
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += ch
  }
  return JSON.parse(out)
}

function unquoteYamlScalar(raw) {
  const trimmed = raw.trim()
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed)
  }
  return trimmed
}

function normalizePnpmDepSpec(depName, rawVersion) {
  const base = rawVersion.replace(/\(.*$/, '')
  if (base.startsWith('link:')) return null
  if (base.startsWith('file:')) return `${depName}@${base}`
  if (base.startsWith('https://') || base.startsWith('http://')) return `${depName}@${base}`
  // pnpm stores npm aliases in snapshots/importers as `<realName>@<version>`.
  const atIdx = base.startsWith('@') ? base.indexOf('@', 1) : base.indexOf('@')
  if (atIdx > 0) return base
  return `${depName}@${base}`
}

/**
 * Parse pnpm-lock.yaml (v9) packages, patches, workspace importers, and transitive snapshot edges
 * without external dependencies.
 * @param {string} text - Raw pnpm-lock.yaml content.
 * @returns {{
 *   packages: Map<string, string>,
 *   patchedDependencies: Set<string>,
 *   importers: Map<string, Map<string, string>>,
 *   snapshotEdges: Map<string, Map<string, Set<string>>>,
 * }}
 */
export function parsePnpmLockfile(text) {
  const packages = new Map()
  const patchedDependencies = new Set()
  const importers = new Map()
  const snapshotEdges = new Map()

  let section = null
  let currentPackage = null
  let inResolutionBlock = false

  let currentImporter = null
  let currentImporterSection = null
  let currentImporterDep = null

  let currentSnapshotParent = null
  let currentSnapshotSection = null

  const depSections = new Set(['dependencies', 'devDependencies', 'optionalDependencies'])
  const snapshotDepSections = new Set(['dependencies', 'optionalDependencies'])

  for (const line of text.split(/\r?\n/)) {
    if (line === '' || line.trimStart().startsWith('#')) continue
    if (!line.startsWith(' ')) {
      const topMatch = line.match(/^([A-Za-z0-9_-]+):\s*$/)
      section = topMatch ? topMatch[1] : null
      currentPackage = null
      inResolutionBlock = false
      currentImporter = null
      currentImporterSection = null
      currentImporterDep = null
      currentSnapshotParent = null
      currentSnapshotSection = null
      continue
    }

    if (section === 'patchedDependencies') {
      const patchMatch = line.match(/^  (\S.*?):\s*\S/)
      if (patchMatch) patchedDependencies.add(unquoteYamlScalar(patchMatch[1]))
      continue
    }

    if (section === 'packages') {
      const pkgMatch = line.match(/^  (\S.*):\s*$/)
      if (pkgMatch) {
        currentPackage = unquoteYamlScalar(pkgMatch[1])
        inResolutionBlock = false
        continue
      }
      if (!currentPackage) continue
      if (line.startsWith('    resolution:')) {
        const inlineIntegrity = line.match(/integrity:\s*([^\s,}]+)/)
        if (inlineIntegrity) {
          packages.set(currentPackage, unquoteYamlScalar(inlineIntegrity[1]))
          inResolutionBlock = false
        } else {
          inResolutionBlock = line.trim() === 'resolution:'
        }
        continue
      }
      if (inResolutionBlock) {
        if (!line.startsWith('      ')) {
          inResolutionBlock = false
          continue
        }
        const blockIntegrity = line.match(/^      integrity:\s*(.+)$/)
        if (blockIntegrity) {
          packages.set(currentPackage, unquoteYamlScalar(blockIntegrity[1]))
          inResolutionBlock = false
        }
      }
      continue
    }

    if (section === 'importers') {
      const impMatch = line.match(/^  (\S.*?):\s*(?:\{\})?\s*$/)
      if (impMatch) {
        currentImporter = unquoteYamlScalar(impMatch[1])
        if (!importers.has(currentImporter)) importers.set(currentImporter, new Map())
        currentImporterSection = null
        currentImporterDep = null
        continue
      }
      if (!currentImporter) continue
      const secMatch = line.match(/^    ([A-Za-z]+):\s*$/)
      if (secMatch) {
        currentImporterSection = depSections.has(secMatch[1]) ? secMatch[1] : null
        currentImporterDep = null
        continue
      }
      if (!currentImporterSection) continue
      const depMatch = line.match(/^      (\S.*?):\s*$/)
      if (depMatch) {
        currentImporterDep = unquoteYamlScalar(depMatch[1])
        continue
      }
      if (!currentImporterDep) continue
      const verMatch = line.match(/^        version:\s*(.+)$/)
      if (verMatch) {
        const normalized = normalizePnpmDepSpec(currentImporterDep, unquoteYamlScalar(verMatch[1]))
        if (normalized) importers.get(currentImporter).set(currentImporterDep, normalized)
      }
      continue
    }

    if (section === 'snapshots') {
      const snapMatch = line.match(/^  (\S.*?):\s*(?:\{\})?\s*$/)
      if (snapMatch) {
        const snapKey = unquoteYamlScalar(snapMatch[1])
        currentSnapshotParent = snapKey.replace(/\(.*$/, '')
        if (!snapshotEdges.has(currentSnapshotParent)) snapshotEdges.set(currentSnapshotParent, new Map())
        currentSnapshotSection = null
        continue
      }
      if (!currentSnapshotParent) continue
      const secMatch = line.match(/^    ([A-Za-z]+):\s*$/)
      if (secMatch) {
        currentSnapshotSection = snapshotDepSections.has(secMatch[1]) ? secMatch[1] : null
        continue
      }
      if (!currentSnapshotSection) continue
      const edgeMatch = line.match(/^      (\S.*?):\s*(.+)$/)
      if (edgeMatch) {
        const depName = unquoteYamlScalar(edgeMatch[1])
        const depVer = unquoteYamlScalar(edgeMatch[2])
        const normalized = normalizePnpmDepSpec(depName, depVer)
        if (normalized) {
          const depMap = snapshotEdges.get(currentSnapshotParent)
          if (!depMap.has(depName)) depMap.set(depName, new Set())
          depMap.get(depName).add(normalized)
        }
      }
    }
  }

  return { packages, patchedDependencies, importers, snapshotEdges }
}

function splitBunPackageKey(key) {
  const parts = key.split('/')
  const segments = []
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].startsWith('@') && i + 1 < parts.length) {
      segments.push(`${parts[i]}/${parts[i + 1]}`)
      i += 1
    } else {
      segments.push(parts[i])
    }
  }
  return segments
}

function resolveBunDependencyFromKey(bunPackages, parentKey, depName) {
  const segments = parentKey ? splitBunPackageKey(parentKey) : []
  for (let len = segments.length; len >= 0; len -= 1) {
    const candidate = len === 0 ? depName : `${segments.slice(0, len).join('/')}/${depName}`
    const entry = bunPackages[candidate]
    if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0]
  }
  return null
}

/**
 * Parse bun.lock packages, patches, workspace metadata, and raw package table.
 * @param {string} text - Raw bun.lock JSONC content.
 */
export function parseBunLockfile(text) {
  const parsed = parseJsonc(text)
  const rawPackages = parsed.packages ?? {}
  const workspaces = parsed.workspaces ?? {}
  const packages = new Map()
  for (const entry of Object.values(rawPackages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
    const spec = entry[0]
    let integrity = null
    for (let i = entry.length - 1; i >= 1; i -= 1) {
      const item = entry[i]
      if (typeof item === 'string' && /^sha\d+-/.test(item)) {
        integrity = item
        break
      }
    }
    if (integrity) packages.set(spec, integrity)
  }
  const patchedDependencies = new Set(Object.keys(parsed.patchedDependencies ?? {}))
  return { packages, patchedDependencies, workspaces, rawPackages }
}

/**
 * Compare pnpm-lock.yaml against bun.lock across global packages, integrity hashes, patches,
 * per-workspace resolved dependency versions, and non-peer transitive dependency edges.
 * @param {string} pnpmText - Raw pnpm-lock.yaml content.
 * @param {string} bunText - Raw bun.lock content.
 */
export function compareLockfiles(pnpmText, bunText) {
  const pnpm = parsePnpmLockfile(pnpmText)
  const bun = parseBunLockfile(bunText)

  const missingInBun = []
  const extraInBun = []
  const integrityMismatches = []

  for (const [spec, integrity] of pnpm.packages) {
    if (!bun.packages.has(spec)) {
      missingInBun.push(spec)
    } else if (bun.packages.get(spec) !== integrity) {
      integrityMismatches.push({ spec, pnpm: integrity, bun: bun.packages.get(spec) })
    }
  }
  for (const spec of bun.packages.keys()) {
    if (!pnpm.packages.has(spec)) extraInBun.push(spec)
  }

  const missingPatchesInBun = [...pnpm.patchedDependencies].filter(key => !bun.patchedDependencies.has(key)).sort()
  const extraPatchesInBun = [...bun.patchedDependencies].filter(key => !pnpm.patchedDependencies.has(key)).sort()

  const workspaceMismatches = []
  let workspaceDepCount = 0
  for (const [impKey, depMap] of pnpm.importers) {
    const bunWsKey = impKey === '.' ? '' : impKey
    const bunWs = bun.workspaces[bunWsKey]
    const wsName = typeof bunWs?.name === 'string' ? bunWs.name : null
    for (const [depName, expectedSpec] of depMap) {
      workspaceDepCount += 1
      let actualSpec = null
      if (bunWsKey && `${bunWsKey}/${depName}` in bun.rawPackages) {
        actualSpec = bun.rawPackages[`${bunWsKey}/${depName}`]?.[0] ?? null
      } else if (wsName && `${wsName}/${depName}` in bun.rawPackages) {
        actualSpec = bun.rawPackages[`${wsName}/${depName}`]?.[0] ?? null
      } else if (depName in bun.rawPackages) {
        actualSpec = bun.rawPackages[depName]?.[0] ?? null
      }
      if (actualSpec !== expectedSpec) {
        workspaceMismatches.push({ workspace: impKey, dep: depName, pnpm: expectedSpec, bun: actualSpec ?? '<missing>' })
      }
    }
  }

  const transitiveMismatches = []
  let transitiveEdgeCount = 0
  for (const [pkgKey, entry] of Object.entries(bun.rawPackages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
    const parentSpec = entry[0]
    if (parentSpec.includes('@workspace:') || parentSpec.includes('@link:')) continue
    const meta = entry.find(item => item && typeof item === 'object' && !Array.isArray(item))
    if (!meta) continue
    const pnpmParentDeps = pnpm.snapshotEdges.get(parentSpec)
    if (!pnpmParentDeps) continue
    for (const sec of ['dependencies', 'optionalDependencies']) {
      for (const depName of Object.keys(meta[sec] ?? {})) {
        const bunResolved = resolveBunDependencyFromKey(bun.rawPackages, pkgKey, depName)
        if (!bunResolved || bunResolved.includes('@workspace:') || bunResolved.includes('@link:')) continue
        const pnpmAllowed = pnpmParentDeps.get(depName)
        if (!pnpmAllowed) continue
        transitiveEdgeCount += 1
        if (!pnpmAllowed.has(bunResolved)) {
          transitiveMismatches.push({
            parent: parentSpec,
            dep: depName,
            pnpm: [...pnpmAllowed].sort().join(' | '),
            bun: bunResolved,
          })
        }
      }
    }
  }

  missingInBun.sort()
  extraInBun.sort()
  integrityMismatches.sort((a, b) => a.spec.localeCompare(b.spec))
  workspaceMismatches.sort((a, b) => `${a.workspace}:${a.dep}`.localeCompare(`${b.workspace}:${b.dep}`))
  transitiveMismatches.sort((a, b) => `${a.parent}:${a.dep}`.localeCompare(`${b.parent}:${b.dep}`))

  return {
    pnpmPackageCount: pnpm.packages.size,
    bunPackageCount: bun.packages.size,
    patchCount: pnpm.patchedDependencies.size,
    workspaceDepCount,
    transitiveEdgeCount,
    missingInBun,
    extraInBun,
    integrityMismatches,
    missingPatchesInBun,
    extraPatchesInBun,
    workspaceMismatches,
    transitiveMismatches,
    inSync: missingInBun.length === 0 && extraInBun.length === 0 && integrityMismatches.length === 0 &&
      missingPatchesInBun.length === 0 && extraPatchesInBun.length === 0 &&
      workspaceMismatches.length === 0 && transitiveMismatches.length === 0,
  }
}

/**
 * Format a human-readable diagnostic when pnpm-lock.yaml and bun.lock diverge.
 * @param {ReturnType<typeof compareLockfiles>} result - Comparison output.
 * @returns {string}
 */
export function formatDriftReport(result) {
  const lines = [
    'Lockfile drift detected between pnpm-lock.yaml and bun.lock.',
    'Bun does not re-migrate pnpm-lock.yaml while bun.lock already exists.',
    'Remigrate from pnpm-lock.yaml with: `rm -f bun.lock && bun install --lockfile-only --linker isolated`',
    '(Then check `git diff package.json` — or run `git checkout -- package.json` if only pnpm-lock.yaml changed — so npm-compatible nested `overrides` are preserved.)',
  ]
  const summarize = (label, items) => {
    if (!items.length) return
    const preview = items.slice(0, 20)
    lines.push(`${label} (${items.length}):`)
    for (const item of preview) lines.push(`  - ${item}`)
    if (items.length > preview.length) lines.push(`  ... and ${items.length - preview.length} more`)
  }
  summarize('Present in pnpm-lock.yaml but missing in bun.lock', result.missingInBun)
  summarize('Present in bun.lock but missing in pnpm-lock.yaml', result.extraInBun)
  summarize(
    'Integrity hash mismatches',
    result.integrityMismatches.map(m => `${m.spec} (pnpm=${m.pnpm} vs bun=${m.bun})`),
  )
  summarize('Patches present in pnpm-lock.yaml but missing in bun.lock', result.missingPatchesInBun)
  summarize('Patches present in bun.lock but missing in pnpm-lock.yaml', result.extraPatchesInBun)
  summarize(
    'Workspace dependency resolution mismatches',
    result.workspaceMismatches.map(m => `${m.workspace} -> ${m.dep} (pnpm=${m.pnpm} vs bun=${m.bun})`),
  )
  summarize(
    'Transitive dependency resolution mismatches',
    result.transitiveMismatches.map(m => `${m.parent} -> ${m.dep} (pnpm=${m.pnpm} vs bun=${m.bun})`),
  )
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pnpmPath = process.argv[2] ?? 'pnpm-lock.yaml'
  const bunPath = process.argv[3] ?? 'bun.lock'
  const result = compareLockfiles(readFileSync(pnpmPath, 'utf8'), readFileSync(bunPath, 'utf8'))
  if (!result.inSync) {
    console.error(formatDriftReport(result))
    process.exit(1)
  }
  console.log(
    `Lockfiles in sync: ${result.pnpmPackageCount} packages, ${result.patchCount} patches, ` +
    `${result.workspaceDepCount} workspace edges, ${result.transitiveEdgeCount} transitive edges.`,
  )
}
