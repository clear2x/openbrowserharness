/**
 * Hand-declared provider routes: `headersText` parsing/validation, the schema
 * envelope's field contract, and the live sync that threads parsed headers
 * through registration onto the served profiles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CUSTOM_PROVIDER_NS,
  CUSTOM_PROVIDER_SCHEMA,
  MAX_CUSTOM_HEADERS,
  customProfileFailure,
  customProviderViews,
  declaredRouteHeaders,
  isDeclaredRoute,
  parseHeadersText,
  publicHttpUrlFailure,
  syncCustomProviders,
} from '../src/chrome/custom-providers.ts'
import type { Context } from '@deepseek-ai/cordis'

// ───────────────────────── in-memory chrome.storage double ─────────────────────────

const storageData = new Map<string, unknown>()

beforeEach(() => {
  storageData.clear()
})

function installChromeDouble(): void {
  ;(globalThis as Record<string, unknown>)['chrome'] = {
    storage: {
      local: {
        get: async (keys: string[]): Promise<Record<string, unknown>> =>
          Object.fromEntries(keys.filter(key => storageData.has(key)).map(key => [key, structuredClone(storageData.get(key))])),
        set: async (items: Record<string, unknown>): Promise<void> => {
          for (const [key, value] of Object.entries(items)) storageData.set(key, value)
        },
        remove: async (keys: string[]): Promise<void> => {
          for (const key of keys) storageData.delete(key)
        },
      },
      onChanged: {
        addListener: (): void => undefined,
      },
    },
    runtime: {
      sendMessage: async (): Promise<never> => {
        throw new Error('not used by these tests')
      },
      onMessage: { addListener: (): void => undefined },
    },
  }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['chrome']
})

/** Minimal `ctx.llm` double recording what the sync registers. */
function makeCtx(): Context & {
  adapters: string[][]
  directory: Array<{ provider: string }>
  registered: Map<string, { listModels: (provider: string) => Promise<readonly unknown[]> }>
} {
  const state = {
    adapters: [] as string[][],
    directory: [] as Array<{ provider: string }>,
    registered: new Map<string, { listModels: (provider: string) => Promise<readonly unknown[]> }>(),
  }
  // The registered-directory handle IS a disposer (callable) carrying
  // `.replace` for the atomic-swap path syncCustomProviders uses.
  const registerDirectory = (
    entries: ReadonlyArray<{ provider: string }>,
  ): { replace: (next: ReadonlyArray<{ provider: string }>) => void } => {
    state.directory.splice(0, state.directory.length, ...entries)
    const handle = ((): void => { state.directory.splice(0, state.directory.length) }) as unknown as {
      replace: (next: ReadonlyArray<{ provider: string }>) => void
    }
    handle.replace = (next): void => { state.directory.splice(0, state.directory.length, ...next) }
    return handle
  }
  return {
    ...state,
    llm: {
      registerAdapter: (providers: string[], adapter: { listModels: (provider: string) => Promise<readonly unknown[]> }): (() => void) => {
        state.adapters.push(providers)
        for (const provider of providers) state.registered.set(provider, adapter)
        return () => undefined
      },
      registerConfigurableProviders: registerDirectory,
    },
  } as unknown as Context & typeof state
}

/** Store one section shape the way api-bridge's generic-namespace writer does. */
function storeProfiles(providers: Record<string, unknown>): void {
  storageData.set('dsh-api-settings-namespaces', {
    [CUSTOM_PROVIDER_NS]: { revision: 3, value: { providers } },
  })
}

const validProfile = (profile: Record<string, unknown>): Record<string, unknown> => ({
  api: 'openai',
  baseURL: 'https://gateway.example/v1',
  models: [{ id: 'acme-large', name: 'Acme Large' }],
  ...profile,
})

// ───────────────────────── parsing ─────────────────────────

describe('parseHeadersText', () => {
  it('parses one header per line and ignores blanks, comments, and empty values', () => {
    expect(parseHeadersText([
      '# gateway tenant routing',
      '',
      'X-Tenant-Id: acme',
      'X-Trace-Id:', // empty value: skipped
      '   ',
      'X-Org : acme-2 ', // whitespace around name and value
    ].join('\n'))).toEqual({ headers: { 'X-Tenant-Id': 'acme', 'X-Org': 'acme-2' } })
  })

  it('accepts CRLF input', () => {
    expect(parseHeadersText('A-B: 1\r\nC-D: 2')).toEqual({ headers: { 'A-B': '1', 'C-D': '2' } })
  })

  it('keeps a repeated name\'s last value', () => {
    expect(parseHeadersText('X-Flag: first\nX-Flag: second'))
      .toEqual({ headers: { 'X-Flag': 'second' } })
  })

  it('refuses a line without a colon, naming the line', () => {
    const parsed = parseHeadersText('X-Good: 1\njust-a-name')
    expect(parsed.headers).toBeUndefined()
    expect(parsed.failure).toMatch(/第 2 行缺少冒号/)
  })

  it('refuses a name containing spaces, naming the line', () => {
    const parsed = parseHeadersText('My Header: v')
    expect(parsed.failure).toMatch(/第 1 行的名称不能包含空格/)
  })

  it('refuses names outside the HTTP token charset', () => {
    expect(parseHeadersText('X(Bad): v').failure).toMatch(/非法字符/)
  })

  it('refuses Authorization and Content-Type with the credential guidance', () => {
    expect(parseHeadersText('Authorization: Bearer sk-x').failure).toMatch(/认证请填写 API Key，勿在此重复配置/)
    expect(parseHeadersText('content-type: application/json').failure).toMatch(/认证请填写 API Key，勿在此重复配置/)
  })

  it(`caps usable entries at ${MAX_CUSTOM_HEADERS}`, () => {
    const many = Array.from({ length: MAX_CUSTOM_HEADERS + 1 }, (_, i) => `X-H${i}: v${i}`).join('\n')
    expect(parseHeadersText(many).failure).toBe(`自定义请求头最多 ${MAX_CUSTOM_HEADERS} 条`)
    const exact = Array.from({ length: MAX_CUSTOM_HEADERS }, (_, i) => `X-H${i}: v${i}`).join('\n')
    expect(Object.keys(parseHeadersText(exact).headers ?? {})).toHaveLength(MAX_CUSTOM_HEADERS)
  })

  it('answers nothing for empty input', () => {
    expect(parseHeadersText('')).toEqual({})
    expect(parseHeadersText('# only a comment\n\n')).toEqual({})
  })
})

// ───────────────────────── profile validation ─────────────────────────

describe('customProfileFailure with headersText', () => {
  it('accepts a servable profile carrying header text', () => {
    expect(customProfileFailure('acme-gateway', validProfile({
      headersText: 'X-Tenant: acme\n# comment\n',
    }))).toBeUndefined()
  })

  it('reports a malformed line under the owning route', () => {
    expect(customProfileFailure('acme-gateway', validProfile({ headersText: 'no-colon-here' })))
      .toBe('provider "acme-gateway"：自定义请求头第 1 行缺少冒号，每行应为 "Header-Name: value"')
  })

  it('requires the field itself to be a string', () => {
    expect(customProfileFailure('acme-gateway', validProfile({ headersText: 42 })))
      .toBe('provider "acme-gateway" 的 headersText 必须是字符串')
  })

  it('leaves profiles without the field alone', () => {
    expect(customProfileFailure('acme-gateway', validProfile({}))).toBeUndefined()
  })
})

describe('customProfileFailure with api and model facts', () => {
  it('accepts every declared protocol, Responses included', () => {
    for (const api of ['anthropic', 'openai', 'openai-responses']) {
      expect(customProfileFailure('acme-gateway', validProfile({ api, models: [{ id: 'm', maxTokens: 128_000, input: ['text', 'image'] }] })))
        .toBeUndefined()
    }
  })

  it('refuses an api outside the served set, naming all three', () => {
    expect(customProfileFailure('acme-gateway', validProfile({ api: 'gemini' })))
      .toBe('provider "acme-gateway" 的 api 必须是 anthropic / openai / openai-responses 之一')
  })

  it('refuses a non-positive or fractional per-model output cap', () => {
    expect(customProfileFailure('acme-gateway', validProfile({ models: [{ id: 'm', maxTokens: 0 }] })))
      .toBe('provider "acme-gateway" 的模型 "m" 的 maxTokens 必须是正整数')
    expect(customProfileFailure('acme-gateway', validProfile({ models: [{ id: 'm', maxTokens: 1.5 }] })))
      .toBe('provider "acme-gateway" 的模型 "m" 的 maxTokens 必须是正整数')
  })

  it('refuses an input list outside the text/image set, or an empty one', () => {
    expect(customProfileFailure('acme-gateway', validProfile({ models: [{ id: 'm', input: ['text', 'video'] }] })))
      .toBe('provider "acme-gateway" 的模型 "m" 的 input 只能由 "text" / "image" 组成')
    expect(customProfileFailure('acme-gateway', validProfile({ models: [{ id: 'm', input: [] }] })))
      .toBe('provider "acme-gateway" 的模型 "m" 的 input 只能由 "text" / "image" 组成')
  })
})

describe('CUSTOM_PROVIDER_SCHEMA', () => {
  it('declares headersText as a textarea-roled string beside baseURL', () => {
    const inner = ((CUSTOM_PROVIDER_SCHEMA.dict as unknown as {
      providers: { inner: { dict: Record<string, { type: string; meta?: { role?: string; description?: string } }> } }
    })).providers.inner.dict
    expect(inner.headersText?.type).toBe('string')
    expect(inner.headersText?.meta?.role).toBe('textarea')
    expect(inner.headersText?.meta?.description).toContain('Header-Name: value')
    // The pre-existing contract stays intact alongside the new field.
    expect(inner.api?.type).toBe('union')
  })

  it('offers the three served protocols in settings-page order', () => {
    const api = ((CUSTOM_PROVIDER_SCHEMA.dict as unknown as {
      providers: { inner: { dict: { api: { list: Array<{ value: string }> } } } }
    })).providers.inner.dict.api
    expect(api.list.map(entry => entry.value)).toEqual(['anthropic', 'openai', 'openai-responses'])
  })

  it('declares the per-model output cap and the input-modality union', () => {
    const dict = (CUSTOM_PROVIDER_SCHEMA.dict as unknown as {
      providers: { inner: { dict: Record<string, { inner?: { dict?: Record<string, unknown> } }> } }
    }).providers.inner.dict
    const models = (dict.models?.inner?.dict ?? {}) as Record<string, {
      type?: string
      inner?: { list?: Array<{ value: string }> }
    }>
    expect(models.maxTokens?.type).toBe('number')
    expect(models.input?.type).toBe('array')
    expect(models.input?.inner?.list?.map(entry => entry.value)).toEqual(['text', 'image'])
  })
})

// ───────────────────────── live sync ─────────────────────────

describe('syncCustomProviders with headersText', () => {
  it('threads parsed headers onto the live route and drops it with the route', async () => {
    installChromeDouble()
    const ctx = makeCtx()
    storeProfiles({
      'acme-openai': validProfile({ displayName: 'Acme OpenAI', headersText: '# tenant\nX-Tenant: acme' }),
      'acme-anthropic': validProfile({
        api: 'anthropic',
        displayName: 'Acme Anthropic',
        headersText: 'X-Zone: anthropic',
      }),
    })

    await syncCustomProviders(ctx)

    // Storage-insertion order drives registration; routes assert flat.
    expect(ctx.adapters.flat().sort()).toEqual(['acme-anthropic', 'acme-openai'])
    expect(isDeclaredRoute('acme-openai')).toBe(true)
    expect(declaredRouteHeaders('acme-openai')).toEqual({ 'X-Tenant': 'acme' })
    expect(declaredRouteHeaders('acme-anthropic')).toEqual({ 'X-Zone': 'anthropic' })
    expect(customProviderViews().map(view => view.provider).sort())
      .toEqual(['acme-anthropic', 'acme-openai'])

    // Removing the routes from storage withdraws everything the sync built.
    storeProfiles({})
    await syncCustomProviders(ctx)

    expect(isDeclaredRoute('acme-openai')).toBe(false)
    expect(declaredRouteHeaders('acme-openai')).toBeUndefined()
    expect(customProviderViews()).toEqual([])
    expect(ctx.directory).toEqual([])
  })

  it('skips a stored profile whose headersText no longer validates', async () => {
    installChromeDouble()
    const ctx = makeCtx()
    storeProfiles({ 'broken-route': validProfile({ headersText: 'Authorization: Bearer x' }) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await syncCustomProviders(ctx)

    expect(ctx.adapters).toEqual([])
    expect(isDeclaredRoute('broken-route')).toBe(false)
    // The assertion must ride the recorded calls, which mockRestore() discards.
    expect(warn).toHaveBeenCalledWith('[custom-providers] 跳过无效的已声明路由 broken-route')
    warn.mockRestore()
  })

  it('serves a Responses route and threads declared model facts into the adapters', async () => {
    installChromeDouble()
    const ctx = makeCtx()
    storeProfiles({
      'acme-responses': validProfile({
        api: 'openai-responses',
        displayName: 'Acme Responses',
        models: [{ id: 'acme-large', maxTokens: 4096 }, { id: 'acme-vision', input: ['text', 'image'] }],
      }),
      'acme-openai': validProfile({
        api: 'openai',
        displayName: 'Acme OpenAI',
        models: [{ id: 'gpt-x', input: ['text', 'image'] }],
      }),
    })

    await syncCustomProviders(ctx)

    expect(ctx.adapters.flat()).toEqual(['acme-responses', 'acme-openai'])
    // The declared input modalities reach the seam through the adapters'
    // model facts, replacing the text-only floor exactly where declared.
    const responsesModels = await ctx.registered.get('acme-responses')!.listModels('acme-responses')
    expect(responsesModels.map(model => (model as { id: string; inputModalities?: string[] }).inputModalities))
      .toEqual([['text'], ['text', 'image']])
    const openaiModels = await ctx.registered.get('acme-openai')!.listModels('acme-openai')
    // The chat-completions family adapter serializes text only in this host,
    // so a declared image modality is intersected away — the seam reports the
    // capability it can actually carry and the bridge refuses image prompts
    // at admission instead of failing mid-turn on a durable message.
    expect(openaiModels.map(model => (model as { inputModalities?: string[] }).inputModalities))
      .toEqual([['text']])
  })
})

// ───────────────────────── SSRF guard ─────────────────────────

describe('publicHttpUrlFailure', () => {
  it('refuses loopback, private, and reserved endpoints', () => {
    expect(publicHttpUrlFailure('http://localhost:9999/v1')).toMatch(/本机/)
    expect(publicHttpUrlFailure('http://127.0.0.1:11434/v1')).toMatch(/环回|私有/)
    expect(publicHttpUrlFailure('http://10.0.0.5/v1')).toMatch(/私有/)
    expect(publicHttpUrlFailure('http://192.168.1.1/v1')).toMatch(/私有/)
    expect(publicHttpUrlFailure('http://169.254.1.1/v1')).toMatch(/链路本地/)
    expect(publicHttpUrlFailure('https://api.openai.com/v1')).toBeUndefined()
  })

  it("allowlists the local Ollama endpoint's exact base URL", () => {
    expect(publicHttpUrlFailure('http://localhost:11434/v1')).toBeUndefined()
    expect(publicHttpUrlFailure('http://localhost:11434/v1/')).toBeUndefined()
    // Any other loopback address, port, or path stays refused.
    expect(publicHttpUrlFailure('http://localhost:11434/other')).toMatch(/本机/)
    expect(publicHttpUrlFailure('http://localhost:9999/v1')).toMatch(/本机/)
    expect(publicHttpUrlFailure('http://127.0.0.1:11434/v1')).toMatch(/环回|私有/)
  })
})
