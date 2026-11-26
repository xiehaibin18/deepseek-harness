/** Verify that Bun's blocked lifecycle scripts and trustedDependencies match pnpm-workspace.yaml allowBuilds policy. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ansiPattern = /\x1b\[[0-9;]*m/g

function unquoteYamlScalar(raw) {
  const trimmed = raw.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Strip an optional `@version` or `@file:...` qualifier from a package spec to obtain its package name.
 * @param {string} spec - Package name or `name@qualifier`.
 * @returns {string}
 */
export function packageNameFromSpec(spec) {
  const start = spec.startsWith('@') ? spec.indexOf('/') + 1 : 0
  const atIndex = spec.indexOf('@', start)
  return atIndex === -1 ? spec : spec.slice(0, atIndex)
}

/**
 * Parse the `allowBuilds` map from pnpm-workspace.yaml without external dependencies.
 * @param {string} yamlText - Raw pnpm-workspace.yaml content.
 * @returns {{ allowed: Set<string>, denied: Set<string>, allowedNames: Set<string> }}
 */
export function parsePnpmAllowBuilds(yamlText) {
  const allowed = new Set()
  const denied = new Set()
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
    if (match[2] === 'true') allowed.add(key)
    else denied.add(key)
  }

  const allowedNames = new Set([...allowed].map(packageNameFromSpec))
  return { allowed, denied, allowedNames }
}

/**
 * Parse package entries printed by `bun pm untrusted`.
 * @param {string} output - Combined stdout from `bun pm untrusted`.
 * @returns {Array<{ name: string, version: string, spec: string }>}
 */
export function parseBunUntrustedOutput(output) {
  const clean = output.replace(ansiPattern, '')
  const entries = []
  const seen = new Set()

  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = line.match(/^(?:\.\/)?node_modules\/(?:.*\/node_modules\/)?((?:@[^/\s]+\/)?[^/\s]+)\s+@([^\s]+)$/)
    if (!match) continue
    const [, name, version] = match
    const spec = `${name}@${version}`
    if (seen.has(spec)) continue
    seen.add(spec)
    entries.push({ name, version, spec })
  }

  if (entries.length === 0 && /had their lifecycle scripts blocked/i.test(clean)) {
    throw new Error('Failed to parse blocked dependencies from `bun pm untrusted` output:\n' + clean)
  }

  return entries
}

/**
 * Verify that every blocked package from `bun pm untrusted` is explicitly denied (`false`) in
 * pnpm-workspace.yaml `allowBuilds`, and every root `trustedDependencies` entry is explicitly
 * approved (`true`) in `allowBuilds`.
 * @param {{ untrustedOutput: string, workspaceYaml: string, packageJsonText: string }} input
 */
export function verifyTrustedBuilds({ untrustedOutput, workspaceYaml, packageJsonText }) {
  const blocked = parseBunUntrustedOutput(untrustedOutput)
  const policy = parsePnpmAllowBuilds(workspaceYaml)
  const manifest = JSON.parse(packageJsonText)
  const trusted = Array.isArray(manifest.trustedDependencies) ? manifest.trustedDependencies : []

  const unreviewedBlocked = []
  const allowedButBlocked = []
  for (const entry of blocked) {
    if (policy.denied.has(entry.spec) || policy.denied.has(entry.name)) continue
    if (policy.allowed.has(entry.spec) || policy.allowedNames.has(entry.name)) {
      allowedButBlocked.push(entry.spec)
    } else {
      unreviewedBlocked.push(entry.spec)
    }
  }

  const unapprovedTrusted = trusted
    .filter(spec => !policy.allowed.has(spec) && !policy.allowedNames.has(packageNameFromSpec(spec)))
    .sort()

  unreviewedBlocked.sort()
  allowedButBlocked.sort()

  return {
    blockedCount: blocked.length,
    trustedCount: trusted.length,
    unreviewedBlocked,
    allowedButBlocked,
    unapprovedTrusted,
    ok: unreviewedBlocked.length === 0 && allowedButBlocked.length === 0 && unapprovedTrusted.length === 0,
  }
}

/**
 * Format an actionable failure message for unreviewed or mismatched lifecycle build scripts.
 * @param {ReturnType<typeof verifyTrustedBuilds>} result
 * @returns {string}
 */
export function formatTrustedBuildsReport(result) {
  const lines = [
    'Lifecycle build script policy check failed (Bun does not fail install on untrusted scripts like pnpm strictDepBuilds).',
  ]
  if (result.unreviewedBlocked.length) {
    lines.push(`Unreviewed blocked lifecycle scripts (${result.unreviewedBlocked.length}):`)
    for (const spec of result.unreviewedBlocked) lines.push(`  - ${spec}`)
    lines.push('Review each package: add `<pkg>: false` to pnpm-workspace.yaml allowBuilds to deny it, or add it to both allowBuilds (true) and package.json trustedDependencies to allow it.')
  }
  if (result.allowedButBlocked.length) {
    lines.push(`Approved in pnpm-workspace.yaml allowBuilds but still blocked by Bun (${result.allowedButBlocked.length}):`)
    for (const spec of result.allowedButBlocked) lines.push(`  - ${spec}`)
    lines.push('Add these packages to root package.json trustedDependencies and rerun `bun install --frozen-lockfile`.')
  }
  if (result.unapprovedTrusted.length) {
    lines.push(`Listed in package.json trustedDependencies without allowBuilds: true (${result.unapprovedTrusted.length}):`)
    for (const spec of result.unapprovedTrusted) lines.push(`  - ${spec}`)
  }
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workspacePath = process.argv[2] ?? 'pnpm-workspace.yaml'
  const packageJsonPath = process.argv[3] ?? 'package.json'
  const untrustedOutput = execFileSync('bun', ['pm', 'untrusted'], { encoding: 'utf8' })
  const result = verifyTrustedBuilds({
    untrustedOutput,
    workspaceYaml: readFileSync(workspacePath, 'utf8'),
    packageJsonText: readFileSync(packageJsonPath, 'utf8'),
  })
  if (!result.ok) {
    console.error(formatTrustedBuildsReport(result))
    process.exit(1)
  }
  console.log(`Trusted builds verified: ${result.blockedCount} blocked scripts explicitly denied, ${result.trustedCount} trustedDependencies approved.`)
}
