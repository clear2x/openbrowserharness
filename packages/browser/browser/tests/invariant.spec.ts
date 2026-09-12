/**
 * Focused invariant topology for `@deepseek-ai/dsh-browser`: the exported
 * PageSnapshot wire-shape validator and the companion's provider-updated
 * event contract. This suite owns its invariant service topology explicitly
 * (the *invariant*.spec.ts convention).
 * @module @deepseek-ai/dsh-browser/tests/invariant
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { InvariantFailure } from '@deepseek-ai/dsh-invariants'
import BrowserRuntimeService from '../src/index.ts'
import * as companion from '../src/invariant.ts'
import { validatePageSnapshot } from '../src/invariant.ts'

/** Collect failures instead of throwing, for shape-coverage assertions. */
function failures(): { seen: string[]; fail: InvariantFailure } {
  const seen: string[] = []
  return {
    seen,
    fail: (message: string) => {
      seen.push(message)
      throw new Error(message)
    },
  }
}

/** A complete, valid snapshot for mutation in tests. */
function validSnapshot(): unknown {
  return {
    tabId: 3,
    url: 'https://example.com',
    title: 't',
    timestamp: 5,
    viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
    elements: [
      {
        index: 0,
        tag: 'button',
        selector: '#a',
        text: 'go',
        rect: { x: 1, y: 2, width: 3, height: 4 },
        center: { x: 2.5, y: 4 },
        interactive: true,
      },
      {
        index: 1,
        tag: 'span',
        selector: '',
        text: '',
        rect: { x: 0, y: 0, width: 1, height: 1 },
        center: { x: 0.5, y: 0.5 },
        interactive: false,
        inShadowDom: true,
      },
    ],
  }
}

describe('validatePageSnapshot', () => {
  it('accepts a complete snapshot', () => {
    const { seen, fail } = failures()
    expect(() => validatePageSnapshot(validSnapshot(), fail)).not.toThrow()
    expect(seen).toEqual([])
  })

  it('rejects non-object roots and bad scalar header fields', () => {
    for (const value of [null, 'x', 5, []]) {
      const { fail } = failures()
      expect(() => validatePageSnapshot(value, fail)).toThrow('PageSnapshot 必须是对象')
    }
    for (const [patch, message] of [
      [{ tabId: 1.5 }, 'tabId'],
      [{ tabId: -1 }, 'tabId'],
      [{ url: 7 }, 'url'],
      [{ title: null }, 'title'],
      [{ timestamp: -1 }, 'timestamp'],
      [{ viewport: null }, 'viewport'],
      [{ viewport: { width: 'a', height: 1, scrollX: 0, scrollY: 0 } }, 'viewport.width'],
      [{ elements: {} }, 'elements'],
    ] as const) {
      const { seen, fail } = failures()
      expect(() => validatePageSnapshot({ ...validSnapshot() as object, ...patch }, fail)).toThrow()
      expect(seen[0]).toContain(message)
    }
  })

  it('rejects malformed elements and index-position mismatches', () => {
    const misordered = validSnapshot() as { elements: unknown[] }
    misordered.elements = [
      { ...(misordered.elements[0] as object), index: 4 },
    ]
    const { seen, fail } = failures()
    expect(() => validatePageSnapshot(misordered, fail)).toThrow()
    expect(seen[0]).toContain('index 字段必须是它在数组中的位置 0')

    const badRect = validSnapshot() as { elements: { rect: unknown }[] }
    badRect.elements[0]!.rect = { x: 0, y: 0 }
    const rect = failures()
    expect(() => validatePageSnapshot(badRect, rect.fail)).toThrow('rect.width')
  })
})

describe('browser invariant companion', () => {
  /** Mount the invariant service plus this package's companion on one root. */
  async function mountCompanion() {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(BrowserRuntimeService)
    const dispose = await companion.apply(ctx)
    return { ctx, dispose }
  }

  it('registers under the package name and disposes cleanly', async () => {
    const { ctx, dispose } = await mountCompanion()
    try {
      expect(() => companion.apply(ctx)).toThrow('already registered')
    } finally {
      dispose()
    }
  })

  it('accepts real provider-set changes', async () => {
    const { ctx, dispose } = await mountCompanion()
    try {
      const noop = (): Promise<void> => Promise.resolve()
      const disposeProvider = ctx.browser.register({
        id: 'ok-provider',
        tabs: () => Promise.resolve([]),
        switchTab: noop,
        openTab: () => Promise.resolve({ tabId: 1, title: '', url: '', active: true, windowId: 1, index: 0 }),
        closeTab: noop,
        navigate: noop,
        goBack: () => Promise.resolve(true),
        goForward: () => Promise.resolve(true),
        snapshot: () => Promise.resolve({
          tabId: 1, url: '', title: '', timestamp: 0,
          viewport: { width: 0, height: 0, scrollX: 0, scrollY: 0 }, elements: [],
        }),
        screenshot: () => Promise.resolve({ data: new Uint8Array(), mediaType: 'image/png', width: 0, height: 0 }),
        clickSelector: noop,
        clickPoint: noop,
        typeText: noop,
        pressKey: noop,
        scroll: noop,
        waitFor: noop,
        evaluate<T>(): Promise<T> {
          return Promise.resolve(undefined as unknown as T)
        },
      })
      disposeProvider()
    } finally {
      dispose()
    }
  })

  it('fails when an emitted payload disagrees with the registry', async () => {
    const { ctx, dispose } = await mountCompanion()
    try {
      expect(() => ctx.emit('browser/provider-updated', ['ghost'])).toThrow('与当前注册表')
      expect(() => ctx.emit('browser/provider-updated', ['bad id'])).toThrow('非法 provider id')
      expect(() => ctx.emit('browser/provider-updated', 'not-an-array' as unknown as readonly string[])).toThrow('provider id 数组')
    } finally {
      dispose()
    }
  })
})
