/**
 * Cross-context message protocol for the dsh extension.
 *
 * Three extension contexts cooperate:
 *   - SidePanel UI  (React app)
 *   - Offscreen     (dsh harness host: Cordis Context + Loader + agent loop)
 *   - Background SW (chrome.debugger CDP controller + offscreen watchdog)
 *
 * SidePanel ↔ Offscreen use a long-lived runtime Port (`dsh-ui`); everything
 * else uses chrome.runtime.sendMessage with a namespaced `channel` field and
 * passive listeners on other channels (return nothing for foreign messages).
 */

import type { PageElementInfo, PageSnapshot, TabInfo } from '@deepseek-ai/dsh-browser'

// ── CDP channel: Offscreen (browser provider) → Background SW ──

export const CDP_CHANNEL = 'dsh-cdp'

export type CdpOp =
  | 'ensure_attached'
  | 'detach'
  | 'navigate'
  | 'go_back'
  | 'go_forward'
  | 'snapshot'
  | 'resolve_index'
  | 'click'
  | 'click_at'
  | 'type_text'
  | 'press_key'
  | 'scroll'
  | 'wait_for'
  | 'evaluate'
  | 'screenshot'
  | 'list_tabs'
  | 'switch_tab'
  | 'open_tab'
  | 'close_tab'
  | 'reload_tab'
  | 'duplicate_tab'
  | 'pin_tab'
  | 'mute_tab'
  | 'move_tab'
  | 'close_others'
  | 'reopen_tab'
  | 'list_windows'
  | 'focus_window'
  | 'network_start'
  | 'network_read'

export interface CdpRequest {
  channel: typeof CDP_CHANNEL
  op: CdpOp
  tabId?: number
  params?: Record<string, unknown>
}

export interface CdpResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

// ── Storage channel: Offscreen → Background SW ──
//
// Chromium offscreen documents do not receive the chrome.storage API bindings
// (their `chrome` object carries runtime only); persistent storage therefore
// routes through the service worker, which has the full API.

export const STORAGE_CHANNEL = 'dsh-storage'

export type StorageRequest =
  | { channel: typeof STORAGE_CHANNEL; op: 'get'; keys: string[] | null }
  | { channel: typeof STORAGE_CHANNEL; op: 'set'; items: Record<string, unknown> }
  | { channel: typeof STORAGE_CHANNEL; op: 'remove'; keys: string[] }

export interface StorageResponse {
  ok: boolean
  /** Present for `get`: the found key/value pairs. */
  data?: Record<string, unknown>
  error?: string
}

/** SW broadcast after every committed chrome.storage.local change. */
export interface StorageEventMessage {
  channel: typeof STORAGE_CHANNEL
  kind: 'changed'
  area: string
  changes: Record<string, { newValue?: unknown }>
}

export function isStorageRequest(m: unknown): m is StorageRequest {
  return typeof m === 'object' && m !== null && (m as { channel?: string }).channel === STORAGE_CHANNEL
}

// ── Download channel: Offscreen (engine tools) → Background SW ──
//
// The offscreen document hosts the engine but has no visible page to anchor a
// browser download from, and chrome.downloads lives in the service worker.
// Agent artifacts (爬取清单、认证导出、报告文件) ride this channel to the
// user's Downloads folder as a fully-formed data: URL — no network, no host.

export const DOWNLOAD_CHANNEL = 'dsh-download'

/** One artifact download request (the data URL is built tool-side). */
export interface DownloadRequest {
  channel: typeof DOWNLOAD_CHANNEL
  /** Sanitized target filename inside the Downloads directory. */
  filename: string
  /** A fully-formed `data:` URL carrying the content. */
  url: string
}

export interface DownloadResponse {
  ok: boolean
  /** chrome.downloads download id, present on success. */
  downloadId?: number
  error?: string
}

export function isDownloadRequest(m: unknown): m is DownloadRequest {
  return typeof m === 'object' && m !== null && (m as { channel?: string }).channel === DOWNLOAD_CHANNEL
}

// ── Sense-watch channel: Offscreen (sense_now tool) → Background SW ──
//
// 实时陪看帧采集：chrome.tabs.captureVisibleTab 只存在于 service worker，
// offscreen 的实时陪看工具经本通道取当前窗口可见标签页的 JPEG data URL
// （质量 50——陪看帧用于差分与拼图，不需要 PNG 级保真）。

export const SENSE_CHANNEL = 'dsh-sense'

/** One companion-watch frame capture request. */
export interface SenseCaptureRequest {
  channel: typeof SENSE_CHANNEL
  /** Target window; omitted = the last focused window's visible tab. */
  windowId?: number
}

export interface SenseCaptureResponse {
  ok: boolean
  /** JPEG data URL of the visible tab. */
  dataUrl?: string
  /** The captured window id, echoed for session bookkeeping. */
  windowId?: number
  error?: string
}

export function isSenseCaptureRequest(m: unknown): m is SenseCaptureRequest {
  return typeof m === 'object' && m !== null && (m as { channel?: string }).channel === SENSE_CHANNEL
}

// ── Interaction alert channel: Offscreen (api-bridge) → Background SW ──
//
// The offscreen document hosts the engine's approval/question waits but its
// `chrome` object carries no chrome.action or chrome.notifications bindings;
// off-panel visibility for a wait that sits with no panel connected is
// therefore delivered by the service worker (toolbar badge + notification).

export const INTERACTION_ALERT_CHANNEL = 'dsh-interaction-alert'

/** `pending` arms the badge/notification; `clear` disarms both. */
export interface InteractionAlertRequest {
  channel: typeof INTERACTION_ALERT_CHANNEL
  kind: 'pending' | 'clear'
}

export function isInteractionAlertRequest(m: unknown): m is InteractionAlertRequest {
  return (
    typeof m === 'object' && m !== null && (m as { channel?: string }).channel === INTERACTION_ALERT_CHANNEL
  )
}

// ── Agent control channel (UI → Background SW: offscreen lifecycle) ──

export const AGENT_CHANNEL = 'dsh-agent'

export type AgentCommand =
  | { channel: typeof AGENT_CHANNEL; type: 'ensure_offscreen' }
  | { channel: typeof AGENT_CHANNEL; type: 'ping' }
  /**
   * Watchdog liveness probe aimed at the Offscreen engine host. Sent by the
   * background SW; answered (asynchronously) ONLY by the offscreen document —
   * every other context must passively ignore it so the sender's callback
   * observes the engine's answer, not its own echo.
   */
  | { channel: typeof AGENT_CHANNEL; type: 'offscreen-ping' }
  /**
   * The SidePanel reports its host window on load; browser operations dock
   * the operated tab into that window (rightmost, left of the panel).
   */
  | { channel: typeof AGENT_CHANNEL; type: 'panel-window'; windowId: number }

/** Reply shape used by AGENT_CHANNEL probes (`ping`, `offscreen-ping`). */
export interface AgentCommandResponse {
  ok: boolean
  error?: string
  /**
   * `offscreen-ping` only: whether any live agent is mid-turn right now. The
   * background watchdog reads this to spare a busy-but-slow engine from the
   * rebuild that would crash-orphan its in-flight tool calls.
   */
  running?: boolean
}

// ── OAuth callback relay (browser tab → DNR intercept → extension relay page) ──

/**
 * The platform's OAuth redirect_uri accepts loopback HTTP origins only
 * (empirically: `auth_init` answers PAYLOAD_SCHEMA_MISMATCH for any web
 * origin). The browser host cannot bind a loopback port, so sign-in registers
 * this fixed port as the callback origin and a declarativeNetRequest rule
 * intercepts the platform's redirect to it, rerouting the navigation onto the
 * bundled relay page (`public/oauth-relay.html`) which forwards code+state to
 * the offscreen shim. Single source for the Service Worker's intercept rule,
 * the api-bridge sign-in RPC's `callbackOrigin`, and the relay page's
 * forwarding identity.
 */
export const OAUTH_LOOPBACK_PORT = 47099

/** Full callback origin the account Host registers for sign-in. */
export const OAUTH_CALLBACK_ORIGIN = 'http://127.0.0.1:' + String(OAUTH_LOOPBACK_PORT)

/**
 * Message the relay page sends to the offscreen shim after the intercept.
 * The shim re-dispatches it over the `webserver/request` waterfall with the
 * synthesized loopback request the upstream listener matches.
 */
export interface OAuthCallbackForward {
  channel: 'oauth-callback-forward'
  code: string
  state: string
  /** Loopback host of the registered callback origin. */
  originHost: string
  /** Path the upstream listener matches (`/oauth/callback`). */
  callbackPath: string
}

// ── SidePanel ↔ Offscreen port protocol (`dsh-ui`) ──

export const UI_PORT_NAME = 'dsh-ui'

/** Serialized dsh SessionEvent (opaque here; shape owned by dsh-session). */
export interface SerializedSessionEvent {
  seq: number
  type: string
  [field: string]: unknown
}

export interface EngineSettings {
  apiKey: string
  provider: string
  baseUrl: string
  model: string
  /** The engine-wide default reasoning effort ('' = cleared), persisted by session.selectModel on fresh sessions. */
  reasoningEffort?: string
}

export type UiMessage =
  | { t: 'hello' }
  | { t: 'session.list' }
  | { t: 'session.create'; title?: string }
  | { t: 'session.select'; sessionId: string }
  | { t: 'session.history'; sessionId: string; fromSeq?: number }
  | { t: 'prompt'; text: string }
  | { t: 'steer'; text: string }
  | { t: 'cancel' }
  | { t: 'status' }
  | { t: 'settings.get' }
  | { t: 'settings.set'; patch: Partial<EngineSettings> }

export interface SessionSummary {
  sessionId: string
  title: string
  createdAt: number
  updatedAt: number
  eventCount: number
}

export type EngineMessage =
  | { t: 'ready'; running: boolean; sessions: SessionSummary[] }
  | { t: 'sessions'; items: SessionSummary[] }
  | { t: 'history'; sessionId: string; events: SerializedSessionEvent[]; upToDate: boolean }
  | { t: 'event'; sessionId: string; event: SerializedSessionEvent }
  | { t: 'agent-status'; sessionId: string; status: 'idle' | 'running'; detail?: string }
  | { t: 'prompt-accepted'; sessionId: string }
  | { t: 'error'; message: string }
  | { t: 'settings'; settings: EngineSettings }

// ── type guards ──

export function isCdpRequest(m: unknown): m is CdpRequest {
  return typeof m === 'object' && m !== null && (m as { channel?: string }).channel === CDP_CHANNEL
}

export function isAgentCommand(m: unknown): m is AgentCommand {
  return typeof m === 'object' && m !== null && (m as { channel?: string }).channel === AGENT_CHANNEL
}

export type { PageElementInfo, PageSnapshot, TabInfo }
