/** Check the selected Host tests and their imports without compiling the repository's aggregate test program. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const dir = mkdtempSync(resolve('node_modules/.dsp-ci-types-'))
try {
  const filename = join(dir, 'tsconfig.json')
  const include = process.argv.slice(2).map(path => resolve(statSync(path).isDirectory() ? join(path, '**/*.spec.ts') : path))
  const host = resolve('tsconfig.host.json')
  const references = ts.readConfigFile(host, ts.sys.readFile).config.references.map(ref => ({ path: resolve(ref.path) }))
  writeFileSync(filename, JSON.stringify({ extends: host, compilerOptions: { composite: false, incremental: false }, references, include, exclude: [] }))
  execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', filename], { stdio: 'inherit' })
} finally {
  rmSync(dir, { recursive: true, force: true })
}
