/**
 * Provider-preset registry guarantees: the sole DeepSeek preset's integrity and
 * registration behavior against a minimal ctx.llm double.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROVIDER,
  PROVIDER_PRESETS,
  configurableProviderViews,
  keyRefOf,
  presetOf,
  registerExtensionProviders,
} from '../src/chrome/llm-providers.ts'

describe('provider presets', () => {
  it('ships DeepSeek as the sole official preset', () => {
    expect(PROVIDER_PRESETS.map(preset => preset.id)).toEqual(['deepseek', 'zhipu', 'zhipu-coding'])
  })

  it('the preset carries base URL, default model, catalog, display name, and a key ref', () => {
    const [preset] = PROVIDER_PRESETS
    expect(preset).toBeDefined()
    if (preset === undefined) throw new Error('unreachable')
    expect(preset.baseUrl).toBe('https://api.deepseek.com')
    expect(preset.defaultModel).toBe('deepseek-v4-flash')
    expect(preset.models.map(entry => entry.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    // The default model is part of the advisory catalog.
    expect(preset.models.some(entry => entry.id === preset.defaultModel)).toBe(true)
    expect(preset.displayName).toBe(preset.label)
    expect(preset.protocol).toBe('openai')
    expect(keyRefOf(preset)).toBe('DEEPSEEK_API_KEY')
    expect(DEFAULT_PROVIDER).toBe('deepseek')
    expect(presetOf('deepseek')).toBe(preset)
    // Other vendors are not presets: the Models page routes them through the
    // 添加供应商 custom flow.
    expect(presetOf('openai')).toBeUndefined()
    expect(presetOf('anthropic')).toBeUndefined()
    expect(presetOf('ollama')).toBeUndefined()
    expect(presetOf('nope')).toBeUndefined()
  })

  it('every preset model declares its input modalities', () => {
    for (const preset of PROVIDER_PRESETS) {
      for (const model of preset.models) {
        expect(model.input).toBeDefined()
        expect(model.input).toContain('text')
        for (const modality of model.input ?? []) {
          expect(modality === 'text' || modality === 'image').toBe(true)
        }
      }
    }
  })

  it('declares the text floor on every catalog model', () => {
    const inputOf = (model: string) =>
      presetOf('deepseek')!.models.find(entry => entry.id === model)!.input
    expect(inputOf('deepseek-v4-flash')).toEqual(['text'])
    expect(inputOf('deepseek-v4-pro')).toEqual(['text'])
  })
})

describe('registerExtensionProviders', () => {
  const makeCtx = () => {
    const adapters: Array<{ providers: string[] }> = []
    const directory: Array<{ provider: string; displayName: string; settingsNs: string }> = []
    const registered = new Map<string, { listModels: (provider: string) => Promise<readonly unknown[]> }>()
    return {
      adapters,
      directory,
      registered,
      llm: {
        registerAdapter: (providers: string[], adapter: { listModels: (provider: string) => Promise<readonly unknown[]> }): void => {
          adapters.push({ providers })
          for (const provider of providers) registered.set(provider, adapter)
        },
        registerConfigurableProviders: (entries: ReadonlyArray<{ provider: string; displayName: string; settingsNs: string }>): void => {
          directory.push(...entries.map(entry => ({ ...entry })))
        },
      },
    }
  }

  it('registers one adapter route and one directory entry per preset', () => {
    const ctx = makeCtx()
    registerExtensionProviders(ctx as never, () => ({ provider: 'deepseek', baseUrl: '', model: '' }))
    expect(ctx.adapters).toHaveLength(PROVIDER_PRESETS.length)
    expect(ctx.adapters.flatMap(entry => entry.providers)).toEqual(PROVIDER_PRESETS.map(preset => preset.id))
    expect(ctx.directory.map(entry => entry.provider)).toEqual(PROVIDER_PRESETS.map(preset => preset.id))
    for (const entry of ctx.directory) {
      expect(entry.settingsNs).toBe('llm-deepseek')
      expect(entry.displayName.length).toBeGreaterThan(0)
    }
  })

  it('threads preset input modalities to the seam', async () => {
    const ctx = makeCtx()
    registerExtensionProviders(ctx as never, () => ({ provider: 'deepseek', baseUrl: '', model: '' }))
    const deepseekModels = await ctx.registered.get('deepseek')!.listModels('deepseek')
    expect(deepseekModels.map(model => (model as { id: string; inputModalities?: string[] }).inputModalities))
      .toEqual([['text'], ['text']])
  })

  it('threads the zhipu vision modalities through both routes', () => {
    for (const id of ['zhipu', 'zhipu-coding'] as const) {
      const preset = PROVIDER_PRESETS.find(candidate => candidate.id === id)
      expect(preset).toBeDefined()
      for (const model of preset!.models) {
        expect(model.input).toEqual(['text', 'image'])
      }
    }
  })

  it('directory views mirror the preset registry', () => {
    const views = configurableProviderViews()
    expect(views.map(view => view.provider)).toEqual(PROVIDER_PRESETS.map(preset => preset.id))
  })

  it('user-added preset models merge into the catalog and preset rows win on duplicate ids', async () => {
    const { setPresetUserModels } = await import('../src/chrome/llm-providers.ts')
    setPresetUserModels({
      models: {
        deepseek: [
          { id: 'deepseek-v4-pro', input: ['image'] },
          { id: 'deepseek-v5-ultra', contextWindow: 2_000_000, input: ['text', 'image'] },
        ],
      },
    })
    const ctx = makeCtx()
    registerExtensionProviders(ctx as never, () => ({ provider: '', baseUrl: '', model: '' }))
    const models = await ctx.registered.get('deepseek')!.listModels('deepseek')
    const ids = models.map(model => (model as { id: string }).id)
    expect(ids).toContain('deepseek-v5-ultra')
    // The OpenAI-compat route floors modalities at text by design; the merge
    // surfaces as the row joining (and a duplicate id staying singular).
    expect(ids.filter(id => id === 'deepseek-v4-pro')).toHaveLength(1)
    expect(ids.filter(id => id === 'deepseek-v5-ultra')).toHaveLength(1)
    // Malformed writes are IGNORED (the loaded table stands); an explicit
    // empty table drops the additions back to the shipped catalog.
    setPresetUserModels({ models: 'nope' })
    const keptCtx = makeCtx()
    registerExtensionProviders(keptCtx as never, () => ({ provider: '', baseUrl: '', model: '' }))
    const kept = await keptCtx.registered.get('deepseek')!.listModels('deepseek')
    expect(kept.map(model => (model as { id: string }).id)).toContain('deepseek-v5-ultra')
    setPresetUserModels({ models: {} })
    const clearedCtx = makeCtx()
    registerExtensionProviders(clearedCtx as never, () => ({ provider: '', baseUrl: '', model: '' }))
    const cleared = await clearedCtx.registered.get('deepseek')!.listModels('deepseek')
    expect(cleared.map(model => (model as { id: string }).id)).not.toContain('deepseek-v5-ultra')
  })
})
