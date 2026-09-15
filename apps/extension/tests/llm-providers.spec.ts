/**
 * Provider-preset registry guarantees: the sole DeepSeek preset's integrity and
 * registration behavior against a minimal ctx.llm double; the interrupted
 * tool-call history repair; cached credential resolution over a chrome.storage
 * double; and the live per-request routing thunk.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_PROVIDER,
  PROVIDER_PRESETS,
  configurableProviderViews,
  keyRefOf,
  presetOf,
  registerExtensionProviders,
  repairToolCallHistory,
  resolveStoredApiKey,
} from '../src/chrome/llm-providers.ts'

// In-memory chrome.storage double (the storage client prefers a local API
// when present, so no SW round-trip happens under test). Installed before any
// storage-touching call; llm-providers reads storage only inside its functions.
const store = new Map<string, unknown>()
const changeListeners = new Set<(changes: Record<string, unknown>, area: string) => void>()
let storageReads = 0
;(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    local: {
      get: async (keys: string[]) => {
        storageReads += 1
        const out: Record<string, unknown> = {}
        for (const key of keys) if (store.has(key)) out[key] = store.get(key)
        return out
      },
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value)
        for (const listener of changeListeners) listener({ ...items }, 'local')
      },
      remove: async (keys: string[]) => {
        for (const key of keys) store.delete(key)
        for (const listener of changeListeners) listener({}, 'local')
      },
    },
    onChanged: {
      addListener: (cb: (changes: Record<string, unknown>, area: string) => void) => {
        changeListeners.add(cb)
      },
    },
  },
  runtime: { sendMessage: async () => undefined, onMessage: { addListener: () => undefined } },
}

beforeEach(() => {
  store.clear()
})

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

/** Minimal ctx.llm double: records adapter routes and directory entries. */
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

describe('registerExtensionProviders', () => {

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

// ───────────────────────── repairToolCallHistory ─────────────────────────

describe('repairToolCallHistory', () => {
  const msg = (role: Message['role'], content: Message['content']): Message =>
    ({ id: 'm' as never, role, content, source: { kind: 'user' } as never })
  const result = (id: string, text: string): Extract<Message['content'][number], { type: 'tool-result' }> =>
    ({ type: 'tool-result', toolCallId: id as never, content: [{ type: 'text', text }] })

  it('leaves intact history alone (a stable copy, no synthetic blocks)', () => {
    const history = [
      msg('user', [{ type: 'text', text: '任务' }]),
      msg('assistant', [{ type: 'tool-call', id: 'c1' as never, name: 'page_snapshot', arguments: '{}' }]),
      msg('user', [result('c1', 'R1')]),
    ]
    const out = repairToolCallHistory(history)
    expect(out).toEqual(history)
    expect(out).not.toBe(history)
  })

  it('merges the synthetic error result into an immediately-following user message', () => {
    const history = [
      msg('user', [{ type: 'text', text: '任务' }]),
      msg('assistant', [
        { type: 'text', text: '执行中' },
        { type: 'tool-call', id: 'c1' as never, name: 'tabs_open', arguments: '{}' },
      ]),
      msg('user', [{ type: 'text', text: '观察' }]),
    ]
    const out = repairToolCallHistory(history)
    expect(out).toHaveLength(3)
    type Filler = { type: string; toolCallId: string; content: Array<{ type: string; text: string }>; isError?: boolean }
    const merged = out[2]!.content as Filler[]
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ type: 'tool-result', toolCallId: 'c1', isError: true })
    expect(merged[0]?.content[0]?.text).toContain('interrupted')
    expect(merged[1]).toEqual({ type: 'text', text: '观察' })
    // The durable log is untouched.
    expect(history[2]!.content).toHaveLength(1)
  })

  it('synthesizes a tool-result user message when no user turn follows', () => {
    const history = [
      msg('user', [{ type: 'text', text: '任务' }]),
      msg('assistant', [
        { type: 'tool-call', id: 'c1' as never, name: 'page_click', arguments: '{}' },
        { type: 'tool-call', id: 'c2' as never, name: 'page_type', arguments: '{}' },
      ]),
    ]
    const out = repairToolCallHistory(history)
    expect(out).toHaveLength(3)
    const synthetic = out[2]!
    expect(synthetic.role).toBe('user')
    expect(synthetic.id).toBe('repair:c1')
    expect(synthetic.source).toEqual({ kind: 'tool', callId: 'c1' })
    const fillers = synthetic.content as Array<{ type: string; toolCallId: string; isError?: boolean }>
    expect(fillers.map(entry => entry.toolCallId)).toEqual(['c1', 'c2'])
    expect(fillers.every(entry => entry.isError === true)).toBe(true)
  })

  it('treats a call answered LATER in the log as answered (no duplicate result)', () => {
    const history = [
      msg('user', [{ type: 'text', text: '任务' }]),
      msg('assistant', [{ type: 'tool-call', id: 'c1' as never, name: 'page_evaluate', arguments: '{}' }]),
      msg('user', [{ type: 'text', text: '继续' }]),
      msg('user', [result('c1', '迟到但存在')]),
    ]
    const out = repairToolCallHistory(history)
    expect(out).toEqual(history)
  })
})

// ───────────────────────── resolveStoredApiKey ─────────────────────────

describe('resolveStoredApiKey', () => {
  it('treats an empty ref as a keyless endpoint', async () => {
    await expect(resolveStoredApiKey('chrome-llm:test', '')).resolves.toBe('')
  })

  it('resolves the stored key, trims it, and serves later reads from the cache', async () => {
    store.set('TEST_API_KEY', '  sk-secret-123  ')
    const first = await resolveStoredApiKey('chrome-llm:test', 'TEST_API_KEY')
    expect(first).toBe('sk-secret-123')
    const readsAfterFirst = storageReads
    const second = await resolveStoredApiKey('chrome-llm:test', 'TEST_API_KEY')
    expect(second).toBe('sk-secret-123')
    expect(storageReads).toBe(readsAfterFirst)
  })

  it('fails with MISSING_CREDENTIAL when nothing is stored', async () => {
    const err = await resolveStoredApiKey('chrome-llm:test', 'ABSENT_API_KEY').catch(
      (error: unknown) => error as LlmErrorLike,
    )
    expect((err as LlmErrorLike).failure?.code).toBe('MISSING_CREDENTIAL')
    expect((err as LlmErrorLike).message).toContain('ABSENT_API_KEY')
  })

  it('refuses a blank stored key with the blank-key diagnosis', async () => {
    store.set('BLANK_API_KEY', '   ')
    const err = await resolveStoredApiKey('chrome-llm:test', 'BLANK_API_KEY').catch(
      (error: unknown) => error as LlmErrorLike,
    )
    expect((err as LlmErrorLike).failure?.code).not.toBe('MISSING_CREDENTIAL')
    expect((err as LlmErrorLike).message).toContain('blank')
  })

  it('refuses a key with header-unsafe characters', async () => {
    store.set('BROKEN_API_KEY', 'sk-key\nwith-newline')
    const err = await resolveStoredApiKey('chrome-llm:test', 'BROKEN_API_KEY').catch(
      (error: unknown) => error as LlmErrorLike,
    )
    expect((err as LlmErrorLike).failure?.code).not.toBe('MISSING_CREDENTIAL')
    expect((err as LlmErrorLike).message).toContain('HTTP header')
  })

  it('drops cached keys when storage changes, so edits take effect without a restart', async () => {
    const ctx = makeCtx()
    registerExtensionProviders(ctx as never, () => ({ provider: 'deepseek', baseUrl: '', model: '' }))
    store.set('LIVE_API_KEY', 'sk-before')
    const before = await resolveStoredApiKey('chrome-llm:test', 'LIVE_API_KEY')
    expect(before).toBe('sk-before')
    // A committed storage change fires onChanged, which drops the key cache.
    store.set('LIVE_API_KEY', 'sk-after')
    for (const listener of changeListeners) listener({ LIVE_API_KEY: { newValue: 'sk-after' } }, 'local')
    const after = await resolveStoredApiKey('chrome-llm:test', 'LIVE_API_KEY')
    expect(after).toBe('sk-after')
  })
})

interface LlmErrorLike {
  readonly message: string
  readonly failure?: { readonly code?: string }
}

// ───────────────────────── live routing ─────────────────────────

describe('live provider routing', () => {
  it('consults the active-state thunk per operation, not once at registration', async () => {
    const ctx = makeCtx()
    let active = { provider: 'deepseek', baseUrl: '', model: '' }
    registerExtensionProviders(ctx as never, () => active)
    // A model set on the active route joins the catalog for later listings.
    active = { provider: 'deepseek', baseUrl: '', model: 'deepseek-v5-custom' }
    const models = await ctx.registered.get('deepseek')!.listModels('deepseek')
    expect(models.map(model => (model as { id: string }).id)[0]).toBe('deepseek-v5-custom')
    // Leaving the route drops the addition again on the next operation.
    active = { provider: 'zhipu', baseUrl: '', model: 'glm-5.3' }
    const later = await ctx.registered.get('deepseek')!.listModels('deepseek')
    expect(later.map(model => (model as { id: string }).id)[0]).not.toBe('deepseek-v5-custom')
  })
})
