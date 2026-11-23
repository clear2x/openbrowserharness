/**
 * cdpController (chrome.debugger owner) — the session-lifecycle regression
 * locks of batch 279/280:
 * - the attach/send race window (the 竞态假性失败 lock): a command sent while
 *   the tab's attach was still in flight joins the in-flight task instead of
 *   firing early with the misleading 「调试会话已断开」; an external detach
 *   notification mid-attach does not delete the in-flight entry;
 * - a session that dies right after the attach resolves is healed on a
 *   backoff schedule, and the final failure names the most recent detach
 *   event (a canceled debugging notice bar tells the model to stop retrying);
 * - non-retryable failures (protected page, another debugger) surface at once
 *   with the live state;
 * - a command that finds the session gone re-attaches and runs exactly once;
 * - a discarded tab is reloaded before the attach; an adopted session is
 *   verified by a probe before it is trusted.
 * Every test drives its OWN controller instance: the singleton would leak its
 * attach map across tests while the chrome double resets between them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface DebuggeeTarget {
  type: string
  tabId?: number
  attached: boolean
  extensionId?: string
  id?: string
}

interface TabState {
  discarded?: boolean
  status?: string
}

const state = vi.hoisted(() => ({
  attachDelayMs: 0,
  attachCalls: 0,
  /** Every attach() entry, including ones that throw before attaching. */
  attachAttempts: 0,
  attaching: new Set<number>(),
  attached: new Set<number>(),
  commands: [] as Array<{ tabId: number; method: string; expression: string | undefined }>,
  /** Per-tab Page.enable failures remaining; tripping also kills the session, like a detach right after the attach. */
  failEnable: new Map<number, number>(),
  /** The detach reason announced when a trip kills a session. */
  detachReason: undefined as string | undefined,
  /** Tabs whose listed session belongs to ANOTHER debugger: our commands are rejected and our detach fails. */
  foreignSessions: new Set<number>(),
  /** The command expression after which the tab silently loses its session (no event). */
  silentDropAfterExpression: undefined as string | undefined,
  /** chrome.tabs state per tab (absent = the tab API reports normally). */
  tabs: new Map<number, TabState>(),
  reloads: [] as number[],
  /** attach() throws this raw message instead of attaching, when set. */
  attachError: undefined as string | undefined,
  detachListeners: [] as Array<(source: { tabId?: number }, reason: string) => void>,
}))

vi.mock('../src/background/capability-gate.ts', () => ({
  blockMediaEnabled: async (): Promise<boolean> => false,
  beaconBlockEnabled: async (): Promise<boolean> => false,
}))

/**
 * chrome.debugger double reproducing the real failure modes: attach takes
 * attachDelayMs; a second attach on an attached tab is rejected the way
 * Chromium rejects it (Another debugger is already attached); sendCommand
 * rejects Not attached until the attach lands; a tripped Page.enable kills
 * the session and announces the detach like chrome.debugger.onDetach does.
 */
function installChromeDouble(): void {
  const sessionStore = new Map<string, unknown>()
  const kill = (tabId: number): void => {
    state.attached.delete(tabId)
    for (const listener of state.detachListeners) listener({ tabId }, state.detachReason ?? 'target_closed')
  }
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
      onDetach: {
        addListener: (listener: (source: { tabId?: number }, reason: string) => void): void => {
          state.detachListeners.push(listener)
        },
      },
      attach: async (target: { tabId: number }): Promise<void> => {
        state.attachAttempts += 1
        if (state.attachError !== undefined) throw new Error(state.attachError)
        if (state.attaching.has(target.tabId) || state.attached.has(target.tabId)) {
          throw new Error('Another debugger is already attached to the tab with id: ' + String(target.tabId))
        }
        state.attaching.add(target.tabId)
        state.attachCalls += 1
        await new Promise(resolve => setTimeout(resolve, state.attachDelayMs))
        state.attaching.delete(target.tabId)
        state.attached.add(target.tabId)
      },
      sendCommand: async (target: { tabId: number }, method: string, params?: { expression?: string }): Promise<unknown> => {
        if (!state.attached.has(target.tabId) || state.foreignSessions.has(target.tabId)) {
          throw new Error('Debugger is not attached to the tab with id: ' + String(target.tabId))
        }
        const expression = params?.expression
        if (method === 'Page.enable') {
          const remaining = state.failEnable.get(target.tabId) ?? 0
          if (remaining > 0) {
            state.failEnable.set(target.tabId, remaining - 1)
            kill(target.tabId)
            throw new Error('Debugger is not attached to the tab with id: ' + String(target.tabId))
          }
        }
        state.commands.push({ tabId: target.tabId, method, expression })
        if (state.silentDropAfterExpression !== undefined && expression === state.silentDropAfterExpression) {
          state.silentDropAfterExpression = undefined
          state.attached.delete(target.tabId)
        }
        return {}
      },
      detach: async (target: { tabId: number }): Promise<void> => {
        if (!state.attached.has(target.tabId) || state.foreignSessions.has(target.tabId)) {
          throw new Error('Debugger is not attached to the tab with id: ' + String(target.tabId))
        }
        state.attached.delete(target.tabId)
      },
      getTargets: async (): Promise<DebuggeeTarget[]> =>
        // Edge-shaped entries: every known page target (attached or not), extensionId omitted,
        // the tab's agent-host id stable.
        [...new Set([...state.attached, ...state.tabs.keys()])].map(tabId => ({
          type: 'page',
          tabId,
          attached: state.attached.has(tabId),
          id: `agent-${String(tabId)}`,
        })),
    },
    tabs: {
      get: async (tabId: number): Promise<TabState & { discarded: boolean }> => {
        const tab = state.tabs.get(tabId)
        if (tab === undefined) throw new Error(`No tab with id: ${String(tabId)}.`)
        return { discarded: false, ...tab }
      },
      reload: async (tabId: number): Promise<void> => {
        state.reloads.push(tabId)
        state.tabs.set(tabId, { discarded: false, status: 'loading' })
        setTimeout(() => { state.tabs.set(tabId, { discarded: false, status: 'complete' }) }, 15)
      },
    },
  }
  ;(globalThis as { chrome?: unknown }).chrome = chromeDouble
}

function deleteChrome(): void {
  delete (globalThis as { chrome?: unknown }).chrome
}

const { CdpController, describeDetach } = await import('../src/background/cdp.ts')

/** A fast controller plus the chrome.double's detach events wired into it. */
function freshController(): InstanceType<typeof CdpController> {
  const controller = new CdpController({ attachRetryWaitsMs: [0, 2, 4, 6], adoptProbeMs: 40, wakeWaitMs: 300 })
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId !== undefined) controller.handleDetached(source.tabId, reason)
  })
  return controller
}

beforeEach(() => {
  state.attachDelayMs = 0
  state.attachCalls = 0
  state.attachAttempts = 0
  state.attaching.clear()
  state.attached.clear()
  state.commands.length = 0
  state.failEnable.clear()
  state.detachReason = undefined
  state.foreignSessions.clear()
  state.silentDropAfterExpression = undefined
  state.tabs.clear()
  state.reloads.length = 0
  state.attachError = undefined
  state.detachListeners.length = 0
  installChromeDouble()
})

afterEach(() => {
  deleteChrome()
})

const methods = (): string[] => state.commands.map(command => command.method)

describe('cdp attach/send race window', () => {
  it('a fire-and-forget send plus an awaited send during a slow attach both succeed (no 调试会话已断开)', async () => {
    state.attachDelayMs = 60
    const controller = freshController()

    const first = controller.send(7, 'Runtime.evaluate', { expression: '1 + 1' })
    const second = await controller.send(7, 'Runtime.evaluate', { expression: '2 + 2' })
    await expect(first).resolves.toBeDefined()
    expect(second).toBeDefined()

    // Attach-time enables first, then BOTH user commands — the second send
    // joined the in-flight attach instead of firing before it completed.
    expect(methods()).toEqual(['Page.enable', 'Runtime.enable', 'Runtime.evaluate', 'Runtime.evaluate'])
    expect(state.attachCalls).toBe(1)
  })

  it('an onDetach notification during an in-flight attach keeps the attach task joinable', async () => {
    state.attachDelayMs = 30
    const controller = freshController()

    const inflight = controller.attach(7)
    controller.handleDetached(7, 'target_closed') // external detach event mid-attach
    await expect(controller.send(7, 'Runtime.evaluate', {})).resolves.toBeDefined()
    await expect(inflight).resolves.toBeUndefined()

    // One attach task total: the send joined it instead of starting a second
    // attach (which Chromium would reject while the first is in flight).
    expect(state.attachCalls).toBe(1)
    expect(controller.isAttached(7)).toBe(true)
  })
})

describe('a session that dies right after the attach', () => {
  it('is healed within the backoff schedule and the transient death never surfaces', async () => {
    state.failEnable.set(7, 2) // dies on the first two attempts, third sticks
    const controller = freshController()

    await expect(controller.send(7, 'Runtime.evaluate', {})).resolves.toBeDefined()

    expect(state.attachCalls).toBe(3)
    // Only the surviving attempt's enables are recorded, then the command.
    expect(methods()).toEqual(['Page.enable', 'Runtime.enable', 'Runtime.evaluate'])
    expect(controller.isAttached(7)).toBe(true)
  })

  it('fails with the retry count, the live state, and the detach cause when the death persists', async () => {
    state.failEnable.set(7, 9)
    state.detachReason = 'canceled_by_user'
    const controller = freshController()

    const error = await controller.send(7, 'Runtime.evaluate', {}).then(
      () => { throw new Error('expected rejection') },
      (err: unknown) => err as Error,
    )

    expect(error.message).toContain('已自动重试 3 次仍失败')
    expect(error.message).toContain('canceled_by_user')
    // The one cause retrying cannot fix: the model must stop and inform the user.
    expect(error.message).toContain('请停止重试')
    expect(error.message).toContain('提示条')
    expect(error.message).toContain('浏览器层无附加会话')
    expect(state.attachCalls).toBe(4)
    expect(controller.isAttached(7)).toBe(false)
    expect(methods()).not.toContain('Runtime.evaluate')
  })

  it('says so when no detach event was observed (a silent death)', async () => {
    state.failEnable.set(7, 9)
    const controller = freshController()
    state.detachListeners.length = 0 // the SW slept through the events: unwire the double's announcements

    await expect(controller.attach(7)).rejects.toThrow('期间未收到调试会话断开事件')
  })

  it('leaves the lane retryable: the next call after a failed attach starts a fresh attempt', async () => {
    state.failEnable.set(7, 4) // all four attempts die this time
    const controller = freshController()
    await expect(controller.attach(7)).rejects.toThrow('已自动重试 3 次')

    state.failEnable.set(7, 0)
    await expect(controller.send(7, 'Runtime.evaluate', {})).resolves.toBeDefined()
    expect(state.attachCalls).toBe(5)
  })
})

describe('non-retryable attach failures', () => {
  it('surfaces a protected page at once with the live state, without retrying', async () => {
    state.attachError = 'Cannot access a chrome:// URL'
    state.tabs.set(7, { status: 'complete' }) // the tab exists; only its page is protected
    const controller = freshController()

    const error = await controller.attach(7).then(
      () => { throw new Error('expected rejection') },
      (err: unknown) => err as Error,
    )
    expect(error.message).toContain('该页面受保护')
    expect(error.message).toContain('标签页存在')
    expect(state.attachAttempts).toBe(1)
  })

  it('translates a missing tab and reports it at once (no retry delay)', async () => {
    state.attachError = 'No tab with given id 7.'
    const controller = freshController()

    const error = await controller.attach(7).then(
      () => { throw new Error('expected rejection') },
      (err: unknown) => err as Error,
    )
    expect(error.message).toContain('目标标签页不存在')
    expect(state.attachAttempts).toBe(1)
  })
})

describe('a command that finds the session gone', () => {
  it('re-attaches and runs the command exactly once', async () => {
    const controller = freshController()
    state.silentDropAfterExpression = 'first' // the session vanishes right after the first command lands
    await controller.send(7, 'Runtime.evaluate', { expression: 'first' })

    await expect(controller.send(7, 'Runtime.evaluate', { expression: 'second' })).resolves.toBeDefined()

    expect(methods()).toEqual([
      'Page.enable', 'Runtime.enable', 'Runtime.evaluate',
      'Page.enable', 'Runtime.enable', 'Runtime.evaluate',
    ])
    expect(state.commands.filter(command => command.expression === 'second')).toHaveLength(1)
    expect(state.attachCalls).toBe(2)
  })

  it('translates the final rejection without the internal op name', async () => {
    const controller = freshController()
    await controller.attach(7)
    state.attached.delete(7)
    state.attachError = 'Cannot access a chrome:// URL' // the re-attach cannot succeed either

    await expect(controller.send(7, 'Runtime.evaluate', {})).rejects.toThrow('该页面受保护')
  })
})

describe('discarded tabs', () => {
  it('reloads a discarded tab and awaits its load before attaching', async () => {
    state.tabs.set(7, { discarded: true })
    const controller = freshController()

    await controller.attach(7)

    expect(state.reloads).toEqual([7])
    expect(state.attachCalls).toBe(1)
    expect(state.tabs.get(7)?.status).toBe('complete')
  })

  it('attaches a live tab without touching the tab API beyond the status read', async () => {
    const controller = freshController()
    await controller.attach(7)
    expect(state.reloads).toEqual([])
    expect(state.attachCalls).toBe(1)
  })
})

describe('sessions the browser layer already holds', () => {
  it('replaces a leftover session of our own (a previous SW incarnation) with a clean one', async () => {
    state.attached.add(7)
    const controller = freshController()

    await controller.attach(7)

    expect(state.attachCalls).toBe(1)
    expect(controller.isAttached(7)).toBe(true)
    expect(methods()).toEqual(['Page.enable', 'Runtime.enable'])
  })

  it('stays loud when another debugger holds the tab', async () => {
    state.attached.add(7)
    state.foreignSessions.add(7)
    const controller = freshController()

    await expect(controller.attach(7)).rejects.toThrow('已被其他调试器占用')
    expect(state.attachCalls).toBe(0)
    expect(controller.isAttached(7)).toBe(false)
  })

  it('does not let a stale ownership record vouch for a session another debugger holds', async () => {
    state.attached.add(7)
    state.foreignSessions.add(7)
    const controller = freshController()
    // The record our earlier attach left behind names the same agent host
    // the other debugger now sits on — the shape that fooled the old adopt.
    await chrome.storage.session.set({ 'dsh-dbg-target:7': 'agent-7' })

    await expect(controller.attach(7)).rejects.toThrow('已被其他调试器占用')
    expect(state.attachCalls).toBe(0)
    // The stale record was cleared so later adopt probes cannot re-trust it.
    expect(await chrome.storage.session.get('dsh-dbg-target:7')).toEqual({})
  })
})

describe('detach cause text', () => {
  const now = 1_000_000

  it('turns a canceled debugging notice into a stop-and-inform instruction', () => {
    const text = describeDetach({ reason: 'canceled_by_user', at: now - 40 }, now)
    expect(text).toContain('40ms 前')
    expect(text).toContain('请停止重试')
    expect(text).toContain('不要点「取消」')
  })

  it('names other reasons plainly and never reports a negative age', () => {
    expect(describeDetach({ reason: 'target_closed', at: now }, now)).toBe('0ms 前调试目标被关闭（target_closed）。')
    expect(describeDetach({ reason: 'replaced_with_devtools', at: now + 5 }, now)).toContain('0ms 前调试会话被断开（replaced_with_devtools）。')
  })
})
