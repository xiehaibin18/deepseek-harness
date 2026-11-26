/**
 * Enforce pnpm-workspace.yaml `allowBuilds` lifecycle-script policy for Bun installs:
 * - `--pre-install`: runs BEFORE `bun install --frozen-lockfile`. Requires an explicit root
 *   `trustedDependencies` array (omitting it re-enables Bun's built-in default allowlist), and
 *   verifies that EVERY resolved instance in `bun.lock` covered by `trustedDependencies` is
 *   explicitly approved (`true`) by `allowBuilds` without widening version- or source-qualified rules.
 * - `--post-install`: runs all `--pre-install` checks plus parses `bun pm untrusted` strictly
 *   (handling spaces in local paths/sources and failing loudly on any unrecognized output line)
 *   to verify every blocked lifecycle script is explicitly denied (`false`) in `allowBuilds`.
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
 * Split a package spec into its npm package name and optional qualifier (`1.2.3`, `file:...`, `workspace:...`).
 * @param {string} spec - Package name or `name@qualifier`.
 * @returns {{ name: string, qualifier: string | null }}
 */
export function parsePackageSpec(spec) {
  const start = spec.startsWith('@') ? spec.indexOf('/') + 1 : 0
  const atIndex = spec.indexOf('@', start)
  if (atIndex === -1) return { name: spec, qualifier: null }
  return { name: spec.slice(0, atIndex), qualifier: spec.slice(atIndex + 1) }
}

/**
 * Normalize a package instance qualifier into a canonical comparison key.
 * Both `file:./a/b` and `workspace:a/b` normalize to `local:a/b` so pnpm's
 * `pkg@file:packages/foo` rule matches Bun's `pkg@workspace:packages/foo` lockfile entry
 * only for that exact repo-relative directory.
 * @param {string | null} qualifier
 * @returns {string | null}
 */
function canonicalQualifier(qualifier) {
  if (qualifier === null) return null
  if (qualifier.startsWith('file:')) return `local:${normalizeRelativeSourcePath(qualifier.slice('file:'.length))}`
  if (qualifier.startsWith('workspace:')) return `local:${normalizeRelativeSourcePath(qualifier.slice('workspace:'.length))}`
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
 * Evaluate a specific resolved package instance against `allowBuilds` with pnpm precedence
 * (qualified rule overrides unqualified package rule).
 * @param {{ name: string, qualifier: string | null }} instance
 * @param {ReturnType<typeof parsePnpmAllowBuilds>} policy
 * @returns {'allowed' | 'denied' | 'unreviewed'}
 */
export function evaluateAllowBuildsInstance(instance, policy) {
  const qualMap = policy.qualified.get(instance.name)
  if (instance.qualifier !== null && qualMap) {
    const exactKey = canonicalQualifier(instance.qualifier)
    if (qualMap.has(exactKey)) return qualMap.get(exactKey) ? 'allowed' : 'denied'
  }
  if (policy.unqualified.has(instance.name)) {
    return policy.unqualified.get(instance.name) ? 'allowed' : 'denied'
  }
  return 'unreviewed'
}

/**
 * Extract every resolved package instance (`name` + `qualifier`) from bun.lock.
 * @param {string} bunLockText - Raw bun.lock JSONC content.
 * @returns {Map<string, Array<{ name: string, qualifier: string | null, spec: string }>>}
 */
export function parseBunLockInstances(bunLockText) {
  const parsed = parseJsonc(bunLockText)
  const byName = new Map()
  const seen = new Set()

  for (const entry of Object.values(parsed.packages ?? {})) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
    const spec = entry[0]
    if (seen.has(spec)) continue
    seen.add(spec)
    const { name, qualifier } = parsePackageSpec(spec)
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push({ name, qualifier, spec })
  }

  return byName
}

/**
 * Parse package entries printed by `bun pm untrusted` strictly line-by-line.
 * Supports local paths/sources containing spaces and throws on any unrecognized line
 * so partial parsing can never silently drop a blocked dependency.
 * @param {string} output - Combined stdout from `bun pm untrusted`.
 * @returns {Array<{ name: string, qualifier: string, spec: string }>}
 */
export function parseBunUntrustedOutput(output) {
  const clean = output.replace(ansiPattern, '')
  const entries = []
  const seen = new Set()
  let currentEntry = null
  let sawBlockedFooter = false

  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    if (/^bun pm untrusted\b/.test(line)) continue
    if (/^These dependencies had their lifecycle scripts blocked during install\.$/i.test(line)) {
      sawBlockedFooter = true
      continue
    }
    if (/^If you trust them and wish to run their scripts, use `bun pm trust`\.$/i.test(line)) continue
    if (/^No untrusted dependencies\b/i.test(line)) continue
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
    const isFileSource = prefixPath.includes('@file+')
    const qualifier = isFileSource && !rawQualifier.startsWith('file:')
      ? `file:${rawQualifier}`
      : rawQualifier
    const spec = `${name}@${qualifier}`
    currentEntry = { name, qualifier, spec }
    if (!seen.has(spec)) {
      seen.add(spec)
      entries.push(currentEntry)
    }
  }

  if (sawBlockedFooter && entries.length === 0) {
    throw new Error('Failed to parse blocked dependencies from `bun pm untrusted` output:\n' + clean)
  }

  return entries
}

/**
 * Pre-install validation: verify root `package.json#trustedDependencies` is explicitly declared
 * and that every resolved instance in `bun.lock` that Bun would trust is explicitly approved
 * (`true`) in `pnpm-workspace.yaml#allowBuilds` (never widening version/source-qualified rules).
 * @param {{ workspaceYaml: string, packageJsonText: string, bunLockText: string }} input
 */
export function verifyPreInstallTrustedBuilds({ workspaceYaml, packageJsonText, bunLockText }) {
  const policy = parsePnpmAllowBuilds(workspaceYaml)
  const manifest = JSON.parse(packageJsonText)
  const lockInstances = parseBunLockInstances(bunLockText)

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
      // No resolved instance in bun.lock: only accept if allowBuilds explicitly approves this exact spec.
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
  const blocked = parseBunUntrustedOutput(untrustedOutput)

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
