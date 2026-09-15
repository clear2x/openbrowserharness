// @vitest-environment jsdom
/**
 * chrome-browser-provider spec: the CDP↔SW bridge that implements the
 * browser seam inside the Offscreen engine. Covers the wire envelope
 * unwrap, the error normalization (dead SW → Chinese readiness error,
 * per-call 30s deadline), the screenshot opt-in gate, and the method→op
 * mapping table.
 * @module @deepseek-ai/dsh-extension/tests/browser-provider
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BrowserRuntimeService } from '@deepseek-ai/dsh-browser'
import { SCREENSHOT_CAPABILITY_KEY, apply as applyChromeBrowserProvider } from '../src/chrome/browser-provider.ts'

/**
 * Scriptable chrome.runtime double: records every sendMessage envelope and
 * answers each from a per-op handler (or the fallback). storage.local is a
 * plain in-memory map backing the screenshot opt-in read.
 */
interface SentCall {
  op: string
  tabId: number | undefined
  params: Record<string, unknown>
}

const state: { sent: SentCall[]; respond: (call: SentCall) => unknown; storage: Map<string, unknown> } = {
  sent: [],
  respond: () => ({ ok: true, data: null }),
  storage: new Map(),
}

function installChromeDouble(): void {
  const chromeDouble = {
    runtime: {
      onConnect: { addListener: (): void => undefined, removeListener: (): void => undefined },
      onMessage: { addListener: (): void => undefined, removeListener: (): void => undefined },
      sendMessage: (message: unknown, callback?: (response?: unknown) => void): Promise<unknown> => {
        const record = message as { channel?: string; op?: string; tabId?: number; params?: Record<string, unknown>; keys?: string[] }
        // The storage client rides the SW channel when chrome.storage.local is
        // absent in this context — serve reads from the same backing map.
        if (record.channel === 'dsh-storage') {
          if (record.op === 'get') {
            const out: Record<string, unknown> = {}
            for (const key of record.keys ?? []) {
              const value = state.storage.get(key)
              if (value !== undefined) out[key] = value
            }
            const response = { ok: true, data: out }
            callback?.(response)
            return Promise.resolve(response)
          }
          const empty = { ok: true, data: {} }
          callback?.(empty)
          return Promise.resolve(empty)
        }
        const call: SentCall = { op: record.op ?? '?', tabId: record.tabId, params: record.params ?? {} }
        state.sent.push(call)
        const response = state.respond(call)
        callback?.(response)
        return Promise.resolve(response)
      },
    },
    storage: {
      local: {
        get: async (keys?: string | string[] | null): Promise<Record<string, unknown>> => {
          const names = typeof keys === 'string'
            ? [keys]
            : Array.isArray(keys)
              ? keys
              : keys === null || keys === undefined
                ? [...state.storage.keys()]
                : Object.keys(keys)
          const out: Record<string, unknown> = {}
          for (const name of names) {
            const value = state.storage.get(name)
            if (value !== undefined) out[name] = value
          }
          return out
        },
      },
    },
  }
  ;(globalThis as { chrome?: unknown }).chrome = chromeDouble
}

function deleteChrome(): void {
  delete (globalThis as { chrome?: unknown }).chrome
}

function boot(): { browser: BrowserRuntimeService } {
  const ctx = new Context()
  // The Service constructor registers itself as ctx.browser — an extra
  // provide() here would collide with that registration.
  const runtime = new BrowserRuntimeService(ctx)
  applyChromeBrowserProvider(ctx, {})
  return { browser: runtime }
}

beforeEach(() => {
  state.sent.length = 0
  state.storage.clear()
  state.respond = () => ({ ok: true, data: null })
  installChromeDouble()
})

afterEach(() => {
  deleteChrome()
})

describe('chrome-browser-provider', () => {
  it('unwraps the CDP envelope: tabs() returns the SW data payload', async () => {
    const { browser } = boot()
    state.respond = (call) => {
      expect(call.op).toBe('list_tabs')
      return { ok: true, data: [{ id: 7, title: 'T', url: 'https://x', active: true }] }
    }
    const tabs = await browser.provider.tabs()
    expect(tabs).toEqual([{ id: 7, title: 'T', url: 'https://x', active: true }])
  })

  it('maps openTab url+active onto the open_tab op params', async () => {
    const { browser } = boot()
    state.respond = (call) => {
      expect(call.op).toBe('open_tab')
      expect(call.params).toMatchObject({ url: 'https://bilibili.com', active: false })
      return { ok: true, data: { id: 3, title: '', url: 'https://bilibili.com', active: false } }
    }
    await browser.provider.openTab('https://bilibili.com', { active: false })
    expect(state.sent[0]?.op).toBe('open_tab')
  })

  it('normalizes a dead SW into the Chinese readiness error', async () => {
    const { browser } = boot()
    state.respond = () => {
      const error = new Error('Receiving end does not exist')
      Object.assign(error, { message: 'Receiving end does not exist' })
      throw error
    }
    state.respond = (call) => {
      void call
      throw Object.assign(new Error('Receiving end does not exist'))
    }
    await expect(browser.provider.tabs()).rejects.toThrow('后台服务未就绪，请稍后重试')
  })

  it('screenshot refuses before any CDP traffic while the capability is opt-in', async () => {
    const { browser } = boot()
    await expect(browser.provider.screenshot(1)).rejects.toThrow('网页截图能力未启用')
    // Only the capability storage read (op 'get') may have travelled — the
    // gate must refuse BEFORE any screenshot CDP op is forwarded.
    expect(state.sent.filter(call => call.op === 'screenshot')).toHaveLength(0)
  })

  it('screenshot forwards to the SW once the capability is opted in', async () => {
    state.storage.set(SCREENSHOT_CAPABILITY_KEY, { enabled: true })
    const { browser } = boot()
    state.respond = (call) => {
      expect(call.op).toBe('screenshot')
      expect(call.params).toMatchObject({ full_page: false })
      return { ok: true, data: { dataBase64: 'aGk=', mediaType: 'image/png', width: 10, height: 10, fullPage: false } }
    }
    const shot = await browser.provider.screenshot(1)
    expect(shot.mediaType).toBe('image/png')
  })

  it('evaluate unwraps the value envelope and nulls an undefined result', async () => {
    const { browser } = boot()
    state.respond = () => ({ ok: true, data: { value: 42 } })
    expect(await browser.provider.evaluate(1, '1+1')).toBe(42)
    state.respond = () => ({ ok: true, data: { value: null } })
    expect(await browser.provider.evaluate(1, 'void 0')).toBeNull()
  })
})
