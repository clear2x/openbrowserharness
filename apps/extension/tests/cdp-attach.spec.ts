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
  /** Per-tab Page.enable failures remaining: tripping also kills the session, like a real target swap. */
  failEnable: new Map<number, number>(),
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
        if (method === 'Page.enable') {
          const remaining = state.failEnable.get(target.tabId) ?? 0
          if (remaining > 0) {
            state.failEnable.set(target.tabId, remaining - 1)
            // A dying session takes the debuggee with it (target swap / wake).
            state.attached.delete(target.tabId)
            throw new Error('Not attached')
          }
        }
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
  state.failEnable.clear()
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

  it('a session that dies between attach and Page.enable gets ONE heal cycle and succeeds', async () => {
    // Tab 8: untouched by the earlier tests — the controller singleton keeps
    // its attachedTabs across tests while the double's browser layer resets,
    // and a reused id would ride the already-attached fast path instead.
    state.failEnable.set(8, 1)

    await expect(cdpController.send(8, 'Runtime.evaluate', {})).resolves.toBeDefined()

    // Fresh attach, Page.enable (dies unrecorded), heal (attach #2), enable,
    // then the user command — the controller did not surface the transient
    // death: exactly one recorded enable (the heal's) and one user command.
    expect(state.attachCalls).toBe(2)
    expect(state.commands.filter(command => command.method === 'Page.enable')).toHaveLength(1)
    expect(state.commands.at(-1)?.method).toBe('Runtime.evaluate')
    expect(cdpController.isAttached(8)).toBe(true)
  })

  it('a session that keeps dying after attach fails with the live-state enriched error', async () => {
    state.failEnable.set(9, 9)

    await expect(cdpController.send(9, 'Runtime.evaluate', {})).rejects.toThrow(/自动重试 1 次仍失败/)
    await expect(cdpController.send(9, 'Runtime.evaluate', {})).rejects.toThrow(/现场：/)
    // The half-session never survives in the map: the next call retries attach.
    expect(cdpController.isAttached(9)).toBe(false)
    expect(state.attachCalls).toBeGreaterThanOrEqual(2)
  })
})
