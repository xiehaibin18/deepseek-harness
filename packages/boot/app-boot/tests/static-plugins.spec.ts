import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, registerStaticPluginImporters, type StaticPluginImporter } from '../src/index.ts'

afterEach(() => {
  registerStaticPluginImporters(undefined)
})

describe('registerStaticPluginImporters', () => {
  it('resolves registered plugins statically while falling back to disk for external plugins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-static-plugins-'))
    onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })

    const externalFile = join(dir, 'external-plugin.mjs')
    writeFileSync(externalFile, [
      'export const name = "external-probe"',
      'export function apply(ctx) { ctx.provide("externalProbe", "from-disk") }',
      '',
    ].join('\n'))

    const configPath = join(dir, 'cordis.yml')
    writeFileSync(configPath, [
      '- id: static-entry',
      '  name: "@fixture/static-probe"',
      '- id: external-entry',
      `  name: ${JSON.stringify(pathToFileURL(externalFile).href)}`,
      '',
    ].join('\n'))

    const observed: Array<{ name: string; source: 'static' | 'disk' }> = []
    const importers = new Map<string, StaticPluginImporter>([
      ['@fixture/static-probe', () => Promise.resolve({
        name: 'static-probe',
        apply(ctx: Context) { ctx.provide('staticProbe', 'from-static') },
      })],
    ])
    registerStaticPluginImporters(importers, (name, source) => {
      observed.push({ name, source })
    })

    const ctx = await boot('dsh-test', configPath)
    onTestFinished(async () => { await ctx.fiber.dispose() })

    expect(ctx.get('staticProbe')).toBe('from-static')
    expect(ctx.get('externalProbe')).toBe('from-disk')
    expect(observed).toEqual([
      { name: '@fixture/static-probe', source: 'static' },
      { name: pathToFileURL(externalFile).href, source: 'disk' },
    ])
  })

  it('restores normal disk-only Include behavior after clearing with undefined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-static-clear-'))
    onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })

    const externalFile = join(dir, 'plugin.mjs')
    writeFileSync(externalFile, [
      'export const name = "disk-only"',
      'export function apply(ctx) { ctx.provide("diskOnly", true) }',
      '',
    ].join('\n'))

    const configPath = join(dir, 'cordis.yml')
    writeFileSync(configPath, [
      '- id: disk-entry',
      `  name: ${JSON.stringify(pathToFileURL(externalFile).href)}`,
      '',
    ].join('\n'))

    const observed: string[] = []
    registerStaticPluginImporters(new Map(), (name) => { observed.push(name) })
    registerStaticPluginImporters(undefined)

    const ctx = await boot('dsh-test', configPath)
    onTestFinished(async () => { await ctx.fiber.dispose() })

    expect(ctx.get('diskOnly')).toBe(true)
    expect(observed).toEqual([])
  })
})
