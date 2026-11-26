/** Select the fork's runtime checks from workspace dependencies and the proposed merge diff. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, globSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLATFORM_MODULES } from '../../packages/client/web/src/platform.ts'

const manifests = new Map()
for (const file of globSync(['packages/*/*/package.json', 'vendor/*/package.json', 'apps/*/package.json'])) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  manifests.set(pkg.name, { dir: dirname(file), deps: Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }) })
}

// The built PTC and workflow tests install these plugins by name in an isolated Host.
const ptcRoots = ['ptc-runtime-node', 'workflow-ptc', 'session', 'session-projection', 'agent', 'system-prompt',
  'fs-local', 'working-directory', 'subprocess-local', 'sandbox-local', 'sandbox-policy', 'subagent',
  'agent-loop-testkit', 'session-persistence-jsonl', 'subagent-spawn-in-process', 'agent-loop']
// CLI also declares other applications' profiles. Web boots the base and web-app bundles.
const webRoots = ['base', 'web-app', 'app-boot', 'cmdline', 'hmr', 'http-proxy', 'plugin-manager',
  'web-frontend', 'client-web', 'client-ui-theme', 'experimental-webworker-runtime']

function closure(roots) {
  const names = new Set(roots)
  for (const name of names) {
    const pkg = manifests.get(name)
    if (!pkg) throw new Error('Unknown DSP CI workspace: ' + name)
    for (const dep of pkg.deps) if (manifests.has(dep)) names.add(dep)
  }
  return new Map(Array.from(names, name => [name, manifests.get(name).dir]))
}

const qualified = name => '@deepseek-ai/dsh-' + name
export const ptc = closure(ptcRoots.map(qualified))
export const web = closure([...webRoots.map(qualified), ...PLATFORM_MODULES.filter(name => manifests.has(name))])
web.set('@deepseek-ai/dsh', manifests.get('@deepseek-ai/dsh').dir)
const ptcDirs = new Set(ptc.values())
const webDirs = new Set(web.values())

export function selectScopes(paths) {
  const selected = new Set()
  let lock = false
  for (const path of paths) {
    if (path === 'pnpm-lock.yaml') { lock = true; continue }
    if (path.startsWith('docs/') || /(?:^|\/)README(?:\.[\w-]+)*\.(?:md|yaml)$/.test(path)) continue
    const owner = path.match(/^(packages\/[^/]+\/[^/]+|(?:vendor|apps)\/[^/]+)\//)?.[1]
    if (ptcDirs.has(owner)) selected.add('ptc')
    // PTC's implementation is loaded by the Web profile too. Its behavior is exercised by the PTC lane.
    if (webDirs.has(owner) && !path.startsWith('packages/ptc-runtime/') && owner !== 'packages/workflow/workflow-ptc') selected.add('web')
    if (/^scripts\/(?:web-product-bundle-isolation|bundle-input-isolation|browser-bundled-externals)\.ts$/.test(path)) selected.add('web')
    if (path === 'packages/client/tsdown.client.ts') selected.add('web')
    if (path.startsWith('native/system/') || path.startsWith('packages/typert/') || path.startsWith('.github/dsp-ci/') ||
        path === '.github/workflows/dsp-ci.yml' || /^(?:package\.json|pnpm-workspace\.yaml|tsconfig[^/]*\.json|tsdown\.config\.ts|vitest[^/]*\.ts)$/.test(path) ||
        /^(?:patches\/|scripts\/(?:build\.ts|compile-referenced-projects\.ts|pnpm-invocation\.ts|generate-typert\.ts|typert-faces\.ts|workspace-package-globs\.ts|client-build-environment\.ts|types\/))/.test(path)) {
      selected.add('ptc')
      selected.add('web')
    }
  }
  if (lock && selected.size === 0) return ['ptc', 'web']
  return ['ptc', 'web'].filter(scope => selected.has(scope))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD'], { maxBuffer: 32 * 1024 * 1024 }).toString().split('\0').filter(Boolean)
  const scopes = selectScopes(files)
  console.log('DSP CI:', scopes.join(', ') || 'no matching runtime changes')
  appendFileSync(process.env.GITHUB_OUTPUT, 'scopes=' + scopes.join(',') + '\n')
}
