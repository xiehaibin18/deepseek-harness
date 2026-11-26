/** Verify that bun.lock stays in sync with pnpm-lock.yaml across resolved packages, integrity hashes, and patches. */
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
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Extract resolved package integrity hashes and patch keys from pnpm-lock.yaml (v9).
 * @param {string} text - Raw pnpm-lock.yaml content.
 * @returns {{ packages: Map<string, string>, patchedDependencies: Set<string> }}
 */
export function parsePnpmLockfile(text) {
  const packages = new Map()
  const patchedDependencies = new Set()
  let section = null
  let currentPackage = null
  let inResolutionBlock = false

  for (const line of text.split(/\r?\n/)) {
    if (line === '' || line.trimStart().startsWith('#')) continue
    if (!line.startsWith(' ')) {
      const topMatch = line.match(/^([A-Za-z0-9_-]+):\s*$/)
      section = topMatch ? topMatch[1] : null
      currentPackage = null
      inResolutionBlock = false
      continue
    }
    if (section === 'patchedDependencies') {
      const patchMatch = line.match(/^  (.+?):\s*\S/)
      if (patchMatch) patchedDependencies.add(unquoteYamlScalar(patchMatch[1]))
      continue
    }
    if (section !== 'packages') continue

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
  }

  return { packages, patchedDependencies }
}

/**
 * Extract resolved package integrity hashes and patch keys from bun.lock.
 * @param {string} text - Raw bun.lock JSONC content.
 * @returns {{ packages: Map<string, string>, patchedDependencies: Set<string> }}
 */
export function parseBunLockfile(text) {
  const parsed = parseJsonc(text)
  const packages = new Map()
  for (const entry of Object.values(parsed.packages ?? {})) {
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
  return { packages, patchedDependencies }
}

/**
 * Compare pnpm-lock.yaml against bun.lock and report any package, integrity, or patch drift.
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

  missingInBun.sort()
  extraInBun.sort()
  integrityMismatches.sort((a, b) => a.spec.localeCompare(b.spec))

  return {
    pnpmPackageCount: pnpm.packages.size,
    bunPackageCount: bun.packages.size,
    patchCount: pnpm.patchedDependencies.size,
    missingInBun,
    extraInBun,
    integrityMismatches,
    missingPatchesInBun,
    extraPatchesInBun,
    inSync: missingInBun.length === 0 && extraInBun.length === 0 && integrityMismatches.length === 0 &&
      missingPatchesInBun.length === 0 && extraPatchesInBun.length === 0,
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
    'Run `bun install --lockfile-only --linker isolated` (or `bun install --linker isolated`) to resynchronize bun.lock.',
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
  console.log(`Lockfiles in sync: ${result.pnpmPackageCount} packages, ${result.patchCount} patches.`)
}
