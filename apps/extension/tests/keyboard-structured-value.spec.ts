// @vitest-environment jsdom
/**
 * applyStructuredValueInPage spec: the page_type structured date/time
 * fallback (批22 — per-character CDP keystrokes never land in
 * `<input type=time>` segmented UIs, leaving the DOM value empty).
 *
 * The same closure-free function runs in production via
 * structuredValueFallbackScript() serialization (evaluateInPage source) and
 * here directly against the jsdom DOM, so these assertions cover the exact
 * production logic: assignment through the native value setter, input/change
 * dispatch, and every sentinel the host wrapper branches on.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyStructuredValueInPage } from '../src/background/structured-value.ts'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function mount(html: string): void {
  document.body.innerHTML = html
}

describe('applyStructuredValueInPage', () => {
  it('assigns the typed value into an empty time input via input/change events and focus', () => {
    mount('<input id="t" type="time">')
    const input = document.querySelector('#t') as HTMLInputElement
    const events: string[] = []
    input.addEventListener('input', () => { events.push('input') })
    input.addEventListener('change', () => { events.push('change') })
    const focusSpy = vi.spyOn(input, 'focus')

    const result = applyStructuredValueInPage('#t', '14:30')

    expect(result).toBe('ok:14:30')
    expect(input.value).toBe('14:30')
    expect(events).toEqual(['input', 'change'])
    expect(focusSpy).toHaveBeenCalled()
  })

  it('skips the fallback (no events) when the value already equals the typed text', () => {
    mount('<input id="t" type="time" value="14:30">')
    const input = document.querySelector('#t') as HTMLInputElement
    const listener = vi.fn()
    input.addEventListener('input', listener)

    const result = applyStructuredValueInPage('#t', '14:30')

    expect(result).toBe('ok:14:30')
    expect(listener).not.toHaveBeenCalled()
  })

  it('covers the datetime-local/month/date family with their canonical formats', () => {
    mount('<input id="d" type="datetime-local"><input id="m" type="month"><input id="w" type="date">')
    expect(applyStructuredValueInPage('#d', '2026-09-05T14:30')).toBe('ok:2026-09-05T14:30')
    expect(applyStructuredValueInPage('#m', '2026-09')).toBe('ok:2026-09')
    expect((document.querySelector('#d') as HTMLInputElement).value).toBe('2026-09-05T14:30')
    expect((document.querySelector('#m') as HTMLInputElement).value).toBe('2026-09')
  })

  it('skips non-structured inputs (text) — humanized typing is their contract', () => {
    mount('<input id="t" type="text">')
    expect(applyStructuredValueInPage('#t', 'hello')).toBe('skip')
    expect((document.querySelector('#t') as HTMLInputElement).value).toBe('')
  })

  it('skips non-input elements', () => {
    mount('<div id="d"></div>')
    expect(applyStructuredValueInPage('#d', '14:30')).toBe('skip')
  })

  it('reports a missing element as not-found (the host wrapper throws on this)', () => {
    expect(applyStructuredValueInPage('#missing', '14:30')).toBe('not-found')
  })

  it('reports the sanitized empty value when the browser rejects the format (fail-loud feed)', () => {
    mount('<input id="t" type="time">')
    const result = applyStructuredValueInPage('#t', 'not-a-time')
    expect(result).toBe('ok:')
  })
})
