// @vitest-environment jsdom
/**
 * Pierce-selector deep resolution (批33 follow-up) plus the index-addressing
 * contract it feeds:
 *
 * - `deepQuery` (shared/deep-query.ts) is closure-free and injected by
 *   function-source serialization — the tests call the SAME function object
 *   production runs, against a real jsdom DOM with real shadow boundaries.
 * - the resolve_index probe and the full snapshot walk derive elements with
 *   the SAME exported `elementInfoOf` — the parity tests drive that one
 *   object over a real jsdom document (stubbed rects; jsdom has no layout):
 *   every snapshot selector round-trips through deepQuery back to the same
 *   element, and re-derivation is deep-equal. Source-wiring assertions pin
 *   that BOTH injected expressions embed exactly these function sources.
 * - resolveSnapshotElement validates tag/text drift and never re-runs the
 *   snapshot pre-steps (the sweep) on the probe path.
 */

import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INVALID_SELECTOR, PIERCE_SEPARATOR, deepQuery } from '../src/shared/deep-query.ts'
import {
  SNAPSHOT_EXPRESSION,
  buildResolveExpression,
  captureSnapshot,
  elementInfoOf,
  resolveSnapshotElement,
  selectorCountsOf,
  snapshotTextMatches,
  topViewportOffset,
} from '../src/background/dom-snapshot.ts'

const cdpSend = vi.fn<(tabId: number, method: string, params?: Record<string, unknown>) => Promise<unknown>>()
const capabilityState = vi.hoisted(() => ({ privacyMask: false }))

vi.mock('../src/background/cdp.ts', () => ({
  cdpController: {
    send: (tabId: number, method: string, params?: Record<string, unknown>) => cdpSend(tabId, method, params),
  },
  sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms))),
}))

vi.mock('../src/background/capability-gate.ts', () => ({
  animFreezeEnabled: async (): Promise<boolean> => false,
  bannerCleanEnabled: async (): Promise<boolean> => false,
  lazyLoadEnabled: async (): Promise<boolean> => false,
  privacyMaskEnabled: async (): Promise<boolean> => capabilityState.privacyMask,
  snapLeanEnabled: async (): Promise<boolean> => false,
}))

afterEach(() => {
  document.body.innerHTML = ''
})

describe('deepQuery (pierce resolution)', () => {
  it('resolves a plain selector against the top document (legacy behavior)', () => {
    document.body.innerHTML = '<input id="top">'
    expect(deepQuery(document, '#top', INVALID_SELECTOR)).toBe(document.querySelector('#top'))
  })

  it('descends one shadow boundary per ` >>> ` segment', () => {
    const host = document.createElement('my-widget')
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<input id="inner">'
    document.body.append(host)

    const resolved = deepQuery(document, 'my-widget >>> #inner', INVALID_SELECTOR)
    expect(resolved).toBe(shadow.querySelector('#inner'))
  })

  it('descends two nested shadow boundaries', () => {
    const outer = document.createElement('outer-widget')
    const outerShadow = outer.attachShadow({ mode: 'open' })
    const inner = document.createElement('inner-widget')
    outerShadow.append(inner)
    const innerShadow = inner.attachShadow({ mode: 'open' })
    innerShadow.innerHTML = '<input id="deep">'
    document.body.append(outer)

    expect(deepQuery(document, 'outer-widget >>> inner-widget >>> #deep', INVALID_SELECTOR))
      .toBe(innerShadow.querySelector('#deep'))
  })

  it('scopes a middle segment to the previous segment\'s subtree', () => {
    document.body.innerHTML = '<div id="a"><input id="x"></div><div id="b"><input id="x"></div>'
    // No shadow/iframe between segments: the middle element scopes the search.
    expect(deepQuery(document, '#a >>> #x', INVALID_SELECTOR)).toBe(document.querySelector('#a #x'))
  })

  it('returns the sentinel for an invalid segment and null for an absent one', () => {
    document.body.innerHTML = '<div id="a"></div>'
    expect(deepQuery(document, '#a >>> <<<broken', INVALID_SELECTOR)).toBe(INVALID_SELECTOR)
    expect(deepQuery(document, '#a >>> #missing', INVALID_SELECTOR)).toBeNull()
  })

  it('keeps the top-level invalid/absent distinction', () => {
    expect(deepQuery(document, '<<<broken', INVALID_SELECTOR)).toBe(INVALID_SELECTOR)
    expect(deepQuery(document, '#missing', INVALID_SELECTOR)).toBeNull()
  })
})

describe('snapshot pierce generation (source wiring)', () => {
  /** esbuild reprints string literals with double quotes; normalize to compare sources. */
  function sourceOf(expression: string): string {
    return expression.replace(/"/g, "'")
  }

  it('threads the pierce prefix through the collect recursion', () => {
    const source = sourceOf(SNAPSHOT_EXPRESSION)
    expect(source).toContain('function collect(root, doc, offsetX, offsetY, depth, inShadow, inIframe, piercePrefix)')
    expect(source).toContain("piercePrefix ? piercePrefix + ' >>> ' + makeSelector(h, countsOf(doc)) : makeSelector(h, countsOf(doc))")
    expect(source).toContain("piercePrefix ? piercePrefix + ' >>> ' + makeSelector(el, countsOf(doc)) : makeSelector(el, countsOf(doc))")
  })

  it('composes the element selector from the prefix and its own segment', () => {
    expect(sourceOf(SNAPSHOT_EXPRESSION)).toContain("selector: piercePrefix !== '' ? piercePrefix + ' >>> ' + own : own,")
  })

  it('starts the top-level collect with an empty prefix', () => {
    expect(SNAPSHOT_EXPRESSION).toContain("collect(document, document, 0, 0, 0, false, false, '');")
  })

  it('collects exactly the render cap (40) — the SW no longer gathers 60 to show 40', () => {
    expect(SNAPSHOT_EXPRESSION).toContain('var MAX_ELEMENTS = 40;')
    expect(SNAPSHOT_EXPRESSION).toContain('interactive.concat(passive).slice(0, MAX_ELEMENTS)')
  })

  it('injects the SAME function sources the parity tests below drive', () => {
    for (const helper of [elementInfoOf, selectorCountsOf]) {
      expect(SNAPSHOT_EXPRESSION).toContain(helper.toString())
    }
    for (const helper of [elementInfoOf, selectorCountsOf, topViewportOffset]) {
      expect(buildResolveExpression({ index: 0, tag: 'a', selector: '#x', text: '', rect: { x: 0, y: 0, width: 1, height: 1 }, center: { x: 0, y: 0 }, interactive: true }))
        .toContain(helper.toString())
    }
  })
})

// ── resolve_index parity: one derivation for snapshot and probe ──

const PARITY_BODY = `
  <a id="first" href="https://example.com/doc">文档链接</a>
  <button id="mid">提交按钮</button>
  <input id="q" placeholder="搜索">
  <p id="status">操作完成 12:00:00</p>
  <parity-widget></parity-widget>
`

/**
 * A real jsdom document carrying plain, pierce (shadow), and passive-text
 * elements, with deterministic stub rects (jsdom has no layout).
 */
function parityDocument(): Document {
  const dom = new JSDOM(`<html><body>${PARITY_BODY}</body></html>`, { url: 'https://example.com/page' })
  const doc = dom.window.document
  doc.defaultView?.customElements.define('parity-widget', class extends dom.window.HTMLElement {
    constructor() {
      super()
      this.attachShadow({ mode: 'open' }).innerHTML = '<button id="shadow-btn">影子按钮</button>'
    }
  })
  let seq = 0
  const rects = new Map<Element, { x: number; y: number; width: number; height: number }>()
  const stub = (root: ParentNode): void => {
    for (const el of root.querySelectorAll('*')) {
      if (!rects.has(el)) {
        seq += 1
        rects.set(el, { x: seq * 10, y: seq * 5, width: 80, height: 24 })
      }
      const shadow = (el).shadowRoot
      if (shadow !== null) stub(shadow)
    }
  }
  stub(doc)
  dom.window.Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    return (rects.get(this) ?? { x: 0, y: 0, width: 0, height: 0 }) as DOMRect
  }
  return doc
}

describe('resolve_index parity (same elementInfoOf object for snapshot and probe)', () => {
  it('round-trips every snapshot selector through deepQuery back to the same element', () => {
    const doc = parityDocument()
    const host = doc.querySelector('parity-widget') as Element
    const counts = selectorCountsOf(doc)
    const candidates = [
      doc.querySelector('#first'),
      doc.querySelector('#mid'),
      doc.querySelector('#q'),
      doc.querySelector('#status'),
      host.shadowRoot?.querySelector('#shadow-btn') ?? null,
    ]
    expect(candidates.every(el => el !== null)).toBe(true)
    for (const el of candidates) {
      const info = elementInfoOf(el as Element, counts, 0, 0, el === candidates[4], false, el === candidates[4] ? 'parity-widget' : '')
      expect(info).not.toBeNull()
      const found = deepQuery(doc, (info as { selector: string }).selector, INVALID_SELECTOR)
      expect(found).toBe(el)
    }
  })

  it('re-derivation of the resolved element is deep-equal to the snapshot record', () => {
    const doc = parityDocument()
    const host = doc.querySelector('parity-widget') as Element
    const shadowButton = host.shadowRoot?.querySelector('#shadow-btn') as Element
    const counts = selectorCountsOf(doc)
    const first = elementInfoOf(shadowButton, counts, 30, 10, true, false, 'parity-widget')
    expect(first).not.toBeNull()
    const found = deepQuery(doc, (first as { selector: string }).selector, INVALID_SELECTOR)
    const second = elementInfoOf(found as Element, counts, 30, 10, true, false, 'parity-widget')
    expect(second).toEqual(first)
  })

  it('carries href/aria-label/placeholder on the derived records (no silent drops)', () => {
    const doc = parityDocument()
    const counts = selectorCountsOf(doc)
    const link = elementInfoOf(doc.querySelector('#first') as Element, counts, 0, 0, false, false, '')
    expect(link).toMatchObject({ href: 'https://example.com/doc', tag: 'a', interactive: true })
    const input = elementInfoOf(doc.querySelector('#q') as Element, counts, 0, 0, false, false, '')
    expect(input).toMatchObject({ placeholder: '搜索' })
    const status = elementInfoOf(doc.querySelector('#status') as Element, counts, 0, 0, false, false, '')
    expect(status).toMatchObject({ interactive: false, text: '操作完成 12:00:00' })
  })

  it('splits the pierce prefix at the last separator for re-resolution', () => {
    const expression = buildResolveExpression({
      index: 7,
      tag: 'button',
      selector: 'host-a >>> host-b >>> #deep',
      text: '',
      rect: { x: 0, y: 0, width: 1, height: 1 },
      center: { x: 0, y: 0 },
      interactive: true,
      inShadowDom: true,
    })
    expect(expression).toContain(JSON.stringify('host-a >>> host-b'))
    expect(expression).toContain('info.index = 7;')
    expect(expression).toContain('true, false, "host-a >>> host-b")')
  })

  it('exports the pierce separator the SW-side prefix split uses', () => {
    expect(PIERCE_SEPARATOR).toBe(' >>> ')
  })
})

// ── resolveSnapshotElement (SW-side cache + drift validation) ──

const ELEMENT = {
  index: 0,
  tag: 'button',
  selector: '#pay-btn',
  text: '确认支付',
  rect: { x: 10, y: 20, width: 100, height: 30 },
  center: { x: 60, y: 35 },
  interactive: true,
}

/** Recorded Runtime.evaluate expressions since the last scriptAnswer. */
const pageExpressions: string[] = []

/**
 * Answer every Runtime.evaluate through the mocked CDP layer with
 * `handler(expression)` — the REAL evaluateInPage unwraps the envelope, so
 * the capture/resolve paths run unmodified.
 */
function scriptAnswer(handler: (expression: string) => unknown): void {
  pageExpressions.length = 0
  cdpSend.mockImplementation(((_tabId: number, _method: string, params?: Record<string, unknown>) => {
    const expression = (params?.expression as string | undefined) ?? ''
    pageExpressions.push(expression)
    return Promise.resolve({ result: { type: 'object', value: handler(expression) } })
  }))
}

/** Seed the per-tab cache through the real captureSnapshot path. */
async function seedCache(tabId: number, element: Record<string, unknown>): Promise<void> {
  scriptAnswer(expression =>
    expression === SNAPSHOT_EXPRESSION
      ? {
        url: 'https://example.com/list',
        title: '列表页',
        timestamp: 1,
        viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
        elements: [element],
      }
      : undefined)
  await captureSnapshot(tabId)
}

describe('resolveSnapshotElement (per-tab cache, on-page validation)', () => {
  beforeEach(() => {
    cdpSend.mockReset()
    capabilityState.privacyMask = false
  })

  it('throws 快照已过期 when the tab has no cached snapshot at all', async () => {
    await expect(resolveSnapshotElement(424242, 0)).rejects.toThrow('快照已过期，请重新 page_snapshot')
  })

  it('re-derives the element on-page and returns fresh geometry under the cached index', async () => {
    await seedCache(31, ELEMENT)
    scriptAnswer((expression) => {
      // The probe expression resolves by the cached selector with the deep resolver.
      expect(expression).toContain('"#pay-btn"')
      return { ...ELEMENT, center: { x: 61, y: 36 }, index: 0 }
    })

    const resolved = await resolveSnapshotElement(31, 0)

    expect(resolved).toEqual({ ...ELEMENT, center: { x: 61, y: 36 }, index: 0 })
  })

  it('rejects tag/text drift with the re-snapshot guidance', async () => {
    await seedCache(32, ELEMENT)
    scriptAnswer(() => ({ ...ELEMENT, tag: 'a', text: '免费领取' }))

    await expect(resolveSnapshotElement(32, 0)).rejects.toThrow('快照已过期，请重新 page_snapshot')
    await expect(resolveSnapshotElement(32, 0)).rejects.toThrow('已变化')
  })

  it('passes relaxed text drift and keeps a whitespace-only cache entry valid', async () => {
    await seedCache(33, ELEMENT)
    scriptAnswer(() => ({ ...ELEMENT, text: '确认支付并继续' }))
    await expect(resolveSnapshotElement(33, 0)).resolves.toMatchObject({ index: 0 })

    await seedCache(34, { ...ELEMENT, text: '' })
    scriptAnswer(() => ({ ...ELEMENT, text: '换了个文案' }))
    await expect(resolveSnapshotElement(34, 0)).resolves.toMatchObject({ index: 0 })
  })

  it('rejects an element that has become invisible (the probe answered null)', async () => {
    await seedCache(35, ELEMENT)
    scriptAnswer(() => null)

    await expect(resolveSnapshotElement(35, 0)).rejects.toThrow('已不可见或已移除')
  })

  it('compares against the MASKED cached text when the privacy-mask capability is on', async () => {
    capabilityState.privacyMask = true
    await seedCache(36, { ...ELEMENT, text: '联系 [手机号]' })
    // The live element carries the raw phone number; masked, it matches the cache.
    scriptAnswer(() => ({ ...ELEMENT, text: '联系 13812345678' }))
    await expect(resolveSnapshotElement(36, 0)).resolves.toMatchObject({ text: '联系 [手机号]' })

    scriptAnswer(() => ({ ...ELEMENT, text: '余额不足' }))
    await expect(resolveSnapshotElement(36, 0)).rejects.toThrow('快照已过期')
  })

  it('never triggers the snapshot pre-steps on the probe path (spy)', async () => {
    await seedCache(37, ELEMENT)
    scriptAnswer(() => ({ ...ELEMENT }))

    await resolveSnapshotElement(37, 0)

    // Exactly ONE page evaluate since the resolve began (the probe), and its
    // expression carries no prep machinery: the sweep (freeze style / banner
    // words / scroll sweep) is capture-only.
    expect(pageExpressions).toHaveLength(1)
    expect(pageExpressions[0]).not.toContain('data-dsh-prep')
    expect(pageExpressions[0]).not.toContain('__dsh_freeze')
    expect(pageExpressions[0]).not.toContain('matchesBannerText')
    expect(pageExpressions[0]).not.toContain('scrollTo')
  })
})

describe('snapshotTextMatches (the relaxed drift rule)', () => {
  it('matches equality, containment both ways, and whitespace noise', () => {
    expect(snapshotTextMatches('确认支付', '确认支付')).toBe(true)
    expect(snapshotTextMatches('确认支付', '确认支付并继续')).toBe(true)
    expect(snapshotTextMatches('确认支付并继续', '确认支付')).toBe(true)
    expect(snapshotTextMatches('确认  支付', '确认 支付')).toBe(true)
  })

  it('keeps an empty cached text valid and rejects unrelated text', () => {
    expect(snapshotTextMatches('', '任何文案')).toBe(true)
    expect(snapshotTextMatches('确认支付', '免费领取')).toBe(false)
  })
})
