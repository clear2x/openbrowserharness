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
