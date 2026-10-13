/**
 * page_press_key combo support: modifier combos ("Ctrl+A",
 * "Ctrl+Shift+ArrowLeft", "Alt+ArrowLeft", "Cmd+C") press modifiers in
 * declared order, run the base key between them, and release in reverse —
 * with CDP modifier bits (Alt=1, Ctrl=2, Meta=4, Shift=8). Bare single-key
 * behavior is unchanged (regression-locked here).
 *
 * Also locks the 拟人化 pacing seams: the 40~110ms pressKey hold runs only
 * with the switch on, and the humanize-off typeText fast path commits long
 * text in one Input.insertText call with keystroke-stream fallbacks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const cdpSend = vi.hoisted(() =>
  vi.fn<(tabId: number, method: string, params: Record<string, unknown>) => Promise<unknown>>(),
)
const evaluateInPage = vi.hoisted(() =>
  vi.fn<(tabId: number, script: string) => Promise<unknown>>(),
)
const gates = vi.hoisted(() => ({ humanized: false }))

vi.mock('../src/background/cdp.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/background/cdp.ts')>()
  return {
    ...actual,
    cdpController: { send: (tabId: number, method: string, params: Record<string, unknown>) => cdpSend(tabId, method, params) },
  }
})
vi.mock('../src/background/dom-snapshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/background/dom-snapshot.ts')>()
  return { ...actual, evaluateInPage: (tabId: number, script: string) => evaluateInPage(tabId, script) }
})
vi.mock('../src/background/mouse.ts', () => ({
  click: vi.fn(async () => ({ x: 10, y: 10 })),
  scroll: vi.fn(async () => undefined),
}))
vi.mock('../src/background/virtual-cursor.ts', () => ({
  showTypePulse: vi.fn(async () => undefined),
  showScroll: vi.fn(async () => undefined),
  noteBrowserOperation: vi.fn(),
}))
vi.mock('../src/background/capability-gate.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/background/capability-gate.ts')>()
  return {
    ...actual,
    humanizedInputEnabled: () => Promise.resolve(gates.humanized),
    submitGuardEnabled: () => Promise.resolve(false),
  }
})

const { pressKey, typeText } = await import('../src/background/keyboard.ts')

interface KeyEvent {
  type: string
  modifiers?: number
  key?: string
  code?: string
  windowsVirtualKeyCode?: number
  text?: string
}

function keyEvents(): KeyEvent[] {
  return cdpSend.mock.calls
    .filter(call => call[1] === 'Input.dispatchKeyEvent')
    .map(call => call[2] as unknown as KeyEvent)
}

function insertTextCalls(): Array<Record<string, unknown>> {
  return cdpSend.mock.calls
    .filter(call => call[1] === 'Input.insertText')
    .map(call => call[2])
}

/**
 * Prime the in-page evaluateInPage mock: the value-readback script (its
 * serialized source contains the 'not-found' sentinel) answers `sentinel`,
 * every other probe (the focusedEditable check) answers `editable`.
 */
function primeInPage(editable: boolean, sentinel: string): void {
  evaluateInPage.mockImplementation(async (_tabId: number, script: string) =>
    script.includes('not-found') ? sentinel : editable)
}

beforeEach(() => {
  gates.humanized = false
  cdpSend.mockReset()
  cdpSend.mockResolvedValue(undefined)
  evaluateInPage.mockReset()
})

describe('pressKey single keys (regression)', () => {
  it('keeps the bare Enter triplet and its text payload', async () => {
    await pressKey(7, 'Enter')

    const events = keyEvents()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    expect(events[1]).toMatchObject({ type: 'keyUp', key: 'Enter' })
    expect('modifiers' in events[0]!).toBe(false)
  })

  it('keeps alias resolution and the bare-space name', async () => {
    await pressKey(7, 'return')
    await pressKey(7, 'space')

    const events = keyEvents()
    expect(events[0]).toMatchObject({ type: 'keyDown', key: 'Enter' })
    expect(events[2]).toMatchObject({ type: 'keyDown', key: 'Space', text: ' ' })
  })
})

describe('pressKey combos', () => {
  it('Ctrl+A presses Control, types no text, releases in reverse', async () => {
    await pressKey(7, 'Ctrl+A')

    const events = keyEvents()
    expect(events).toHaveLength(4)
    expect(events[0]).toMatchObject({ type: 'keyDown', modifiers: 2, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
    expect(events[1]).toMatchObject({ type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    expect(events[1]!.text).toBeUndefined()
    expect(events[2]).toMatchObject({ type: 'keyUp', modifiers: 2, key: 'a' })
    expect(events[3]).toMatchObject({ type: 'keyUp', modifiers: 2, key: 'Control' })
  })

  it('stacks modifier bits for Ctrl+Shift+ArrowLeft and unwinds in reverse', async () => {
    await pressKey(7, 'Ctrl+Shift+ArrowLeft')

    const events = keyEvents()
    expect(events.map(e => `${e.type}:${e.key}`)).toEqual([
      'keyDown:Control',
      'keyDown:Shift',
      'keyDown:ArrowLeft',
      'keyUp:ArrowLeft',
      'keyUp:Shift',
      'keyUp:Control',
    ])
    const bits = events.map(e => e.modifiers)
    expect(bits).toEqual([2, 10, 10, 10, 10, 10])
  })

  it('maps Alt to bit 1 (history-back spelling)', async () => {
    await pressKey(7, 'Alt+ArrowLeft')

    const events = keyEvents()
    expect(events[0]).toMatchObject({ type: 'keyDown', modifiers: 1, key: 'Alt' })
    expect(events[1]).toMatchObject({ type: 'keyDown', modifiers: 1, key: 'ArrowLeft', windowsVirtualKeyCode: 37 })
  })

  it('accepts Meta aliases and digit base keys', async () => {
    await pressKey(7, 'Cmd+C')

    const events = keyEvents()
    expect(events[0]).toMatchObject({ type: 'keyDown', modifiers: 4, key: 'Meta' })
    expect(events[1]).toMatchObject({ type: 'keyDown', modifiers: 4, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 })
  })

  it('is case-insensitive end to end', async () => {
    await pressKey(7, 'ctrl+shift+a')

    const events = keyEvents()
    expect(events.map(e => `${e.type}:${e.key}`)).toEqual([
      'keyDown:Control',
      'keyDown:Shift',
      'keyDown:a',
      'keyUp:a',
      'keyUp:Shift',
      'keyUp:Control',
    ])
    expect(events[2]).toMatchObject({ modifiers: 10, key: 'a' })
  })

  it('suppresses the text payload on modified text-producing keys (Ctrl+Space)', async () => {
    await pressKey(7, 'Ctrl+Space')

    const events = keyEvents()
    expect(events[1]).toMatchObject({ type: 'keyDown', modifiers: 2, key: 'Space', windowsVirtualKeyCode: 32 })
    expect(events[1]!.text).toBeUndefined()
  })

  it('reaches the provider-supported named keys the old schema enum hid', async () => {
    await pressKey(7, 'PageUp')
    await pressKey(7, 'Delete')

    const events = keyEvents()
    expect(events[0]).toMatchObject({ type: 'keyDown', key: 'PageUp', windowsVirtualKeyCode: 33 })
    expect(events[2]).toMatchObject({ type: 'keyDown', key: 'Delete', windowsVirtualKeyCode: 46 })
  })
})

describe('pressKey fail-loud', () => {
  it('rejects unknown modifiers, unknown base keys, and dangling separators', async () => {
    await expect(pressKey(7, 'Hyper+A')).rejects.toThrow('不支持的修饰键')
    await expect(pressKey(7, 'Ctrl+Foo')).rejects.toThrow('不支持的按键')
    await expect(pressKey(7, 'Ctrl+')).rejects.toThrow('格式错误')
    await expect(pressKey(7, '你好')).rejects.toThrow('不支持的按键')
  })
})

describe('pressKey hold pacing (拟人化 gate)', () => {
  it('schedules zero hold timers when 拟人化 is off (fake timers)', async () => {
    gates.humanized = false
    vi.useFakeTimers()
    try {
      await pressKey(7, 'Enter')
      expect(vi.getTimerCount()).toBe(0)
      expect(keyEvents().map(e => e.type)).toEqual(['keyDown', 'keyUp'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds the key 40~110ms between down and up when 拟人化 is on (fake timers)', async () => {
    gates.humanized = true
    vi.useFakeTimers()
    try {
      const run = pressKey(7, 'Enter')
      // The hold is closed-range [40, 110]: at 39ms the key is still down.
      await vi.advanceTimersByTimeAsync(39)
      expect(keyEvents().map(e => e.type)).toEqual(['keyDown'])
      await vi.advanceTimersByTimeAsync(200)
      await run
      expect(keyEvents().map(e => e.type)).toEqual(['keyDown', 'keyUp'])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('typeText humanize-off fast path (Input.insertText)', () => {
  it('commits 100 characters in one insertText call — ≤4 CDP calls total, no keystrokes', async () => {
    gates.humanized = false
    primeInPage(true, 'ok')
    const text = 'a'.repeat(100)

    await typeText(7, '#box', text)

    expect(insertTextCalls()).toEqual([{ text }])
    expect(cdpSend.mock.calls.length).toBeLessThanOrEqual(4)
    expect(keyEvents()).toHaveLength(0)
  })

  it('falls back to the keystroke stream when the focused element is not editable', async () => {
    gates.humanized = false
    primeInPage(false, 'ok')

    await typeText(7, '#box', 'x'.repeat(30))

    expect(insertTextCalls()).toHaveLength(0)
    const chars = keyEvents().filter(e => e.type === 'char')
    expect(chars).toHaveLength(30)
  })

  it('falls back to the keystroke stream when Input.insertText fails', async () => {
    gates.humanized = false
    primeInPage(true, 'ok')
    cdpSend.mockImplementation(async (_tabId: number, method: string) => {
      if (method === 'Input.insertText') throw new Error('insert rejected')
      return undefined
    })

    await typeText(7, '#box', 'x'.repeat(30))

    expect(insertTextCalls()).toHaveLength(1)
    expect(keyEvents().filter(e => e.type === 'char')).toHaveLength(30)
  })

  it('keeps short text on the zero-delay keystroke stream (no insertText)', async () => {
    gates.humanized = false
    primeInPage(true, 'ok')

    await typeText(7, '#box', 'short text')

    expect(insertTextCalls()).toHaveLength(0)
    expect(keyEvents().filter(e => e.type === 'char').map(e => e.text))
      .toEqual(Array.from('short text'))
  })

  it('keeps the per-character stream when 拟人化 is on (no insertText)', async () => {
    gates.humanized = true
    primeInPage(true, 'ok')

    await typeText(7, '#box', 'hi')

    expect(insertTextCalls()).toHaveLength(0)
    expect(keyEvents().filter(e => e.type === 'char').map(e => e.text)).toEqual(['h', 'i'])
  })
})
