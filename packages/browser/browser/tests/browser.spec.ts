/**
 * BrowserRuntimeService coverage: registration lifecycle, execution-time
 * provider resolution (configured id / single / ambiguity / none), the
 * provider-updated event, and defensive provider-shape rejection.
 * @module @deepseek-ai/dsh-browser/tests/browser
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BrowserRuntimeService from '../src/index.ts'
import type { BrowserProvider, PageSnapshot, TabInfo } from '../src/index.ts'

/** A scripted provider recording every call. */
function makeProvider(id: string, overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  const tab: TabInfo = { tabId: 1, title: '示例页', url: 'https://example.com', active: true, windowId: 1, index: 0 }
  return {
    id,
    tabs: () => Promise.resolve([tab]),
    switchTab: () => Promise.resolve(),
    openTab: url => Promise.resolve({ ...tab, tabId: 2, url }),
    closeTab: () => Promise.resolve(),
    navigate: () => Promise.resolve(),
    snapshot: () => Promise.resolve(makeSnapshot(1)),
    screenshot: () => Promise.resolve({ data: new Uint8Array(), mediaType: 'image/png', width: 0, height: 0 }),
    clickSelector: () => Promise.resolve(),
    clickPoint: () => Promise.resolve(),
    typeText: () => Promise.resolve(),
    pressKey: () => Promise.resolve(),
    scroll: () => Promise.resolve(),
    waitFor: () => Promise.resolve(),
    evaluate<T>(): Promise<T> {
      return Promise.resolve(undefined as unknown as T)
    },
    ...overrides,
  }
}

function makeSnapshot(tabId: number): PageSnapshot {
  return {
    tabId,
    url: 'https://example.com',
    title: '示例页',
    timestamp: 1_000,
    viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
    elements: [
      {
        index: 0,
        tag: 'button',
        selector: '#submit',
        text: '提交',
        rect: { x: 600, y: 700, width: 80, height: 40 },
        center: { x: 640, y: 720 },
        interactive: true,
      },
    ],
  }
}

/** Mount the seam on a fresh root context with the given config. */
async function mountBrowser(config: ConstructorParameters<typeof BrowserRuntimeService>[1] = {}) {
  const ctx = new Context()
  await ctx.plugin(BrowserRuntimeService, config)
  return { ctx, browser: ctx.browser }
}

describe('BrowserRuntimeService registration', () => {
  it('registers a provider and unregisters it via the returned disposer', async () => {
    const { browser } = await mountBrowser()
    const dispose = browser.register(makeProvider('cdp'))
    expect(browser.provider.id).toBe('cdp')
    await expect(browser.provider.tabs()).resolves.toHaveLength(1)

    dispose()
    expect(() => browser.provider).toThrow('尚未注册任何浏览器 provider')
  })

  it('disposes registrations with the contributing fiber (HMR safety)', async () => {
    const { ctx, browser } = await mountBrowser()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.browser.register(makeProvider('cdp'))
    }, { inject: ['browser'] }))
    expect(browser.provider.id).toBe('cdp')
    await fiber.dispose()
    expect(() => browser.provider).toThrow('尚未注册任何浏览器 provider')
  })

  it('rejects a duplicate id', async () => {
    const { browser } = await mountBrowser()
    browser.register(makeProvider('cdp'))
    expect(() => browser.register(makeProvider('cdp'))).toThrow('id 为 "cdp" 的浏览器 provider 已注册')
  })

  it('rejects malformed provider ids and missing methods', async () => {
    const { browser } = await mountBrowser()
    expect(() => browser.register(makeProvider(' has space '))).toThrow(/provider\.id/)
    expect(() => browser.register(makeProvider(''))).toThrow(/provider\.id/)
    const partial = makeProvider('partial') as unknown as Record<string, unknown>
    delete partial['clickPoint']
    expect(() => browser.register(partial as unknown as BrowserProvider)).toThrow('缺少必需的方法 clickPoint()')
  })

  it('emits browser/provider-updated with the resulting ids on register and dispose', async () => {
    const { ctx, browser } = await mountBrowser()
    const events: string[][] = []
    ctx.on('browser/provider-updated', ids => events.push([...ids]))
    const disposeA = browser.register(makeProvider('a'))
    const disposeB = browser.register(makeProvider('b'))
    disposeA()
    disposeB()
    expect(events).toEqual([['a'], ['a', 'b'], ['b'], []])
    expect(browser.providerIds).toEqual([])
  })
})

describe('BrowserRuntimeService provider resolution', () => {
  it('auto-selects the single registered provider', async () => {
    const { browser } = await mountBrowser()
    browser.register(makeProvider('cdp'))
    expect(browser.provider.id).toBe('cdp')
  })

  it('rejects resolution with a Chinese error when nothing is registered', async () => {
    const { browser } = await mountBrowser()
    expect(() => browser.provider).toThrow('browser：尚未注册任何浏览器 provider，无法执行浏览器操作')
  })

  it('rejects ambiguity by listing the candidates', async () => {
    const { browser } = await mountBrowser()
    browser.register(makeProvider('a'))
    browser.register(makeProvider('b'))
    expect(() => browser.provider).toThrow('注册了多个浏览器 provider（a、b），请在配置中指定 defaultProviderId')
  })

  it('runs the configured id even when another provider is registered', async () => {
    const { browser } = await mountBrowser({ defaultProviderId: 'b' })
    browser.register(makeProvider('a'))
    browser.register(makeProvider('b'))
    expect(browser.provider.id).toBe('b')
  })

  it('rejects a configured id that is not registered', async () => {
    const { browser } = await mountBrowser({ defaultProviderId: 'gone' })
    browser.register(makeProvider('a'))
    expect(() => browser.provider).toThrow('配置的 defaultProviderId "gone" 未注册（当前已注册：a）')
  })

  it('providerIds reports registration order', async () => {
    const { browser } = await mountBrowser()
    browser.register(makeProvider('a'))
    browser.register(makeProvider('b'))
    expect(browser.providerIds).toEqual(['a', 'b'])
  })
})
