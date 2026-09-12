// @vitest-environment jsdom
/**
 * Pierce-selector deep resolution (批33 follow-up): shadow-DOM and
 * same-origin-iframe elements enter the snapshot with a `seg >>> seg`
 * selector, and the SAME deep resolver runs at every consumer probe
 * (element rect, click targeting, clear, structured-value fallback).
 *
 * `deepQuery` is closure-free and injected by function-source serialization —
 * the tests below call the SAME function object production runs, against a
 * real jsdom DOM with real shadow boundaries.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { deepQuery, INVALID_SELECTOR, SNAPSHOT_EXPRESSION } from '../src/background/dom-snapshot.ts'

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
  it('threads the pierce prefix through the collect recursion', () => {
    expect(SNAPSHOT_EXPRESSION).toContain('function collect(root, doc, offsetX, offsetY, depth, inShadow, inIframe, piercePrefix)')
    expect(SNAPSHOT_EXPRESSION).toContain("piercePrefix ? piercePrefix + ' >>> ' + makeSelector(h, doc) : makeSelector(h, doc)")
    expect(SNAPSHOT_EXPRESSION).toContain("piercePrefix ? piercePrefix + ' >>> ' + makeSelector(el, doc) : makeSelector(el, doc)")
  })

  it('composes the element selector from the prefix and its own segment', () => {
    expect(SNAPSHOT_EXPRESSION).toContain("selector: piercePrefix ? piercePrefix + ' >>> ' + own : own,")
  })

  it('starts the top-level collect with an empty prefix', () => {
    expect(SNAPSHOT_EXPRESSION).toContain("collect(document, document, 0, 0, 0, false, false, '');")
  })
})
