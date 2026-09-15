/**
 * `chrome-browser-provider`: implements the dsh-browser BrowserProvider
 * contract (14 methods including the screenshot capture) inside the Offscreen
 * engine host by forwarding each operation over the CDP channel to the
 * background Service Worker, which owns chrome.debugger.
 *
 * - every call races a 30s deadline so a dead SW fails loudly instead of
 *   hanging the agent loop;
 * - "Receiving end does not exist" (SW asleep AND failing to wake) maps to a
 *   Chinese readiness error;
 * - responses are CdpResponse envelopes; failures rethrow the SW's Chinese
 *   message verbatim.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { BrowserProvider, PageScreenshot, PageSnapshot, Point, TabInfo } from '@deepseek-ai/dsh-browser'
import { CDP_CHANNEL } from '../shared/protocol'
import type { CdpOp, CdpResponse } from '../shared/protocol'
import { storageGet } from './storage-client'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'chrome-browser-provider'

/** The browser seam service must exist before the provider registers. */
export const inject = ['browser']

/** Per-call deadline for the SW round trip. */
const REQUEST_TIMEOUT_MS = 30_000

/** chrome.storage key backing the user-opt-in 网页截图 capability. */
export const SCREENSHOT_CAPABILITY_KEY = 'dsh-capability-screenshot'

/**
 * Whether the user opted the 网页截图 capability in (the UserPluginPanel's
 * built-in row). The flag lives in chrome.storage (defaults OFF — a capture
 * is opt-in) and is read per call so a toggle applies to the very next tool
 * call without an engine reload.
 */
export async function isScreenshotCapabilityEnabled(): Promise<boolean> {
  try {
    const stored = await storageGet([SCREENSHOT_CAPABILITY_KEY])
    return ((stored)[SCREENSHOT_CAPABILITY_KEY] as { enabled?: unknown } | undefined)?.enabled === true
  } catch {
    // No storage channel (dead SW): the capability stays off — a read-only
    // nicety must never break tool dispatch on a storage outage.
    return false
  }
}

/** This plugin has no config. */
export interface Config {}

function isChromeRuntimeAvailable(): boolean {
  return typeof chrome !== 'undefined' && chrome.runtime !== undefined
}

/** Send one CDP operation to the background SW and unwrap its envelope. */
function cdpRequest<T = unknown>(
  op: CdpOp,
  tabId?: number,
  params?: Record<string, unknown>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!isChromeRuntimeAvailable()) {
      reject(new Error('chrome.runtime 不可用，无法访问后台服务'))
      return
    }
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    }
    const done = (value: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      fail(new Error(`浏览器操作超时（${REQUEST_TIMEOUT_MS / 1000} 秒）：${op}`))
    }, REQUEST_TIMEOUT_MS)
    try {
      chrome.runtime.sendMessage(
        { channel: CDP_CHANNEL, op, ...(tabId !== undefined ? { tabId } : {}), params: params ?? {} },
        (response: unknown) => {
          const lastError = chrome.runtime.lastError
          if (lastError !== undefined && lastError !== null) {
            const message = lastError.message ?? ''
            if (/Receiving end does not exist/i.test(message)) {
              fail(new Error('后台服务未就绪，请稍后重试'))
              return
            }
            fail(new Error(`后台服务通信失败：${message}`))
            return
          }
          const envelope = response as CdpResponse<T> | undefined
          if (envelope === undefined || typeof envelope !== 'object') {
            fail(new Error(`后台服务返回了无效响应：${op}`))
            return
          }
          if (envelope.ok) {
            done((envelope.data ?? null) as T)
          } else {
            fail(new Error(envelope.error ?? `浏览器操作失败：${op}`))
          }
        },
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/Receiving end does not exist/i.test(message)) {
        fail(new Error('后台服务未就绪，请稍后重试'))
        return
      }
      fail(new Error(`后台服务通信失败：${message}`))
    }
  })
}

/** The provider registered under `ctx.browser`. */
function createProvider(): BrowserProvider {
  return {
    id: 'chrome-extension',
    tabs: () => cdpRequest<TabInfo[]>('list_tabs'),
    switchTab: tabId => cdpRequest<void>('switch_tab', tabId),
    openTab: (url, opts) =>
      cdpRequest<TabInfo>('open_tab', undefined, {
        url,
        ...(opts?.active === undefined ? {} : { active: opts.active }),
      }),
    closeTab: tabId => cdpRequest<void>('close_tab', tabId),
    reloadTab: (tabId, opts) =>
      cdpRequest<void>('reload_tab', tabId, {
        ...(opts?.bypassCache === undefined ? {} : { bypass_cache: opts.bypassCache }),
      }),
    duplicateTab: tabId => cdpRequest<TabInfo>('duplicate_tab', tabId),
    updateTabPinned: (tabId, pinned) => cdpRequest<void>('pin_tab', tabId, { pinned }),
    updateTabMuted: (tabId, muted) => cdpRequest<void>('mute_tab', tabId, { muted }),
    moveTab: (tabId, index) => cdpRequest<void>('move_tab', tabId, { index }),
    closeOtherTabs: keepTabId =>
      cdpRequest<{ closed: number }>('close_others', keepTabId).then(r => r.closed),
    reopenClosedTab: () =>
      cdpRequest<TabInfo | undefined | null>('reopen_tab').then(tab => tab ?? undefined),
    listWindows: () => cdpRequest<Array<{ windowId: number; focused: boolean; tabCount: number }>>('list_windows'),
    focusWindow: windowId => cdpRequest<void>('focus_window', undefined, { window_id: windowId }),

    navigate: (tabId, url) => cdpRequest<void>('navigate', tabId, { url }),
    goBack: tabId => cdpRequest<{ navigated: boolean }>('go_back', tabId).then(r => r.navigated),
    goForward: tabId => cdpRequest<{ navigated: boolean }>('go_forward', tabId).then(r => r.navigated),
    snapshot: tabId => cdpRequest<PageSnapshot>('snapshot', tabId),
    screenshot: async (tabId, opts) => {
      if (!(await isScreenshotCapabilityEnabled())) {
        throw new Error('网页截图能力未启用：请在侧栏「用户插件」面板中勾选开启')
      }
      const captured = await cdpRequest<{ dataBase64: string; mediaType: 'image/png'; width: number; height: number; fullPage: boolean }>(
        'screenshot',
        tabId,
        { full_page: opts?.fullPage === true },
      )
      // The SW wire carries the PNG as base64 (runtime messages are JSON);
      // decode once at this edge so the seam hands real bytes to callers.
      const binary = atob(captured.dataBase64)
      const data = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) data[i] = binary.charCodeAt(i)
      const screenshot: PageScreenshot = { data, mediaType: 'image/png', width: captured.width, height: captured.height }
      return screenshot
    },
    clickSelector: (tabId, selector) => cdpRequest<void>('click', tabId, { selector }),
    clickPoint: (tabId, point: Point) =>
      cdpRequest<void>('click_at', tabId, { x: point.x, y: point.y }),
    typeText: (tabId, selector, text, opts) =>
      cdpRequest<void>('type_text', tabId, {
        selector,
        text,
        ...(opts?.submit === undefined ? {} : { submit: opts.submit }),
      }),
    pressKey: (tabId, key) => cdpRequest<void>('press_key', tabId, { key }),
    scroll: (tabId, direction, amountPx) =>
      cdpRequest<void>('scroll', tabId, {
        direction,
        ...(amountPx === undefined ? {} : { amount_px: amountPx }),
      }),
    waitFor: (tabId, selector, timeoutMs) =>
      cdpRequest<void>('wait_for', tabId, {
        selector,
        ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
      }),
    evaluate: <T>(tabId: number, expression: string): Promise<T> =>
      cdpRequest<{ value: T | null }>('evaluate', tabId, { expression }).then((envelope) => {
        // The wire envelope nulls an `undefined` evaluation result; the seam's
        // Promise<T> contract is satisfied by the same widening callers of the
        // JSONL-era providers already rely on.
        const value = envelope === null || envelope === undefined ? null : envelope.value
        return value as T
      }),
  }
}

export function apply(ctx: Context, _config: Config): void {
  void _config
  ctx.browser.register(createProvider())
}
