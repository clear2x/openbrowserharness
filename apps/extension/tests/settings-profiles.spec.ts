/**
 * Per-provider profile caching: each provider's baseUrl/model survive route
 * switches (switch away and back loses nothing), legacy single-field settings
 * migrate into the active provider's profile, and empty writes clear fields.
 */

import { beforeEach, describe, expect, it } from 'vitest'

// In-memory chrome.storage double (the storage client prefers a local API
// when present, so no SW round-trip happens under test).
const store = new Map<string, unknown>()
const changeListeners: Record<string, (changes: Record<string, unknown>, area: string) => void> = {}
;(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    local: {
      get: async (keys: string[]) => {
        const out: Record<string, unknown> = {}
        for (const key of keys) if (store.has(key)) out[key] = store.get(key)
        return out
      },
      set: async (items: Record<string, unknown>) => {
        const changes: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(items)) {
          changes[key] = { newValue: value }
          store.set(key, value)
        }
        for (const listener of Object.values(changeListeners)) listener(changes, 'local')
      },
      remove: async (keys: string[]) => {
        for (const key of keys) store.delete(key)
        for (const listener of Object.values(changeListeners)) listener({}, 'local')
      },
    },
    onChanged: {
      addListener: (cb: (changes: Record<string, unknown>, area: string) => void) => {
        changeListeners['t'] = cb
      },
    },
  },
  runtime: { sendMessage: async () => undefined, onMessage: { addListener: () => {} } },
}

const {
  DEFAULT_PROVIDER,
  currentEngineConfig,
  initSettingsCache,
  providerProfile,
  writeEngineSettings,
} = await import('../src/chrome/settings-store.ts')

beforeEach(async () => {
  store.clear()
  initSettingsCache()
  await new Promise(resolve => setTimeout(resolve, 20)) // let the async cache prime settle
})

describe('per-provider profiles', () => {
  it('keeps each provider\'s baseUrl/model across switches', async () => {
    // Configure openai with a custom endpoint and model.
    await writeEngineSettings({ provider: 'openai', baseUrl: 'https://proxy.example/v1', model: 'gpt-4o' })
    expect(currentEngineConfig()).toEqual({ provider: 'openai', baseUrl: 'https://proxy.example/v1', model: 'gpt-4o' })

    // Switch to deepseek with different values.
    await writeEngineSettings({ provider: 'deepseek', baseUrl: '', model: 'deepseek-v4-pro' })
    expect(currentEngineConfig()).toEqual({ provider: 'deepseek', baseUrl: '', model: 'deepseek-v4-pro' })

    // Switch back: openai's profile is intact — no re-entry needed.
    await writeEngineSettings({ provider: 'openai' })
    expect(currentEngineConfig()).toEqual({ provider: 'openai', baseUrl: 'https://proxy.example/v1', model: 'gpt-4o' })
  })

  it('exposes any provider profile without switching', async () => {
    await writeEngineSettings({ provider: 'anthropic', baseUrl: 'https://relay.example', model: 'claude-opus-4-1' })
    await writeEngineSettings({ provider: DEFAULT_PROVIDER })
    expect(providerProfile('anthropic')).toEqual({ baseUrl: 'https://relay.example', model: 'claude-opus-4-1' })
    expect(currentEngineConfig().provider).toBe(DEFAULT_PROVIDER)
  })

  it('migrates legacy single-field settings into the active provider profile', async () => {
    store.set('dsh-engine-settings', { provider: 'moonshot', baseUrl: 'https://legacy.example/v1', model: 'kimi-k2' })
    await writeEngineSettings({ model: 'moonshot-v1-8k' })
    const raw = store.get('dsh-engine-settings') as { provider: string; profiles: Record<string, { baseUrl?: string; model?: string }> }
    expect(raw.provider).toBe('moonshot')
    expect(raw.profiles.moonshot).toEqual({ baseUrl: 'https://legacy.example/v1', model: 'moonshot-v1-8k' })
  })

  it('clearing a field removes it from that provider only', async () => {
    await writeEngineSettings({ provider: 'openai', baseUrl: 'https://a.example', model: 'gpt-4o' })
    await writeEngineSettings({ provider: 'zhipu', baseUrl: 'https://b.example', model: 'glm-4.5' })
    await writeEngineSettings({ provider: 'openai', baseUrl: '' })
    expect(providerProfile('openai')).toEqual({ baseUrl: '', model: 'gpt-4o' })
    expect(providerProfile('zhipu')).toEqual({ baseUrl: 'https://b.example', model: 'glm-4.5' })
  })
})
