// @vitest-environment jsdom
/**
 * 横幅遮罩清理 (the banner-clean built-in capability): the consent sweep
 * runs as ONE combined snapshot pre-step whose word matching is ANCHORED —
 * the substring sweep it replaces clicked 「不同意」 because it contains
 * 「同意」. `matchesBannerText` is the pure matcher (same object the prep
 * script serializes), and the clicked texts are recorded as prepActions so
 * the read-only snapshot reports its own clicks instead of performing
 * unrecorded ones.
 */

import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPrepExpression, matchesBannerText } from '../src/background/dom-snapshot.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('matchesBannerText (anchored word matching)', () => {
  it('hits plain consent words', () => {
    expect(matchesBannerText('接受')).toBe('接受')
    expect(matchesBannerText('同意')).toBe('同意')
    expect(matchesBannerText('关闭')).toBe('关闭')
    expect(matchesBannerText('知道了')).toBe('知道了')
  })

  it('does not hit 「不同意」 — the substring-sweep regression', () => {
    expect(matchesBannerText('不同意')).toBeNull()
    expect(matchesBannerText('不接受此条款')).toBeNull()
    expect(matchesBannerText('不同意,继续浏览')).toBeNull()
  })

  it('does not hit when a word character precedes the occurrence', () => {
    expect(matchesBannerText('完全同意')).toBeNull()
    expect(matchesBannerText('不接受')).toBeNull()
    expect(matchesBannerText('xclose')).toBeNull()
  })

  it('hits compound banner labels that START with a word', () => {
    expect(matchesBannerText('同意并继续')).toBe('同意')
    expect(matchesBannerText('全部接受')).toBe('全部接受')
    expect(matchesBannerText('接受全部')).toBe('接受全部')
    expect(matchesBannerText('好的，我知道了')).toBe('我知道了')
  })

  it('does not hit English negations right before the word', () => {
    expect(matchesBannerText("Don't accept")).toBeNull()
    expect(matchesBannerText('not accept')).toBeNull()
    expect(matchesBannerText('Accept all cookies')).toBe('accept all')
    expect(matchesBannerText('Got It')).toBe('got it')
  })

  it('never matches empty or whitespace text', () => {
    expect(matchesBannerText('')).toBeNull()
    expect(matchesBannerText('   \n ')).toBeNull()
  })
})

describe('buildPrepExpression (combined pre-step wiring)', () => {
  it('serializes the matcher by function source and records clicked texts as actions', () => {
    const expression = buildPrepExpression({ freeze: false, banner: true, lazy: false, checkToken: null, setToken: 't1' })
    expect(expression).toContain(`var matchesBannerText = ${matchesBannerText.toString()};`)
    expect(expression).toContain('actions.push(t)')
  })

  it('marks the document generation with the prep token attribute', () => {
    const expression = buildPrepExpression({ freeze: false, banner: false, lazy: false, checkToken: 't0', setToken: 't1' })
    expect(expression).toContain("'data-dsh-prep'")
    expect(expression).toContain('flags.checkToken')
    expect(expression).toContain('flags.setToken')
  })

  it('restores the pre-sweep scroll position instead of forcing the page back to the top', () => {
    const expression = buildPrepExpression({ freeze: false, banner: false, lazy: true, checkToken: null, setToken: 't1' })
    expect(expression).toContain('var startY = window.scrollY || window.pageYOffset || 0;')
    expect(expression).toContain('window.scrollTo(0, startY)')
    expect(expression).not.toContain('window.scrollTo(0, 0)')
  })

  it('omits disabled steps entirely', () => {
    const expression = buildPrepExpression({ freeze: false, banner: false, lazy: false, checkToken: null, setToken: 't1' })
    expect(expression).not.toContain('matchesBannerText')
    expect(expression).not.toContain('__dsh_freeze')
    expect(expression).not.toContain('new Promise')
  })
})

describe('prep script against a real jsdom document', () => {
  function boot(bodyHtml: string): {
    doc: Document
    run: (flags: Parameters<typeof buildPrepExpression>[0]) => { cached: boolean; actions: string[] }
  } {
    const dom = new JSDOM(`<html><body>${bodyHtml}</body></html>`, { url: 'https://example.com/', runScripts: 'outside-only' })
    const win = dom.window
    // jsdom has no layout: give every element a nonzero rect so the sweep's
    // visibility gate passes.
    win.Element.prototype.getBoundingClientRect = function (): DOMRect {
      return { x: 0, y: 0, width: 100, height: 24 } as DOMRect
    }
    return {
      doc: win.document,
      run: flags => win.eval(buildPrepExpression(flags)) as { cached: boolean; actions: string[] },
    }
  }

  it('clicks anchored banner buttons and records their texts', () => {
    const { doc, run } = boot(`
      <button id="yes">同意</button>
      <button id="no">不同意</button>
      <button id="ok">我知道了</button>
      <button id="plain">提交订单</button>
    `)
    const result = run({ freeze: false, banner: true, lazy: false, checkToken: null, setToken: 't1' })
    expect(result.cached).toBe(false)
    expect(result.actions).toEqual(['同意', '我知道了'])
    // 「不同意」 must stay unclicked — the anchored matcher's whole point.
    expect(doc.querySelector('#no')?.textContent).toBe('不同意')
    // The marker is written so the next snapshot on this document skips the sweep.
    expect(doc.documentElement.getAttribute('data-dsh-prep')).toBe('t1')
  })

  it('skips the whole sweep when the document still carries the checked token', () => {
    const { doc, run } = boot('<button id="yes">同意</button>')
    run({ freeze: false, banner: true, lazy: false, checkToken: null, setToken: 't1' })
    const second = run({ freeze: false, banner: true, lazy: false, checkToken: 't1', setToken: 't2' })
    expect(second).toEqual({ cached: true, actions: [] })
    // The cached branch leaves the marker untouched.
    expect(doc.documentElement.getAttribute('data-dsh-prep')).toBe('t1')
  })
})
