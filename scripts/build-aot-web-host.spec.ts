import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  AOT_THIN_WORKSPACE_EXTERNALS,
  discoverOfficialPluginSpecifiers,
  indexWorkspaceManifests,
  planStaticPluginEntries,
  renderAotEntryModule,
  renderBuiltinPluginsModule,
  resolveWorkspaceExportFile,
} from './build-aot-web-host.ts'

describe('build-aot-web-host helpers', () => {
  it('discovers official plugins from workspace cordis YAML files and resolves built exports', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-aot-builder-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })

    const bundleDir = join(root, 'packages/bundle/sample')
    const pluginDir = join(root, 'packages/core/sample-plugin')
    const toolsDir = join(root, 'packages/core/tools')
    const browseHostDir = join(root, 'packages/host/directory-picker-browse')
    const browseUiDir = join(root, 'packages/client/ui-directory-picker-browse')
    for (const dir of [bundleDir, join(pluginDir, 'lib'), join(toolsDir, 'lib'), join(browseHostDir, 'lib'), join(browseUiDir, 'lib')]) {
      mkdirSync(dir, { recursive: true })
    }

    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-sample-bundle' }))
    writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: sample',
      '      name: "@deepseek-ai/dsh-sample-plugin"',
      '    - id: sample-sub',
      '      name: "@deepseek-ai/dsh-sample-plugin/tools"',
      '    - id: tools',
      '      name: "@deepseek-ai/dsh-tools"',
      '    - id: external-ignored',
      '      name: "third-party-plugin"',
      '',
    ].join('\n'))

    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-sample-plugin',
      exports: {
        '.': { import: './lib/index.js' },
        './tools': './lib/tools.js',
      },
    }))
    writeFileSync(join(pluginDir, 'lib/index.js'), 'export const name = "sample"\n')
    writeFileSync(join(pluginDir, 'lib/tools.js'), 'export const name = "sample-tools"\n')

    writeFileSync(join(toolsDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-tools',
      exports: { '.': './lib/index.js' },
    }))
    writeFileSync(join(toolsDir, 'lib/index.js'), 'export const name = "tools"\n')

    writeFileSync(join(browseHostDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-host-directory-picker-browse',
      exports: { '.': './lib/index.js' },
    }))
    writeFileSync(join(browseHostDir, 'lib/index.js'), 'export const name = "browse-host"\n')
    writeFileSync(join(browseUiDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse',
      exports: { '.': './lib/index.js' },
    }))
    writeFileSync(join(browseUiDir, 'lib/index.js'), 'export const name = "browse-ui"\n')

    const specifiers = discoverOfficialPluginSpecifiers(root)
    expect(specifiers).toContain('@deepseek-ai/dsh-sample-plugin')
    expect(specifiers).toContain('@deepseek-ai/dsh-sample-plugin/tools')
    expect(specifiers).toContain('@deepseek-ai/dsh-tools')
    expect(specifiers).not.toContain('third-party-plugin')

    const manifests = indexWorkspaceManifests(root)
    expect(resolveWorkspaceExportFile('@deepseek-ai/dsh-sample-plugin/tools', manifests))
      .toBe(join(pluginDir, 'lib/tools.js'))

    const stagingDir = join(root, 'apps/cli/.aot-staging')
    const plan = planStaticPluginEntries(root, stagingDir, 'darwin')
    expect(plan.unresolved).toEqual([])
    expect(plan.keptExternal).toEqual(['@deepseek-ai/dsh-tools'])
    expect(plan.entries.map(e => e.specifier)).toEqual([
      '@deepseek-ai/dsh-client-ui-directory-picker-browse',
      '@deepseek-ai/dsh-host-directory-picker-browse',
      '@deepseek-ai/dsh-sample-plugin',
      '@deepseek-ai/dsh-sample-plugin/tools',
    ])

    const generated = renderBuiltinPluginsModule(plan.entries)
    expect(generated).toContain('["@deepseek-ai/dsh-sample-plugin", () => import("../../../packages/core/sample-plugin/lib/index.js")]')
    expect(generated).not.toContain('@deepseek-ai/dsh-tools')
  })

  it('keeps dsh-session out of the AOT-thin external boundary', () => {
    expect(AOT_THIN_WORKSPACE_EXTERNALS).toContain('@deepseek-ai/cordis')
    expect(AOT_THIN_WORKSPACE_EXTERNALS).toContain('@deepseek-ai/dsh-tools')
    expect(AOT_THIN_WORKSPACE_EXTERNALS).toContain('@deepseek-ai/dsh-llm')
    expect(AOT_THIN_WORKSPACE_EXTERNALS).toContain('@deepseek-ai/dsh-storage')
    expect(AOT_THIN_WORKSPACE_EXTERNALS).not.toContain('@deepseek-ai/dsh-session')
  })

  it('dispatches embedded PTC worker and initializer stripping modes before CLI boot', () => {
    const entry = renderAotEntryModule('../../../packages/ptc-runtime/ptc-runtime-node/lib/process.js')
    const ptcIndex = entry.indexOf("DSH_PTC_RUNTIME_NODE === '1'")
    const stripIndex = entry.indexOf('DSH_PTC_STRIP_INITIALIZER !== undefined')
    const cliIndex = entry.indexOf("Symbol.for('dsh.ptc.embeddedRuntime')")
    expect(ptcIndex).toBeGreaterThan(-1)
    expect(stripIndex).toBeGreaterThan(ptcIndex)
    expect(cliIndex).toBeGreaterThan(stripIndex)
    expect(entry).toContain('await import("../../../packages/ptc-runtime/ptc-runtime-node/lib/process.js")')
  })
})
