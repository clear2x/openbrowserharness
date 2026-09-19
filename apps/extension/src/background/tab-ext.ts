/**
 * Extended tab-management operations for the SW CDP dispatcher: reload,
 * duplicate, pin, mute, move, close-others, reopen-closed, and window
 * listing/focus. Split from ops.ts so each op stays a thin chrome.* call
 * with one Chinese error surface; dispatched by the same `executeCdpOp`
 * switch. Low-level error details ride Error.cause instead of string
 * interpolation.
 * @module background/tab-ext
 */

import type { TabInfo } from '@deepseek-ai/dsh-browser'

function toTabInfo(tab: chrome.tabs.Tab): TabInfo {
  return {
    tabId: tab.id ?? -1,
    title: tab.title ?? '',
    url: tab.url ?? '',
    active: tab.active ?? false,
    windowId: tab.windowId ?? -1,
    index: tab.index ?? -1,
    pinned: tab.pinned ?? false,
    muted: tab.mutedInfo?.muted ?? false,
  }
}

async function reloadTab(tabId: number, bypassCache: boolean): Promise<void> {
  try {
    await chrome.tabs.reload(tabId, { bypassCache })
  } catch (err) {
    if (!/No tab with id/i.test(err instanceof Error ? err.message : String(err))) {
      throw new Error('刷新标签页失败', { cause: err })
    }
  }
}

async function duplicateTab(tabId: number): Promise<TabInfo> {
  const tab = await chrome.tabs.duplicate(tabId)
  if (tab === undefined) throw new Error(`复制标签页 ${tabId} 失败：标签页不存在或已被关闭`)
  return toTabInfo(tab)
}

async function pinTab(tabId: number, pinned: boolean): Promise<void> {
  await chrome.tabs.update(tabId, { pinned })
}

async function muteTab(tabId: number, muted: boolean): Promise<void> {
  await chrome.tabs.update(tabId, { muted })
}

async function moveTab(tabId: number, index: number): Promise<void> {
  try {
    await chrome.tabs.move(tabId, { index })
  } catch (err) {
    throw new Error('移动标签页失败', { cause: err })
  }
}

async function closeOtherTabs(keepTabId: number): Promise<number> {
  const keep = await chrome.tabs.get(keepTabId)
  const tabs = await chrome.tabs.query({ windowId: keep.windowId })
  const victims = tabs
    .map(tab => tab.id)
    .filter((id): id is number => id !== undefined && id !== keepTabId)
  let closed = 0
  for (const id of victims) {
    try {
      await chrome.tabs.remove(id)
      closed += 1
    } catch {
      // 已经关闭的标签页：跳过继续清点其余。
    }
  }
  return closed
}

async function reopenClosedTab(): Promise<TabInfo | undefined> {
  const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 1 })
  const entry = sessions.find(session => session.tab !== undefined)
  const closed = entry?.tab
  if (closed === undefined) return undefined
  // Edge records stale window ids (0) for closed sessions; create with the
  // recorded window first and fall back to the default window on refusal.
  const create = (withWindow: boolean): Promise<chrome.tabs.Tab> => chrome.tabs.create({
    url: closed.url,
    active: closed.active ?? true,
    ...(withWindow && closed.windowId !== undefined ? { windowId: closed.windowId } : {}),
  })
  let tab: chrome.tabs.Tab
  try {
    tab = await create(true)
  } catch {
    tab = await create(false)
  }
  return toTabInfo(tab)
}

async function listWindows(): Promise<Array<{ windowId: number; focused: boolean; tabCount: number }>> {
  const windows = await chrome.windows.getAll({ populate: true })
  return windows.map(window => ({
    windowId: window.id ?? -1,
    focused: window.focused ?? false,
    tabCount: window.tabs?.length ?? 0,
  }))
}

async function focusWindow(windowId: number): Promise<void> {
  await chrome.windows.update(windowId, { focused: true })
}

/** Dispatch facade for the extended tab ops (shared by the SW switch). */
export const tabExtOps = {
  reloadTab,
  duplicateTab,
  pinTab,
  muteTab,
  moveTab,
  closeOtherTabs,
  reopenClosedTab,
  listWindows,
  focusWindow,
}
