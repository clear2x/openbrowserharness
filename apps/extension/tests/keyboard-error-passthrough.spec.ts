/**
 * executeCdpOp error passthrough for page_type / page_press_key: a value
 * readback failure inside typeText (native writeback still mismatched, or
 * the browser rejected a structured format) must surface to the model as
 * the `{ ok: false, error }` envelope with expected/actual code-point
 * counts — the typed text itself (routinely a credential) is never echoed.
 *
 * The dispatcher is exercised for real (imported from ops.ts); only the
 * CDP controller, the page-evaluate surface, and the presentation-side
 * docking/overlay modules are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CdpResponse } from '../src/shared/protocol.ts'

const cdpSend = vi.hoisted(() =>
  vi.fn<(tabId: number, method: string, params: Record<string, unknown>) => Promise<unknown>>(),
)
const evaluateInPage = vi.hoisted(() =>
  vi.fn<(tabId: number, script: string) => Promise<unknown>>(),
)
const gates = vi.hoisted(() => ({ humanized: false, submitGuard: false }))

vi.mock('../src/background/cdp.ts', () => ({
  cdpController: { send: (tabId: number, method: string, params: Record<string, unknown>) => cdpSend(tabId, method, params) },
  sleep: () => Promise.resolve(),
}))
vi.mock('../src/background/dom-snapshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/background/dom-snapshot.ts')>()
  return { ...actual, evaluateInPage: (tabId: number, script: string) => evaluateInPage(tabId, script) }
})
vi.mock('../src/background/mouse.ts', () => ({
  click: vi.fn(async () => ({ x: 10, y: 10 })),
  scroll: vi.fn(async () => undefined),
}))
vi.mock('../src/background/dock.ts', () => ({
  dockTabBesidePanel: vi.fn(async () => undefined),
  dockWindowForNewTab: vi.fn(async () => undefined),
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
    submitGuardEnabled: () => Promise.resolve(gates.submitGuard),
  }
})

const { executeCdpOp } = await import('../src/background/ops.ts')

/** The value-readback script (serialized source carries the 'not-found' sentinel) answers `sentinel`. */
function primeReadback(sentinel: string): void {
  evaluateInPage.mockImplementation(async (_tabId: number, script: string) =>
    script.includes('not-found') ? sentinel : true)
}

function errorOf(res: CdpResponse): string {
  expect(res.ok).toBe(false)
  return res.error ?? '(missing error)'
}

beforeEach(() => {
  gates.humanized = false
  gates.submitGuard = false
  cdpSend.mockReset()
  cdpSend.mockResolvedValue(undefined)
  evaluateInPage.mockReset()
})

describe('type_text error passthrough', () => {
  it('a readback mismatch after the native writeback surfaces with expected/actual lengths', async () => {
    primeReadback('mismatch:5:0')

    const res = await executeCdpOp('type_text', 7, { selector: '#secret', text: 'hello' })

    const error = errorOf(res)
    expect(error).toContain('输入写入校验失败')
    expect(error).toContain('期望 5 个字符')
    expect(error).toContain('实际 0 个字符')
    expect(error).toContain('#secret')
    expect(error).not.toContain('hello')
  })

  it('a structured time rejection surfaces with the length summary, not the text', async () => {
    primeReadback('rejected-empty')

    const res = await executeCdpOp('type_text', 7, { selector: '#t', text: '25:99' })

    const error = errorOf(res)
    expect(error).toContain('时间/日期输入框')
    expect(error).toContain('共 5 个字符')
    expect(error).not.toContain('25:99')
  })

  it('a verified value keeps the {ok:true} envelope', async () => {
    primeReadback('ok')

    const res = await executeCdpOp('type_text', 7, { selector: '#a', text: 'hi' })

    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ selector: '#a', length: 2 })
  })
})

describe('press_key error passthrough', () => {
  it('an unsupported combo surfaces as {ok:false, error}', async () => {
    const res = await executeCdpOp('press_key', 7, { key: 'Hyper+Q' })

    expect(errorOf(res)).toContain('不支持的修饰键')
  })
})
