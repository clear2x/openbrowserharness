/**
 * CDP operation dispatcher: routes CdpRequest.op to its implementation; every
 * branch is uniformly try/catch-ed into {ok, data?} / {ok:false, error}
 * CdpResponse envelopes. The debugger ops (including the screenshot capture)
 * go through the CDP controller; the four tab-management ops use chrome.tabs
 * directly.
 */

import type { CdpOp, CdpResponse, TabInfo } from '../shared/protocol'
import { cdpController, sleep } from './cdp'
import { dockTabBesidePanel, dockWindowForNewTab } from './dock'
import { captureSnapshot, evaluateInPage, waitFor } from './dom-snapshot'
import { pressKey, typeText } from './keyboard'
import { click, scroll } from './mouse'
import { createRng } from './rng'
import { noteBrowserOperation } from './virtual-cursor'

// ───────────────────────── parameter readers ─────────────────────────

function requireString(params: Record<string, unknown>, key: string): string {
  const v = params[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`缺少或非法参数：${key}（应为非空字符串）`)
  }
  return v
}

function requireNumber(params: Record<string, unknown>, key: string): number {
  const v = params[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`缺少或非法参数：${key}（应为数字）`)
  }
  return v
}

function optionalNumber(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = params[key]
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`非法参数：${key}（应为数字）`)
  }
  return v
}

/** The active tab of the current window when tabId was not supplied. */
async function resolveTabId(tabId: number | undefined): Promise<number> {
  if (typeof tabId === 'number') return tabId
  // The automation target is the user's actual browsing tab — never the
  // SidePanel itself (chrome-extension://) or a blank tab. Prefer the
  // RIGHTMOST eligible tab (the one the user opened last / is reading).
  const isEligible = (tab: chrome.tabs.Tab): boolean =>
    tab.id !== undefined
    && !(tab.url ?? '').startsWith('chrome-extension://')
    && !(tab.url ?? '').startsWith('chrome://')
    && (tab.url ?? '') !== 'about:blank'
  const active = (await chrome.tabs.query({ active: true, currentWindow: true }))
    .find(isEligible)
  if (active?.id !== undefined) return active.id
  const all = (await chrome.tabs.query({ currentWindow: true })).filter(isEligible)
  const rightmost = all[all.length - 1]
  if (rightmost?.id !== undefined) return rightmost.id
  throw new Error('未找到可操作的非扩展标签页（请打开一个普通网页）')
}

/** A tab id that must be supplied explicitly (management ops never guess). */
function requireTabId(tabId: number | undefined): number {
  if (typeof tabId !== 'number' || !Number.isFinite(tabId)) {
    throw new Error('缺少或非法参数：tabId（应为数字）')
  }
  return tabId
}

// ───────────────────────── tab helpers ─────────────────────────

function toTabInfo(tab: chrome.tabs.Tab): TabInfo {
  return {
    tabId: tab.id ?? -1,
    title: tab.title ?? '',
    url: tab.url ?? '',
    active: tab.active ?? false,
    windowId: tab.windowId ?? -1,
    index: tab.index ?? -1,
  }
}

async function listTabs(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({})
  return tabs.map(toTabInfo)
}

async function switchTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.get(tabId)
  } catch {
    throw new Error(`标签页 ${tabId} 不存在或已被关闭`)
  }
  // Docking moves the tab beside the panel, activates it, and focuses the
  // window — the full "switch" in one step.
  await dockTabBesidePanel(tabId)
}

async function openTab(url: string, active: boolean): Promise<TabInfo> {
  // New tabs open directly into the panel's window (rightmost slot) so the
  // workspace stays in one place; without a panel window use the default.
  const windowId = await dockWindowForNewTab()
  const tab = await chrome.tabs.create({
    url,
    active,
    ...(windowId !== undefined ? { windowId } : {}),
  })
  return toTabInfo(tab)
}

async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/No tab with id/i.test(msg)) {
      throw new Error(`关闭标签页 ${tabId} 失败：${msg}`)
    }
  }
}

// ───────────────────────── dispatch entry ─────────────────────────

/**
 * Execute one CDP operation. All failures are caught and returned as
 * `{ ok: false, error }` envelopes with Chinese messages.
 */
export async function executeCdpOp(
  op: CdpOp,
  tabId: number | undefined,
  params: Record<string, unknown>,
): Promise<CdpResponse> {
  const rng = createRng()
  try {
    // Tab management ops need no debugger session and no resolved tabId.
    switch (op) {
      case 'list_tabs':
        return { ok: true, data: await listTabs() }

      case 'switch_tab': {
        const id = requireTabId(tabId)
        await switchTab(id)
        noteBrowserOperation(id) // the pointer follows the agent onto the tab
        return { ok: true, data: { tabId: id } }
      }

      case 'open_tab': {
        const url = requireString(params, 'url')
        const active = params['active'] !== false
        const tab = await openTab(url, active)
        return { ok: true, data: tab }
      }

      case 'close_tab': {
        const id = requireTabId(tabId)
        await closeTab(id)
        return { ok: true }
      }
    }

    const id = await resolveTabId(tabId)
    // EVERY agent operation on a tab gets a visible pointer reaction: the
    // overlay installs (parked) if missing, brightens with an amber activity
    // blip if present. Pointer gestures answer with motion on top of this.
    noteBrowserOperation(id)
    // Only INTERACTIVE operations dock their target beside the panel. Read
    // -only probes (snapshot, extract, wait, evaluate) run wherever the tab
    // lives so data lookups (e.g. a JSON API check) never yank the visible
    // page away from the gesture the user is watching.
    if (
      op === 'navigate' || op === 'go_back' || op === 'go_forward' || op === 'click'
      || op === 'click_at' || op === 'type_text' || op === 'press_key' || op === 'scroll'
    ) {
      await dockTabBesidePanel(id)
    }

    switch (op) {
      case 'ensure_attached': {
        await cdpController.attach(id)
        return { ok: true, data: { tabId: id } }
      }

      case 'detach': {
        await cdpController.detach(id)
        return { ok: true }
      }

      case 'navigate': {
        const url = requireString(params, 'url')
        await cdpController.send(id, 'Page.navigate', { url })
        await sleep(rng.randInt(700, 1000)) // initial load wait (not load completion)
        return { ok: true, data: { url } }
      }

      case 'go_back':
      case 'go_forward': {
        const history = await cdpController.send<{ currentIndex: number; entries: { id: number }[] }>(id, 'Page.getNavigationHistory', {})
        const offset = op === 'go_back' ? -1 : 1
        const target = history.entries[history.currentIndex + offset]
        if (target === undefined) {
          return { ok: true, data: { navigated: false } }
        }
        await cdpController.send(id, 'Page.navigateToHistoryEntry', { entryId: target.id })
        await sleep(rng.randInt(700, 1000)) // initial load wait (not load completion)
        return { ok: true, data: { navigated: true } }
      }

      case 'snapshot': {
        const snapshot = await captureSnapshot(id)
        return { ok: true, data: snapshot }
      }

      case 'click': {
        const selector = requireString(params, 'selector')
        const point = await click(id, selector)
        return { ok: true, data: { selector, x: point.x, y: point.y } }
      }

      case 'click_at': {
        const x = requireNumber(params, 'x')
        const y = requireNumber(params, 'y')
        await click(id, { x, y })
        return { ok: true, data: { x, y } }
      }

      case 'type_text': {
        const selector = requireString(params, 'selector')
        const text = requireString(params, 'text')
        await typeText(id, selector, text, {
          submit: params['submit'] === true,
          clear: params['clear'] === true,
          minDelayMs: optionalNumber(params, 'min_delay_ms', 20),
          maxDelayMs: optionalNumber(params, 'max_delay_ms', 150),
        })
        return { ok: true, data: { selector, length: Array.from(text).length } }
      }

      case 'press_key': {
        const key = requireString(params, 'key')
        await pressKey(id, key)
        return { ok: true, data: { key } }
      }

      case 'scroll': {
        const raw = params['direction']
        if (raw !== 'up' && raw !== 'down') {
          throw new Error('非法参数：direction（应为 "up" 或 "down"）')
        }
        const amountPx = optionalNumber(params, 'amount_px', 400)
        await scroll(id, raw, amountPx)
        return { ok: true, data: { direction: raw, amountPx } }
      }

      case 'wait_for': {
        const selector = requireString(params, 'selector')
        const timeoutMs = optionalNumber(params, 'timeout_ms', 5000)
        await waitFor(id, selector, timeoutMs)
        return { ok: true, data: { selector, timeoutMs } }
      }

      case 'evaluate': {
        const expression = requireString(params, 'expression')
        const value = await evaluateInPage<unknown>(id, expression)
        return { ok: true, data: { value: value === undefined ? null : value } }
      }

      case 'screenshot': {
        // Read-only probe: like snapshot/evaluate, it never docks the tab.
        const fullPage = params['full_page'] === true
        await cdpController.attach(id)
        const metrics = await cdpController.send(id, 'Page.getLayoutMetrics', {})
        const css = (metrics as {
          cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
          cssContentSize?: { width?: number; height?: number }
        } | undefined)
        const vw = css?.cssVisualViewport?.clientWidth ?? 0
        const vh = css?.cssVisualViewport?.clientHeight ?? 0
        const width = Math.round(fullPage ? css?.cssContentSize?.width ?? vw : vw)
        const height = Math.round(fullPage ? css?.cssContentSize?.height ?? vh : vh)
        const captured = await cdpController.send(id, 'Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: fullPage,
        })
        const base64 = (captured as { data?: string } | undefined)?.data
        if (typeof base64 !== 'string' || base64.length === 0) {
          throw new Error(`标签页 ${id} 截图失败：CDP 未返回图像数据`)
        }
        return { ok: true, data: { dataBase64: base64, mediaType: 'image/png', width, height, fullPage } }
      }

      default: {
        // The switch exhausts CdpOp; a new enum value fails to compile here.
        const exhausted: never = op
        return { ok: false, error: `未知 CDP 操作：${String(exhausted)}` }
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
