/**
 * chrome-llm catalog spec: the Models-page save → composer-picker chain.
 *
 * The composer's model picker filters `llm.models` groups by
 * `resolveStoredApiKey` — a key stored through the credentials service must
 * therefore make the provider's group resolvable. The live failure (the
 * picker showing 「暂无已配置的模型」 after a successful save) reproduced
 * here against the REAL chrome-llm registration: the offscreen document has
 * no `chrome.storage` bindings, so the storage client relays every read and
 * write through `runtime.sendMessage` onto the `dsh-storage` channel — the
 * stub answers that channel from an in-memory map, the same envelope the
 * background service worker's handleStorageRequest serves.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { FiberState } from '@deepseek-ai/cordis'
import ChromeCredentialProvider from '../src/chrome/credentials.ts'
import * as chromeLlm from '../src/chrome/llm.ts'
import { resolveStoredApiKey } from '../src/chrome/llm-providers.ts'

const storageMap = new Map<string, string>()

/** The cordis loader's active fiber state (the big spec's local constant). */
const FIBER_ACTIVE = 2

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).chrome = {
    runtime: {
      sendMessage: async (req: {
        channel?: string
        op?: string
        keys?: string[]
        items?: Record<string, unknown>
      }) => {
        if (req.channel !== 'dsh-storage') throw new Error(`stub: unexpected channel ${String(req.channel)}`)
        if (req.op === 'get') {
          const data: Record<string, unknown> = {}
          for (const key of req.keys ?? []) {
            if (storageMap.has(key)) data[key] = storageMap.get(key)
          }
          return { ok: true, data }
        }
        if (req.op === 'set') {
          for (const [key, value] of Object.entries(req.items ?? {})) storageMap.set(key, String(value))
          return { ok: true }
        }
        if (req.op === 'remove') {
          for (const key of req.keys ?? []) storageMap.delete(key)
          return { ok: true }
        }
        throw new Error(`stub: unexpected op ${String(req.op)}`)
      },
      onMessage: { addListener() {} },
    },
  }
})

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Loader)
  // The loader resolves plugin modules through this artifact map (the big
  // spec's MODULES table, narrowed to the three rows this spec needs).
  const MODULES: Record<string, object> = {
    '@deepseek-ai/dsh-llm': LlmRuntime,
    'chrome-credentials': ChromeCredentialProvider,
    'chrome-llm': chromeLlm,
  }
  ctx.loader.internal = {
    import: async (name: string) => {
      const mod = MODULES[name]
      if (mod === undefined) throw new Error(`引擎宿主未捆绑插件模块：${name}`)
      return mod
    },
  } as never
  await ctx.loader.create({ name: '@deepseek-ai/dsh-llm' })
  await ctx.loader.create({ name: 'chrome-credentials' })
  await ctx.loader.create({ name: 'chrome-llm' })
  const settleDeadline = Date.now() + 5_000
  let notActive: string[] = ['pending']
  while (Date.now() < settleDeadline) {
    notActive = Array.from(ctx.loader.entries())
      .filter(entry => entry.fiber === undefined || entry.fiber.state !== (FIBER_ACTIVE as FiberState))
      .map(entry => `${entry.options.name}(${entry.fiber?.state ?? 'fiberless'})`)
    if (notActive.length === 0) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  expect(notActive).toEqual([])
  return ctx
}

describe('chrome-llm catalog', () => {
  let ctx: Context

  beforeAll(async () => {
    ctx = await boot()
  })

  it('resolves a stored key through the credential storage and lists the route catalog', async () => {
    await ctx.credentials.set(credentialRef('ZHIPU_CODING_API_KEY'), 'sk-catalog')
    // The exact read the composer's picker filter runs.
    const stored = await resolveStoredApiKey('zhipu-coding', 'ZHIPU_CODING_API_KEY')
    expect(stored).toBe('sk-catalog')
    // The registered route's catalog — the other half of the picker filter.
    const models = await ctx.llm.listModels('zhipu-coding')
    expect(models.length).toBeGreaterThan(0)
  })
})
