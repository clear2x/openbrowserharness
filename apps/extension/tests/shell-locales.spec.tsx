// @vitest-environment jsdom
/**
 * shell locale seat spec: the extension shell's copy lives in one typed
 * dictionary pair (`locales/`) and reaches components through the seat in
 * `locales/index.ts`, which rides the upstream `LocaleRuntime`.
 *
 * Covered contracts:
 * - dictionaries: `zh` and `en` carry the same keys and the same
 *   `{placeholder}` sets, the surface files own disjoint keys, `en` holds no
 *   CJK text and neither dictionary carries invisible characters, and the
 *   on-device catalog tables carry English entries (the catalog-side parity
 *   lives in the host-face `shell-catalog-parity.spec.ts`);
 * - reachability: every dictionary key is referenced by a shell component;
 * - the seat: the zh dictionary answers before a face is bound; through the
 *   real runtime the shell follows the browser language (zh, en, and an
 *   active locale without a shell dictionary falling back to en), components
 *   re-render on a live switch, and the dictionaries stay registered until
 *   the last installer context unloads.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_LOCAL_LABEL_KEYS, AI_LOCAL_PURPOSE_KEYS } from '../src/sidepanel-dsh/locales/ai-local.ts'
import { capabilityLabel, capabilityLabelKey } from '../src/sidepanel-dsh/locales/capabilities.ts'
import {
  cardsZh,
  composerZh,
  panelsZh,
  presetsZh,
  settingsZh,
  shellChromeZh,
  shellEn,
  shellZh,
} from '../src/sidepanel-dsh/locales/dictionaries.ts'
import {
  bindShellLocaleFace,
  installShellLocale,
  interpolate,
  type ShellLocaleHost,
  shellT,
  SHELL_NS,
  useShellT,
} from '../src/sidepanel-dsh/locales/index.ts'
import { AGENT_PRESET_LABEL_KEYS, agentPresetDescription, agentPresetName } from '../src/sidepanel-dsh/locales/preset-labels.ts'
import {
  CAPABILITY_FALLBACKS,
  MCP_SERVER_CAPABILITY_KEY,
  PTC_MODE_CAPABILITY_KEY,
  SCREENSHOT_CAPABILITY_KEY,
} from '../src/shared/capability-keys.ts'
import { SHIPPED_AGENT_PRESETS } from '../src/shared/shipped-agent-presets.ts'

const SHELL_DIR = resolve(__dirname, '../src/sidepanel-dsh')
/** Han ideographs and the CJK extensions: text an `en` reader cannot be shown. */
const CJK = /[\u3400-\u9fff]/u

/** One installer plugin body: the one call every shell plugin's apply makes. */
function installer(ctx: ShellLocaleHost): void {
  installShellLocale(ctx)
}

/**
 * A client root carrying a fresh locale service whose opening locale the
 * pinned browser languages decide.
 */
function panel(languages: readonly string[]): Context {
  vi.stubGlobal('navigator', { languages, language: languages[0] ?? '' })
  const ctx = new Context()
  ctx.provide('locale', new LocaleRuntime(ctx))
  return ctx
}

/** The `{name}` placeholders of one template, sorted for comparison. */
function placeholders(template: string): string[] {
  return (template.match(/\{\w+\}/g) ?? []).sort()
}

/**
 * Source text of every shell component. The dictionary files under `locales/`
 * name every key by construction, so only the two key tables there are read.
 */
function shellSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'locales' || entry.name.startsWith('.')) continue
      shellSources(path, out)
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(readFileSync(path, 'utf8'))
    }
  }
  return out
}

/** A component rendering one dictionary entry through the render-time seat. */
function Probe(): JSX.Element {
  const t = useShellT()
  return <span>{t('shell.rail.services')}</span>
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  bindShellLocaleFace(undefined)
})

describe('shell dictionaries', () => {
  it('carries the same keys and placeholder sets in zh and en', () => {
    const zhKeys = Object.keys(shellZh).sort()
    expect(Object.keys(shellEn).sort()).toEqual(zhKeys)
    for (const key of zhKeys) {
      expect(placeholders(shellEn[key as keyof typeof shellEn]), key).toEqual(placeholders(shellZh[key as keyof typeof shellZh]))
    }
  })

  it('owns disjoint keys across the surface files', () => {
    const surfaces: ReadonlyArray<readonly string[]> = [
      Object.keys(cardsZh), Object.keys(composerZh), Object.keys(panelsZh), Object.keys(presetsZh),
      Object.keys(settingsZh), Object.keys(shellChromeZh),
    ]
    const seen = new Set<string>()
    for (const keys of surfaces) {
      for (const key of keys) {
        expect(seen.has(key), `duplicate key ${key}`).toBe(false)
        seen.add(key)
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(shellZh).sort())
  })

  it('keeps en English and both dictionaries free of invisible characters', () => {
    for (const [key, text] of Object.entries(shellEn)) {
      expect(CJK.test(text), `${key}: ${text}`).toBe(false)
    }
    for (const dictionary of [shellZh, shellEn]) {
      for (const [key, text] of Object.entries(dictionary)) {
        expect(/[\u200b\ufeff]/u.test(text), key).toBe(false)
        expect(text, key).not.toBe('')
      }
    }
  })

  it('gives the on-device catalog tables one entry per model id, with English text', () => {
    expect(Object.keys(AI_LOCAL_PURPOSE_KEYS).sort()).toEqual(Object.keys(AI_LOCAL_LABEL_KEYS).sort())
    for (const key of [...Object.values(AI_LOCAL_PURPOSE_KEYS), ...Object.values(AI_LOCAL_LABEL_KEYS)]) {
      expect(CJK.test(shellEn[key]), key).toBe(false)
    }
    expect(shellEn['aiLocal.model.embedE5Small']).toBe('multilingual-e5-small embeddings')
  })

  it('labels every built-in capability switch', async () => {    // The MCP server and PTC rows own their own cards and carry no switch label.
    const switches = Object.keys(CAPABILITY_FALLBACKS).filter(key =>
      key !== MCP_SERVER_CAPABILITY_KEY && key !== PTC_MODE_CAPABILITY_KEY)
    const ctx = panel(['en-US'])
    const holder = await ctx.plugin(installer)
    for (const key of switches) {
      expect(capabilityLabelKey(key), key).toBeDefined()
      expect(CJK.test(capabilityLabel(shellT(), key)), key).toBe(false)
    }
    expect(capabilityLabel(shellT(), SCREENSHOT_CAPABILITY_KEY)).toBe('Web page screenshots')
    expect(capabilityLabel(shellT(), MCP_SERVER_CAPABILITY_KEY)).toBe(MCP_SERVER_CAPABILITY_KEY)
    await holder.dispose()
  })

  it('labels every shipped agent preset with the roster wording, and nothing else', async () => {
    expect(Object.keys(AGENT_PRESET_LABEL_KEYS).sort()).toEqual(SHIPPED_AGENT_PRESETS.map(preset => preset.id).sort())
    for (const preset of SHIPPED_AGENT_PRESETS) {
      const keys = AGENT_PRESET_LABEL_KEYS[preset.id]
      expect(keys, `label keys of ${preset.id}`).toBeDefined()
      expect(shellZh[keys?.nameKey ?? 'presetLabel.standard.name']).toBe(preset.name)
      expect(shellZh[keys?.descriptionKey ?? 'presetLabel.standard.description']).toBe(preset.description)
    }
    const ctx = panel(['en-US'])
    const holder = await ctx.plugin(installer)
    const webResearch = SHIPPED_AGENT_PRESETS.find(preset => preset.id === 'web-research') ?? { id: 'web-research' }
    expect(agentPresetName(shellT(), webResearch)).toBe('Web researcher')
    expect(agentPresetDescription(shellT(), webResearch)).not.toMatch(CJK)
    // A user-authored preset keeps its stored text; a row without a name shows its id.
    expect(agentPresetName(shellT(), { id: 'mine', name: 'My preset' })).toBe('My preset')
    expect(agentPresetDescription(shellT(), { id: 'mine', description: 'stored text' })).toBe('stored text')
    expect(agentPresetName(shellT(), { id: 'bare' })).toBe('bare')
    expect(agentPresetDescription(shellT(), { id: 'bare' })).toBeUndefined()
    await holder.dispose()
  })

  it('has every key referenced by a shell component', () => {
    const sources = [
      ...shellSources(SHELL_DIR),
      readFileSync(join(SHELL_DIR, 'locales', 'ai-local.ts'), 'utf8'),
      readFileSync(join(SHELL_DIR, 'locales', 'capabilities.ts'), 'utf8'),
      readFileSync(join(SHELL_DIR, 'locales', 'preset-labels.ts'), 'utf8'),
    ]
    expect(sources.length).toBeGreaterThan(10)
    const dead = Object.keys(shellZh).filter(key => !sources.some(source => source.includes(`'${key}'`)))
    expect(dead).toEqual([])
  })
})

describe('shell locale seat', () => {
  it('answers from the zh dictionary before a face is bound', () => {
    expect(shellT()('shell.rail.services')).toBe('服务')
    expect(shellT()('shell.time.minutesAgo', { count: 3 })).toBe('3分钟前')
  })

  it.each([
    [['zh-CN', 'zh'], '服务'],
    [['zh-TW'], '服务'],
    [['en-US', 'en'], 'Services'],
    [['fr-FR', 'fr'], 'Services'],
    [[], 'Services'],
  ] as const)('follows the browser languages %j through the real runtime', async (languages, expected) => {
    const ctx = panel(languages)
    const holder = await ctx.plugin(installer)
    expect(shellT()('shell.rail.services')).toBe(expected)
    expect(ctx.locale.bind(SHELL_NS)('shell.brand.name')).toBe('OpenBrowserHarness')
    await holder.dispose()
  })

  it('falls back to en for an active locale without a shell dictionary', async () => {
    const ctx = panel(['zh-CN'])
    const holder = await ctx.plugin(installer)
    ctx.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' })
    act(() => { ctx.locale.setLocale('ja') })
    expect(shellT()('shell.rail.services')).toBe('Services')
    await holder.dispose()
  })

  it('re-renders components on a live locale switch', async () => {
    const ctx = panel(['zh-CN'])
    const holder = await ctx.plugin(installer)
    render(<Probe />)
    expect(screen.getByText('服务')).toBeTruthy()
    act(() => { ctx.locale.setLocale('en') })
    expect(screen.getByText('Services')).toBeTruthy()
    act(() => { ctx.locale.setLocale('zh') })
    expect(screen.getByText('服务')).toBeTruthy()
    await holder.dispose()
  })

  it('keeps the dictionaries registered until the last installer unloads', async () => {
    const ctx = panel(['en-US'])
    const first = await ctx.plugin(installer)
    const second = await ctx.plugin(installer)
    await first.dispose()
    expect(shellT()('shell.rail.services')).toBe('Services')
    await second.dispose()
    expect(shellT()('shell.rail.services')).toBe('shell.rail.services')
    // A later installer registers again instead of colliding with a stale entry.
    const third = await ctx.plugin(installer)
    expect(shellT()('shell.rail.services')).toBe('Services')
    await third.dispose()
  })

  it('registers on a newer client root while an older one still holds its registration', async () => {
    const older = panel(['zh-CN'])
    const olderHolder = await older.plugin(installer)
    const newer = panel(['en-US'])
    const newerHolder = await newer.plugin(installer)
    expect(shellT()('shell.rail.services')).toBe('Services')
    await newerHolder.dispose()
    bindShellLocaleFace(older.locale)
    // The older root's registration was never touched by the newer root's unload.
    expect(shellT()('shell.rail.services')).toBe('服务')
    await olderHolder.dispose()
  })

  it('interpolates named placeholders and leaves unknown ones verbatim', () => {
    expect(interpolate('{a} and {b}', { a: 1, b: 'two' })).toBe('1 and two')
    expect(interpolate('{a} and {b}', { a: 1 })).toBe('1 and {b}')
    expect(interpolate('plain')).toBe('plain')
  })
})
