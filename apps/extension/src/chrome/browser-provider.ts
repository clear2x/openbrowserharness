/**
 * `chrome-browser-provider`: implements the dsh-browser BrowserProvider
 * contract (15 methods including the screenshot capture and index resolve)
 * inside the Offscreen engine host by forwarding each operation over the CDP
 * channel to the background Service Worker, which owns chrome.debugger.
 *
 * - every call races a deadline — the 30s baseline, widened for the
 *   string-typing op (type_text) by its typed length so a dead SW still
 *   fails loudly instead of hanging the agent loop (see requestDeadlineMs);
 * - "Receiving end does not exist" (SW asleep AND failing to wake) maps to a
 *   Chinese readiness error;
 * - responses are CdpResponse envelopes; failures rethrow the SW's Chinese
 *   message verbatim.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { BrowserProvider, NetworkCapture, PageElementInfo, PageScreenshot, PageSnapshot, Point, TabInfo } from '@deepseek-ai/dsh-browser'
import { CDP_CHANNEL } from '../shared/protocol'
import type { CdpOp, CdpResponse } from '../shared/protocol'
import { HUMANIZED_INPUT_CAPABILITY_KEY } from '../shared/capability-keys.ts'
import { storageGet } from './storage-client'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'chrome-browser-provider'

/** The browser seam service must exist before the provider registers. */
export const inject = ['browser']

/** Per-call deadline baseline for the SW round trip (type_text scales it). */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Inter-key pacing upper bound the SW side applies when the op params omit
 * max_delay_ms (ops.ts and keyboard.ts share the same default).
 */
const TYPE_TEXT_DEFAULT_MAX_DELAY_MS = 150

/**
 * Per-call deadline: the 30s baseline, widened for the string-typing op
 * (type_text) whose humanized keystroke stream costs up to one maxDelay per
 * character — a flat 30s cap misreports normally-typing long text as a
 * timeout. Humanize off (zero pacing, insertText fast path), or a char
 * count that cannot be read from the op params, keeps the 30s baseline.
 */
async function requestDeadlineMs(op: CdpOp, params: Record<string, unknown> | undefined): Promise<number> {
  if (op !== 'type_text') return REQUEST_TIMEOUT_MS
  const text = params?.['text']
  if (typeof text !== 'string') return REQUEST_TIMEOUT_MS
  if (!(await isCapabilityEnabled(HUMANIZED_INPUT_CAPABILITY_KEY, true))) return REQUEST_TIMEOUT_MS
  const rawMax = params?.['max_delay_ms']
  const maxDelay = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
    ? rawMax
    : TYPE_TEXT_DEFAULT_MAX_DELAY_MS
  return REQUEST_TIMEOUT_MS + Array.from(text).length * maxDelay
}

/** Capability keys and their panel-facing defaults live in the shared module. */
export {
  CURSOR_CAPABILITY_KEY,
  PRIVACY_MASK_CAPABILITY_KEY,
  SCREENSHOT_CAPABILITY_KEY,
  SITE_KNOWLEDGE_CAPABILITY_KEY,
} from '../shared/capability-keys.ts'
import { SCREENSHOT_CAPABILITY_KEY } from '../shared/capability-keys.ts'

/**
 * Whether one first-party capability flag is on. A missing key reads as
 * `fallback`; a storage outage reads as `fallback` too — a display or
 * cheat-sheet nicety must never break tool dispatch on a dead SW.
 */
export async function isCapabilityEnabled(key: string, fallback: boolean): Promise<boolean> {
  try {
    const stored = await storageGet([key])
    const flag = (stored)[key] as { enabled?: unknown } | undefined
    if (flag?.enabled === true) return true
    if (flag?.enabled === false) return false
    return fallback
  } catch {
    return fallback
  }
}

/**
 * Whether the user opted the 网页截图 capability in (the UserPluginPanel's
 * built-in row). The flag lives in chrome.storage (defaults OFF — a capture
 * is opt-in) and is read per call so a toggle applies to the very next tool
 * call without an engine reload.
 */
export async function isScreenshotCapabilityEnabled(): Promise<boolean> {
  return isCapabilityEnabled(SCREENSHOT_CAPABILITY_KEY, false)
}

/** This plugin has no config. */
export interface Config {}

function isChromeRuntimeAvailable(): boolean {
  return typeof chrome !== 'undefined' && chrome.runtime !== undefined
}

/** Send one CDP operation to the background SW and unwrap its envelope. */
async function cdpRequest<T = unknown>(
  op: CdpOp,
  tabId?: number,
  params?: Record<string, unknown>,
): Promise<T> {
  const timeoutMs = await requestDeadlineMs(op, params)
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
      fail(new Error(`浏览器操作超时（${timeoutMs / 1000} 秒）：${op}`))
    }, timeoutMs)
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
    resolve: (tabId, index) => cdpRequest<PageElementInfo>('resolve_index', tabId, { index }),
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
    startNetworkCapture: tabId => cdpRequest<void>('network_start', tabId),
    readNetworkCapture: (tabId, opts) =>
      cdpRequest<NetworkCapture>('network_read', tabId, {
        ...(opts?.stop === true ? { stop: true } : {}),
        ...(opts?.filter === undefined ? {} : { filter: opts.filter }),
        ...(opts?.resourceType === undefined ? {} : { resource_type: opts.resourceType }),
      }),
  }
}

export function apply(ctx: Context, _config: Config): void {
  void _config
  ctx.browser.register(createProvider())
}
