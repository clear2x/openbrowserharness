/**
 * page_press_key combo support: modifier combos ("Ctrl+A",
 * "Ctrl+Shift+ArrowLeft", "Alt+ArrowLeft", "Cmd+C") press modifiers in
 * declared order, run the base key between them, and release in reverse —
 * with CDP modifier bits (Alt=1, Ctrl=2, Meta=4, Shift=8). Bare single-key
 * behavior is unchanged (regression-locked here).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const cdpSend = vi.fn()

vi.mock('../src/background/cdp.ts', () => ({
  cdpController: { send: (...args: unknown[]) => cdpSend(...args) },
  sleep: () => Promise.resolve(),
}))
vi.mock('../src/background/dom-snapshot.ts', () => ({
  evaluateInPage: vi.fn(),
  getElementRect: vi.fn(),
  getViewport: vi.fn(),
}))
vi.mock('../src/background/mouse.ts', () => ({
  click: vi.fn(),
}))

const { pressKey } = await import('../src/background/keyboard.ts')

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
    .map(call => call[2] as KeyEvent)
}

beforeEach(() => {
  cdpSend.mockReset()
  cdpSend.mockResolvedValue(undefined)
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
