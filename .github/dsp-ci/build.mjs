/** Compile and bundle only workspaces consumed by the selected DSP checks. Run from the repository root. */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import ts from 'typescript'
import { ptc, web } from './scope.mjs'
import { hasTypertExport, WorkspaceTypertGenerator } from '../../packages/typert/generator/src/workspace.ts'
import { writeWorkspaceArtifacts } from '../../packages/typert/generator/src/artifact-files.ts'
import { clientBuildProcessEnvironment, repositoryClientBuildEnvironment } from '../../scripts/client-build-environment.ts'

const scopes = process.argv[2]?.split(',') ?? []
if (!scopes.length || scopes.some(scope => !['ptc', 'web'].includes(scope))) throw new Error('Expected ptc, web or ptc,web')
const packages = new Map(scopes.flatMap(scope => [...(scope === 'ptc' ? ptc : web)]))
const dirs = new Set([...packages.values(), 'packages/typert/generator'])
const root = process.cwd()
const env = clientBuildProcessEnvironment(process.env, repositoryClientBuildEnvironment(root, process.env))
function bunRun(args) {
  execFileSync('bun', ['run', ...args], { stdio: 'inherit', env })
}

bunRun(['build:native-system'])
const generator = new WorkspaceTypertGenerator(root, { checkDiagnostics: false, rejectBuildOutputs: true })
const contributors = generator.discover(['host'], pkg => packages.has(pkg.name) && hasTypertExport(pkg.exports))
if (contributors.length) writeWorkspaceArtifacts(root, generator.generate(contributors.map(pkg => pkg.package), ['host']))
for (const face of scopes.includes('web') ? ['host', 'client'] : ['host']) {
  const filename = 'tsconfig.' + face + '.json'
  const { config, error } = ts.readConfigFile(filename, ts.sys.readFile)
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
  const projects = new Set(config.references.map(ref => ref.path.replace(/^\.\//, '')).filter(path =>
    dirs.has(path.endsWith('.json') ? dirname(path) : path)))
  // Dependency projects can be reachable only transitively from the repository aggregate.
  for (const dir of dirs) {
    const leaf = dir + '/tsconfig.' + face + '.json'
    if (existsSync(leaf)) projects.add(leaf)
  }
  // Web's Vite preview entry imports the worker's published JS and types.
  // Its standalone TS project is outside both repository aggregates.
  if (face === 'host' && scopes.includes('web')) projects.add('packages/experimental/webworker-runtime')
  const workspaces = [...new Set([...projects].map(path => path.endsWith('.json') ? dirname(path) : path))]
    .filter(path => path !== 'apps/web')
  console.log('DSP ' + face + ' workspaces (' + workspaces.length + '): ' + workspaces.join(' '))
  bunRun(['tsc', '-b', ...projects])
  execFileSync(process.execPath, ['.github/dsp-ci/bundle.mjs', face, ...workspaces], { stdio: 'inherit', env })
}
if (scopes.includes('web')) bunRun(['build:web'])
