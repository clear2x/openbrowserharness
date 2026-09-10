/**
 * Dock-to-panel: the tab a browser operation targets is moved into the
 * SidePanel's host window (rightmost tab slot, immediately left of the
 * panel) and activated, so the user watches every gesture next to the agent
 * transcript instead of chasing windows.
 *
 * The panel reports its host window on every load (`panel-window` command on
 * the agent channel); the id survives Service Worker restarts in
 * chrome.storage.session. Everything here is best-effort presentation: a
 * dock failure must never break the underlying browser operation.
 */

const PANEL_WINDOW_KEY = 'dsh-panel-window-id'

/** In-memory cache; restored from session storage on first use. */
let panelWindowId: number | undefined

/** Record the SidePanel's host window (sent on every panel load). */
export function notePanelWindow(windowId: number): void {
  panelWindowId = windowId
  void chrome.storage.session.set({ [PANEL_WINDOW_KEY]: windowId }).catch(() => {
    // Session storage unavailable (rare) — the in-memory id still works.
  })
}

async function restorePanelWindow(): Promise<void> {
  if (panelWindowId !== undefined) return
  try {
    const stored = await chrome.storage.session.get(PANEL_WINDOW_KEY)
    const id = stored[PANEL_WINDOW_KEY]
    if (typeof id === 'number') panelWindowId = id
  } catch {
    // Falls through: dock degrades to focus-the-tab's-window.
  }
}

/** The panel's host window id, if the tracked window is still alive. */
async function livePanelWindowId(): Promise<number | undefined> {
  await restorePanelWindow()
  if (panelWindowId === undefined) return undefined
  try {
    const win = await chrome.windows.get(panelWindowId)
    return win.id
  } catch {
    // The panel's window was closed; drop the stale id.
    panelWindowId = undefined
    void chrome.storage.session.remove(PANEL_WINDOW_KEY).catch(() => {})
    return undefined
  }
}

/**
 * Bring `tabId` beside the panel: move it into the panel's window as the
 * rightmost tab, activate it, and focus that window — but only when
 * something actually changed, so a stream of operations on the already
 * -docked active tab never steals focus from the user. Without a known
 * panel window, falls back to making the operated tab visible in its own
 * window.
 */
/**
 * Bring `tabId` beside the panel: move it into the panel's window as the
 * rightmost tab and activate it. The window itself is only raised when the
 * tab had to move across windows (adopting it into the workspace once);
 * same-window tab switches never raise or focus anything, so watching the
 * gestures never wrestles the front of the screen away from the user —
 * switching back to the panel window always shows the latest operated tab.
 */
export async function dockTabBesidePanel(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.windowId === undefined) return
    const panelId = await livePanelWindowId()
    if (panelId === undefined) {
      // No known panel window: at least surface the operated tab in place.
      if (!tab.active) await chrome.tabs.update(tabId, { active: true })
      return
    }
    if (tab.windowId !== panelId) {
      // Adopting a foreign tab into the workspace: move + activate + raise
      // the window ONCE so the user lands on the workspace.
      await chrome.tabs.move(tabId, { windowId: panelId, index: -1 })
      await chrome.tabs.update(tabId, { active: true })
      await chrome.windows.update(panelId, { focused: true })
      return
    }
    // Already the workspace's own tab: keep it visible without raising.
    if (!tab.active) await chrome.tabs.update(tabId, { active: true })
  } catch {
    // Docking is presentation; the operation itself must proceed.
  }
}

/** The panel's window id for creating new tabs in (undefined → browser default). */
export async function dockWindowForNewTab(): Promise<number | undefined> {
  return livePanelWindowId()
}
