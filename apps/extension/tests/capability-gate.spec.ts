/**
 * capability-gate spec: the switch reader behind the input gestures and the
 * tool gate answers from the storage client in every extension context — the
 * offscreen engine included, whose `chrome` object carries `runtime` only —
 * so a switch the panel turned on is on in the engine too, and a toggle
 * reaches the next call through the change broadcast.
 *
 * @module capability-gate-spec
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CURSOR_CAPABILITY_KEY, SAFE_CLICK_CAPABILITY_KEY, SCRIPT_NETWORK_CAPABILITY_KEY } from '../src/shared/capability-keys.ts'
import {
  cursorOverlayEnabled, directSiteApiEnabled, safeClickEnabled, submitGuardEnabled,
} from '../src/background/capability-gate.ts'

/** The storage client stand-in: the stored flags, a forced outage, the reads, and the change listeners. */
const storageState = vi.hoisted(() => ({
  flags: {} as Record<string, { enabled: boolean }>,
  fail: false,
  reads: [] as string[][],
  listeners: [] as Array<(area: string) => void>,
}))

vi.mock('../src/chrome/storage-client.ts', () => ({
  storageGet: async (keys: string[]): Promise<Record<string, unknown>> => {
    storageState.reads.push(keys)
    if (storageState.fail) throw new Error('访问设置存储失败（后台服务未就绪）')
    return Object.fromEntries(
      keys.filter(key => storageState.flags[key] !== undefined).map(key => [key, storageState.flags[key]]),
    )
  },
  onStorageChanged: (cb: (area: string) => void): (() => void) => {
    storageState.listeners.push(cb)
    return () => {}
  },
}))

describe('capability-gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // The offscreen engine's global: runtime only, no storage bindings.
    vi.stubGlobal('chrome', { runtime: {} })
    storageState.flags = {}
    storageState.fail = false
    storageState.reads = []
    // The module-level cache outlives a test: one local broadcast clears it.
    for (const listener of storageState.listeners) listener('local')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('answers a switch the panel turned on where chrome.storage is absent (the offscreen engine)', async () => {
    storageState.flags[SAFE_CLICK_CAPABILITY_KEY] = { enabled: true }
    storageState.flags[SCRIPT_NETWORK_CAPABILITY_KEY] = { enabled: true }

    expect(await safeClickEnabled()).toBe(true)
    expect(await directSiteApiEnabled()).toBe(true)
    expect(storageState.reads).toEqual([[SAFE_CLICK_CAPABILITY_KEY], [SCRIPT_NETWORK_CAPABILITY_KEY]])
  })

  it('reads each switch default for a missing key', async () => {
    expect(await safeClickEnabled()).toBe(false)
    expect(await submitGuardEnabled()).toBe(false)
    expect(await cursorOverlayEnabled()).toBe(true)
  })

  it('honors an explicit off over a default-on switch', async () => {
    storageState.flags[CURSOR_CAPABILITY_KEY] = { enabled: false }
    expect(await cursorOverlayEnabled()).toBe(false)
  })

  it('answers the default and reports a storage outage instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    storageState.fail = true

    expect(await safeClickEnabled()).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain(SAFE_CLICK_CAPABILITY_KEY)
  })

  it('serves a repeat read from the cache until the two-second window ends', async () => {
    await safeClickEnabled()
    await safeClickEnabled()
    expect(storageState.reads).toHaveLength(1)

    vi.advanceTimersByTime(2_001)
    await safeClickEnabled()
    expect(storageState.reads).toHaveLength(2)
  })

  it('drops the cache on a local change broadcast so a toggle reaches the next call', async () => {
    expect(await safeClickEnabled()).toBe(false)
    storageState.flags[SAFE_CLICK_CAPABILITY_KEY] = { enabled: true }
    expect(await safeClickEnabled()).toBe(false)

    storageState.listeners[0]?.('sync')
    expect(await safeClickEnabled()).toBe(false)

    storageState.listeners[0]?.('local')
    expect(await safeClickEnabled()).toBe(true)
  })
})
