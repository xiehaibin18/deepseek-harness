/**
 * Enforce pnpm-workspace.yaml `allowBuilds` lifecycle-script policy for Bun installs:
 * - `--pre-install`: runs BEFORE `bun install --frozen-lockfile`. Requires an explicit root
 *   `trustedDependencies` array (omitting it re-enables Bun's built-in default allowlist), and
 *   verifies that EVERY resolved instance in `bun.lock` covered by `trustedDependencies` is
 *   explicitly approved (`true`) by `allowBuilds` using pnpm 11 deny-over-allow precedence
 *   without widening version- or source-qualified rules.
 * - `--post-install`: runs all `--pre-install` checks plus parses `bun pm untrusted` strictly
 *   (supporting zero-untrusted output, spaced local directories/tarballs via lockfile resolution,
 *   and failing loudly on any unrecognized output line) to verify every blocked lifecycle script
 *   is explicitly denied (`false`) in `allowBuilds`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseJsonc } from './verify-lockfile-sync.mjs'

const ansiPattern = /\x1b\[[0-9;]*m/g

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

function normalizeRelativeSourcePath(rawPath) {
  let normalized = rawPath.trim().replaceAll('\\', '/')
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  while (normalized.endsWith('/') && normalized.length > 1) normalized = normalized.slice(0, -1)
  return normalized
}

/**
 * Split a package spec into its npm package name and optional qualifier (`1.2.3`, `file:...`, `workspace:...`, `../foo.tgz`).
 * @param {string} spec - Package name or `name@qualifier`.
 * @returns {{ name: string, qualifier: string | null }}
 */
export function parsePackageSpec(spec) {
  const start = spec.startsWith('@') ? spec.indexOf('/') + 1 : 0
  const atIndex = spec.indexOf('@', start)
  if (atIndex === -1) return { name: spec, qualifier: null }
  return { name: spec.slice(0, atIndex), qualifier: spec.slice(atIndex + 1) }
}

function isLocalPathQualifier(qualifier) {
  return qualifier.startsWith('file:') ||
    qualifier.startsWith('workspace:') ||
    qualifier.startsWith('./') ||
    qualifier.startsWith('../') ||
    qualifier.startsWith('/')
}

/**
 * Normalize a package instance qualifier into a canonical comparison key.
 * `file:./a/b`, `workspace:a/b`, and bare local relative paths like `../spacing probe.tgz`
 * normalize to `local:<normalized-path>` so pnpm `allowBuilds` `file:` entries match Bun
 * lockfile and `bun pm untrusted` local directory/tarball records consistently.
 * @param {string | null} qualifier
 * @returns {string | null}
 */
function canonicalQualifier(qualifier) {
  if (qualifier === null) return null
  if (qualifier.startsWith('file:')) return `local:${normalizeRelativeSourcePath(qualifier.slice('file:'.length))}`
  if (qualifier.startsWith('workspace:')) return `local:${normalizeRelativeSourcePath(qualifier.slice('workspace:'.length))}`
  if (qualifier.startsWith('./') || qualifier.startsWith('../') || qualifier.startsWith('/')) {
    return `local:${normalizeRelativeSourcePath(qualifier)}`
  }
  return `ver:${qualifier}`
}

/**
 * Parse the `allowBuilds` map from pnpm-workspace.yaml without external dependencies.
 * Preserves exact version/source qualification alongside unqualified package rules.
 * @param {string} yamlText - Raw pnpm-workspace.yaml content.
 * @returns {{
 *   unqualified: Map<string, boolean>,
 *   qualified: Map<string, Map<string, boolean>>,
 * }}
 */
export function parsePnpmAllowBuilds(yamlText) {
  const unqualified = new Map()
  const qualified = new Map()
  let inAllowBuilds = false

  for (const line of yamlText.split(/\r?\n/)) {
    if (line === '' || line.trimStart().startsWith('#')) continue
    if (!line.startsWith(' ')) {
      inAllowBuilds = /^allowBuilds:\s*$/.test(line)
      continue
    }
    if (!inAllowBuilds) continue
    const match = line.match(/^  (\S.*?):\s*(true|false)\s*(?:#.*)?$/)
    if (!match) continue
    const key = unquoteYamlScalar(match[1])
    const decision = match[2] === 'true'
    const { name, qualifier } = parsePackageSpec(key)
    if (qualifier === null) {
      unqualified.set(name, decision)
    } else {
      if (!qualified.has(name)) qualified.set(name, new Map())
      qualified.get(name).set(canonicalQualifier(qualifier), decision)
    }
  }

  return { unqualified, qualified }
}

/**
 * Evaluate a specific resolved package instance against `allowBuilds` matching pnpm 11.28.5
 * `decideAllowBuild` precedence: any matching denial (`false`) overrides any matching approval (`true`),
 * regardless of whether the denial is unqualified or version/source-qualified.
 * @param {{ name: string, qualifier: string | null }} instance
 * @param {ReturnType<typeof parsePnpmAllowBuilds>} policy
 * @returns {'allowed' | 'denied' | 'unreviewed'}
 */
export function evaluateAllowBuildsInstance(instance, policy) {
  const matches = []
  const qualMap = policy.qualified.get(instance.name)
  if (instance.qualifier !== null && qualMap) {
    const exactKey = canonicalQualifier(instance.qualifier)
    if (qualMap.has(exactKey)) matches.push(qualMap.get(exactKey))
  }
  if (policy.unqualified.has(instance.name)) {
    matches.push(policy.unqualified.get(instance.name))
  }
  if (matches.includes(false)) return 'denied'
  if (matches.includes(true)) return 'allowed'
  return 'unreviewed'
}

/**
 * Extract every resolved package instance (`name` + `qualifier`) and declared workspace local
 * (`file:` / `workspace:`) source paths from bun.lock.
 * @param {string} bunLockText - Raw bun.lock JSONC content.
 */
export function parseBunLockInstances(bunLockText) {
  const parsed = parseJsonc(bunLockText)
  const byName = new Map()
  const localPathsByName = new Map()
  const seen = new Set()

  const recordLocalPath = (name, rawPath) => {
    if (!localPathsByName.has(name)) localPathsByName.set(name, new Set())
    localPathsByName.get(name).add(normalizeRelativeSourcePath(rawPath))
  }

  for (const ws of Object.values(parsed.workspaces ?? {})) {
    for (const sec of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [depName, range] of Object.entries(ws?.[sec] ?? {})) {
        if (typeof range !== 'string') continue
        if (range.startsWith('file:')) recordLocalPath(depName, range.slice('file:'.length))
        else if (range.startsWith('workspace:')) recordLocalPath(depName, range.slice('workspace:'.length))
      }
    }
  }

  for (const entry of Object.values(parsed.packages ?? {})) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
    const spec = entry[0]
    if (seen.has(spec)) continue
    seen.add(spec)
    const { name, qualifier } = parsePackageSpec(spec)
    let normalizedQualifier = qualifier
    if (qualifier !== null) {
      if (qualifier.startsWith('file:')) {
        recordLocalPath(name, qualifier.slice('file:'.length))
      } else if (qualifier.startsWith('workspace:')) {
        recordLocalPath(name, qualifier.slice('workspace:'.length))
      } else if (
        isLocalPathQualifier(qualifier) ||
        localPathsByName.get(name)?.has(normalizeRelativeSourcePath(qualifier))
      ) {
        normalizedQualifier = `file:${qualifier}`
        recordLocalPath(name, qualifier)
      }
    }
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push({ name, qualifier: normalizedQualifier, spec })
  }

  return { byName, localPathsByName }
}

/**
 * Parse package entries printed by `bun pm untrusted` strictly line-by-line.
 * Recognizes Bun 1.4.5's zero-untrusted output, supports local paths/tarballs containing spaces
 * (using bun.lock local source declarations when available), and throws on any unrecognized line
 * so partial parsing can never silently drop a blocked dependency.
 * @param {string} output - Combined stdout from `bun pm untrusted`.
 * @param {Map<string, Set<string>>} [localPathsByName] - Optional normalized local paths from bun.lock.
 * @returns {Array<{ name: string, qualifier: string, spec: string }>}
 */
export function parseBunUntrustedOutput(output, localPathsByName = new Map()) {
  const clean = output.replace(ansiPattern, '')
  const entries = []
  const seen = new Set()
  let currentEntry = null
  let sawBlockedFooter = false
  let sawZeroUntrusted = false

  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    if (/^bun pm untrusted\b/.test(line)) continue
    if (/^Found 0 untrusted dependencies with scripts\.$/i.test(line)) {
      sawZeroUntrusted = true
      continue
    }
    if (/^This means all packages with scripts are in "trustedDependencies" or none of your dependencies have scripts\.$/i.test(line)) {
      continue
    }
    if (/^For more information, visit https:\/\/bun\.(?:com|sh)\/docs\/install\/lifecycle#trusteddependencies$/i.test(line)) {
      continue
    }
    if (/^These dependencies had their lifecycle scripts blocked during install\.$/i.test(line)) {
      sawBlockedFooter = true
      continue
    }
    if (/^If you trust them and wish to run their scripts, use `bun pm trust`\.$/i.test(line)) continue
    if (/^No untrusted dependencies\b/i.test(line)) {
      sawZeroUntrusted = true
      continue
    }
    if (/^»\s+\[[^\]]+\]:/.test(line)) {
      if (!currentEntry) {
        throw new Error(`Unexpected hook line without preceding package header in \`bun pm untrusted\`: ${line}`)
      }
      continue
    }

    const headerMatch = line.match(/^((?:\.\/)?node_modules\/(?:.*\/node_modules\/)?)((?:@[^/\s]+\/)?[^/\s]+)\s+@(.+)$/)
    if (!headerMatch) {
      throw new Error(`Unrecognized line in \`bun pm untrusted\` output: ${line}`)
    }

    const [, prefixPath, name, rawQualifier] = headerMatch
    const isLocalSource = prefixPath.includes('@file+') ||
      isLocalPathQualifier(rawQualifier) ||
      Boolean(localPathsByName.get(name)?.has(normalizeRelativeSourcePath(rawQualifier)))
    const qualifier = isLocalSource && !rawQualifier.startsWith('file:') && !rawQualifier.startsWith('workspace:')
      ? `file:${rawQualifier}`
      : rawQualifier
    const spec = `${name}@${qualifier}`
    currentEntry = { name, qualifier, spec }
    if (!seen.has(spec)) {
      seen.add(spec)
      entries.push(currentEntry)
    }
  }

  if (sawZeroUntrusted && entries.length > 0) {
    throw new Error('Contradictory `bun pm untrusted` output: reported 0 untrusted dependencies alongside package entries.')
  }
  if (sawBlockedFooter && entries.length === 0) {
    throw new Error('Failed to parse blocked dependencies from `bun pm untrusted` output:\n' + clean)
  }

  return entries
}

/**
 * Pre-install validation: verify root `package.json#trustedDependencies` is explicitly declared
 * and that every resolved instance in `bun.lock` that Bun would trust is explicitly approved
 * (`true`) in `pnpm-workspace.yaml#allowBuilds` under deny-over-allow precedence without widening
 * version/source-qualified rules.
 * @param {{ workspaceYaml: string, packageJsonText: string, bunLockText: string }} input
 */
export function verifyPreInstallTrustedBuilds({ workspaceYaml, packageJsonText, bunLockText }) {
  const policy = parsePnpmAllowBuilds(workspaceYaml)
  const manifest = JSON.parse(packageJsonText)
  const { byName: lockInstances } = parseBunLockInstances(bunLockText)

  const manifestErrors = []
  const unapprovedTrusted = []
  const widenedQualifiedTrusted = []

  if (!Object.hasOwn(manifest, 'trustedDependencies')) {
    manifestErrors.push(
      'Root package.json must explicitly declare "trustedDependencies" (omitting it re-enables Bun\'s built-in default trusted list).',
    )
  } else if (
    !Array.isArray(manifest.trustedDependencies) ||
    manifest.trustedDependencies.some(item => typeof item !== 'string' || item.trim() === '')
  ) {
    manifestErrors.push('Root package.json "trustedDependencies" must be an array of non-empty package strings.')
  }

  const trusted = manifestErrors.length === 0 ? manifest.trustedDependencies : []

  for (const trustedSpec of trusted) {
    const parsedTrusted = parsePackageSpec(trustedSpec)
    const allInstances = lockInstances.get(parsedTrusted.name) ?? []
    const matchedInstances = parsedTrusted.qualifier === null
      ? allInstances
      : allInstances.filter(inst => canonicalQualifier(inst.qualifier) === canonicalQualifier(parsedTrusted.qualifier))

    if (matchedInstances.length === 0) {
      const decision = evaluateAllowBuildsInstance(parsedTrusted, policy)
      if (decision !== 'allowed') unapprovedTrusted.push(trustedSpec)
      continue
    }

    const rejectedInstances = []
    for (const inst of matchedInstances) {
      const decision = evaluateAllowBuildsInstance(inst, policy)
      if (decision !== 'allowed') {
        rejectedInstances.push(`${inst.spec} (${decision})`)
      }
    }

    if (rejectedInstances.length > 0) {
      const hasQualifiedApproval = policy.qualified.has(parsedTrusted.name) &&
        [...policy.qualified.get(parsedTrusted.name).values()].some(Boolean)
      if (hasQualifiedApproval || policy.unqualified.get(parsedTrusted.name) === true) {
        widenedQualifiedTrusted.push({ trustedSpec, rejectedInstances: rejectedInstances.sort() })
      } else {
        unapprovedTrusted.push(trustedSpec)
      }
    }
  }

  unapprovedTrusted.sort()
  widenedQualifiedTrusted.sort((a, b) => a.trustedSpec.localeCompare(b.trustedSpec))

  return {
    trustedCount: trusted.length,
    manifestErrors,
    unapprovedTrusted,
    widenedQualifiedTrusted,
    ok: manifestErrors.length === 0 && unapprovedTrusted.length === 0 && widenedQualifiedTrusted.length === 0,
  }
}

/**
 * Full post-install validation: runs pre-install policy checks plus verifies that every blocked
 * script reported by `bun pm untrusted` is explicitly denied (`false`) in `allowBuilds`.
 * @param {{ untrustedOutput: string, workspaceYaml: string, packageJsonText: string, bunLockText: string }} input
 */
export function verifyTrustedBuilds({ untrustedOutput, workspaceYaml, packageJsonText, bunLockText }) {
  const pre = verifyPreInstallTrustedBuilds({ workspaceYaml, packageJsonText, bunLockText })
  const policy = parsePnpmAllowBuilds(workspaceYaml)
  const { localPathsByName } = parseBunLockInstances(bunLockText)
  const blocked = parseBunUntrustedOutput(untrustedOutput, localPathsByName)

  const unreviewedBlocked = []
  const allowedButBlocked = []
  for (const entry of blocked) {
    const decision = evaluateAllowBuildsInstance(entry, policy)
    if (decision === 'denied') continue
    if (decision === 'allowed') allowedButBlocked.push(entry.spec)
    else unreviewedBlocked.push(entry.spec)
  }

  unreviewedBlocked.sort()
  allowedButBlocked.sort()

  return {
    ...pre,
    blockedCount: blocked.length,
    unreviewedBlocked,
    allowedButBlocked,
    ok: pre.ok && unreviewedBlocked.length === 0 && allowedButBlocked.length === 0,
  }
}

/**
 * Format an actionable failure message for pre-install or post-install build-script policy violations.
 * @param {ReturnType<typeof verifyPreInstallTrustedBuilds> & Partial<ReturnType<typeof verifyTrustedBuilds>>} result
 * @returns {string}
 */
export function formatTrustedBuildsReport(result) {
  const lines = [
    'Lifecycle build script policy check failed (enforcing pnpm-workspace.yaml allowBuilds for Bun).',
  ]
  for (const err of result.manifestErrors ?? []) lines.push(`  - ${err}`)
  if (result.unapprovedTrusted?.length) {
    lines.push(`Listed in package.json trustedDependencies without allowBuilds: true (${result.unapprovedTrusted.length}):`)
    for (const spec of result.unapprovedTrusted) lines.push(`  - ${spec}`)
  }
  if (result.widenedQualifiedTrusted?.length) {
    lines.push(
      `trustedDependencies entry would trust resolved instance(s) not approved by allowBuilds (${result.widenedQualifiedTrusted.length}):`,
    )
    for (const item of result.widenedQualifiedTrusted) {
      lines.push(`  - ${item.trustedSpec} covers unapproved/denied instance(s): ${item.rejectedInstances.join(', ')}`)
    }
  }
  if (result.unreviewedBlocked?.length) {
    lines.push(`Unreviewed blocked lifecycle scripts (${result.unreviewedBlocked.length}):`)
    for (const spec of result.unreviewedBlocked) lines.push(`  - ${spec}`)
    lines.push(
      'Review each package: add `<pkg>: false` to pnpm-workspace.yaml allowBuilds to deny it, or add it to both allowBuilds (true) and package.json trustedDependencies to allow it.',
    )
  }
  if (result.allowedButBlocked?.length) {
    lines.push(`Approved in pnpm-workspace.yaml allowBuilds but still blocked by Bun (${result.allowedButBlocked.length}):`)
    for (const spec of result.allowedButBlocked) lines.push(`  - ${spec}`)
    lines.push('Add these packages to root package.json trustedDependencies and rerun `bun install --frozen-lockfile`.')
  }
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  let mode = 'post-install'
  const positional = []
  for (const arg of args) {
    if (arg === '--pre-install') mode = 'pre-install'
    else if (arg === '--post-install') mode = 'post-install'
    else positional.push(arg)
  }

  const workspacePath = positional[0] ?? 'pnpm-workspace.yaml'
  const packageJsonPath = positional[1] ?? 'package.json'
  const bunLockPath = positional[2] ?? 'bun.lock'
  const workspaceYaml = readFileSync(workspacePath, 'utf8')
  const packageJsonText = readFileSync(packageJsonPath, 'utf8')
  const bunLockText = readFileSync(bunLockPath, 'utf8')

  if (mode === 'pre-install') {
    const result = verifyPreInstallTrustedBuilds({ workspaceYaml, packageJsonText, bunLockText })
    if (!result.ok) {
      console.error(formatTrustedBuildsReport(result))
      process.exit(1)
    }
    console.log(`Pre-install trustedDependencies verified: ${result.trustedCount} entries match allowBuilds and bun.lock instances.`)
  } else {
    const untrustedOutput = execFileSync('bun', ['pm', 'untrusted'], { encoding: 'utf8' })
    const result = verifyTrustedBuilds({ untrustedOutput, workspaceYaml, packageJsonText, bunLockText })
    if (!result.ok) {
      console.error(formatTrustedBuildsReport(result))
      process.exit(1)
    }
    console.log(
      `Post-install trusted builds verified: ${result.blockedCount} blocked scripts explicitly denied, ` +
      `${result.trustedCount} trustedDependencies approved.`,
    )
  }
}
