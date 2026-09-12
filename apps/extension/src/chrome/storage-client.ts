/**
 * chrome.storage.local access that works in EVERY extension context.
 *
 * Offscreen documents do not receive the chrome.storage API bindings (their
 * `chrome` object carries runtime only — an observed Chromium behavior, see
 * the chromium-extensions guidance to keep storage in the service worker).
 * This client uses the local API directly when present (service worker,
 * sidepanel) and otherwise routes get/set/remove through the background SW
 * over the `dsh-storage` channel, including change-event rebroadcasts.
 */

import { STORAGE_CHANNEL, type StorageEventMessage, type StorageRequest } from '../shared/protocol'

interface ChromeWithStorage {
  storage?: {
    local: {
      get(keys: string[]): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string[]): Promise<void>
    }
    onChanged: {
      addListener(cb: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void
    }
  }
  runtime: {
    sendMessage(msg: unknown): Promise<unknown>
    onMessage: {
      addListener(cb: (m: unknown) => void): void
    }
    lastError?: { message?: string }
  }
}

function chromeApi(): ChromeWithStorage | undefined {
  return (globalThis as { chrome?: ChromeWithStorage }).chrome
}

function localStorageApi(): ChromeWithStorage['storage'] | undefined {
  const api = chromeApi()
  const storage = api?.storage
  if (storage === undefined || storage.local === undefined || storage.onChanged === undefined) {
    return undefined
  }
  return storage
}

async function sendViaSw(req: StorageRequest): Promise<Record<string, unknown>> {
  const api = chromeApi()
  if (api === undefined) throw new Error('chrome.runtime 不可用，无法访问设置存储')
  let response: unknown
  try {
    response = await api.runtime.sendMessage(req)
  } catch (err) {
    throw new Error(`访问设置存储失败（后台服务未就绪）：${err instanceof Error ? err.message : String(err)}`)
  }
  const r = response as { ok?: boolean; data?: Record<string, unknown>; error?: string }
  if (r === null || typeof r !== 'object' || r.ok !== true) {
    throw new Error(`访问设置存储失败：${r?.error ?? '未知错误'}`)
  }
  return r.data ?? {}
}

/** `keys: null` enumerates every stored item (the record-list scan). */
export async function storageGet(keys: string[] | null): Promise<Record<string, unknown>> {
  const local = localStorageApi()
  if (local !== undefined) return local.local.get(keys as never)
  return sendViaSw({ channel: STORAGE_CHANNEL, op: 'get', keys })
}

export async function storageSet(items: Record<string, unknown>): Promise<void> {
  const local = localStorageApi()
  if (local !== undefined) return local.local.set(items)
  await sendViaSw({ channel: STORAGE_CHANNEL, op: 'set', items })
}

export async function storageRemove(keys: string[]): Promise<void> {
  const local = localStorageApi()
  if (local !== undefined) return local.local.remove(keys)
  await sendViaSw({ channel: STORAGE_CHANNEL, op: 'remove', keys })
}

export function onStorageChanged(cb: (area: string) => void): () => void {
  const local = localStorageApi()
  if (local !== undefined) {
    const listener = (_changes: Record<string, { newValue?: unknown }>, area: string): void => cb(area)
    local.onChanged.addListener(listener)
    return () => {
      // chrome.storage.onChanged has no removeListener in the minimal face
      // typed above; extension contexts keep it for the page lifetime.
    }
  }
  const api = chromeApi()
  if (api === undefined) return () => {}
  const listener = (m: unknown): void => {
    const event = m as StorageEventMessage
    if (
      typeof m === 'object' && m !== null &&
      (m as { channel?: string }).channel === STORAGE_CHANNEL &&
      event.kind === 'changed'
    ) {
      cb(event.area)
    }
  }
  api.runtime.onMessage.addListener(listener)
  return () => {}
}
