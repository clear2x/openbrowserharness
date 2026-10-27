/**
 * cdpController attach/send race window (the 竞态假性失败 regression lock):
 * - a command sent while the tab's attach was still in flight used to skip
 *   the join and fire immediately, failing with the misleading
 *   「调试会话已断开」; send() now joins the same in-flight attach task;
 * - an external detach notification mid-attach no longer deletes the
 *   in-flight attaching entry, so joiners keep sharing the one task.
 * Only the race window is pinned here: a genuine detach after a completed
 * attach keeps the original 调试会话已断开 error (unchanged behavior, and
 * covered by the send error translation, not re-locked).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface DebuggeeTarget {
  type: string
  tabId?: number
  attached: boolean
  extensionId?: string
  id?: string
}

const state = vi.hoisted(() => ({
  attachDelayMs: 0,
  attachCalls: 0,
  attaching: new Set<number>(),
  attached: new Set<number>(),
  commands: [] as Array<{ tabId: number; method: string }>,
}))

vi.mock('../src/background/capability-gate.ts', () => ({
  blockMediaEnabled: async (): Promise<boolean> => false,
  beaconBlockEnabled: async (): Promise<boolean> => false,
}))

/**
 * chrome.debugger double that reproduces the race: attach takes
 * attachDelayMs, and a second attach overlapping an in-flight one is
 * rejected the way real Chromium rejects it (Another debugger is already
 * attached); sendCommand rejects Not attached until the attach lands.
 */
function installChromeDouble(): void {
  const sessionStore = new Map<string, unknown>()
  const chromeDouble = {
    runtime: { id: 'dsh-test' },
    storage: {
      session: {
        get: async (keys: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>> => {
          const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
          const out: Record<string, unknown> = {}
          for (const name of names) {
            if (sessionStore.has(name)) out[name] = sessionStore.get(name)
          }
          return out
        },
        set: async (items: Record<string, unknown>): Promise<void> => {
          for (const [key, value] of Object.entries(items)) sessionStore.set(key, value)
        },
        remove: async (keys: string | string[]): Promise<void> => {
          for (const key of typeof keys === 'string' ? [keys] : keys) sessionStore.delete(key)
        },
      },
    },
    debugger: {
      attach: async (target: { tabId: number }): Promise<void> => {
        if (state.attaching.has(target.tabId) || state.attached.has(target.tabId)) {
          throw new Error('Another debugger is already attached')
        }
        state.attaching.add(target.tabId)
        state.attachCalls += 1
        await new Promise(resolve => setTimeout(resolve, state.attachDelayMs))
        state.attaching.delete(target.tabId)
        state.attached.add(target.tabId)
      },
      sendCommand: async (target: { tabId: number }, method: string): Promise<unknown> => {
        if (!state.attached.has(target.tabId)) throw new Error('Not attached')
        state.commands.push({ tabId: target.tabId, method })
        return {}
      },
      detach: async (target: { tabId: number }): Promise<void> => {
        state.attached.delete(target.tabId)
      },
      getTargets: async (): Promise<DebuggeeTarget[]> =>
        [...state.attached].map(tabId => ({ type: 'page', tabId, attached: true, extensionId: 'dsh-test', id: `t${String(tabId)}` })),
    },
  }
  ;(globalThis as { chrome?: unknown }).chrome = chromeDouble
}

function deleteChrome(): void {
  delete (globalThis as { chrome?: unknown }).chrome
}

const { cdpController } = await import('../src/background/cdp.ts')

beforeEach(() => {
  state.attachDelayMs = 0
  state.attachCalls = 0
  state.attaching.clear()
  state.attached.clear()
  state.commands.length = 0
  installChromeDouble()
})

afterEach(() => {
  deleteChrome()
})

describe('cdp attach/send race window', () => {
  it('a fire-and-forget send plus an awaited send during a slow attach both succeed (no 调试会话已断开)', async () => {
    state.attachDelayMs = 60

    const first = cdpController.send(7, 'Runtime.evaluate', { expression: '1' }) // not awaited
    const second = await cdpController.send(7, 'Runtime.evaluate', { expression: '2' })
    await expect(first).resolves.toBeDefined()
    expect(second).toBeDefined()

    // Attach-time enables first, then BOTH user commands — the second send
    // joined the in-flight attach instead of firing before it completed.
    expect(state.commands.map(command => command.method))
      .toEqual(['Page.enable', 'Runtime.enable', 'Runtime.evaluate', 'Runtime.evaluate'])
    expect(state.attachCalls).toBe(1)
  })

  it('an onDetach notification during an in-flight attach keeps the attach task joinable', async () => {
    state.attachDelayMs = 30

    const inflight = cdpController.attach(7)
    cdpController.handleDetached(7) // external detach event mid-attach
    await expect(cdpController.send(7, 'Runtime.evaluate', {})).resolves.toBeDefined()
    await expect(inflight).resolves.toBeUndefined()

    // One attach task total: the send joined it instead of starting a second
    // attach (which Chromium would reject while the first is in flight).
    expect(state.attachCalls).toBe(1)
    expect(cdpController.isAttached(7)).toBe(true)
  })
})
