// @vitest-environment jsdom
/**
 * applyInputValueInPage spec: the in-page value readback/writeback
 * (批22 structured date/time fallback + 切片2 full-type readback — per-
 * character CDP keystrokes never land in `<input type=time>` segmented
 * UIs, and plain fields can lose the value to a controlled re-render or a
 * blur reset).
 *
 * The same closure-free function runs in production via
 * inputValueFallbackScript() serialization (evaluateInPage source) and
 * here directly against the jsdom DOM, so these assertions cover the exact
 * production logic: readback comparison (raw / separator-stripped for
 * masked fields / whitespace-normalized for contenteditable), assignment
 * through the native value setter, input/change dispatch, and every
 * sentinel the host wrapper branches on.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyInputValueInPage } from '../src/background/structured-value.ts'
import { deepQuery, INVALID_SELECTOR } from '../src/background/dom-snapshot.ts'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function mount(html: string): void {
  document.body.innerHTML = html
}

function inputOf(selector: string): HTMLInputElement {
  return document.querySelector(selector) as HTMLInputElement
}

function recordEvents(el: Element): { events: string[]; listen: (type: string) => void } {
  const events: string[] = []
  const listen = (type: string): void => { el.addEventListener(type, () => { events.push(type) }) }
  return { events, listen }
}

describe('applyInputValueInPage — structured date/time family (批22)', () => {
  it('assigns the typed value into an empty time input via input/change events and focus', () => {
    mount('<input id="t" type="time">')
    const input = inputOf('#t')
    const { events, listen } = recordEvents(input)
    listen('input')
    listen('change')
    const focusSpy = vi.spyOn(input, 'focus')

    const result = applyInputValueInPage('#t', '14:30', deepQuery, INVALID_SELECTOR)

    expect(result).toBe('ok')
    expect(input.value).toBe('14:30')
    expect(events).toEqual(['input', 'change'])
    expect(focusSpy).toHaveBeenCalled()
  })

  it('skips the writeback (no events) when the value already equals the typed text', () => {
    mount('<input id="t" type="time" value="14:30">')
    const input = inputOf('#t')
    const listener = vi.fn()
    input.addEventListener('input', listener)

    const result = applyInputValueInPage('#t', '14:30', deepQuery, INVALID_SELECTOR)

    expect(result).toBe('ok')
    expect(listener).not.toHaveBeenCalled()
  })

  it('covers the datetime-local/month/date family with their canonical formats', () => {
    mount('<input id="d" type="datetime-local"><input id="m" type="month"><input id="w" type="date">')
    expect(applyInputValueInPage('#d', '2026-09-05T14:30', deepQuery, INVALID_SELECTOR)).toBe('ok')
    expect(applyInputValueInPage('#m', '2026-09', deepQuery, INVALID_SELECTOR)).toBe('ok')
    expect(applyInputValueInPage('#w', '2026-09-05', deepQuery, INVALID_SELECTOR)).toBe('ok')
    expect(inputOf('#d').value).toBe('2026-09-05T14:30')
    expect(inputOf('#m').value).toBe('2026-09')
    expect(inputOf('#w').value).toBe('2026-09-05')
  })

  it('reports rejected-empty when the browser rejects the format (fail-loud feed)', () => {
    mount('<input id="t" type="time">')
    const result = applyInputValueInPage('#t', 'not-a-time', deepQuery, INVALID_SELECTOR)
    expect(result).toBe('rejected-empty')
  })
})

describe('applyInputValueInPage — plain text inputs and textareas', () => {
  it('writes the typed text back natively when the input lost it (blur reset / keydown-driven validators)', () => {
    mount('<input id="k" type="text">')
    const input = inputOf('#k')
    const { events, listen } = recordEvents(input)
    listen('input')
    listen('change')
    // The page wipes the field on blur (controlled reset / keydown-driven
    // validation): the typed value is gone by the time the readback runs.
    input.addEventListener('blur', () => { input.value = '' })
    input.value = 'hello'
    input.dispatchEvent(new Event('blur'))
    expect(input.value).toBe('')

    const result = applyInputValueInPage('#k', 'hello', deepQuery, INVALID_SELECTOR)

    expect(result).toBe('ok')
    expect(input.value).toBe('hello')
    expect(events).toEqual(['input', 'change'])
  })

  it('keeps the value (no events) when the typed text already landed', () => {
    mount('<input id="t" type="text" value="hello">')
    const input = inputOf('#t')
    const listener = vi.fn()
    input.addEventListener('input', listener)

    const result = applyInputValueInPage('#t', 'hello', deepQuery, INVALID_SELECTOR)

    expect(result).toBe('ok')
    expect(listener).not.toHaveBeenCalled()
  })

  it('repairs a textarea through the native setter, newlines included', () => {
    mount('<textarea id="ta"></textarea>')
    const ta = document.querySelector('#ta') as HTMLTextAreaElement
    const { events, listen } = recordEvents(ta)
    listen('input')
    listen('change')

    const result = applyInputValueInPage('#ta', 'line1\nline2', deepQuery, INVALID_SELECTOR)

    expect(result).toBe('ok')
    expect(ta.value).toBe('line1\nline2')
    expect(events).toEqual(['input', 'change'])
  })

  it('reports the mismatch sentinel with code-point lengths when a field resists every write', () => {
    mount('<input id="locked" type="text">')
    const input = inputOf('#locked')
    const { events, listen } = recordEvents(input)
    listen('input')
    listen('change')
    // A field whose value never changes no matter what is written (a
    // hostile/controlled trap): the host wrapper throws on this sentinel.
    Object.defineProperty(input, 'value', { configurable: true, get: () => 'locked!!' })

    const result = applyInputValueInPage('#locked', 'hello', deepQuery, INVALID_SELECTOR)

    expect(result).toBe('mismatch:5:8')
    expect(events).toEqual(['input', 'change'])
  })
})

describe('applyInputValueInPage — masked inputs', () => {
  it('counts separator-only differences as landed (no writeback, no events)', () => {
    mount('<input id="phone" type="tel" value="138-1234-5678">')
    const input = inputOf('#phone')
    const listener = vi.fn()
    input.addEventListener('input', listener)

    const result = applyInputValueInPage('#phone', '13812345678', deepQuery, INVALID_SELECTOR)

    expect(result).toBe('ok')
    expect(input.value).toBe('138-1234-5678') // the mask formatting survives
    expect(listener).not.toHaveBeenCalled()
  })

  it('strips the common separator set (space, dot, slash, parens, hyphen)', () => {
    mount('<input id="card" type="text" value="6222 0210.0111/1234(5678)">')
    const result = applyInputValueInPage('#card', '62220210011112345678', deepQuery, INVALID_SELECTOR)
    expect(result).toBe('ok')
  })

  it('writes the raw text back when even separator-stripping cannot reconcile the value', () => {
    mount('<input id="phone" type="tel" value="139-0000-0000">')
    const input = inputOf('#phone')

    const result = applyInputValueInPage('#phone', '13812345678', deepQuery, INVALID_SELECTOR)

    expect(result).toBe('ok')
    expect(input.value).toBe('13812345678')
  })
})

describe('applyInputValueInPage — contenteditable', () => {
  it('writes the typed text in and dispatches input/change', () => {
    mount('<div id="ce" contenteditable="true"></div>')
    const ce = document.querySelector('#ce') as HTMLDivElement
    const { events, listen } = recordEvents(ce)
    listen('input')
    listen('change')

    const result = applyInputValueInPage('#ce', 'hello world', deepQuery, INVALID_SELECTOR)

    expect(result).toBe('ok')
    expect(ce.textContent).toBe('hello world')
    expect(events).toEqual(['input', 'change'])
  })

  it('compares on whitespace-normalized textContent (nbsp / collapsed runs)', () => {
    mount('<div id="ce" contenteditable="true">hello&nbsp;&nbsp;world</div>')
    const ce = document.querySelector('#ce') as HTMLDivElement
    const listener = vi.fn()
    ce.addEventListener('input', listener)

    const result = applyInputValueInPage('#ce', 'hello world', deepQuery, INVALID_SELECTOR)

    expect(result).toBe('ok')
    expect(listener).not.toHaveBeenCalled() // normalized comparison, not a rewrite
  })
})

describe('applyInputValueInPage — not text-entry targets', () => {
  it('skips non-text-entry input types (checkbox, hidden)', () => {
    mount('<input id="c" type="checkbox"><input id="h" type="hidden">')
    expect(applyInputValueInPage('#c', 'on', deepQuery, INVALID_SELECTOR)).toBe('skip')
    expect(applyInputValueInPage('#h', 'x', deepQuery, INVALID_SELECTOR)).toBe('skip')
  })

  it('skips non-editable non-input elements', () => {
    mount('<div id="d"></div>')
    expect(applyInputValueInPage('#d', '14:30', deepQuery, INVALID_SELECTOR)).toBe('skip')
  })

  it('reports a missing element as not-found (the host wrapper throws on this)', () => {
    expect(applyInputValueInPage('#missing', '14:30', deepQuery, INVALID_SELECTOR)).toBe('not-found')
  })
})
