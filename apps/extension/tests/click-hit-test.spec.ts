// @vitest-environment jsdom
/**
 * Click-hit validation (silent null-click guard): a click whose target point
 * resolves to an occluding overlay, an off-viewport point, or a
 * pointer-events:none target used to fire Input events that hit nothing and
 * still report success.
 *
 * `clickHitOk` is injected into the click probe via function-source
 * serialization — the tests call the SAME function object the shipped probe
 * runs (the text-leaf spec's pattern), and the probe EXPRESSION itself is
 * evaluated against a real jsdom document: jsdom has no elementFromPoint and
 * no layout, so every case injects a document, stubs
 * `document.elementFromPoint`, and stubs `getBoundingClientRect` — no
 * device-style hit testing here.
 */

import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import {
  INVALID_SELECTOR,
  clickHitOk,
  clickProbeExpression,
  deepQuery,
  elementVisible,
  topViewportOffset,
  type HitCheckElement,
} from '../src/background/dom-snapshot.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

/** Minimal double satisfying HitCheckElement over a parent chain. */
function node(children: HitCheckElement[] = []): HitCheckElement {
  const self: HitCheckElement = {
    contains(other: HitCheckElement | null): boolean {
      if (other === null) return false
      if (other === self) return true
      return children.some(child => child.contains(other))
    },
  }
  return self
}

describe('clickHitOk (pure predicate, same object the probe serializes)', () => {
  it('accepts a hit on the target itself', () => {
    const target = node()
    expect(clickHitOk(target, target)).toBe(true)
  })

  it('accepts a hit on a descendant (bubbles to the target)', () => {
    const child = node()
    const target = node([child])
    expect(clickHitOk(target, child)).toBe(true)
  })

  it('rejects an occluding element and a null hit', () => {
    const target = node()
    const overlay = node()
    expect(clickHitOk(target, overlay)).toBe(false)
    expect(clickHitOk(target, null)).toBe(false)
  })
})

describe('click probe expression (serialization wiring)', () => {
  it('injects every helper by function source — the same objects these tests import', () => {
    const expression = clickProbeExpression('#btn')
    expect(expression).toContain(`var clickHitOk = ${clickHitOk.toString()};`)
    expect(expression).toContain(`var deepQuery = ${deepQuery.toString()};`)
    expect(expression).toContain(`var elementVisible = ${elementVisible.toString()};`)
    expect(expression).toContain(`var topViewportOffset = ${topViewportOffset.toString()};`)
    expect(expression).toContain(`deepQuery(document, "#btn", ${JSON.stringify(INVALID_SELECTOR)})`)
  })

  it('calls elementFromPoint at the element center and validates through clickHitOk', () => {
    const expression = clickProbeExpression('#btn')
    expect(expression).toContain('elementFromPoint(cx, cy)')
    expect(expression).toContain('clickHitOk(el, hit || null)')
  })
})

describe('click probe against a real jsdom document (stubbed elementFromPoint + rects)', () => {
  function boot(bodyHtml: string): {
    win: JSDOM['window']
    eval: (expression: string) => unknown
    rects: Map<Element, { x: number; y: number; width: number; height: number }>
    hits: Map<Element, Element | null>
  } {
    const dom = new JSDOM(`<html><body>${bodyHtml}</body></html>`, { url: 'https://example.com/', runScripts: 'outside-only' })
    const win = dom.window
    const doc = win.document
    const rects = new Map<Element, { x: number; y: number; width: number; height: number }>()
    const hits = new Map<Element, Element | null>()
    // jsdom has no layout: every element reports its stubbed rect.
    for (const el of doc.querySelectorAll('*')) {
      rects.set(el, { x: 10, y: 10, width: 100, height: 30 })
    }
    win.Element.prototype.getBoundingClientRect = function (this: Element) {
      return (rects.get(this) ?? { x: 0, y: 0, width: 0, height: 0 }) as DOMRect
    }
    // jsdom has no elementFromPoint: each case stubs what the point hits.
    doc.elementFromPoint = (x: number, _y: number): Element | null => {
      const target = doc.querySelector('#btn')
      const stubbed = target !== null ? hits.get(target) : undefined
      void x
      return stubbed !== undefined ? stubbed : target
    }
    return { win, eval: (expression: string) => win.eval(expression), rects, hits }
  }

  it('reports an unoccluded target as hittable with the probed center', () => {
    const { win, eval: evalInPage, hits } = boot('<button id="btn">提交</button>')
    const target = win.document.querySelector('#btn') as Element
    hits.set(target, target)
    const probe = evalInPage(clickProbeExpression('#btn')) as { hitOk: boolean; hitReason: string; center: { x: number; y: number } }
    expect(probe.hitOk).toBe(true)
    expect(probe.hitReason).toBe('')
    expect(probe.center).toEqual({ x: 60, y: 25 })
  })

  it('rejects an occluding overlay with the 遮挡 reason', () => {
    const { win, eval: evalInPage, hits } = boot('<button id="btn">提交</button><div id="overlay" style="position:fixed"></div>')
    const target = win.document.querySelector('#btn') as Element
    const overlay = win.document.querySelector('#overlay') as Element
    hits.set(target, overlay)
    const probe = evalInPage(clickProbeExpression('#btn')) as { hitOk: boolean; hitReason: string }
    expect(probe.hitOk).toBe(false)
    expect(probe.hitReason).toContain('遮挡')
  })

  it('rejects an off-viewport target with the 视口外 reason', () => {
    const { win, eval: evalInPage, rects, hits } = boot('<button id="btn">提交</button>')
    const target = win.document.querySelector('#btn') as Element
    rects.set(target, { x: 0, y: 2000, width: 100, height: 30 }) // jsdom viewport is 1024x768
    hits.set(target, null)
    const probe = evalInPage(clickProbeExpression('#btn')) as { hitOk: boolean; hitReason: string }
    expect(probe.hitOk).toBe(false)
    expect(probe.hitReason).toBe('目标点在视口外')
  })

  it('rejects a pointer-events:none target through the same probe (implementation trade-off)', () => {
    // 实现取舍：pointer-events:none 时 elementFromPoint 会跳过目标、返回下层
    // 元素，与遮挡同判——探针不单独读取 computed style 的 pointer-events，
    // 一次命中校验同时拦下两类静默空点。
    const { win, eval: evalInPage, hits } = boot('<button id="btn">提交</button><input id="beneath">')
    const target = win.document.querySelector('#btn') as Element
    const beneath = win.document.querySelector('#beneath') as Element
    hits.set(target, beneath)
    const probe = evalInPage(clickProbeExpression('#btn')) as { hitOk: boolean; hitReason: string }
    expect(probe.hitOk).toBe(false)
    expect(probe.hitReason).toContain('指针事件')
  })

  it('accepts a descendant hit (click bubbles to the target)', () => {
    const { win, eval: evalInPage, hits } = boot('<button id="btn"><span id="label">提交</span></button>')
    const target = win.document.querySelector('#btn') as Element
    const label = win.document.querySelector('#label') as Element
    hits.set(target, label)
    const probe = evalInPage(clickProbeExpression('#btn')) as { hitOk: boolean }
    expect(probe.hitOk).toBe(true)
  })

  it('returns null for an invisible element and a sentinel record for invalid selector syntax', () => {
    const { eval: evalInPage } = boot('<button id="btn" style="display: none">提交</button>')
    expect(evalInPage(clickProbeExpression('#btn'))).toBeNull()
    // The invalid-selector sentinel becomes the Chinese throw in getElementRect.
    expect(evalInPage(clickProbeExpression('<<<broken'))).toEqual({ invalid: true })
  })
})
