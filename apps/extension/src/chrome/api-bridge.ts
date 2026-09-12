/**
 * `chrome-api-bridge`: the dsh ApiProxy service surface over a chrome.runtime
 * Port (`dsh-api`), so the REAL dsh Web UI (static-booted in the SidePanel)
 * can drive the engine composed inside the Offscreen document.
 *
 * This is the browser twin of `packages/host/apiproxy`'s Node gateway — the
 * wire vocabulary (method names, payload/value shapes, RpcResult, MuxFrame /
 * HostFrame unions) mirrors `packages/host/apiproxy/src/api/*.ts` contract
 * layer, re-declared locally because the extension package does not depend on
 * the gateway package (and must not pull its Node import graph into the
 * bundle). Alignment point: when the SidePanel's
 * `src/shared/api-port-protocol.ts` contract lands, keep the message unions
 * below byte-compatible with it.
 *
 * Method tiers:
 * - REAL: session.* core surface over ctx.sessions/ctx.agents/ctx.llm
 *   (create/prompt/fork/resume reuse the ui-bridge's proven call shapes;
 *   search keyword-matches the persisted event logs, mirroring the gateway's
 *   wire shape — packages/host/apiproxy/src/api/session-search.ts),
 *   host.describe, workspace.list (one fixed workspace view), llm.*,
 *   settings.* + credentials.* over the chrome.storage-backed engine
 *   settings and ChromeCredentialProvider, the agentPreset.* authoring face
 *   over the chrome.storage roster beside the implicit 'default' composition
 *   preset (the extension twin of the desktop's dsh-agent-presets — see the
 *   agent-presets section below), the plugin-inventory projection
 *   (`/api/pluginInventory/list` over the live Cordis Loader tree, static
 *   fallback when no loader service is mounted), and subagent.* over the
 *   composed dsh-subagent service (list/history/prompt/interrupt mirror the
 *   gateway's wire semantics — packages/host/apiproxy/src/api/subagents.ts).
 * - EMPTY: capabilities this host composes no service for answer with the
 *   contract's empty value (skill.list when the skill
 *   service answers nothing), plus the dynamicCordisRunner surfaces the
 *   cordis Client plugins touch at apply time — the extension runs no
 *   dynamic Cordis packages, so syncInspectManifest answers null and
 *   inventory answers an empty row list instead of a refusal.
 * - STRUCTURED-UNAVAILABLE: everything the extension host cannot serve
 *   (native directory surfaces, workspace mutations, goals) answers
 *   `{ok:false,error:{code:'not-available-in-extension'}}`
 *   — never a thrown exception crossing the Port.
 *
 * Settings/credential invalidations fan out to every connected port as
 * `host/remote-event` frames on the host stream (`settings/document-updated`
 * after each committed settings write, `credentials/updated` off the
 * credentials service's own commit event), so pushed refetches converge the
 * SidePanel's settings pages without polling.
 *
 * Streams: `stream.open {stream:'mux'}` subscribes ctx.on('session/event')
 * (first frame `session/subscribed` per attached session; an optional mux
 * payload `since: Record<sessionId, lastSeq>` replays the durable delta from
 * persistence — the history-sync hook); `stream.open {stream:'host'}` sends
 * the fixed single-workspace baseline frame once, then forwards
 * agent/status → host/session-status, session/created/disposed →
 * host/session-added/removed, agent/error → host/agent-error. Every port
 * owns its stream subscriptions; `stream.close` (and disconnect, and plugin
 * disposal) tears them down.
 *
 * respond: the pending server-request registry routes each echoed rpcId to
 * its settler. The interaction channel (installed here, consumed by
 * `chrome-ask-bridge`) registers approval/question settlements into it and
 * broadcasts the answerable `approval/requested` / `question/requested` mux
 * frames; with no ask bridge composed the registry stays empty and respond
 * answers the `not-pending` receipt.
 *
 * Multiple SidePanel connections are supported: each port keeps its own
 * stream state, RPC results return on the originating port, and frames fan
 * out to every port that opened that stream.
 */

import type { Context, FiberState } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.loader` Context augmentation from the vendored
// Loader plugin (plugin-inventory gateway precedent) without a runtime edge.
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: load the ctx.commands / ctx.goals / ctx.messageFeedback Context
// augmentations from the engine-side services the typert dispatchers drive.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-message-feedback'
import { storageGet, storageSet } from './storage-client'
import { removeStoredSkill, writeStoredSkill } from './skill-storage'
import type { StoredSkill } from './skill-storage'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials/src/index.ts'
import { createUserMessage, freezeMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { PromptContentPart } from '@deepseek-ai/dsh-attachment'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { bytesToBase64, decodeCanonicalBase64 } from './attachment-store.ts'
// The subagent service the `subagent.*` RPC face drives (value import also
// loads the `ctx.subagents` Context augmentation, like offscreen/main.ts).
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent/internal'
import { SessionId, SessionLogOffset, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: the question frame's payload reuses the interaction seam's wire type.
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
// Type-only: loads the `ctx.systemPrompt` Context augmentation the preset
// prompt-addendum registration drives (the service itself is a composition row).
import type {} from '@deepseek-ai/dsh-system-prompt'
// Wire-value constructors for the typert dispatchers' branded engine types.
import { GoalId } from '@deepseek-ai/dsh-goal'
// Type-only: loads the `ctx.sessionPersistence` Context augmentation from the
// persistence seam (same precedent as ui-bridge.ts).
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from '@deepseek-ai/dsh-llm-deepseek/src/adapter.ts'
import { activeProviderId } from './llm'
import { DEFAULT_PROVIDER, PROVIDER_PRESETS, PROVIDER_SETTINGS_NS, keyRefOf, presetOf, resolveStoredApiKey } from './llm-providers'
import { PRESET_MODELS_NS, loadPresetUserModels, setPresetUserModels } from './llm-providers'
/**
 * The plugin-merged `agent-preset/selected` session event is declared by
 * `@deepseek-ai/dsh-agent-presets`, which this app never composes (the
 * extension owns its own preset roster) — this type-only edge still pulls the
 * package's declarations into the program, so the blank-window switch logged
 * on `agentPreset.select` and every summary/resume read of that record stay
 * typed without a second (drift-prone) copy of the merge.
 */
import type {} from '@deepseek-ai/dsh-agent-presets'
import { SCREENSHOT_CAPABILITY_KEY } from './browser-provider'
import { DEFAULT_PERMISSION_MODE, isPermissionMode } from '../shared/permission-mode.ts'
import { createUserPluginMethods } from './user-plugin-bridge'
import { userPluginHost } from './user-plugins'
import {
  CUSTOM_PROVIDER_NS,
  CUSTOM_PROVIDER_SCHEMA,
  CUSTOM_PROTOCOLS,
  customProfileFailure,
  customProviderViews,
  declaredRouteHeaders,
  isDeclaredRoute,
  declaredRouteDefaultModel,
  publicHttpUrlFailure,
  syncCustomProviders,
} from './custom-providers.ts'
import type { CustomProtocol } from './custom-providers.ts'
import { resolveAnthropicEndpoint } from './anthropic-adapter.ts'
import { resolveResponsesEndpoint } from './responses-adapter.ts'
import {
  currentEngineConfig,
  providerProfile,
  readEngineSettings,
  writeEngineSettings, DEFAULT_MODEL } from './settings-store'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'chrome-api-bridge'

/**
 * Engine services the bridge drives. `sessionPersistence` arrives with the
 * IndexedDB row; the LLM registry with the chrome-llm row; credentials with
 * the chrome-credentials row; the Loader with the boot entry's first plugin
 * (the plugin-inventory projection reads its live entry tree); subagents with
 * the `@deepseek-ai/dsh-subagent` row (its listChildren projection needs the
 * `@deepseek-ai/dsh-session-projection` row composed before it); the
 * permission knob with the `permission-mode` row (session.permission.get/set).
 */
export const inject = ['agents', 'sessions', 'sessionPersistence', 'credentials', 'llm', 'skills', 'loader', 'commands', 'goals', 'messageFeedback', 'subagents', 'sessionProjections', 'permissionMode']

/** This plugin has no config. */
export interface Config {}

// ───────────────────────── port line protocol ─────────────────────────

/**
 * Named Port the SidePanel connects on. Mirrors the dsh-ui precedent: a
 * dedicated name keeps this bridge passive toward every other Port.
 */
export const API_PORT_NAME = 'dsh-api'

/**
 * Structured RPC error body (wire shape of apiproxy RpcError; `details` is
 * loose here because the closed apiproxy code→details map cannot be imported
 * without depending on the gateway package).
 */
export interface ApiRpcError {
  code: string
  message: string
  details?: Record<string, unknown>
}

/** Business result carried by rpc.result / respond messages. */
export type ApiRpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: ApiRpcError }

/** Frames this host emits on the mux stream (subset of the apiproxy MuxFrame union). */
export type MuxFrame =
  | { type: 'session/event'; sessionId: SessionId; event: SessionEvent }
  | { type: 'session/subscribed'; sessionId: SessionId; lastSeq: number }
  | { type: 'session/projection'; sessionId: SessionId; key: string; value: unknown; seq: number }
  // ── interaction frames (the chrome-ask-bridge channel; wire shapes mirror
  // packages/host/apiproxy/src/api/events.ts — the SidePanel re-parses every
  // frame against the real apiproxy zod schemas, so the field sets are exact) ──
  | { type: 'approval/requested'; sessionId: SessionId; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'approval/resolved'; sessionId: SessionId; approvalId: string; outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' }
  | { type: 'question/requested'; sessionId: SessionId; questions: AskUserQuestionItem[] }
  | { type: 'question/resolved'; sessionId: SessionId; questionRpcId: string; outcome: 'answered' | 'cancelled' }
  | { type: 'stream/error'; error: ApiRpcError }

/** Frames this host emits on the host stream (subset of the apiproxy HostFrame union). */
export type HostFrame =
  | { type: 'host/session-added'; sessionId: SessionId; blank: boolean }
  | { type: 'host/session-removed'; sessionId: SessionId }
  | { type: 'host/session-status'; sessionId: SessionId; running: boolean }
  | { type: 'host/agent-error'; sessionId: SessionId; message: string }
  | { type: 'host/workspace-changed'; workspace: WorkspaceView }
  /**
   * One allowlisted host cordis event forwarded verbatim (wire shape of the
   * apiproxy events contract: `event` is the host's own event name, `args`
   * its JSON-safe argument list). This bridge forwards the
   * settings/credentials invalidations so pushed refetches converge the
   * SidePanel's settings pages.
   */
  | { type: 'host/remote-event'; event: string; args: unknown[] }

/**
 * `stream.open` mux payload — the subscription/resume hook of the events.mux
 * contract (`since` is a per-session lastSeq watermark; the delta above it is
 * replayed from persistence before live forwarding starts).
 */
export interface MuxOpenPayload {
  since?: Record<string, number>
}

/** SidePanel → Offscreen messages (discriminated by `k`). */
export type ApiPortUpMessage =
  | { k: 'rpc'; rpcId: string; method: string; payload?: unknown }
  | { k: 'respond'; rpcId: string; result: ApiRpcResult }
  | { k: 'stream.open'; stream: 'mux' | 'host'; rpcId: string; payload?: MuxOpenPayload }
  | { k: 'stream.close'; stream: 'mux' | 'host' }

/** Offscreen → SidePanel messages (discriminated by `k`). */
export type ApiPortDownMessage =
  | { k: 'ready' }
  | { k: 'rpc.result'; rpcId: string; result: ApiRpcResult }
  | { k: 'frame'; stream: 'mux' | 'host'; frame: MuxFrame | HostFrame }

// ───────────────────────── wire view helpers ─────────────────────────

/** One workspace row (wire shape of the apiproxy WorkspaceView). */
export interface WorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds: SessionId[]
  createdAt: string
  updatedAt: string
}

/** One session.list row (wire shape of the apiproxy SessionSummary). */
export interface SessionSummaryView {
  sessionId: SessionId
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: SessionId
  origin?: 'subagent'
  cwd?: string
  agentPreset?: string
  projections?: { asOfSeq: number; values: Record<string, unknown> }
}

/** One history page entry (wire shape of the apiproxy HistoryEntry). */
export interface HistoryEntryView {
  event: SessionEvent
}

/** One model's selectable reasoning metadata (apiproxy ModelReasoning wire view). */
export interface ModelReasoningView {
  efforts: Array<{ id: string; name: string; description?: string }>
  defaultEffort?: string
}

/** One provider group of the model catalog (apiproxy ModelProviderGroup). */
export interface ModelProviderGroupView {
  id: string
  name: string
  /** Provider-level context capacity in tokens when the route declares one (advisory). */
  contextWindow?: number
  models: Array<{
    id: string
    name: string
    description?: string
    /** Provider-disclosed combined request/response context capacity in tokens. */
    contextWindow?: number
    /** Accepted input modalities; absence means unknown, explicit omission is text-only. */
    inputModalities?: Array<'text' | 'image'>
    /** Exact-route reasoning metadata when the adapter exposes it. */
    reasoning?: ModelReasoningView
  }>
}

/** Host version reported by host.describe — keep in sync with package.json. */
const HOST_VERSION = '0.1.0-rc.5'

/** Error code for capabilities this extension host cannot serve. */
export const UNAVAILABLE_CODE = 'not-available-in-extension'

/** Page size when session.history carries no maxMessages (apiproxy parity). */
const DEFAULT_MAX_MESSAGES = 50

/** Maximum sessions returned by one session.search (apiproxy parity). */
const SESSION_SEARCH_RESULT_LIMIT = 20

/** Fixed wire bound for one session.search query (apiproxy parity). */
const SESSION_SEARCH_QUERY_MAX_CHARS = 500

/** Maximum snippet length in Unicode code points (apiproxy parity). */
const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240

/** Conversation message event types (the pagination counting unit). */
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/** The single settings namespace this host exposes (engine settings face). */
const SETTINGS_NS = PROVIDER_SETTINGS_NS

/** Fixed identity of the single-workspace view this host serves. */
const WORKSPACE_ID = 'extension-main'

/** Fallback title length when deriving from the first user message. */
const FALLBACK_TITLE_CHARS = 24

function log(...args: unknown[]): void {
  console.log('[dsh-offscreen]', ...args)
}

function warn(...args: unknown[]): void {
  console.warn('[dsh-offscreen]', ...args)
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function isChromeRuntimeAvailable(): boolean {
  return typeof chrome !== 'undefined' && chrome.runtime !== undefined
}

/**
 * Thrown by method handlers to answer a structured RPC error; the dispatcher
 * folds it into the rpc.result error branch so nothing raw ever crosses the
 * Port.
 */
class RpcFailure extends Error {
  constructor(readonly error: ApiRpcError) {
    super(error.message)
  }
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new RpcFailure({ code, message, ...(details === undefined ? {} : { details }) })
}

/** The structured refusal for methods the extension host cannot serve. */
function unavailable(method: string): never {
  fail(UNAVAILABLE_CODE, `此方法在扩展宿主中不可用：${method}`, { method })
}

/**
 * The optional attachment service, read through the reflect accessor: the
 * plain `ctx.attachments` property read throws "without inject" for an
 * unprovided service, while this deployment answers undefined and the image
 * surfaces keep their structured ATTACHMENTS_NOT_COMPOSED refusal.
 */
function attachmentsOf(ctx: Context): AttachmentStore | undefined {
  return ctx.reflect.get('attachments', false)
}

// ───────────────────────── durable prompt images ─────────────────────────

/**
 * Browser-submitted prompt content (apiproxy wire parity): text parts pass
 * through verbatim; image parts carry TEMPORARY canonical base64 bytes that
 * `durablePromptContent` promotes to durable references before the user
 * message is appended.
 */
type WirePromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: ImageMediaType; data: string; name?: string }

const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Validate one browser-submitted image part's wire shape (canonical-base64
 * byte DECODE happens later, at batch admission).
 * @param part - the raw content entry.
 * @returns the validated part.
 */
function parseImagePart(part: unknown): WirePromptPart {
  const shape = part as { mediaType?: unknown; data?: unknown; name?: unknown }
  if (typeof shape.mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(shape.mediaType)) {
    fail('bad-request', 'session.prompt：图片 mediaType 必须是 image/png、image/jpeg、image/webp 或 image/gif', { issues: [] })
  }
  if (typeof shape.data !== 'string' || shape.data === '') {
    fail('bad-request', 'session.prompt：图片 data 必须是非空 base64 字符串', { issues: [] })
  }
  if (shape.name !== undefined && typeof shape.name !== 'string') {
    fail('bad-request', 'session.prompt：图片 name 必须是字符串', { issues: [] })
  }
  return {
    type: 'image',
    mediaType: shape.mediaType as ImageMediaType,
    data: shape.data,
    ...(typeof shape.name === 'string' ? { name: shape.name } : {}),
  }
}

/** Search durable content for an image reference, including nested tool results. */
function imageBlockIn(content: unknown, match: (ref: ImageAttachmentRef) => boolean): ImageAttachmentRef | undefined {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { type?: unknown; attachment?: unknown; content?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ImageAttachmentRef
      if (match(ref)) return ref
    }
    if (block.type === 'tool-result') {
      const nested = imageBlockIn(block.content, match)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Search every durable event carrier that can own model-visible content —
 * the authorization walk behind `session.attachment`: a client may read an
 * image's bytes only through a session whose log references the id.
 */
function referencedImage(events: readonly SessionEvent[], attachmentId: string): ImageAttachmentRef | undefined {
  const match = (ref: ImageAttachmentRef): boolean => String(ref.attachmentId) === attachmentId
  for (const event of events) {
    const data = event.data as {
      content?: unknown
      message?: { content?: unknown }
      inserted?: Array<{ content?: unknown }>
      stream?: Array<{ type: string; chunk?: { type?: unknown; block?: unknown } }>
    }
    const direct = imageBlockIn(data.content, match)
    if (direct !== undefined) return direct
    if (data.message !== undefined) {
      const wrapped = imageBlockIn(data.message.content, match)
      if (wrapped !== undefined) return wrapped
    }
    if (data.inserted !== undefined) {
      for (const message of data.inserted) {
        const inserted = imageBlockIn(message.content, match)
        if (inserted !== undefined) return inserted
      }
    }
    // 0.1.5 packs the live model stream into the message/attempt event's
    // `stream` records; raw `chunk` records carry block-end with the block.
    for (const record of data.stream ?? []) {
      if (record.type === 'chunk' && record.chunk?.type === 'block-end') {
        const streamed = imageBlockIn([record.chunk.block], match)
        if (streamed !== undefined) return streamed
      }
    }
  }
  return undefined
}

/**
 * Map one `ctx.subagents.listChildren` failure onto its wire refusal
 * (apiproxy parity: the projections registry absence is a deterministic
 * deployment failure, never an empty success).
 */
function subagentCatalogFailure(error: unknown): never {
  if (error instanceof SubagentError) {
    if (error.code === 'CANCELLED') {
      fail('cancelled', 'subagent catalog read was cancelled', {})
    }
    if (error.code === 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE') {
      fail('internal', 'subagent catalog is unavailable: this deployment does not mount the sessionProjections registry (load @deepseek-ai/dsh-session-projection)', {})
    }
  }
  fail('internal', 'subagent catalog read failed', {})
}

/** Map one continuation admission failure onto its wire refusal (apiproxy subagentPromptError parity).
 * The raw error message rides along (truncated): the composer's failure notice
 * surfaces it, and without it a finished-child refusal is indistinguishable
 * from a persistence failure. */
function subagentPromptFailure(childSessionId: SessionId, error: unknown): never {
  const detail = error instanceof Error ? error.message : String(error)
  if (error instanceof SubagentError) {
    switch (error.code) {
      case 'NOT_RESUMABLE':
        fail('subagent-not-resumable', `subagent cannot be resumed: ${detail}`, { childSessionId })
      case 'UNAUTHORIZED':
        fail('subagent-unauthorized', `subagent does not belong to this parent: ${detail}`, { childSessionId })
      case 'DRAINING':
      case 'ACTIVATION_CLOSING':
      case 'CONTINUATION_UNAVAILABLE':
      case 'PERSISTENCE_UNAVAILABLE':
        fail('subagent-delivery-unavailable', `subagent follow-up is temporarily unavailable: ${detail}`, { childSessionId })
      default:
        break
    }
  }
  fail('internal', `subagent prompt failed: ${detail}`, {})
}

/**
 * Verify one subagent address against the composed service's durable
 * direct-child catalog (apiproxy catalogChild parity). The catalog read is
 * the single authority for parent ownership and child mode; a diagnostic
 * candidate relays the projection fold's reason.
 * @returns the healthy child entry, or throws the structured refusal.
 */
async function catalogSubagentChild(
  ctx: Context,
  parentSessionId: SessionId,
  childSessionId: SessionId,
  mode: 'one-shot' | 'continuable',
): Promise<Extract<SubagentListEntry, { kind: 'child' }>> {
  let entries: SubagentListEntry[]
  try {
    entries = await ctx.subagents.listChildren(parentSessionId)
  } catch (error) {
    subagentCatalogFailure(error)
  }
  const entry = entries.find(candidate => candidate.id === childSessionId)
  if (entry === undefined || (entry.kind === 'child' && entry.mode !== mode)) {
    fail('subagent-not-found', `session "${childSessionId}" is not a ${mode} direct child of "${parentSessionId}"`, { parentSessionId, childSessionId })
  }
  if (entry.kind === 'diagnostic') {
    fail('subagent-catalog-diagnostic', `subagent "${childSessionId}" is ${entry.reason}`, { parentSessionId, childSessionId, reason: entry.reason })
  }
  return entry
}

/** Strict browser-zone profile: UTC or an IANA Area/Location-style identifier. */
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/** Validate and canonicalize one browser-supplied IANA zone (apiproxy parity). */
function canonicalClientTimeZone(value: string): string | undefined {
  if (value.length === 0 || value.trim() !== value
    || (value !== 'UTC' && !IANA_TIME_ZONE.test(value))) return undefined
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions().timeZone
    if (canonical !== 'UTC' && !IANA_TIME_ZONE.test(canonical)) return undefined
    return canonical
  } catch {
    return undefined
  }
}

function mintSessionId(): SessionId {
  const uuid =
    globalThis.crypto?.randomUUID?.() ?? `t${Date.now()}-${Math.random().toString(16).slice(2)}`
  return SessionId(`session-${uuid}`)
}

function mintSubagentRequestId(): SubagentPromptRequestId {
  const uuid =
    globalThis.crypto?.randomUUID?.() ?? `t${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `request-${uuid}` as SubagentPromptRequestId
}

/** Loose payload reader: an absent/foreign-typed payload slot reads as {}. */
function payloadObject(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

// ── Generic settings namespaces (chrome.storage blob store) ──
//
// The engine namespace (`llm-deepseek`) maps onto real services, but browser
// UI plugins persist their own state through the settings face too (e.g. the
// `ui-onboarding` acknowledgement). Any other namespace is served as a
// per-namespace JSON blob with its own revision for the CAS protocol.

const GENERIC_NS_STORAGE_KEY = 'dsh-api-settings-namespaces'
const GENERIC_NS_SCHEMA_ENVELOPE = { type: 'object', dict: {} }

interface GenericNsEntry {
  revision: number
  value: Record<string, unknown>
}

async function readGenericNamespaces(): Promise<Record<string, GenericNsEntry>> {
  try {
    const items = await storageGet([GENERIC_NS_STORAGE_KEY])
    const raw = items[GENERIC_NS_STORAGE_KEY]
    if (raw === null || typeof raw !== 'object') return {}
    const out: Record<string, GenericNsEntry> = {}
    for (const [ns, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (entry === null || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      if (typeof e.revision !== 'number' || e.value === null || typeof e.value !== 'object') continue
      out[ns] = { revision: e.revision, value: e.value as Record<string, unknown> }
    }
    return out
  } catch {
    return {}
  }
}

async function writeGenericNamespaces(all: Record<string, GenericNsEntry>): Promise<void> {
  try {
    await storageSet({ [GENERIC_NS_STORAGE_KEY]: all })
  } catch (err) {
    const c = (globalThis as { chrome?: Record<string, unknown> }).chrome
    fail('storage-error', `写入设置存储失败：${errTextOf(err)}（chrome=${typeof c}，storage=${c ? typeof c.storage : 'n/a'}，keys=${c ? Object.keys(c).slice(0, 12).join(',') : 'n/a'}）`, {})
  }
}

function errTextOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Deep-clone a JSON-ish value (blob reads must not alias stored state). */
function cloneJsonValue(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown)
}

/** Apply one settings.mutate path-op onto a plain-object value (mutates). */
function applyPathOp(value: Record<string, unknown>, op: Record<string, unknown>): void {
  const rawPath = op.path
  if (!Array.isArray(rawPath) || rawPath.length === 0 || rawPath.some(p => typeof p !== 'string')) {
    fail('bad-request', 'settings.mutate：path 必须是非空字符串数组', { issues: [] })
  }
  const path = rawPath as string[]
  let cursor: Record<string, unknown> = value
  for (const key of path.slice(0, -1)) {
    const next = cursor[key]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[key] = {}
    }
    cursor = cursor[key] as Record<string, unknown>
  }
  const leaf = path[path.length - 1] as string
  if (op.op === 'set') {
    cursor[leaf] = cloneJsonValue(op.value)
  } else if (op.op === 'unset') {
    // The settings wire treats a missing key and an unset key identically, so
    // the absent-leaf case needs no guard.
    Reflect.deleteProperty(cursor, leaf)
  } else {
    fail('bad-request', `settings.mutate：未知操作 ${String(op.op)}`, { issues: [] })
  }
}

/** CAS + write one generic namespace; returns its new view. */
async function applyGenericNsWrite(
  ns: string,
  expectedRevision: unknown,
  transform: (value: Record<string, unknown>) => void,
  validate?: (value: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const all = await readGenericNamespaces()
  const entry = all[ns] ?? { revision: 0, value: {} }
  if (expectedRevision !== undefined) {
    if (typeof expectedRevision !== 'number' || expectedRevision !== entry.revision) {
      fail('settings-conflict', '设置分区已被其他写入方更新，请重新读取后再保存', {
        ns,
        expected: typeof expectedRevision === 'number' ? expectedRevision : -1,
        actual: entry.revision,
      })
    }
  }
  transform(entry.value)
  // Post-transform, pre-persist gate: a namespace whose payload the engine
  // must be able to serve (the hand-declared-provider profiles) refuses an
  // unservable write before anything is committed.
  if (validate !== undefined) validate(entry.value)
  entry.revision += 1
  all[ns] = entry
  await writeGenericNamespaces(all)
  return genericNsView(ns, entry)
}

/**
 * Refuse an unservable hand-declared-provider table before it is committed:
 * every `providers.<route>` entry must pass the registry's profile gate, so
 * the create card's failure names the field while the user still sees it.
 */
function validateCustomProviderNs(value: Record<string, unknown>): void {
  const providers = value.providers
  if (providers === undefined) return
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) {
    fail('bad-request', 'llm-pi-ai：providers 必须是对象', { issues: [] })
  }
  for (const [route, profile] of Object.entries(providers as Record<string, unknown>)) {
    const failure = customProfileFailure(route, profile)
    if (failure !== undefined) fail('bad-request', failure, { issues: [] })
  }
}

// ── agent presets (chrome.storage roster beside the implicit 'default') ──
//
// The extension composes no @deepseek-ai/dsh-agent-presets roster: that
// package discovers preset directories under the harness home and mounts
// their cordis.yml plugin sets through dynamic ESM imports — both impossible
// in an extension page (no filesystem, MV3 CSP forbids dynamic code). The
// browser twin keeps the same wire vocabulary over a chrome.storage blob:
// each preset is a per-session override document the engine consumes at
// session create/select (provider/model via the mutable model selection, a
// prompt addendum via a scope-keyed systemPrompt section), not a plugin set.

/** chrome.storage.local key holding the authorable preset roster. */
export const AGENT_PRESET_STORE_KEY = 'dsh-agent-presets'

/** The implicit preset: the engine's own composition, never stored. */
const DEFAULT_PRESET_ID = 'default'

/**
 * Ids a stored preset may use — the desktop rule (packages/preset/agent-presets
 * PRESET_ID). There the id becomes a path segment, so the shape is a
 * containment boundary; here it is wire-face parity, and it also keeps the
 * implicit 'default' (which matches the pattern) claimable by a stored row.
 */
const AGENT_PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/**
 * One authorable preset: the fields of a desktop preset composition this host
 * can honor per session. `provider`/`model` override the engine route at
 * create and select; `systemPrompt` is registered as an extra prompt section
 * scoped to the session's agent. A desktop preset's plugin rows have no
 * extension equivalent — the static module map admits no per-preset plugins.
 */
interface StoredAgentPreset {
  id: string
  name?: string
  description?: string
  provider?: string
  model?: string
  systemPrompt?: string
}

/** Why an agentPreset.* call was refused, mapped onto the apiproxy codes. */
type PresetRefusalKind = 'agent-preset-not-found' | 'agent-preset-invalid' | 'agent-preset-read-only'

/** Structured authoring refusal (apiproxy presetError's wire codes, one class). */
class PresetRefusal extends Error {
  constructor(
    readonly kind: PresetRefusalKind,
    readonly presetId: string,
    message: string,
    readonly available?: readonly string[],
  ) {
    super(message)
  }
}

/**
 * Parse one stored roster entry. A row that is not an object or names no
 * valid id is dropped (storage corruption, not a user choice to surface);
 * a row with a valid id but mistyped fields keeps the id and reports the
 * damage through `broken`, mirroring desktop discovery's broken rows.
 */
function parseStoredPreset(raw: unknown): (StoredAgentPreset & { broken?: string }) | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !AGENT_PRESET_ID.test(r.id) || r.id === DEFAULT_PRESET_ID) {
    return undefined
  }
  const optionalString = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined
  const bad: string[] = []
  for (const field of ['name', 'description', 'provider', 'model', 'systemPrompt'] as const) {
    const value = r[field]
    if (value !== undefined && (typeof value !== 'string' || (field !== 'systemPrompt' && value === ''))) {
      bad.push(field)
    }
  }
  const name = optionalString(r.name)
  const description = optionalString(r.description)
  const provider = optionalString(r.provider)
  const model = optionalString(r.model)
  const systemPrompt = optionalString(r.systemPrompt)
  return {
    id: r.id,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(bad.length === 0 ? {} : { broken: `字段类型无效：${bad.join('、')}` }),
  }
}

/** Read the stored roster, newest-independent and id-sorted (desktop root order). */
async function readStoredPresets(): Promise<Array<StoredAgentPreset & { broken?: string }>> {
  try {
    const items = await storageGet([AGENT_PRESET_STORE_KEY])
    const raw = items[AGENT_PRESET_STORE_KEY]
    if (!Array.isArray(raw)) return []
    return raw
      .map(parseStoredPreset)
      .filter((entry): entry is StoredAgentPreset & { broken?: string } => entry !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    // An unreadable roster degrades to the implicit default rather than
    // failing every session start: the blob is one storage key away from the
    // engine settings and carries no composition text.
    return []
  }
}

async function writeStoredPresets(presets: readonly StoredAgentPreset[]): Promise<void> {
  await storageSet({ [AGENT_PRESET_STORE_KEY]: presets })
}

/**
 * The preset id a session that names none gets: the `agent-presets` settings
 * namespace's `default` field when it names a non-empty string (the UI's
 * makeDefault writes the id there through settings.update), else the implicit
 * engine composition.
 */
async function storedDefaultPresetId(): Promise<string> {
  const stored = (await readGenericNamespaces())['agent-presets']?.value.default
  return typeof stored === 'string' && stored !== '' ? stored : DEFAULT_PRESET_ID
}

/** Whether a preset's provider names a route this engine can serve. */
function isServableProvider(provider: string): boolean {
  return presetOf(provider) !== undefined || isDeclaredRoute(provider)
}

/** The resolved roster, default first: the wire view `agentPreset.list` serves. */
async function agentPresetRoster(): Promise<{
  defaultId: string
  presets: Array<StoredAgentPreset & { broken?: string }>
}> {
  const [defaultId, stored] = await Promise.all([storedDefaultPresetId(), readStoredPresets()])
  const config = currentEngineConfig()
  const model = config.model === '' ? (presetOf(config.provider)?.defaultModel ?? '') : config.model
  const presets: Array<StoredAgentPreset & { broken?: string }> = [
    { id: DEFAULT_PRESET_ID, name: '默认', description: `当前引擎：${activeProviderId()}/${model}` },
    ...stored,
  ]
  for (const preset of stored) {
    if (preset.broken === undefined && preset.provider !== undefined && !isServableProvider(preset.provider)) {
      preset.broken = `未知 provider "${preset.provider}"`
    }
  }
  return { defaultId, presets }
}

/**
 * Resolve one preset id against the roster, the implicit id included.
 * @param id - the preset id, or undefined for the stored default.
 * @returns the resolved preset definition.
 * @throws PresetRefusal(kind 'agent-preset-not-found') when no row supplies it.
 */
async function resolveAgentPreset(id?: string): Promise<StoredAgentPreset & { broken?: string }> {
  const roster = await agentPresetRoster()
  const wanted = id ?? roster.defaultId
  const found = roster.presets.find(preset => preset.id === wanted)
  if (found === undefined) {
    throw new PresetRefusal(
      'agent-preset-not-found',
      wanted,
      `agent 预设 "${wanted}" 不存在（可用：${roster.presets.map(preset => preset.id).join(', ') || '无'}）`,
      roster.presets.map(preset => preset.id),
    )
  }
  return found
}

/** Pretty-printed document `agentPreset.read` serves as the composition text. */
function presetDocument(preset: StoredAgentPreset, trust: 'system' | 'user'): string {
  return JSON.stringify(
    {
      id: preset.id,
      trust,
      ...(preset.name === undefined ? {} : { name: preset.name }),
      ...(preset.description === undefined ? {} : { description: preset.description }),
      ...(preset.provider === undefined ? {} : { provider: preset.provider }),
      ...(preset.model === undefined ? {} : { model: preset.model }),
      ...(preset.systemPrompt === undefined ? {} : { systemPrompt: preset.systemPrompt }),
      ...(preset.id === DEFAULT_PRESET_ID
        ? { engine: '扩展引擎内置组合（工具集与提示词由组合行固定，不可编辑）' }
        : {}),
    },
    null,
    2,
  )
}

// ── llm.discoverModels probe facts (declared-route protocol / credential) ──
//
// The probe helpers read the same `llm-pi-ai` namespace blob the custom
// provider registry syncs from, so a probe naming an already-declared route
// travels the route's stored protocol and credential ref without either being
// repeated in the payload.

/** Minimal Messages ping model when the probed route declares none. */
const ANTHROPIC_PROBE_MODEL = 'claude-sonnet-4-5'
/** Minimal Responses ping model when the probed route declares none. */
const RESPONSES_PROBE_MODEL = 'gpt-4o'

/** Stored declared-route profile facts an endpoint probe falls back on. */
interface StoredDeclaredProfileFacts {
  protocol?: CustomProtocol
  apiKeyEnv: string
}

async function storedDeclaredProfile(provider: string | undefined): Promise<StoredDeclaredProfileFacts> {
  if (provider === undefined) return { apiKeyEnv: '' }
  const ns = (await readGenericNamespaces())[CUSTOM_PROVIDER_NS]
  const raw = ns?.value.providers
  if (raw === null || typeof raw !== 'object') return { apiKeyEnv: '' }
  const profile = (raw as Record<string, unknown>)[provider]
  if (profile === null || typeof profile !== 'object') return { apiKeyEnv: '' }
  const p = profile as Record<string, unknown>
  const api = p.api
  return {
    ...(typeof api === 'string' && (CUSTOM_PROTOCOLS as readonly string[]).includes(api)
      ? { protocol: api as CustomProtocol }
      : {}),
    apiKeyEnv: typeof p.apiKeyEnv === 'string' ? p.apiKeyEnv : '',
  }
}

/**
 * The wire protocol one endpoint probe travels. The payload's explicit `api`
 * field wins; a probe naming an already-declared route falls back to the
 * route's stored protocol, and a preset route to the preset's own. Absent
 * either, the probe is OpenAI-compatible (the historical default).
 */
async function probeProtocolOf(
  p: Record<string, unknown>,
  provider: string | undefined,
): Promise<CustomProtocol> {
  const explicit = p.api
  if (typeof explicit === 'string') {
    if (!(CUSTOM_PROTOCOLS as readonly string[]).includes(explicit)) {
      fail('bad-request', `llm.discoverModels：api 必须是 ${CUSTOM_PROTOCOLS.join(' / ')} 之一`, { issues: [] })
    }
    return explicit as CustomProtocol
  }
  if (provider !== undefined) {
    const preset = presetOf(provider)
    if (preset !== undefined) return preset.protocol
    const stored = await storedDeclaredProfile(provider)
    if (stored.protocol !== undefined) return stored.protocol
  }
  return 'openai'
}

/**
 * The credential one endpoint probe travels with: a typed key probes the
 * draft, an empty key probes the named route's stored credential — the same
 * ref semantics the adapters resolve (shared cache, invalidated on committed
 * storage changes) — so a saved route verifies without re-typing its key. A
 * route naming no credential ref (keyless endpoint) probes without auth; a
 * ref with nothing stored fails the probe loudly instead of guessing.
 */
async function storedProbeKey(provider: string | undefined): Promise<string> {
  if (provider === undefined) return ''
  const preset = presetOf(provider)
  if (preset !== undefined) {
    const ref = keyRefOf(preset)
    if (ref === '') return ''
    return resolveProbeKey(provider, ref)
  }
  return resolveProbeKey(`chrome-llm:${provider}`, (await storedDeclaredProfile(provider)).apiKeyEnv)
}

async function resolveProbeKey(owner: string, ref: string): Promise<string> {
  if (ref === '') return ''
  try {
    return await resolveStoredApiKey(owner, ref)
  } catch (err) {
    fail('bad-request', `llm.discoverModels：${errText(err)}`, { issues: [] })
  }
}

/** Model the minimal POST probe names: the route's first declared model,
 * then the preset's default, then a wire placeholder (a connectivity ping
 * needs any model the endpoint accepts). */
function probeModelOf(provider: string | undefined, placeholder: string): string {
  if (provider !== undefined) {
    const declared = declaredRouteDefaultModel(provider)
    if (declared !== undefined) return declared
    const preset = presetOf(provider)
    if (preset !== undefined) return preset.defaultModel
  }
  return placeholder
}

// ── typert remote payload decoding (`{ args: { <wire>: value } }` envelope) ──

/** The args object of one typert `/api` invocation payload. */
function typertArgs(payload: unknown, endpoint: string): Record<string, unknown> {
  const args = payloadObject(payload).args
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    fail('bad-request', `${endpoint}：args 必须是对象`, { issues: [] })
  }
  return args as Record<string, unknown>
}

/** The scoped-agent wire field (agentId) of one typert invocation. */
function agentIdOf(payload: unknown, endpoint: string): SessionId {
  const value = typertArgs(payload, endpoint).agentId
  if (typeof value !== 'string' || value.length === 0) {
    fail('bad-request', `${endpoint}：args.agentId 必须是非空字符串`, { issues: [] })
  }
  return SessionId(value)
}

/** The `request` wire field of one typert invocation, with required-field presence checks. */
function requestOf(
  payload: unknown,
  endpoint: string,
  required: ReadonlyArray<{ field: string; kind: 'string' | 'number' }> = [],
): Record<string, unknown> {
  const value = typertArgs(payload, endpoint).request
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('bad-request', `${endpoint}：args.request 必须是对象`, { issues: [] })
  }
  const request = value as Record<string, unknown>
  for (const { field, kind } of required) {
    if (typeof request[field] !== kind) {
      fail('bad-request', `${endpoint}：args.request.${field} 必须是${kind === 'string' ? '字符串' : '数字'}`, { issues: [] })
    }
  }
  return request
}

/**
 * The CAS `ref` wire field ({ id, revision }), as the engine's branded GoalRef.
 * Accepts the typert envelope (`args.ref`) and the legacy dotted-path flat payload (`ref`).
 */
function refOf(payload: unknown, endpoint: string): { id: ReturnType<typeof GoalId>; revision: number } {
  const object = payloadObject(payload)
  const value = (object.args !== undefined ? payloadObject(object.args).ref : object.ref)
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || typeof (value as { id?: unknown }).id !== 'string'
    || typeof (value as { revision?: unknown }).revision !== 'number') {
    fail('bad-request', `${endpoint}：ref 必须是 { id, revision }`, { issues: [] })
  }
  const ref = value as { id: string; revision: number }
  return { id: GoalId(ref.id), revision: ref.revision }
}

function genericNsView(ns: string, entry: GenericNsEntry): Record<string, unknown> {  return {
  ns,
  // The hand-declared-provider namespace carries its real schema (the dsh
  // Models page reads the protocol union at providers.<route>.api to enable
  // the custom-provider entry point); every other generic namespace is a
  // free-form blob.
  schema: ns === CUSTOM_PROVIDER_NS ? CUSTOM_PROVIDER_SCHEMA : GENERIC_NS_SCHEMA_ENVELOPE,
  value: cloneJsonValue(entry.value),
  base: {},
  applies: 'live',
  secrets: [],
  revision: entry.revision,
}
}

function payloadString(payload: unknown, key: string, method: string): string {
  const value = payloadObject(payload)[key]
  if (typeof value !== 'string' || value.length === 0) {
    fail('bad-request', `${method}：字段 ${key} 必须是非空字符串`, { issues: [] })
  }
  return value
}

// ── Plugin inventory (loader-tree projection; plugin-inventory parity) ──

/**
 * Runtime mirror of cordis' `const enum FiberState` (erased from the built
 * cordis lib the bundle resolves — offscreen/main.ts keeps the same mirror),
 * mapped onto the PluginFiberPhase vocabulary the plugin-inventory contract
 * publishes. DISPOSED has no live phase to report (null).
 */
const FIBER_PHASES = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
} as const satisfies Record<FiberState, 'pending' | 'loading' | 'active' | 'failed' | null | 'unloading'>

/**
 * Static fallback inventory: the composition module names the offscreen boot
 * creates loader entries for (`MODULES`/compositionRows of
 * src/offscreen/main.ts). Serves `/api/pluginInventory/list` only when no
 * loader service is mounted (the inject declaration makes that unreachable
 * in the real composition; direct-apply test mounts keep a usable answer).
 */
const FALLBACK_PLUGIN_ENTRIES: readonly string[] = [
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-retry',
  '@deepseek-ai/dsh-browser',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence-indexeddb',
  '@deepseek-ai/dsh-session-checkpoint-policy',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-web-search-deepseek',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tool-call-timeout-policy',
  '@deepseek-ai/dsh-repeat-tool-reminder',
  '@deepseek-ai/dsh-time-context',
  '@deepseek-ai/dsh-tool-browser',
  'chrome-credentials',
  'chrome-llm',
  'chrome-browser-provider',
  'ui-bridge',
  'chrome-api-bridge',
  'chrome-skill-storage',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-session-title',
  '@deepseek-ai/dsh-session-title-first-prompt-llm',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-user-questions',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-command-feedback',
  '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-goal',
  '@deepseek-ai/dsh-goal-round-driver',
  '@deepseek-ai/dsh-command-goal',
  '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-jobs-local',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-fs-opfs',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-spill-policy',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-tool-subagent',
  'chrome-tool-gate',
  'chrome-ask-bridge',
]

/** One wire row of the plugin inventory (PluginInventoryEntry shape). */
interface PluginInventoryEntryView {
  entryId: string
  moduleName: string
  enabled: boolean
  fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
}

/**
 * Project the live loader tree the way the plugin-inventory gateway does:
 * non-group entries in loader order, enablement from the effective disabled
 * chain, phase from each entry's root fiber. Falls back to the static
 * composition roster (everything enabled + active) when no loader service
 * is reachable.
 */
type LoaderEntry = { id: string; options: { name?: unknown; group?: unknown }; disabled: boolean; fiber?: { state: FiberState } }

function pluginInventoryEntries(ctx: Context): PluginInventoryEntryView[] {
  const loader = (ctx as { loader?: { entries(): Iterable<LoaderEntry> } }).loader
  if (loader === undefined) {
    return FALLBACK_PLUGIN_ENTRIES.map(name => ({
      entryId: name,
      moduleName: name,
      enabled: true,
      fiberPhase: 'active' as const,
    }))
  }
  const entries: PluginInventoryEntryView[] = []
  for (const entry of loader.entries()) {
    if (entry.options.group === true) continue
    entries.push({
      entryId: entry.id,
      moduleName: typeof entry.options.name === 'string' ? entry.options.name : '',
      enabled: !entry.disabled,
      fiberPhase: entry.fiber === undefined ? null : (FIBER_PHASES[entry.fiber.state] ?? null),
    })
  }
  return entries
}

/** Derive a short title from message text (ui-bridge parity). */
function titleFromText(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim().slice(0, FALLBACK_TITLE_CHARS)
}

/**
 * Plain text of one conversation message event: the user message's content
 * blocks directly (`user/message` data IS the message) or the nested
 * `message.content` of an assembled `assistant/message` (whose data carries
 * the message under `data.message` — packages/core/session/src/types.ts).
 */
function conversationMessageText(event: SessionEvent): string {
  const data = event.data as {
    content?: Array<{ type?: string; text?: string }>
    message?: { content?: Array<{ type?: string; text?: string }> }
  }
  const content = data.message !== undefined ? data.message.content : data.content
  return (content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join(' ')
}

/**
 * Longest prefix of `value` containing at most `maximum` Unicode code points.
 * The search wire schema caps snippets at 240 code points, so the boundary
 * must never split a surrogate pair.
 */
function truncateUnicodeCodePoints(value: string, maximum: number): string {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count += 1
    end += codePoint.length
  }
  return value
}

/**
 * Plain-text excerpt around the first case-insensitive query hit: at most 60
 * code points of lead-in before the match, then the match and as much of the
 * remainder as the snippet cap admits. A message with no hit returns its
 * plain prefix (callers pass title text through the same cap).
 */
function searchSnippet(text: string, query: string): string {
  const at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  if (at < 0) return truncateUnicodeCodePoints(text, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS)
  let leadStart = 0
  let seen = 0
  for (const codePoint of text) {
    if (seen === 60 || leadStart >= at) break
    leadStart += codePoint.length
    seen += 1
  }
  const ellipsis = leadStart > 0 ? '…' : ''
  return ellipsis + truncateUnicodeCodePoints(
    text.slice(leadStart),
    SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS - ellipsis.length,
  )
}

/**
 * Message-boundary pagination (apiproxy parity, simplified): count
 * maxMessages append-origin messages backwards from the window tail; the cut
 * is the starting seq of the oldest counted message group.
 */
function paginate(
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
): { events: SessionEvent[]; hasMore: boolean } {
  const window = beforeSeq === undefined ? [...events] : events.filter(event => event.seq < beforeSeq)
  let count = 0
  let cut = 0
  for (let i = window.length - 1; i >= 0; i--) {
    const event = window[i] as SessionEvent
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    const sources = (event as { sourceEventSeqs?: number[] }).sourceEventSeqs
    const groupStart = sources !== undefined && sources.length > 0
      ? Math.min(event.seq, ...sources)
      : event.seq
    if (count >= maxMessages) {
      cut = groupStart
      break
    }
  }
  const page = window.filter(event => event.seq >= cut)
  return { events: page, hasMore: cut > 0 }
}

/** The narrow append signature for the plugin-merged `session/title` event. */
type TitleAppend = (
  type: 'session/title',
  data: { title: string; messageSeqs: number[]; source: { kind: 'user' } },
) => SessionEvent

// ───────────────────────── interaction channel ─────────────────────────

/**
 * The mux/respond half of the interaction channel (approval + question
 * answerable server-requests). `apply` installs the live instance; the ask
 * bridge (`chrome-ask-bridge`) resolves it lazily per ask — never at its own
 * apply time, so plugin row order between the two bridge plugins is free.
 */
export interface InteractionChannel {
  /** Fan one interaction frame out to every connected port's mux stream. */
  broadcastMuxFrame(frame: MuxFrame): void
  /**
   * Register the settlement callback for one answerable request. `rpcId` is
   * the id the bridge used on the requested frame; the SidePanel echoes
   * whatever id its client layer minted for that frame, so the callback also
   * receives the respond message's actual rpcId.
   */
  addResponder(rpcId: string, settle: (respondRpcId: string, result: ApiRpcResult) => void): void
  /** Withdraw a responder without settling (the ask's own abort/cancel path). */
  removeResponder(rpcId: string): void
  /**
   * Route a respond whose echoed rpcId matched no registered responder. The
   * SidePanel's client layer mints a FRESH rpcId per delivered frame
   * (`PortApiClient.tapStream`), so a panel's respond carries an id the engine
   * never minted; the channel correlates on the respond body instead (the
   * approval payload's `approvalId`; the question batch's ids, accepted only
   * when exactly one pending request matches). Returns whether it settled.
   * Throws to refuse a matched-but-malformed body (→ `bad-response` receipt).
   */
  routeRespondByValue(respondRpcId: string, result: ApiRpcResult): boolean
}

let interactionChannelRef: InteractionChannel | undefined
let interactionCancelHook: (() => void) | undefined
let interactionValueRouter:
  | ((respondRpcId: string, result: ApiRpcResult) => boolean)
  | undefined

/** The live interaction channel; undefined before apply or after plugin disposal. */
export function interactionChannel(): InteractionChannel | undefined {
  return interactionChannelRef
}

/**
 * Register the ask bridge's cancel hook. The bridge fires it when the last
 * port disconnects or the plugin disposes, so every pending approval/question
 * fails closed instead of outliving its audience. Returns the disposer.
 * @param hook - the cancel callback (idempotent; safe to fire repeatedly).
 * @returns a disposer that removes the hook when it is still the registered one.
 */
export function setInteractionCancel(hook: () => void): () => void {
  interactionCancelHook = hook
  return () => {
    if (interactionCancelHook === hook) interactionCancelHook = undefined
  }
}

/**
 * Register the ask bridge's value router — the body-correlation half of the
 * respond path (the SidePanel client mints fresh frame rpcIds, so most panel
 * responds match by payload, not by id). Returns the disposer.
 * @param router - correlates one unmatched respond by its body; true when settled.
 * @returns a disposer that removes the router when it is still the registered one.
 */
export function setInteractionValueRouter(
  router: (respondRpcId: string, result: ApiRpcResult) => boolean,
): () => void {
  interactionValueRouter = router
  return () => {
    if (interactionValueRouter === router) interactionValueRouter = undefined
  }
}

/** Fire the registered cancel hook; a throwing hook must not break teardown. */
function cancelInteractions(): void {
  try {
    interactionCancelHook?.()
  } catch (err) {
    warn('api-bridge：交互取消钩子执行失败：', errText(err))
  }
}

// ───────────────────────── apply ─────────────────────────

/**
 * One live SidePanel connection: the Port plus its per-stream subscription
 * state. Stream disposers tear the ctx.on listeners down on stream.close,
 * Port disconnect, or plugin disposal.
 */
interface ApiConnection {
  readonly port: chrome.runtime.Port
  muxDisposers: Array<() => void> | undefined
  hostDisposers: Array<() => void> | undefined
}

export function apply(ctx: Context, _config: Config): void {
  // Seed the user-added preset-model merge table once; the settings write
  // path keeps it fresh afterwards.
  void loadPresetUserModels()

  void _config

  // ── bridge state ──

  const connections = new Set<ApiConnection>()

  /** Fan a session-added frame to every connected port's host stream.
   * Called BEFORE session.create's RPC response resolves — the client's
   * sessions.open() fires the moment the RPC returns and needs the session
   * in manager.summaries (populated only from these frames). */
  const broadcastSessionAdded = (sessionId: SessionId): void => {
    const agent = ctx.agents.get(sessionId)
    const blank = agent === undefined || !agent.session.snapshotEvents().some(event => event.type === 'turn/start')
    for (const conn of connections) {
      if (conn.hostDisposers === undefined) continue
      postFrame(conn, 'host', { type: 'host/session-added', sessionId, blank })
    }
  }
  /** Pending answerable server-requests (approval/question rpcId → settle). */
  const pendingResponders = new Map<string, (respondRpcId: string, result: ApiRpcResult) => void>()
  /** Per-agent mutable model selection installed through installModelSelection. */
  const selections = new WeakMap<Agent, { picked: ModelSelection | undefined; ref: ModelSelectionRef }>()
  /** Monotonic revision of the engine settings section (CAS anchor). */
  let settingsRevision = 1

  const post = (conn: ApiConnection, message: ApiPortDownMessage): void => {
    try {
      conn.port.postMessage(message)
    } catch {
      teardownConnection(conn)
    }
  }

  const postResult = (conn: ApiConnection, rpcId: string, result: ApiRpcResult): void => {
    post(conn, { k: 'rpc.result', rpcId, result })
  }

  const postFrame = (conn: ApiConnection, stream: 'mux' | 'host', frame: MuxFrame | HostFrame): void => {
    post(conn, { k: 'frame', stream, frame })
  }

  /**
   * Fan one allowlisted host cordis event out to every connected port as a
   * `host/remote-event` frame (settings/credentials invalidations; the
   * SidePanel's connection layer drops frames on streams it has not opened,
   * so unconditional broadcast is safe).
   */
  const broadcastRemoteEvent = (event: string, args: unknown[]): void => {
    for (const conn of [...connections]) {
      postFrame(conn, 'host', { type: 'host/remote-event', event, args })
    }
  }

  // The live interaction channel (see InteractionChannel): responder settlement
  // rides the pendingResponders table handleRespond already consumes, so a
  // respond message needs no knowledge of which interaction kind it settles.
  interactionChannelRef = {
    broadcastMuxFrame: (frame) => {
      for (const conn of [...connections]) postFrame(conn, 'mux', frame)
    },
    addResponder: (rpcId, settle) => {
      pendingResponders.set(rpcId, settle)
    },
    removeResponder: (rpcId) => {
      pendingResponders.delete(rpcId)
    },
    routeRespondByValue: (respondRpcId, result) => {
      // Delegation through the module slot: the router itself is the ask
      // bridge's (it owns the pending tables the body correlation needs).
      return interactionValueRouter !== undefined
        ? interactionValueRouter(respondRpcId, result)
        : false
    },
  }

  const teardownConnection = (conn: ApiConnection): void => {
    closeStream(conn, 'mux')
    closeStream(conn, 'host')
    connections.delete(conn)
    // Last audience gone: pending approvals/questions have no surface left to
    // answer them — withdraw them (fail closed) instead of leaving zombie
    // waits that can only resolve after the next reconnect.
    if (connections.size === 0) cancelInteractions()
  }

  const closeStream = (conn: ApiConnection, stream: 'mux' | 'host'): void => {
    const key = stream === 'mux' ? 'muxDisposers' : 'hostDisposers'
    const disposers = conn[key]
    conn[key] = undefined
    if (disposers === undefined) return
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (err) {
        warn(`api-bridge：关闭 ${stream} 流订阅失败：`, errText(err))
      }
    }
  }

  /** Run one stream's disposers and re-arm it with a fresh disposer list. */
  const armStream = (conn: ApiConnection, stream: 'mux' | 'host'): Array<() => void> => {
    closeStream(conn, stream)
    const disposers: Array<() => void> = []
    if (stream === 'mux') conn.muxDisposers = disposers
    else conn.hostDisposers = disposers
    return disposers
  }

  // ── agent / session helpers (ui-bridge call shapes) ──

  const agentOptions = (): { provider: string; model: string } => ({
    provider: activeProviderId(),
    // Empty model (unset profile) falls back to the route's default — the
    // agent loop rejects falsy model with "no provider/model". A declared
    // route's first catalog model stands in for the preset default there.
    model: currentEngineConfig().model
      || presetOf(activeProviderId())?.defaultModel
      || declaredRouteDefaultModel(activeProviderId())
      || DEFAULT_MODEL,
  })

  /** The engine route with one preset's provider/model overrides applied. */
  const agentOptionsForPreset = (
    preset: StoredAgentPreset | undefined,
  ): { provider: string; model: string } => {
    if (preset === undefined) return agentOptions()
    const base = agentOptions()
    return {
      provider: preset.provider ?? base.provider,
      model: preset.model ?? base.model,
    }
  }

  /**
   * Fail loud before a preset composes a session: a discovery-broken row (or
   * one naming a route removed after it was authored) must refuse the create
   * with its reason, exactly a desktop mount refuses a broken composition.
   * @throws PresetRefusal('agent-preset-invalid') when the preset is unusable.
   */
  const assertPresetServable = (preset: StoredAgentPreset & { broken?: string }): void => {
    if (preset.broken !== undefined) {
      throw new PresetRefusal('agent-preset-invalid', preset.id, `agent 预设 "${preset.id}" 不可用：${preset.broken}`)
    }
    if (preset.provider !== undefined && !isServableProvider(preset.provider)) {
      throw new PresetRefusal(
        'agent-preset-invalid',
        preset.id,
        `agent 预设 "${preset.id}"：未知 provider "${preset.provider}"`,
      )
    }
  }

  /**
   * Install one preset's per-session composition on a live agent: the
   * provider/model override rides the mutable model selection (the same
   * mechanism `session.selectModel` drives), and the prompt addendum registers
   * as a scope-keyed systemPrompt section — the call goes through the agent's
   * context, whose scope key is the agent itself, so the section dies with the
   * agent and is re-applied at resume. A preset naming neither route nor
   * prompt clears any picked selection: selecting a preset installs exactly
   * that preset's definition, and its absent route override means the engine
   * default.
   */
  const applyPresetToAgent = (agent: Agent, preset: StoredAgentPreset): void => {
    const entry = selections.get(agent)
    if (entry !== undefined) {
      entry.picked = preset.provider === undefined && preset.model === undefined
        ? undefined
        : {
          provider: preset.provider ?? agentOptions().provider,
          model: preset.model ?? agentOptions().model,
        }
    }
    if (preset.systemPrompt !== undefined) {
      agent.ctx.systemPrompt.section({
        name: `preset:${preset.id}`,
        order: 5,
        text: preset.systemPrompt,
      })
    }
  }

  /**
   * Install (once per agent) the mutable model selection the prompt-assembly
   * and request waterfalls consult — the same mechanism the Node gateway
   * uses, so `session.selectModel` reaches the very next model call. The
   * selection getter re-reads the log's last request header, so a resumed
   * session keeps the model it last ran.
   */
  const ensureSelection = (agent: Agent): void => {
    if (selections.has(agent)) return
    const entry: { picked: ModelSelection | undefined; ref: ModelSelectionRef } = {
      picked: undefined,
      ref: {
        get current(): ModelSelection | undefined {
          if (entry.picked !== undefined) return entry.picked
          const logged = agent.session.requestHeader()?.config
          if (logged === undefined) return { provider: agentOptions().provider, model: agentOptions().model }
          return {
            provider: logged.provider,
            model: logged.model,
            ...(logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort }),
          }
        },
        set current(next: ModelSelection | undefined) {
          entry.picked = next
        },
        assembled: undefined,
      },
    }
    selections.set(agent, entry)
    try {
      installModelSelection(agent.ctx, entry.ref)
    } catch (err) {
      // A disposal race (agent torn down between get and install) must not
      // fail the caller: selection falls back to the agent's static options.
      warn('api-bridge：安装会话模型选择失败：', errText(err))
      selections.delete(agent)
    }
  }

  /**
   * In-flight cold resumes per session id. The sidepanel fires several RPCs at
   * once for the adopted session (session.models, session.usage, and a
   * subagent.prompt's own ensure), so every caller after the first must join
   * the running resume instead of starting a colliding second one —
   * `ctx.agents.resume` rejects the loser with "already registered" at the
   * registry boundary, which would surface as a spurious refusal of an
   * ordinary send right after an engine restart.
   */
  const ensuring = new Map<SessionId, Promise<Agent>>()

  /** The cold half of {@link ensureAgent}: resume one persisted session. */
  const ensureAgentCold = async (sessionId: SessionId): Promise<Agent> => {
    const persisted = (await ctx.sessionPersistence.list()).find(snapshot => snapshot.header.id === sessionId)
    if (persisted === undefined) {
      fail('session-not-found', `会话 ${sessionId} 不存在`, { sessionId })
    }
    // The header names the preset the session was created from; the log's
    // `agent-preset/selected` events carry any later blank-window switch and
    // win (the desktop resolveSessionPreset rule). The route override must
    // survive the resume, or a restart would silently move a preset session
    // onto the engine default while its summary still names the preset.
    const headerPreset = await resolveAgentPreset(persisted.header.agentPreset).catch(() => undefined)
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: agentOptionsForPreset(headerPreset),
    })
    ensureSelection(handle.agent)
    let selectedId: string | undefined
    for (const event of handle.agent.session.snapshotEvents()) {
      if (event.type === 'agent-preset/selected') {
        selectedId = (event.data as { agentPreset?: unknown }).agentPreset as string | undefined
      }
    }
    const preset = selectedId === undefined
      ? headerPreset
      : await resolveAgentPreset(selectedId).catch(() => undefined)
    if (preset !== undefined) applyPresetToAgent(handle.agent, preset)
    return handle.agent
  }

  /**
   * Resolve a live agent for a known session, cold-resuming it when persisted.
   * Concurrent callers for the same session join one resume (see `ensuring`);
   * a failed resume clears its entry so the next caller retries.
   */
  const ensureAgent = (sessionId: SessionId): Promise<Agent> => {
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) {
      ensureSelection(live)
      return Promise.resolve(live)
    }
    const inFlight = ensuring.get(sessionId)
    if (inFlight !== undefined) return inFlight
    const ensure = ensureAgentCold(sessionId).finally(() => {
      ensuring.delete(sessionId)
    })
    ensuring.set(sessionId, ensure)
    return ensure
  }

  /**
   * Whether one session event is the model-context runtime snapshot the
   * system-prompt assembly projects as a plugin-sourced user message (the
   * current approval policy, sandbox policy, …). It is model input, not user
   * conversation: the dsh desktop transcript renders it as a collapsed
   * context-injection row, but the extension shell's ConversationView draws
   * every user message as a chat bubble, so an unfiltered snapshot would
   * surface as a permanent fake user message at the top of the conversation.
   * The durable log keeps the event (the model path is untouched); only the
   * panel-facing history read drops it.
   * @param event - one session event from the log.
   * @returns true for the system-prompt runtime-context snapshots (including
   * the "none retained" cleared marker, which carries the same source).
   */
  const isModelContextSnapshot = (event: SessionEvent): boolean => {
    if (event.type !== 'user/message') return false
    const source = (event.data as { source?: { kind?: string; plugin?: string } }).source
    return source?.kind === 'plugin' && source.plugin === '@deepseek-ai/dsh-system-prompt'
  }

  /** Read one stored session's event log from `fromSeq` through a short-lived read handle. */
  const readPersistedEvents = async (sessionId: SessionId, fromSeq = 0): Promise<SessionEvent[]> => {
    const handle = await ctx.sessionPersistence.open(sessionId, 'read')
    try {
      const { events } = await handle.read(fromSeq)
      return [...events]
    } finally {
      await handle.close()
    }
  }

  /** Read the full event log of one session: the live object when attached, else persistence. */
  const readSessionEvents = async (sessionId: SessionId): Promise<SessionEvent[]> => {
    const session = ctx.sessions.get(sessionId)
    if (session !== undefined) return [...session.snapshotEvents()]
    try {
      return await readPersistedEvents(sessionId)
    } catch {
      fail('session-not-found', `会话 ${sessionId} 不存在`, { sessionId })
    }
  }

  /**
   * Promote browser-submitted prompt parts into durable content blocks
   * (apiproxy `serializeImageAdmission` + `durablePromptContent` parity).
   * The model gate runs FIRST so a text-only route refuses before any byte
   * is stored — a message that persisted and then could not replay would
   * brick the session. Text-only prompts short-circuit to plain blocks.
   * @param agent - the addressed agent (its selection names the model gate).
   * @param parts - the validated wire parts.
   * @returns durable blocks: text as submitted, images as stored references.
   */
  const durablePromptContent = async (agent: Agent, parts: readonly WirePromptPart[]): Promise<ContentBlock[]> => {
    if (parts.every(part => part.type === 'text')) {
      return parts.map(part => ({ type: 'text', text: part.text }))
    }
    const store = attachmentsOf(ctx)
    if (store === undefined) {
      fail('attachment-error', '扩展宿主未组合附件服务，无法接收图片', { reason: 'ATTACHMENTS_NOT_COMPOSED' })
    }
    const current = selections.get(agent)?.ref.current
      ?? { provider: agentOptions().provider, model: agentOptions().model }
    const modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model)
    if (modelInfo.inputModalities !== undefined && !modelInfo.inputModalities.includes('image')) {
      fail('attachment-error', `模型 "${current.model}" 不支持图片输入。`, { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })
    }
    const limits = store.imageLimits
    if (parts.filter(part => part.type === 'image').length > limits.maxImagesPerMessage) {
      fail('attachment-error', '消息图片数量超出上限。', { reason: 'TOO_MANY_IMAGES' })
    }
    const prepared = parts.map(part => part.type === 'text'
      ? part
      : { part, data: decodeCanonicalBase64(part.data) })
    const images = prepared.filter((item): item is Extract<typeof item, { data: Uint8Array }> => 'data' in item)
    const totalBytes = images.reduce((sum, image) => sum + image.data.byteLength, 0)
    if (totalBytes > limits.maxMessageImageBytes) {
      fail('attachment-error', '消息图片总字节数超出上限。', { reason: 'IMAGES_TOO_LARGE' })
    }
    // Batch-validate every member before saving any member, so a refused
    // prompt publishes nothing (durable references only ever reach the log
    // through the message that carries them).
    for (const image of images) {
      await store.validateImage({
        data: image.data,
        mediaType: image.part.mediaType,
        ...image.part.name === undefined ? {} : { name: image.part.name },
      })
    }
    const blocks: ContentBlock[] = []
    for (const item of prepared) {
      if (!('data' in item)) {
        blocks.push({ type: 'text', text: item.text })
        continue
      }
      const attachment = await store.saveImage({
        data: item.data,
        mediaType: item.part.mediaType,
        ...item.part.name === undefined ? {} : { name: item.part.name },
      })
      blocks.push({ type: 'image', attachment })
    }
    return blocks
  }

  /** Run one ref-only goal verb (pause/resume/complete/clear) for the bridge dispatchers (typert envelope or dotted path). */
  const goalTransition = async (
    verb: 'pause' | 'resume' | 'complete' | 'clear',
    payload: unknown,
  ): Promise<unknown> => {
    const object = payloadObject(payload)
    const sessionId = object.args !== undefined
      ? agentIdOf(payload, `goals/${verb}`)
      : SessionId(payloadString(payload, 'sessionId', `goal.${verb}`))
    const agent = await ensureAgent(sessionId)
    const ref = refOf(payload, `goals/${verb}`)
    switch (verb) {
      case 'pause': return ctx.goals.pause(agent, ref)
      case 'resume': return ctx.goals.resume(agent, ref)
      case 'complete': return ctx.goals.complete(agent, ref)
      case 'clear': return ctx.goals.clear(agent, ref)
    }
  }

  // ── session.list projection ──

  /**
   * Fold the title a client renders: the latest explicit `session/title`
   * event, else the first user message text. Absent when the conversation
   * has not started.
   */
  const foldedTitle = (events: readonly SessionEvent[]): string | undefined => {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i] as SessionEvent
      // Wide compare: 'session/title' is a plugin-merged event type this
      // program does not carry in its core map.
      if ((event.type as string) !== 'session/title') continue
      const title = (event.data as { title?: unknown }).title
      if (typeof title === 'string' && title.length > 0) return title
    }
    for (const event of events) {
      if (event.type !== 'user/message') continue
      const message = event.data as { content?: Array<{ type?: string; text?: string }>; source?: { kind?: string } }
      if (message.source?.kind !== 'user') continue
      const text = (message.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join(' ')
      if (text.trim() !== '') return titleFromText(text)
    }
    return undefined
  }

  /** SessionSummary projection over a full event log (attached or cold read). */
  const summarizeEvents = (
    sessionId: SessionId,
    header: { createdAt: number; parentSession?: SessionId; origin?: 'subagent'; cwd?: string; agentPreset?: string },
    events: readonly SessionEvent[],
    running: boolean,
  ): SessionSummaryView => {
    let lastPromptAt = 0
    let blank = true
    // Newest `agent-preset/selected` wins over the header's creation-time
    // value (the apiproxy sessionListFields rule): the picker must name the
    // composition the model actually runs.
    let agentPreset = header.agentPreset
    for (const event of events) {
      if (event.type === 'turn/start') blank = false
      if (event.type === 'agent-preset/selected') {
        agentPreset = (event.data as { agentPreset?: unknown }).agentPreset as string | undefined
      }
      if (event.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind === 'user'
        && event.time > lastPromptAt) {
        lastPromptAt = event.time
      }
    }
    const title = foldedTitle(events)
    // The list-row projection baseline carries every registered key (title,
    // todos, …) so the client seeds its stores without opening the session
    // (apiproxy listProjectionsFor parity; a live session folds the registry
    // snapshot plus the folded title, a cold one serves title-only — never
    // broken).
    const live = ctx.sessions.get(sessionId)
    const block = live !== undefined
      ? (ctx.get('sessionProjections') as { snapshot(session: unknown): { asOfSeq: number; values: Record<string, unknown> } } | undefined)?.snapshot(live)
      : undefined
    const values: Record<string, unknown> = { ...block?.values }
    if (values.title === undefined && title !== undefined) values.title = title
    return {
      sessionId,
      updatedAt: Math.max(header.createdAt, lastPromptAt),
      running,
      blank,
      ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
      ...(header.origin === undefined ? {} : { origin: header.origin }),
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
      ...(Object.keys(values).length === 0
        ? {}
        : { projections: { asOfSeq: block?.asOfSeq ?? (events.at(-1)?.seq ?? -1), values } }),
    }
  }

  /** The session.list baseline: attached sessions from memory, cold ones from persistence. */
  const listSummaries = async (): Promise<SessionSummaryView[]> => {
    const items: SessionSummaryView[] = []
    const attached = new Set<SessionId>()
    for (const session of ctx.sessions.list()) {
      attached.add(session.id)
      items.push(summarizeEvents(session.id, session.header, session.snapshotEvents(),
        ctx.agents.get(session.id)?.status === 'running'))
    }
    for (const snapshot of await ctx.sessionPersistence.list()) {
      if (attached.has(snapshot.header.id)) continue
      try {
        const events = await readPersistedEvents(snapshot.header.id)
        items.push(summarizeEvents(snapshot.header.id, snapshot.header, events, false))
      } catch (err) {
        // Fail-soft listing: an unreadable cold session stays visible with
        // header facts only (blank is conservatively false).
        warn(`api-bridge：读取冷会话 ${snapshot.header.id} 失败：`, errText(err))
        items.push({
          sessionId: snapshot.header.id,
          updatedAt: snapshot.header.createdAt,
          running: false,
          blank: false,
        })
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    return items
  }

  /**
   * The session.search corpus and matcher: one hit per session whose folded
   * title or conversation message text (user prompts and assistant replies;
   * injected plugin context is not conversation, matching the history read)
   * contains the query, case-insensitively. Snippets excerpt the first
   * matching message; a title-only hit uses the title. Result order follows
   * session.list (most recently updated first), capped at the wire limit —
   * the scan stops once the cap is exceeded, so hasMore stays cheap. An
   * unreadable cold session is skipped fail-soft, like the listing path.
   */
  const searchSummaries = async (query: string): Promise<{
    items: Array<{ sessionId: SessionId; snippet: string }>
    hasMore: boolean
  }> => {
    const items: Array<{ sessionId: SessionId; snippet: string }> = []
    const lowerQuery = query.toLocaleLowerCase()
    for (const summary of await listSummaries()) {
      let events: SessionEvent[]
      try {
        events = await readSessionEvents(summary.sessionId)
      } catch (err) {
        // Fail-soft search, like the listing path: an unreadable cold session
        // (the same corruption the list projection tolerates) is skipped, not
        // fatal to the whole query.
        warn(`api-bridge：搜索跳过不可读会话 ${summary.sessionId}：`, errText(err))
        continue
      }
      let messageSnippet: string | undefined
      for (const event of events) {
        if (event.type === 'user/message'
          && (event.data as { source?: { kind?: string } }).source?.kind !== 'user') continue
        if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
        const text = conversationMessageText(event)
        if (text.toLocaleLowerCase().includes(lowerQuery)) {
          messageSnippet = searchSnippet(text, query)
          break
        }
      }
      const title = foldedTitle(events)
      const snippet = messageSnippet
        ?? (title !== undefined && title.toLocaleLowerCase().includes(lowerQuery)
          ? truncateUnicodeCodePoints(title, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS)
          : undefined)
      if (snippet !== undefined) items.push({ sessionId: summary.sessionId, snippet })
      if (items.length > SESSION_SEARCH_RESULT_LIMIT) break
    }
    return {
      items: items.slice(0, SESSION_SEARCH_RESULT_LIMIT),
      hasMore: items.length > SESSION_SEARCH_RESULT_LIMIT,
    }
  }

  // ── fixed single-workspace view ──

  /**
   * The one workspace this host serves: every known session accounted under a
   * stable synthetic id (v1 has no workspace registry; the client gets a
   * single-group navigation surface that always contains the `main` session).
   */
  const fixedWorkspaceView = async (): Promise<WorkspaceView> => {
    const summaries = await listSummaries()
    const sessionIds = summaries.map(item => item.sessionId)
    let createdAtMs = Number.POSITIVE_INFINITY
    for (const session of ctx.sessions.list()) {
      createdAtMs = Math.min(createdAtMs, session.header.createdAt)
    }
    if (!Number.isFinite(createdAtMs)) createdAtMs = Date.now()
    const updatedAtMs = summaries[0]?.updatedAt ?? createdAtMs
    return {
      workspaceId: WORKSPACE_ID,
      path: '/',
      title: 'dsh 扩展',
      sessionIds,
      createdAt: new Date(createdAtMs).toISOString(),
      updatedAt: new Date(updatedAtMs).toISOString(),
    }
  }

  // ── model catalog ──

  // ── model catalog ──

  /** Adapter-owned reasoning metadata as the apiproxy ModelReasoning wire view. */
  const reasoningView = (reasoning: LlmModelReasoningInfo | undefined): ModelReasoningView | undefined => {
    if (reasoning === undefined) return undefined
    return {
      efforts: reasoning.efforts.map(effort => ({
        id: effort.id,
        name: effort.name,
        ...(effort.description === undefined ? {} : { description: effort.description }),
      })),
      ...(reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort }),
    }
  }

  /**
   * One provider group's model rows with adapter-resolved capability metadata:
   * per-model context window, declared input modalities, and reasoning levels.
   * `fallbackContextWindow` is the route-level window (the preset's) applied
   * when the adapter's exact-model resolution reports none.
   */
  const catalogModels = async (
    provider: string,
    fallbackContextWindow?: number,
  ): Promise<ModelProviderGroupView['models']> => {
    const models = await ctx.llm.listModels(provider)
    return Promise.all(models.map(async (model) => {
      const resolved = await ctx.llm.resolveModelInfo(provider, model.id)
      const contextWindow = resolved.context?.contextWindow ?? fallbackContextWindow
      const reasoning = reasoningView(resolved.reasoning)
      return {
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(resolved.inputModalities === undefined
          ? {}
          : { inputModalities: [...resolved.inputModalities] }),
        ...(reasoning === undefined ? {} : { reasoning }),
      }
    }))
  }

  /** Catalog over the single registered provider route (apiproxy buildModelCatalog parity). */
  const modelCatalog = async (): Promise<{
    groups: ModelProviderGroupView[]
    failures: Array<{ id: string; name: string; message: string }>
  }> => {
    const groups: ModelProviderGroupView[] = []
    const failures: Array<{ id: string; name: string; message: string }> = []
    // Only CONFIGURED providers belong in the picker: a preset without a
    // stored key is noise (the user asked for "已配置好能用的"), and adding
    // one is a settings-page action, not a picker concern. The missing-key
    // resolution is that filter — it skips the preset without joining the
    // failure list, which stays for catalog failures the user could act on.
    for (const preset of PROVIDER_PRESETS) {
      try {
        const keyRef = keyRefOf(preset)
        if (keyRef !== '') {
          try {
            const stored = await resolveStoredApiKey(preset.id, keyRef)
            if (stored === '') continue
          } catch (err) {
            if (err instanceof LlmError && err.code === 'MISSING_CREDENTIAL') continue
            throw err
          }
        }
        const models = await catalogModels(preset.id, preset.contextWindow)
        // Groups that advertise nothing are dropped (apiproxy parity).
        if (models.length > 0) groups.push({
          id: preset.id,
          name: preset.label,
          ...(preset.contextWindow === undefined ? {} : { contextWindow: preset.contextWindow }),
          models,
        })
      } catch (err) {
        failures.push({ id: preset.id, name: preset.label, message: errText(err) })
      }
    }
    // Hand-declared routes join the catalog from the same adapter source, so
    // the composer's model picker lists their models under their own group.
    for (const view of customProviderViews()) {
      try {
        const models = await catalogModels(view.provider)
        if (models.length > 0) groups.push({ id: view.provider, name: view.displayName, models })
      } catch (err) {
        failures.push({ id: view.provider, name: view.displayName, message: errText(err) })
      }
    }
    return { groups, failures }
  }

  // ── settings namespace view ──

  /** One serialized schemastery const node (union member). */
  const constNode = (value: string): Record<string, unknown> => ({
    type: 'const',
    value,
    meta: { required: true },
  })

  /**
   * Serialized schemastery envelope of the engine-settings section, mirroring
   * the `Config` schema of packages/llm/llm-deepseek/src/index.ts (the
   * adapter family whose curated editor the dsh Models page renders for this
   * namespace). Field defaults carry the ACTIVE provider's facts so the
   * editor's placeholders and inherited-catalog reads resolve against the
   * route the engine currently runs. Kept as a plain JSON envelope: the
   * client rehydrates it with `new Schema(serialized)`, whose property-based
   * resolution validates drafts against exactly this shape.
   */
  const engineSchemaEnvelope = (facts: {
    provider: string
    keyRef: string
    baseURL: string
    model: string
    contextWindow: number
    models: Array<{ id: string; name: string; description?: string; contextWindow?: number }>
  }): Record<string, unknown> => ({
    type: 'object',
    dict: {
      provider: {
        type: 'string',
        meta: { description: '默认供应商路由 ID（官方 preset id 或自定义路由 id）', default: facts.provider },
      },
      apiKeyEnv: {
        type: 'string',
        meta: { role: 'credential-ref', description: 'API Key 环境变量名', default: facts.keyRef },
      },
      baseURL: {
        type: 'string',
        meta: { description: 'API Base URL', default: facts.baseURL },
      },
      model: {
        type: 'string',
        meta: { description: '默认模型名', default: facts.model },
      },
      thinking: {
        type: 'union',
        meta: {},
        list: [constNode('enabled'), constNode('disabled')],
      },
      reasoningEffort: {
        type: 'union',
        meta: {},
        list: [constNode('off'), constNode('high'), constNode('max')],
      },
      maxTokens: {
        type: 'number',
        meta: { step: 1, min: 1, default: DEFAULT_MAX_TOKENS },
      },
      defaultContextWindow: {
        type: 'number',
        meta: { step: 1, min: 1, default: DEFAULT_CONTEXT_WINDOW },
      },
      models: {
        type: 'array',
        meta: { default: facts.models },
        inner: {
          type: 'object',
          meta: {},
          dict: {
            id: { type: 'string', meta: { required: true } },
            name: { type: 'string', meta: {} },
            description: { type: 'string', meta: {} },
            contextWindow: { type: 'number', meta: { step: 1, min: 1 } },
            maxTokens: { type: 'number', meta: { step: 1, min: 1 } },
          },
        },
      },
      streamIdleTimeoutMs: {
        type: 'number',
        meta: { default: DEFAULT_STREAM_IDLE_TIMEOUT_MS },
      },
    },
  })

  /**

  /** Seed plugin-card namespaces the UI's Plugin Configuration page expects. */
  const seedPluginNamespaces = async (): Promise<void> => {
    const existing = await readGenericNamespaces()
    const seeds: Array<[string, Record<string, unknown>]> = [
      ['shell', { kind: 'bash-local', label: 'Bash', available: false, note: 'Shell execution is not available in the browser extension host.' }],
      ['agent-loop', { maxParallelToolCalls: 4 }],
      // Enabled matches the offscreen composition: the web-search-deepseek
      // provider row is mounted, so the settings card must not read disabled.
      ['web-search-deepseek', { enabled: true, apiKeyEnv: 'DEEPSEEK_API_KEY' }],
    ]
    let dirty = false
    for (const [ns, value] of seeds) {
      if (existing[ns] === undefined) {
        existing[ns] = { revision: 0, value }
        dirty = true
      }
    }
    if (dirty) await writeGenericNamespaces(existing)
  }

  /** The redacted namespace view of the chrome.storage-backed engine settings.
   * `value` carries the effective endpoint/model of the active provider;
   * `base` the composition-default layer (the active preset's catalog facts
   * the DeepSeek editor inherits); `user` the active provider's stored
   * overrides (a field's presence there marks it user-owned). The section
   * names no `apiKeyEnv` of its own in `value`, so each provider row's editor
   * derives its conventional `<ROUTE>_API_KEY` reference — per-route refs on
   * a shared section.
   */
  const settingsNamespaceView = async (): Promise<Record<string, unknown>> => {
    const settings = await readEngineSettings()
    const provider = settings.provider === '' ? DEFAULT_PROVIDER : settings.provider
    const preset = presetOf(provider)
    const keyRef = preset === undefined ? '' : keyRefOf(preset)
    const baseURL = settings.baseUrl === '' ? (preset?.baseUrl ?? '') : settings.baseUrl
    const model = settings.model === '' ? (preset?.defaultModel ?? '') : settings.model
    const contextWindow = preset?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
    const models = (preset?.models ?? []).map(entry => ({
      id: entry.id,
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      contextWindow,
    }))
    // The stored user layer: the ACTIVE provider's cached profile ('' = the
    // field re-inherits the preset default above).
    const profile = providerProfile(provider)
    const user: Record<string, unknown> = {
      ...(profile.baseUrl === '' ? {} : { baseURL: profile.baseUrl }),
      ...(profile.model === '' ? {} : { model: profile.model }),
    }
    let keySet = false
    if (keyRef !== '') {
      const info = await ctx.credentials.describe(credentialRef(keyRef)).catch(() => undefined)
      keySet = info?.configured === true
    }
    return {
      ns: SETTINGS_NS,
      schema: engineSchemaEnvelope({ provider, keyRef, baseURL, model, contextWindow, models }),
      value: { provider, baseURL, model },
      // The composition-default layer (what an unset field falls back to).
      base: {
        provider: DEFAULT_PROVIDER,
        ...(keyRef === '' ? {} : { apiKeyEnv: keyRef }),
        baseURL: preset?.baseUrl ?? '',
        model: preset?.defaultModel ?? '',
        maxTokens: DEFAULT_MAX_TOKENS,
        defaultContextWindow: contextWindow,
        models,
      },
      user,
      applies: 'live',
      secrets: keyRef === '' ? [] : [{ path: ['apiKeyEnv'], set: keySet }],
      revision: settingsRevision,
    }
  }

  /** CAS-check the caller's expectedRevision against the live revision. */
  const assertSettingsRevision = (expected: unknown): void => {
    if (expected === undefined) return
    if (typeof expected !== 'number' || expected !== settingsRevision) {
      fail('settings-conflict', '设置分区已被其他写入方更新，请重新读取后再保存', {
        ns: SETTINGS_NS,
        expected: typeof expected === 'number' ? expected : -1,
        actual: settingsRevision,
      })
    }
  }

  /**
   * Apply one engine-settings write: the API key routes through the
   * credentials service (so `credentials/updated` fires), the rest through
   * the settings store. `baseURL` is the deepseek-family spelling of
   * `baseUrl` (the dsh editor card names it that way); `models` — the
   * advisory catalog the DeepSeek editor edits — is accepted and acknowledged
   * (the live catalog stays the preset registry's own projection).
   */
  const applyEngineSettings = async (
    ns: string,
    patch: {
      apiKey?: string
      provider?: string
      baseUrl?: string
      baseURL?: string
      model?: string
      apiKeys?: Record<string, unknown>
      models?: unknown[]
    },
    expectedRevision: unknown,
  ): Promise<Record<string, unknown>> => {
    if (ns !== SETTINGS_NS) {
      fail('settings-not-exposed', `设置分区 ${ns} 未在扩展宿主暴露`, { ns })
    }
    assertSettingsRevision(expectedRevision)
    const baseUrl = patch.baseUrl ?? patch.baseURL
    try {
      // Per-provider keys: {providerId: key} routes to each preset's ref.
      if (patch.apiKeys !== null && typeof patch.apiKeys === 'object') {
        for (const [id, value] of Object.entries(patch.apiKeys)) {
          if (typeof value !== 'string') continue
          const preset = presetOf(id)
          if (preset === undefined) continue
          const ref = keyRefOf(preset)
          if (ref === '') continue
          if (value === '') await ctx.credentials.unset(credentialRef(ref))
          else await ctx.credentials.set(credentialRef(ref), value)
        }
      }
      // Legacy single-key field: routes to the ACTIVE provider's ref.
      if (patch.apiKey !== undefined) {
        const activeRef = keyRefOf(presetOf(activeProviderId()) ?? { keyEnv: '' } as never)
        if (activeRef !== '') {
          if (patch.apiKey === '') await ctx.credentials.unset(credentialRef(activeRef))
          else await ctx.credentials.set(credentialRef(activeRef), patch.apiKey)
        }
      }
      await writeEngineSettings({
        ...(patch.provider === undefined ? {} : { provider: patch.provider }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
      })
    } catch (err) {
      fail('settings-rejected', `保存设置失败：${errText(err)}`, { ns })
    }
    settingsRevision += 1
    return settingsNamespaceView()
  }

  // ───────────────────────── method table ─────────────────────────

  /**
   * Token-meter service handle (optional child of the composition), resolved
   * lazily inside the usage handler: injecting during apply() can park this
   * fiber, while awaiting inside a handler is fiber-agnostic.
   */
  const resolveMeter = (): Promise<{
    measure(session: unknown): { totalTokens: number; surfaceTokens: number; baseline: { kind: string } }
  }> => {
    return new Promise((resolve) => {
      ctx.inject(['tokenMeter'], (tokenMeterCtx: unknown) => {
        resolve(tokenMeterCtx as { measure(session: unknown): { totalTokens: number; surfaceTokens: number; baseline: { kind: string } } })
      })
    })
  }

  /** One method implementation: returns the ok VALUE, throws RpcFailure for structured refusals. */
  type MethodHandler = (payload: unknown, ctx: Context) => Promise<unknown>

  const METHODS: Record<string, MethodHandler> = {
    // ---- sessions ----
    'session.list': async () => ({ items: await listSummaries() }),

    'session.search': async (payload) => {
      // Wire parity (apiproxy sessionSearchRequestSchema): trimmed non-empty
      // query, at most 500 chars, no NUL.
      const raw = payloadObject(payload).query
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        fail('bad-request', 'session.search：query 必须是非空字符串', { issues: [] })
      }
      const query = raw.trim()
      if (query.length > SESSION_SEARCH_QUERY_MAX_CHARS || query.includes('\0')) {
        fail('bad-request', `session.search：query 长度不能超过 ${SESSION_SEARCH_QUERY_MAX_CHARS} 字符且不能包含 NUL`, { issues: [] })
      }
      return searchSummaries(query)
    },

    'session.create': async (payload) => {
      const p = payloadObject(payload)
      const sessionId = typeof p.sessionId === 'string' && p.sessionId.length > 0
        ? SessionId(p.sessionId)
        : mintSessionId()
      if (p.cwd !== undefined && p.cwd !== '/') {
        fail('bad-request', 'session.create：扩展宿主不支持自定义 cwd', { issues: [] })
      }
      // The requested preset (or the stored default when none is named) is the
      // composition this session starts on; an unknown id is a bad request
      // against the roster, not a structural refusal.
      const preset = await resolveAgentPreset(
        typeof p.agentPreset === 'string' ? p.agentPreset : undefined,
      ).catch((error: unknown) => {
        if (error instanceof PresetRefusal) {
          fail(error.kind, error.message, {
            agentPreset: error.presetId,
            ...(error.available === undefined ? {} : { available: [...error.available] }),
          })
        }
        throw error
      })
      assertPresetServable(preset)
      const presetEcho = { agentPreset: preset.id }
      if (ctx.agents.get(sessionId) !== undefined) {
        broadcastSessionAdded(sessionId)
        return { sessionId, ...presetEcho }
      }
      const persisted = (await ctx.sessionPersistence.list()).some(snapshot => snapshot.header.id === sessionId)
      if (persisted) {
        // Retry semantics: the same id resolves to the same session.
        await ensureAgent(sessionId)
        broadcastSessionAdded(sessionId)
        return { sessionId, ...presetEcho }
      }
      const addendum = preset.systemPrompt
      const handle = await ctx.agents.create({
        sessionId,
        meta: { agentPreset: preset.id },
        // The preset's prompt addendum must exist before publication, so the
        // first assembly and every later one carries it (a setup throw rolls
        // the whole creation back rather than publishing a half-composed
        // session).
        ...(addendum === undefined
          ? {}
          : {
            setup: (agentCtx: Context): void => {
              agentCtx.systemPrompt.section({
                name: `preset:${preset.id}`,
                order: 5,
                text: addendum,
              })
            },
          }),
        agentOptions: agentOptionsForPreset(preset),
      })
      ensureSelection(handle.agent)
      if (preset.provider !== undefined || preset.model !== undefined) {
        // The route override rides the mutable selection; the addendum rode setup.
        const entry = selections.get(handle.agent)
        if (entry !== undefined) {
          entry.picked = {
            provider: preset.provider ?? agentOptions().provider,
            model: preset.model ?? agentOptions().model,
          }
        }
      }
      log(`api-bridge：已创建会话 ${sessionId}（agent 预设 ${preset.id}）`)
      return { sessionId, ...presetEcho }
    },

    'session.history': async (payload) => {
      // No redirect: a persisted (cold) session must show ITS OWN history.
      // readSessionEvents falls back to the persistence layer, so the request
      // resolves correctly whether or not a live agent is attached — rewriting
      // the id here used to display session-main's transcript under another
      // session's identity after an engine restart.
      const p = payloadObject(payload)
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'session.history'))
      // The panel transcript must not render model-context snapshots as user
      // messages; pagination runs over the filtered log so the page math
      // stays consistent.
      const events = (await readSessionEvents(sessionId)).filter(event => !isModelContextSnapshot(event))
      const maxMessages = typeof p.maxMessages === 'number' && p.maxMessages > 0
        ? Math.floor(p.maxMessages)
        : DEFAULT_MAX_MESSAGES
      const beforeSeq = typeof p.beforeSeq === 'number' ? p.beforeSeq : undefined
      const page = paginate(events, beforeSeq, maxMessages)
      // Tail-page projection baseline (apiproxy parity): the client seeds its
      // projection stores (todos/goals/titles) from this block, so a reload
      // or cold open must carry the current values — live `session/projection`
      // frames alone leave a reconnecting panel empty.
      const live = ctx.sessions.get(sessionId)
      const block = live !== undefined
        ? (ctx.get('sessionProjections') as { snapshot(session: unknown): { asOfSeq: number; values: Record<string, unknown> } } | undefined)?.snapshot(live)
        : undefined
      const projections = block !== undefined && Object.keys(block.values).length > 0
        ? { asOfSeq: block.asOfSeq, values: block.values }
        : undefined
      return {
        events: page.events.map(event => ({ event })),
        hasMore: page.hasMore,
        ...(projections === undefined ? {} : { projections }),
      }
    },

    'session.models': async (payload) => {
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'session.models'))
      const agent = await ensureAgent(sessionId)
      const current = selections.get(agent)?.ref.current
        ?? { provider: agentOptions().provider, model: agentOptions().model }
      const { groups, failures } = await modelCatalog()
      return {
        current,
        routable: ctx.llm.listProviders().some(provider => provider.id === current.provider),
        groups,
        failures,
      }
    },

    'session.selectModel': async (payload) => {
      const p = payloadObject(payload)
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'session.selectModel'))
      const provider = payloadString(payload, 'provider', 'session.selectModel')
      const model = payloadString(payload, 'model', 'session.selectModel')
      if (presetOf(provider) === undefined && !isDeclaredRoute(provider)) {
        fail('model-unavailable', `扩展宿主不支持 provider "${provider}"（可用：${[...PROVIDER_PRESETS.map(entry => entry.id), ...customProviderViews().map(view => view.provider)].join(', ')}）`, { provider, model })
      }
      const agent = await ensureAgent(sessionId)
      const selected: ModelSelection = {
        provider,
        model,
        ...(typeof p.reasoningEffort === 'string'
          ? { reasoningEffort: p.reasoningEffort as NonNullable<ModelSelection['reasoningEffort']> }
          : {}),
      }
      const entry = selections.get(agent)
      if (entry !== undefined) entry.picked = selected
      // Persist as the host default so the next created/resumed session and a
      // host restart both start from it (single-selection host, v1). The
      // provider rides along: a declared route or a preset switch must
      // survive restarts the same way the model does.
      try {
        await writeEngineSettings({ provider, model })
      } catch (err) {
        warn('api-bridge：持久化默认模型失败：', errText(err))
      }
      return { selected }
    },

    'session.rename': async (payload) => {
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'session.rename'))
      const raw = payloadString(payload, 'title', 'session.rename')
      const title = raw.trim().slice(0, 120)
      if (title === '') {
        fail('title-invalid', '会话标题不能为空白', { sessionId })
      }
      const agent = await ensureAgent(sessionId)
      // Append the log-only `session/title` event directly (the shape the
      // dsh-session-title service writes), so every client's title fold picks
      // it up from the shared event stream. The event type is a plugin merge
      // this program does not carry, hence the narrow local cast.
      const appendTitle = agent.session.append as unknown as TitleAppend
      const event = appendTitle('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
      return { title, seq: event.seq }
    },

    'session.usage': async (payload) => {
      let meter: Awaited<ReturnType<typeof resolveMeter>>
      try {
        meter = await Promise.race([
          resolveMeter(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('token meter 未组合')), 2000)),
        ])
      } catch {
        fail('unavailable', 'token meter 未组合，无法读取用量', {})
      }
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'session.usage'))
      const agent = await ensureAgent(sessionId)
      const measurement = meter.measure(agent.session)
      return {
        totalTokens: measurement.totalTokens,
        surfaceTokens: measurement.surfaceTokens,
        baselineKind: measurement.baseline.kind,
      }
    },

    'session.fork': async (payload) => {
      const p = payloadObject(payload)
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'session.fork'))
      const atSeq = typeof p.atSeq === 'number' ? p.atSeq : undefined
      const events = await readSessionEvents(sessionId)
      const lastSeq = events.at(-1)?.seq ?? -1
      const anchoredBoundary = atSeq === undefined
        ? undefined
        : events.find(event => event.type === 'turn/end' && event.seq >= atSeq)
      const boundary = anchoredBoundary
        ?? (atSeq === undefined || atSeq > lastSeq
          ? events.findLast(event => event.type === 'turn/end')
          : undefined)
      if (boundary === undefined) {
        fail('fork-unavailable', `会话 ${sessionId} 没有已完成的回合可供分叉`, { sessionId })
      }
      // Extend the cut through trailing standalone appends (title, …) up to
      // the next turn/start so the seed stays balanced (apiproxy parity).
      let cut = boundary.seq + 1
      while (cut < events.length && (events[cut] as SessionEvent | undefined)?.type !== 'turn/start') cut++
      const childId = mintSessionId()
      const source = ctx.sessions.get(sessionId)
      try {
        const handle = await ctx.agents.create({
          sessionId: childId,
          seed: events.slice(0, cut),
          meta: {
            parentSession: sessionId,
            isSeeded: true,
            ...(source?.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          },
          inheritedEventCount: SessionLogOffset(cut),
          agentOptions: agentOptions(),
        })
        ensureSelection(handle.agent)
      } catch (err) {
        fail('internal', `分叉会话 ${sessionId} 失败：${errText(err)}`, {})
      }
      log(`api-bridge：已从 ${sessionId}（前 ${String(cut)} 个事件）分叉出 ${childId}`)
      return { sessionId: childId }
    },

    'session.status': async (payload) => {
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'session.status'))
      const agent = ctx.agents.get(sessionId)
      return { running: agent?.status === 'running' }
    },

    'capability.screenshot.get': async () => {
      // The opt-in flag lives in chrome.storage so the provider's next call
      // sees a toggle without an engine reload; a failed read reports OFF
      // (the provider-side default) rather than guessing.
      try {
        const stored = await storageGet([SCREENSHOT_CAPABILITY_KEY])
        const flag = (stored as Record<string, unknown>)[SCREENSHOT_CAPABILITY_KEY] as { enabled?: unknown } | undefined
        return { enabled: flag?.enabled === true }
      } catch {
        return { enabled: false }
      }
    },

    'capability.screenshot.set': async (payload) => {
      const enabled = (payload as { enabled?: unknown } | undefined)?.enabled === true
      await storageSet({ [SCREENSHOT_CAPABILITY_KEY]: { enabled } })
      log(`capability.screenshot.set：${enabled ? '已启用' : '已停用'}`)
      return { enabled }
    },

    'session.permission.get': async (payload) => {
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'session.permission.get'))
      const agent = ctx.agents.get(sessionId)
      // A cold (not-yet-live) session has no log in memory: report the
      // composition default. The knob only becomes settable once the session
      // is live, which the panel guarantees before rendering the switcher.
      if (agent === undefined) return { mode: DEFAULT_PERMISSION_MODE, planActive: false }
      return ctx.permissionMode.effectiveOf(agent)
    },

    'session.permission.set': async (payload) => {
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'session.permission.set'))
      const raw = payloadString(payload, 'mode', 'session.permission.set')
      if (!isPermissionMode(raw)) {
        fail('bad-request', 'session.permission.set：mode 必须是 ask-always / ask-change / full 之一', { issues: [] })
      }
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) {
        fail('no-session', '会话未启动，无法切换权限模式：请先在面板里打开该会话', {})
      }
      log(`session.permission.set：${sessionId} → ${raw}`)
      return ctx.permissionMode.set(agent, raw)
    },

    'session.interrupt': async (payload) => {
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'session.interrupt'))
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined || agent.status !== 'running') {
        return { interrupted: false, running: false }
      }
      agent.cancel({ kind: 'user' })
      log(`session.interrupt：已请求中断 ${sessionId}`)
      return { interrupted: true, running: false }
    },

    'session.prompt': async (payload) => {
      // No redirect: ensureAgent() below resumes the named session from
      // persistence when no live agent exists, so the message lands where the
      // client addressed it. (The old redirect to session-main wrote prompts
      // into the wrong conversation after an engine restart.)
      const p = payloadObject(payload)
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'session.prompt'))
      const mode = p.mode === 'steer' ? 'steer' : 'queue'
      // Accept either `content` (block array) or `text` (plain string
      // convenience — the shell's own composer sends this).
      let content = p.content
      if (!Array.isArray(content) && typeof p.text === 'string' && p.text.trim() !== '') {
        content = [{ type: 'text', text: p.text }]
      }
      if (!Array.isArray(content) || content.length === 0) {
        fail('bad-request', 'session.prompt：content 必须是非空数组', { issues: [] })
      }
      const parts: WirePromptPart[] = []
      for (const part of content) {
        if (typeof part !== 'object' || part === null) {
          fail('bad-request', 'session.prompt：content 项格式非法', { issues: [] })
        }
        const block = part as { type?: unknown; text?: unknown }
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: 'text', text: block.text })
          continue
        }
        // Image parts carry temporary base64 bytes; admission promotes them
        // to durable references below (apiproxy wire parity).
        parts.push(parseImagePart(part))
      }
      if (p.clientTimeZone !== undefined) {
        if (typeof p.clientTimeZone !== 'string'
          || canonicalClientTimeZone(p.clientTimeZone) === undefined) {
          fail('invalid-time-zone', 'clientTimeZone 必须是 UTC 或有效的 IANA 时区名', {
            value: String(p.clientTimeZone),
          })
        }
      }
      const agent = await ensureAgent(sessionId)
      try {
        const durable = await durablePromptContent(agent, parts)
        const message = createUserMessage({
          content: durable,
          source: { kind: 'user' },
        })
        if (mode === 'steer') agent.steer(message)
        else agent.followup(message)
      } catch (error: unknown) {
        if (error instanceof AttachmentError) {
          fail('attachment-error', error.message, { reason: error.code })
        }
        throw error
      }
      return { accepted: true }
    },

    'session.attachment': async (payload) => {
      // Authorized durable-byte read (apiproxy parity): the addressed
      // session's log must reference the attachment id, so one session cannot
      // exfiltrate another's images.
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'session.attachment'))
      const attachmentId = payloadString(payload, 'attachmentId', 'session.attachment')
      const store = attachmentsOf(ctx)
      if (store === undefined) {
        fail('attachment-error', '扩展宿主未组合附件服务，无法读取附件', {
          reason: 'ATTACHMENTS_NOT_COMPOSED',
        })
      }
      const events = await readSessionEvents(sessionId)
      const ref = referencedImage(events, attachmentId)
      if (ref === undefined) {
        fail('attachment-error', 'Image is not referenced by this session.', {
          reason: 'ATTACHMENT_NOT_REFERENCED',
        })
      }
      try {
        const stored = await store.readImage(ref)
        return { attachment: stored.ref, data: bytesToBase64(stored.data) }
      } catch (error: unknown) {
        if (error instanceof AttachmentError) {
          fail('attachment-error', error.message, { reason: error.code })
        }
        throw error
      }
    },

    'session.updateQueue': async (payload) => {
      const p = payloadObject(payload)
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'session.updateQueue'))
      const itemId = payloadString(payload, 'itemId', 'session.updateQueue')
      const action = p.action
      if (typeof action !== 'object' || action === null
        || !['edit', 'remove', 'steer'].includes(String((action as { kind?: unknown }).kind))) {
        fail('bad-request', 'session.updateQueue：action 格式非法', { issues: [] })
      }
      const kind = (action as { kind: 'edit' | 'remove' | 'steer' }).kind
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) {
        fail('queue-item-not-found', '队列项已不再等待中', { itemId })
      }
      const brandedItemId = itemId as MessageId
      const target = agent.inbox.nextTurn.some(message => message.id === itemId)
        ? 'next-turn'
        : agent.inbox.nextStep.some(message => message.id === itemId) ? 'next-step' : undefined
      const message = target === undefined
        ? undefined
        : (target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep)
          .find(candidate => candidate.id === itemId)
      if (target === undefined || message === undefined) {
        fail('queue-item-not-found', '队列项已不再等待中', { itemId })
      }
      if (kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
        fail('steer-unavailable', '当前回合不再接受插话', { itemId })
      }
      if (kind === 'edit') {
        const content = (action as { content?: unknown }).content
        if (!Array.isArray(content)) {
          fail('bad-request', 'session.updateQueue：edit 需要 content 数组', { issues: [] })
        }
        const blocks: ContentBlock[] = content.map((block) => {
          const typed = block as { type?: unknown; text?: unknown }
          if (typed.type === 'text' && typeof typed.text === 'string') {
            return { type: 'text', text: typed.text } satisfies ContentBlock
          }
          fail('attachment-error', '队列编辑仅接受文本内容', { reason: 'QUEUE_EDIT_NON_TEXT' })
        })
        agent.inbox.replace(brandedItemId, freezeMessage({ ...message, content: blocks } as UserMessage))
      } else {
        agent.inbox.remove(brandedItemId)
        if (kind === 'steer') agent.steer(message)
      }
      return { accepted: true }
    },

    'session.cancel': async (payload) => {
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'session.cancel'))
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) {
        fail('session-not-found', `会话 ${sessionId} 未挂载（没有可取消的运行）`, { sessionId })
      }
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      return { accepted: true }
    },

    // ---- subagents (real projection over the composed dsh-subagent service;
    // wire parity with packages/host/apiproxy/src/api/subagents.ts) ----
    'subagent.list': async (payload) => {
      const parentSessionId = SessionId(payloadString(payload, 'parentSessionId', 'subagent.list'))
      let entries: SubagentListEntry[]
      try {
        entries = await ctx.subagents.listChildren(parentSessionId)
      } catch (error) {
        subagentCatalogFailure(error)
      }
      return {
        // Wire activity is the agent-driver sampling at the host boundary,
        // not the service's own store-snapshot field (apiproxy parity).
        entries: entries.map(entry => entry.kind === 'child'
          ? { ...entry, activity: ctx.agents.get(entry.id)?.status === 'running' ? 'running' : 'inactive' }
          : entry),
        parentAvailable: ctx.agents.get(parentSessionId) !== undefined,
      }
    },
    'subagent.history': async (payload) => {
      const parentSessionId = SessionId(payloadString(payload, 'parentSessionId', 'subagent.history'))
      const childSessionId = SessionId(payloadString(payload, 'childSessionId', 'subagent.history'))
      const rawMode = payloadObject(payload).mode
      if (rawMode !== 'one-shot' && rawMode !== 'continuable') {
        fail('bad-request', 'subagent.history：mode 必须是 one-shot 或 continuable', { issues: [] })
      }
      await catalogSubagentChild(ctx, parentSessionId, childSessionId, rawMode)
      // The catalog gate binds parent+origin durably; the read below reuses
      // the session.history data plane (attached snapshot or persistence),
      // with the same model-context-snapshot filter for the panel transcript.
      const events = (await readSessionEvents(childSessionId)).filter(event => !isModelContextSnapshot(event))
      const p = payloadObject(payload)
      const maxMessages = typeof p.maxMessages === 'number' && p.maxMessages > 0
        ? Math.floor(p.maxMessages)
        : DEFAULT_MAX_MESSAGES
      const beforeSeq = typeof p.beforeSeq === 'number' ? p.beforeSeq : undefined
      const page = paginate(events, beforeSeq, maxMessages)
      return { events: page.events.map(event => ({ event })), hasMore: page.hasMore }
    },
    'subagent.prompt': async (payload) => {
      const p = payloadObject(payload)
      const parentSessionId = SessionId(payloadString(payload, 'parentSessionId', 'subagent.prompt'))
      const childSessionId = SessionId(payloadString(payload, 'childSessionId', 'subagent.prompt'))
      const content = p.content
      if (!Array.isArray(content) || content.length === 0) {
        fail('bad-request', 'subagent.prompt：content 必须是非空数组', { issues: [] })
      }
      const blocks: PromptContentPart[] = []
      for (const part of content) {
        if (typeof part !== 'object' || part === null) {
          fail('bad-request', 'subagent.prompt：content 项格式非法', { issues: [] })
        }
        const block = part as { type?: unknown; text?: unknown }
        if (block.type === 'text' && typeof block.text === 'string') {
          blocks.push({ type: 'text', text: block.text })
          continue
        }
        // The extension composes no attachments service (session.prompt
        // parity): image parts cannot reach a child conversation either.
        fail('attachment-error', '扩展宿主暂不支持图片输入', { reason: 'ATTACHMENTS_NOT_COMPOSED' })
      }
      const canonicalTimeZone = p.clientTimeZone === undefined
        ? undefined
        : canonicalClientTimeZone(String(p.clientTimeZone))
      if (p.clientTimeZone !== undefined && canonicalTimeZone === undefined) {
        fail('invalid-time-zone', 'clientTimeZone 必须是 UTC 或有效的 IANA 时区名', {
          value: String(p.clientTimeZone),
        })
      }
      // A continuable delivery rides the exact live direct parent (apiproxy
      // parity). Unlike the desktop proxy — whose host keeps an opened session
      // mounted — this bridge owns lazy resume: after an engine restart the
      // addressed parent is persisted but not yet mounted (the sidepanel's
      // session.models/usage polls race the send), so ensureAgent resumes it
      // here instead of refusing. The same treatment session.prompt already
      // has; an unknown parent stays a structured session-not-found refusal.
      await ensureAgent(parentSessionId)
      await catalogSubagentChild(ctx, parentSessionId, childSessionId, 'continuable')
      try {
        const receipt = await ctx.subagents.prompt({
          requestId: mintSubagentRequestId(),
          parentSessionId,
          childSessionId,
          mode: 'continuable',
          delivery: 'queue',
          content: blocks,
          ...(canonicalTimeZone === undefined ? {} : { clientTimeZone: canonicalTimeZone }),
        }, new AbortController().signal)
        return { messageId: receipt.messageId }
      } catch (error) {
        subagentPromptFailure(childSessionId, error)
      }
    },
    'subagent.interrupt': async (payload) => {
      const parentSessionId = SessionId(payloadString(payload, 'parentSessionId', 'subagent.interrupt'))
      const childSessionId = SessionId(payloadString(payload, 'childSessionId', 'subagent.interrupt'))
      try {
        ctx.subagents.interrupt(childSessionId, { kind: 'user', parentSessionId })
      } catch (error) {
        if (error instanceof SubagentError && error.code === 'UNAUTHORIZED') {
          fail('subagent-unauthorized', 'subagent does not belong to this parent', { childSessionId })
        }
        fail('internal', 'subagent interrupt failed', {})
      }
      return { accepted: true }
    },

    // ---- host ----
    'debug.agentOptions': async () => {
      const agents = ctx.agents.roots()
      return {
        agents: agents.map(a => ({
          id: a.id,
          provider: a.options.provider,
          model: a.options.model,
          status: a.status,
        })),
        registry: ctx.agents.list().map(a => a.id),
      }
    },

    'host.describe': async () => {
      const config = currentEngineConfig()
      return {
        version: HOST_VERSION,
        cwd: '/',
        provider: activeProviderId(),
        model: config.model === '' ? (presetOf(config.provider)?.defaultModel ?? '') : config.model,
        attachedSessions: ctx.agents.list().length,
        canOpenPath: false,
      }
    },
    'host.pickDirectory': async () => unavailable('host.pickDirectory'),
    'host.listDirectory': async () => unavailable('host.listDirectory'),
    'host.createDirectory': async () => unavailable('host.createDirectory'),
    'host.openPath': async () => unavailable('host.openPath'),

    // ---- workspace (v1: one fixed workspace) ----
    'workspace.list': async () => ({
      items: [await fixedWorkspaceView()],
      archivedSessionIds: [],
    }),
    'workspace.create': async () => unavailable('workspace.create'),
    'workspace.rename': async () => unavailable('workspace.rename'),
    'workspace.delete': async () => unavailable('workspace.delete'),
    'workspace.insertBefore': async () => unavailable('workspace.insertBefore'),
    'workspace.insertSessionBefore': async () => unavailable('workspace.insertSessionBefore'),
    'workspace.archiveSession': async () => unavailable('workspace.archiveSession'),

    // ---- skills / presets (no services composed) ----
    'skill.list': async (payload) => {
      const sessionId = payloadObject(payload).sessionId
      const scope = typeof sessionId === 'string' ? sessionId : undefined
      try {
        const summaries = await ctx.skills.list(scope === undefined ? {} : { cwd: scope })
        return {
          skills: summaries.map(skill => ({
            name: skill.name,
            description: skill.description,
            ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
            modelInvocable: skill.invocation.modelInvocable,
          })),
        }
      } catch {
        return { skills: [] }
      }
    },
    // ---- skill authoring (chrome.storage roster; writeStoredSkill 是唯一写入口) ----
    'skill.write': async (payload) => {
      const p = payloadObject(payload)
      const name = typeof p.name === 'string' ? p.name : ''
      const description = typeof p.description === 'string' ? p.description : ''
      const content = typeof p.content === 'string' ? p.content : ''
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        throw new Error(`skill.write：name 必须是小写 kebab-case，收到：${name}`)
      }
      if (description.trim() === '') throw new Error('skill.write：description 不能为空')
      if (content.trim() === '') throw new Error('skill.write：content 不能为空')
      const record: StoredSkill = { name, description, content }
      if (typeof p.whenToUse === 'string' && p.whenToUse !== '') record.whenToUse = p.whenToUse
      if (p.modelInvocable === false) record.modelInvocable = false
      if (p.userInvocable === false) record.userInvocable = false
      await writeStoredSkill(record)
      return { written: true, name }
    },
    'skill.remove': async (payload) => {
      const p = payloadObject(payload)
      if (typeof p.name !== 'string' || p.name === '') {
        throw new Error('skill.remove：name 必须是非空字符串')
      }
      await removeStoredSkill(p.name)
      return { removed: true, name: p.name }
    },
    /**
     * The authorable roster: the implicit engine composition ('default',
     * system trust) plus every chrome.storage preset (user trust). The
     * `agent-presets` settings namespace's `default` field decides isDefault —
     * the same document `makeDefault` writes through settings.update, which is
     * what the desktop's settings layering does too.
     */
    'agentPreset.list': async () => {
      const roster = await agentPresetRoster()
      const config = currentEngineConfig()
      const model = config.model === '' ? (presetOf(config.provider)?.defaultModel ?? '') : config.model
      return {
        presets: roster.presets.map((preset) => {
          const system = preset.id === DEFAULT_PRESET_ID
          return {
            id: preset.id,
            trust: system ? ('system' as const) : ('user' as const),
            isDefault: preset.id === roster.defaultId,
            name: preset.name ?? (system ? '默认' : preset.id),
            ...(system || preset.description !== undefined
              ? { description: preset.description ?? `当前引擎：${activeProviderId()}/${model}` }
              : {}),
            ...(preset.broken === undefined ? {} : { broken: preset.broken }),
          }
        }),
        authorable: true,
        // No filesystem, no native opener: openDocument always answers the
        // reveal-path shape.
        hasDocument: false,
      }
    },
    /**
     * Recompose a blank session onto another preset (the desktop semantic): a
     * started conversation's history was produced under its composition, so a
     * non-blank session answers `agent-preset-locked`. The route override
     * lands in the mutable selection, the prompt addendum registers scoped to
     * the agent, and the switch is logged as `agent-preset/selected` so
     * summaries and resumes rebuild what the model actually saw.
     */
    'agentPreset.select': async (payload) => {
      const sessionId = SessionId(payloadString(payload, 'sessionId', 'agentPreset.select'))
      const wanted = payloadString(payload, 'agentPreset', 'agentPreset.select')
      const preset = await resolveAgentPreset(wanted).catch((error: unknown) => {
        if (error instanceof PresetRefusal) {
          fail(error.kind, error.message, {
            agentPreset: error.presetId,
            ...(error.available === undefined ? {} : { available: [...error.available] }),
          })
        }
        throw error
      })
      assertPresetServable(preset)
      const agent = await ensureAgent(sessionId)
      if (agent.session.snapshotEvents().some(event => event.type === 'turn/start')) {
        fail('agent-preset-locked', `会话 ${sessionId} 已开始对话，其 agent 预设已固定`, { sessionId, agentPreset: wanted })
      }
      applyPresetToAgent(agent, preset)
      agent.session.append('agent-preset/selected', { agentPreset: preset.id })
      return { agentPreset: preset.id }
    },
    /** One preset's definition document, exactly as stored (read-only viewer). */
    'agentPreset.read': async (payload) => {
      const wanted = payloadString(payload, 'agentPreset', 'agentPreset.read')
      const preset = await resolveAgentPreset(wanted).catch((error: unknown) => {
        if (error instanceof PresetRefusal) {
          fail(error.kind, error.message, {
            agentPreset: error.presetId,
            ...(error.available === undefined ? {} : { available: [...error.available] }),
          })
        }
        throw error
      })
      const trust = preset.id === DEFAULT_PRESET_ID ? ('system' as const) : ('user' as const)
      return {
        agentPreset: preset.id,
        trust,
        content: presetDocument(preset, trust),
        ...(preset.name === undefined ? {} : { name: preset.name }),
        ...(preset.description === undefined ? {} : { description: preset.description }),
      }
    },
    /**
     * Copy one preset whole (the only authoring write, as on the desktop): the
     * copy keeps the source's description and override document; `name` here —
     * or the id fallback — is what distinguishes the row.
     */
    'agentPreset.copy': async (payload) => {
      const p = payloadObject(payload)
      const from = payloadString(payload, 'from', 'agentPreset.copy')
      const newId = payloadString(payload, 'agentPreset', 'agentPreset.copy')
      const name = typeof p.name === 'string' && p.name.trim() !== '' ? p.name.trim() : undefined
      if (!AGENT_PRESET_ID.test(newId) || newId === DEFAULT_PRESET_ID) {
        fail('agent-preset-invalid', `agent 预设 id "${newId}" 不可用（需匹配 ${String(AGENT_PRESET_ID)} 且不为 ${DEFAULT_PRESET_ID}）`, {
          agentPreset: newId,
          reason: 'id 不合法',
        })
      }
      const source = await resolveAgentPreset(from).catch((error: unknown) => {
        if (error instanceof PresetRefusal) {
          fail(error.kind, error.message, {
            agentPreset: error.presetId,
            ...(error.available === undefined ? {} : { available: [...error.available] }),
          })
        }
        throw error
      })
      const roster = await readStoredPresets()
      if (roster.some(preset => preset.id === newId)) {
        fail('agent-preset-invalid', `agent 预设 id "${newId}" 已被占用`, { agentPreset: newId, reason: 'id 已存在' })
      }
      await writeStoredPresets([
        ...roster,
        {
          id: newId,
          ...(name === undefined ? {} : { name }),
          ...(source.description === undefined ? {} : { description: source.description }),
          ...(source.provider === undefined ? {} : { provider: source.provider }),
          ...(source.model === undefined ? {} : { model: source.model }),
          ...(source.systemPrompt === undefined ? {} : { systemPrompt: source.systemPrompt }),
        },
      ])
      return { agentPreset: newId }
    },
    /**
     * No native desktop: the extension never opens an editor, so a user preset
     * answers the reveal shape — the storage location as text. The implicit
     * engine composition is refused read-only, matching the desktop's shipped
     * install line.
     */
    'agentPreset.openDocument': async (payload) => {
      const wanted = payloadString(payload, 'agentPreset', 'agentPreset.openDocument')
      const preset = await resolveAgentPreset(wanted).catch((error: unknown) => {
        if (error instanceof PresetRefusal) {
          fail(error.kind, error.message, {
            agentPreset: error.presetId,
            ...(error.available === undefined ? {} : { available: [...error.available] }),
          })
        }
        throw error
      })
      if (preset.id === DEFAULT_PRESET_ID) {
        fail('agent-preset-read-only', 'agent 预设 "default" 随扩展发布，不可编辑', {
          agentPreset: preset.id,
          reason: '随扩展发布',
        })
      }
      return { opened: false as const, path: `chrome.storage.local["${AGENT_PRESET_STORE_KEY}"] → ${preset.id}` }
    },
    /** Delete a stored preset; the implicit engine composition is refused. */
    'agentPreset.remove': async (payload) => {
      const wanted = payloadString(payload, 'agentPreset', 'agentPreset.remove')
      if (wanted === DEFAULT_PRESET_ID) {
        fail('agent-preset-read-only', 'agent 预设 "default" 随扩展发布，不可删除', {
          agentPreset: wanted,
          reason: '随扩展发布',
        })
      }
      const roster = await readStoredPresets()
      if (!roster.some(preset => preset.id === wanted)) {
        const full = await agentPresetRoster()
        fail('agent-preset-not-found', `agent 预设 "${wanted}" 不存在（可用：${full.presets.map(preset => preset.id).join(', ') || '无'}）`, {
          agentPreset: wanted,
          available: full.presets.map(preset => preset.id),
        })
      }
      await writeStoredPresets(roster.filter(preset => preset.id !== wanted))
      // A default this call just deleted must not strand every later session
      // create (the desktop remove clears its settings default the same way).
      if ((await storedDefaultPresetId()) === wanted) {
        await applyGenericNsWrite('agent-presets', undefined, (value) => { delete value['default'] })
        broadcastRemoteEvent('settings/document-updated', ['agent-presets', (await readGenericNamespaces())['agent-presets']?.revision ?? 0])
      }
      return {}
    },

    // ---- goals, legacy dotted /api paths (the Node gateway's HTTP
    // vocabulary: flat `{ sessionId, ref, ... }` payloads; superseded by the
    // typert 'goals/*' dispatchers above for the Remote proxies) ----
    'goal.create': async (payload) => {
      const agent = await ensureAgent(SessionId(payloadString(payload, 'sessionId', 'goal.create')))
      return ctx.goals.create(
        agent,
        payloadObject(payload) as unknown as Parameters<typeof ctx.goals.create>[1],
      )
    },
    'goal.edit': async (payload) => {
      const agent = await ensureAgent(SessionId(payloadString(payload, 'sessionId', 'goal.edit')))
      return ctx.goals.edit(
        agent,
        refOf(payload, 'goal.edit'),
        payloadObject(payload).request as unknown as Parameters<typeof ctx.goals.edit>[2],
      )
    },
    'goal.pause': async payload => goalTransition('pause', payload),
    'goal.resume': async payload => goalTransition('resume', payload),
    'goal.complete': async payload => goalTransition('complete', payload),
    'goal.clear': async payload => goalTransition('clear', payload),

    // ---- plugin inventory (loader-tree projection; gateway parity) ----
    // The HTTP-path key is the wire name the dsh Web UI's plugin-inventory
    // surface reaches the bridge with; every other /api/* path falls through
    // to the dispatcher's not-available-in-extension refusal.
    'pluginInventory/list': async () => ({ entries: pluginInventoryEntries(ctx) }),

    // ---- dynamic Cordis runner (empty host: the extension runs no dynamic
    // Cordis packages, but the ui-cordis / cordis-client-runner Client rows
    // touch the namespace at apply time). Minimal answers — never a refusal —
    // so the panel reaches its empty state instead of surfacing an error:
    // the inspect manifest is accepted (null, host parity), the inventory
    // lists no rows, and the panel verbs report their wire-shaped
    // not-running/plugin-missing outcomes. Wire names use the typert
    // `<namespace>/<method>` vocabulary (dsh-api-remotes client).
    'dynamicCordisRunner/syncInspectManifest': async () => null,
    'dynamicCordisRunner/inventory': async () => [],
    'dynamicCordisRunner/list': async () => [],
    'dynamicCordisRunner/stopFromPanel': async () => ({
      ok: false,
      reason: 'not-running',
      message: '扩展宿主没有运行的动态 Cordis 插件',
    }),
    'dynamicCordisRunner/undefineFromPanel': async () => ({
      ok: false,
      reason: 'plugin-missing',
      message: '扩展宿主没有已定义的动态 Cordis 插件',
    }),
    // No current client calls this verb (panel runs go through startUserRun →
    // runHostHalf); kept as the run-response refusal so a future caller gets
    // an empty-state answer instead of an unknown-method refusal.
    'dynamicCordisRunner/runFromPanel': async () => ({
      ok: false,
      reason: 'not-running',
      message: '扩展宿主不支持在面板中运行动态 Cordis 插件',
    }),

    // ---- typert remote dispatchers (commands / goals / messageFeedback) ----
    // The SidePanel's generated Remote proxies send `/api` channel calls whose
    // payload is `{ args: { <wire param>: value } }` (the gateway client's
    // invoke encoding); these entries decode that envelope and drive the same
    // engine services the Node gateway's typert dispatcher would.
    'commands/list': async (payload) => {
      const agent = await ensureAgent(agentIdOf(payload, 'commands/list'))
      return [...ctx.commands.list(agent)]
    },
    'commands/execute': async (payload) => {
      const agent = await ensureAgent(agentIdOf(payload, 'commands/execute'))
      const line = payloadString(payloadObject(payload).args, 'line', 'commands/execute')
      // The UI request's cancellation signal stops at the transport; the
      // command handler runs to settlement (lifecycle is logged either way).
      const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
      return execution === undefined ? undefined : { ...execution }
    },
    'goals/create': async (payload) => {
      const agent = await ensureAgent(agentIdOf(payload, 'goals/create'))
      return ctx.goals.create(
        agent,
        requestOf(payload, 'goals/create', [{ field: 'objective', kind: 'string' }]) as unknown as Parameters<typeof ctx.goals.create>[1],
      )
    },
    'goals/edit': async (payload) => {
      const agent = await ensureAgent(agentIdOf(payload, 'goals/edit'))
      return ctx.goals.edit(
        agent,
        refOf(payload, 'goals/edit'),
        requestOf(payload, 'goals/edit') as unknown as Parameters<typeof ctx.goals.edit>[2],
      )
    },
    'goals/pause': async payload => goalTransition('pause', payload),
    'goals/resume': async payload => goalTransition('resume', payload),
    'goals/complete': async payload => goalTransition('complete', payload),
    'goals/clear': async payload => goalTransition('clear', payload),
    'messageFeedback/list': async payload => ctx.messageFeedback.list(
      requestOf(payload, 'messageFeedback/list', [{ field: 'sessionId', kind: 'string' }]) as unknown as Parameters<typeof ctx.messageFeedback.list>[0],
    ),
    'messageFeedback/put': async payload => ctx.messageFeedback.put(
      requestOf(payload, 'messageFeedback/put', [
        { field: 'sessionId', kind: 'string' },
        { field: 'messageId', kind: 'string' },
        { field: 'rating', kind: 'string' },
        { field: 'ifVersion', kind: 'string' },
      ]) as unknown as Parameters<typeof ctx.messageFeedback.put>[0],
    ),
    'messageFeedback/delete': async payload => ctx.messageFeedback.delete(
      requestOf(payload, 'messageFeedback/delete', [
        { field: 'sessionId', kind: 'string' },
        { field: 'messageId', kind: 'string' },
        { field: 'ifVersion', kind: 'string' },
      ]) as unknown as Parameters<typeof ctx.messageFeedback.delete>[0],
    ),


    // ---- settings / credentials (chrome.storage-backed) ----
    'settings.describe': async () => {
      await seedPluginNamespaces()
      const generic = await readGenericNamespaces()
      const views = Object.entries(generic).map(([ns, entry]) => genericNsView(ns, entry))
      // The hand-declared-provider namespace must always exist for the Models
      // page to read its protocol choices (an absent namespace keeps the
      // custom-provider entry point disabled).
      if (generic[CUSTOM_PROVIDER_NS] === undefined) {
        views.push(genericNsView(CUSTOM_PROVIDER_NS, { revision: 0, value: {} }))
      }
      return {
        writable: true,
        hasDocument: false,
        namespaces: [
          await settingsNamespaceView(),
          ...views,
        ],
      }
    },

    'settings.openDocument': async () => unavailable('settings.openDocument'),
    'settings.update': async (payload, ctx) => {
      const ns = payloadString(payload, 'ns', 'settings.update')
      const patch = payloadObject(payload).patch
      if (ns !== SETTINGS_NS) {
        const view = await applyGenericNsWrite(
          ns,
          payloadObject(payload).expectedRevision,
          (value) => {
            for (const [key, item] of Object.entries(payloadObject(patch))) {
              value[key] = cloneJsonValue(item)
            }
          },
          ns === CUSTOM_PROVIDER_NS ? validateCustomProviderNs : undefined,
        )
        if (ns === CUSTOM_PROVIDER_NS) await syncCustomProviders(ctx)
        if (ns === PRESET_MODELS_NS) setPresetUserModels(view.value)
        broadcastRemoteEvent('settings/document-updated', [ns, view.revision as number])
        return view
      }
      const p = payloadObject(patch)
      const view = await applyEngineSettings(
        ns,
        {
          ...(typeof p.apiKey === 'string' ? { apiKey: p.apiKey } : {}),
          ...(typeof p.provider === 'string' ? { provider: p.provider } : {}),
          ...(typeof p.baseUrl === 'string' ? { baseUrl: p.baseUrl } : {}),
          ...(typeof p.baseURL === 'string' ? { baseURL: p.baseURL } : {}),
          ...(typeof p.model === 'string' ? { model: p.model } : {}),
          ...(p.apiKeys !== null && typeof p.apiKeys === 'object' && !Array.isArray(p.apiKeys) ? { apiKeys: p.apiKeys as Record<string, unknown> } : {}),
          ...(Array.isArray(p.models) ? { models: p.models } : {}),
        },
        payloadObject(payload).expectedRevision,
      )
      broadcastRemoteEvent('settings/document-updated', [ns, view.revision as number])
      return view
    },
    'settings.replace': async (payload, ctx) => {
      const ns = payloadString(payload, 'ns', 'settings.replace')
      if (ns !== SETTINGS_NS) {
        const section = payloadObject(payloadObject(payload).section)
        const view = await applyGenericNsWrite(
          ns,
          payloadObject(payload).expectedRevision,
          (value) => {
            for (const key of Object.keys(value)) Reflect.deleteProperty(value, key)
            for (const [key, item] of Object.entries(section)) value[key] = cloneJsonValue(item)
          },
          ns === CUSTOM_PROVIDER_NS ? validateCustomProviderNs : undefined,
        )
        if (ns === CUSTOM_PROVIDER_NS) await syncCustomProviders(ctx)
        if (ns === PRESET_MODELS_NS) setPresetUserModels(view.value)
        broadcastRemoteEvent('settings/document-updated', [ns, view.revision as number])
        return view
      }
      const section = payloadObject(payloadObject(payload).section)
      const view = await applyEngineSettings(
        ns,
        {
          // Wholesale replace: absent keys drop (empty string resets to default).
          apiKey: typeof section.apiKey === 'string' ? section.apiKey : '',
          // The deepseek-family spelling (baseURL) and the store's (baseUrl)
          // name the same field; either presence wins over the reset default.
          baseUrl: typeof section.baseUrl === 'string'
            ? section.baseUrl
            : typeof section.baseURL === 'string' ? section.baseURL : '',
          model: typeof section.model === 'string' ? section.model : '',
        },
        payloadObject(payload).expectedRevision,
      )
      broadcastRemoteEvent('settings/document-updated', [ns, view.revision as number])
      return view
    },
    'settings.mutate': async (payload, ctx) => {
      const ns = payloadString(payload, 'ns', 'settings.mutate')
      const ops = payloadObject(payload).ops
      if (!Array.isArray(ops)) {
        fail('bad-request', 'settings.mutate：ops 必须是数组', { issues: [] })
      }
      if (ns !== SETTINGS_NS) {
        const view = await applyGenericNsWrite(
          ns,
          payloadObject(payload).expectedRevision,
          (value) => {
            for (const op of ops) applyPathOp(value, payloadObject(op))
          },
          ns === CUSTOM_PROVIDER_NS ? validateCustomProviderNs : undefined,
        )
        if (ns === CUSTOM_PROVIDER_NS) await syncCustomProviders(ctx)
        if (ns === PRESET_MODELS_NS) setPresetUserModels(view.value)
        broadcastRemoteEvent('settings/document-updated', [ns, view.revision as number])
        return view
      }
      const patch: {
        apiKey?: string
        provider?: string
        baseUrl?: string
        baseURL?: string
        model?: string
        models?: unknown[]
      } = {}
      for (const op of ops) {
        const typed = payloadObject(op)
        const path = Array.isArray(typed.path) ? typed.path.map(String) : []
        const field = path[0]
        if (typed.op === 'set' && field !== undefined) {
          const value = typed.value
          if (field === 'apiKey' && typeof value === 'string') patch.apiKey = value
          if (field === 'provider' && typeof value === 'string') patch.provider = value
          if (field === 'baseUrl' && typeof value === 'string') patch.baseUrl = value
          if (field === 'baseURL' && typeof value === 'string') patch.baseURL = value
          if (field === 'model' && typeof value === 'string') patch.model = value
          if (field === 'models' && Array.isArray(value)) patch.models = value
        } else if (typed.op === 'unset' && field !== undefined) {
          if (field === 'apiKey') patch.apiKey = ''
          if (field === 'provider') patch.provider = ''
          if (field === 'baseUrl') patch.baseUrl = ''
          if (field === 'baseURL') patch.baseURL = ''
          if (field === 'model') patch.model = ''
        }
      }
      const view = await applyEngineSettings(ns, patch, payloadObject(payload).expectedRevision)
      broadcastRemoteEvent('settings/document-updated', [ns, view.revision as number])
      return view
    },

    'credentials.describe': async (payload) => {
      const refs = payloadObject(payload).refs
      if (!Array.isArray(refs)) {
        fail('bad-request', 'credentials.describe：refs 必须是数组', { issues: [] })
      }
      const credentials: Record<string, unknown> = {}
      for (const ref of refs) {
        if (typeof ref !== 'string') continue
        const info = await ctx.credentials.describe(credentialRef(ref))
        credentials[ref] = {
          configured: info.configured,
          ...(info.source === undefined ? {} : { source: info.source }),
          writable: info.writable,
        }
      }
      return { credentials }
    },
    'credentials.set': async (payload) => {
      const ref = payloadString(payload, 'ref', 'credentials.set')
      const value = payloadString(payload, 'value', 'credentials.set')
      try {
        await ctx.credentials.set(credentialRef(ref), value)
      } catch (err) {
        fail('credential-rejected', `写入凭据被拒绝：${errText(err)}`, { ref })
      }
      return {}
    },
    'credentials.unset': async (payload) => {
      const ref = payloadString(payload, 'ref', 'credentials.unset')
      try {
        await ctx.credentials.unset(credentialRef(ref))
      } catch (err) {
        fail('credential-rejected', `清除凭据被拒绝：${errText(err)}`, { ref })
      }
      return {}
    },

    // ---- llm ----
    'llm.providers': async () => {
      const live = new Set(ctx.llm.listProviders().map(provider => provider.id))
      return {
        providers: [
          // Official presets also carry their connection facts (credential
          // reference, endpoint, wire protocol, default model) beyond the
          // directory contract: the Models page's official rail renders one
          // key editor per preset and needs each preset's own facts, while
          // the shared engine-settings section only describes the ACTIVE one.
          ...PROVIDER_PRESETS.map(preset => ({
            provider: preset.id,
            displayName: preset.label,
            settingsNs: SETTINGS_NS,
            settingsPath: [],
            active: live.has(preset.id),
            keyEnv: preset.keyEnv,
            baseURL: preset.baseUrl,
            api: preset.protocol,
            defaultModel: preset.defaultModel,
          })),
          // Hand-declared routes (the llm-pi-ai namespace): declared: true is
          // what the Models page reads to tag the row 自定义 and offer removal.
          ...customProviderViews().map(view => ({
            ...view,
            active: live.has(view.provider),
          })),
        ],
      }
    },
    'llm.models': async () => modelCatalog(),
    'llm.discoverModels': async (payload) => {
      const p = payloadObject(payload)
      // A registered route answers from its own catalog; a drafted endpoint is
      // interrogated live (GET {base}/models for OpenAI-compatible, POST
      // {base}/messages for the Anthropic protocol, POST {base}/responses for
      // the Responses protocol).
      const provider = typeof p.provider === 'string' && p.provider.length > 0 ? p.provider : undefined
      if (provider !== undefined && p.baseURL === undefined) {
        const models = (await ctx.llm.listModels(provider))
          .map(model => ({ id: model.id, name: model.name }))
        return { models }
      }
      const baseURL = typeof p.baseURL === 'string' ? p.baseURL.trim() : ''
      if (baseURL === '') fail('bad-request', 'llm.discoverModels：缺少 baseURL', { issues: [] })
      const urlFailure = publicHttpUrlFailure(baseURL)
      if (urlFailure !== undefined) fail('bad-request', `llm.discoverModels：${urlFailure}`, { issues: [] })
      const protocol = await probeProtocolOf(p, provider)
      // A probe naming an already-declared route asks with that route's stored
      // headers, so the interrogation travels the way a real request will.
      // The credential still owns the auth header (validation keeps
      // headersText from ever holding it), and profile headers may override
      // Accept.
      const routeHeaders = provider !== undefined ? declaredRouteHeaders(provider) : undefined
      // The typed key probes the draft; an empty key probes the route's stored
      // credential so a saved route verifies without re-typing its key.
      const probeKey = typeof p.apiKey === 'string' && p.apiKey.trim() !== ''
        ? p.apiKey.trim()
        : await storedProbeKey(provider)

      if (protocol === 'anthropic') {
        // The Messages API serves no model-list endpoint; a 200 to the minimal
        // ping is the connectivity verdict.
        let response: Response
        try {
          response = await fetch(resolveAnthropicEndpoint(baseURL), {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              ...(routeHeaders ?? {}),
              'content-type': 'application/json',
              'anthropic-version': '2023-06-01',
              ...(probeKey === '' ? {} : { 'x-api-key': probeKey }),
            },
            body: JSON.stringify({
              model: probeModelOf(provider, ANTHROPIC_PROBE_MODEL),
              max_tokens: 1,
              messages: [{ role: 'user', content: 'ping' }],
            }),
            signal: AbortSignal.timeout(10000),
          })
        } catch (err) {
          fail('bad-request', `探测端点失败：${errText(err)}`, { issues: [] })
        }
        if (!response.ok) {
          fail('bad-request', `端点返回 ${String(response.status)} ${response.statusText}`, { issues: [] })
        }
        return { models: [] }
      }

      if (protocol === 'openai-responses') {
        // Same connectivity semantics as the Anthropic branch: the Responses
        // protocol serves no model-list endpoint, so a 200 to the minimal
        // ping is the verdict.
        let response: Response
        try {
          response = await fetch(resolveResponsesEndpoint(baseURL), {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              ...(routeHeaders ?? {}),
              'content-type': 'application/json',
              ...(probeKey === '' ? {} : { authorization: `Bearer ${probeKey}` }),
            },
            body: JSON.stringify({
              model: probeModelOf(provider, RESPONSES_PROBE_MODEL),
              input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
              // The adapter floor for explicit caps (the API rejects smaller).
              max_output_tokens: 16,
            }),
            signal: AbortSignal.timeout(10000),
          })
        } catch (err) {
          fail('bad-request', `探测端点失败：${errText(err)}`, { issues: [] })
        }
        if (!response.ok) {
          fail('bad-request', `端点返回 ${String(response.status)} ${response.statusText}`, { issues: [] })
        }
        return { models: [] }
      }

      let response: Response
      try {
        response = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
          headers: {
            Accept: 'application/json',
            ...(probeKey === '' ? {} : { Authorization: `Bearer ${probeKey}` }),
            ...(routeHeaders ?? {}),
          },
          signal: AbortSignal.timeout(10000),
        })
      } catch (err) {
        fail('bad-request', `探测端点失败：${errText(err)}`, { issues: [] })
      }
      if (!response.ok) {
        fail('bad-request', `端点返回 ${String(response.status)} ${response.statusText}`, { issues: [] })
      }
      const body = await response.json().catch(() => null) as
        | { data?: Array<{ id?: unknown; name?: unknown }> | null; models?: Array<{ id?: unknown; name?: unknown }> | null }
        | null
      const rows = Array.isArray(body?.data) ? body?.data : Array.isArray(body?.models) ? body?.models : []
      const models = (rows ?? [])
        .map((row) => {
          const id = typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : ''
          return { id, name: typeof row?.name === 'string' && row.name !== '' ? row.name : id }
        })
        .filter(model => model.id !== '')
      if (models.length === 0) fail('bad-request', '端点未返回任何模型', { issues: [] })
      return { models }
    },
  }

  // User-authored plugins (AI-generated via plugin.write, run in the MV3
  // sandbox page). The host lives on the offscreen document and may not be
  // up yet when this table builds, so each entry resolves it lazily.
  Object.assign(METHODS, createUserPluginMethods(() => {
    const host = userPluginHost()
    if (host === undefined) {
      fail('unavailable', '用户插件宿主未就绪（offscreen 引擎启动中）', {})
    }
    return host
  }))

  // ───────────────────────── dispatcher ─────────────────────────

  const handleRpc = (conn: ApiConnection, rpcId: string, method: string, payload: unknown): void => {
    void (async () => {
      const handler = METHODS[method]
      if (handler === undefined) {
        postResult(conn, rpcId, {
          ok: false,
          error: {
            code: UNAVAILABLE_CODE,
            message: `此方法在扩展宿主中不可用：${method}`,
            details: { method },
          },
        })
        return
      }
      try {
        const value = await handler(payload, ctx)
        postResult(conn, rpcId, { ok: true, value })
      } catch (err) {
        const error: ApiRpcError = err instanceof RpcFailure
          ? err.error
          : { code: 'internal', message: errText(err), details: {} }
        postResult(conn, rpcId, { ok: false, error })
      }
    })()
  }

  /**
   * respond: route one ClientResponse by its echoed rpcId into the pending
   * registry; an unmatched id falls through to the interaction channel's
   * body-based correlation (the SidePanel client mints fresh frame rpcIds, so
   * panel responds usually carry an id no responder registered). The receipt
   * rides a rpc.result message whose value is the {@code RpcReceipt} — the
   * port protocol has no dedicated receipt member.
   */
  const handleRespond = (conn: ApiConnection, rpcId: string, result: ApiRpcResult): void => {
    const settle = pendingResponders.get(rpcId)
    if (settle !== undefined) {
      pendingResponders.delete(rpcId)
      try {
        settle(rpcId, result)
        postResult(conn, rpcId, { ok: true, value: { accepted: true } })
      } catch {
        postResult(conn, rpcId, { ok: true, value: { accepted: false, reason: 'bad-response' } })
      }
      return
    }
    const channel = interactionChannelRef
    if (channel !== undefined) {
      try {
        if (channel.routeRespondByValue(rpcId, result)) {
          postResult(conn, rpcId, { ok: true, value: { accepted: true } })
          return
        }
      } catch {
        postResult(conn, rpcId, { ok: true, value: { accepted: false, reason: 'bad-response' } })
        return
      }
    }
    postResult(conn, rpcId, { ok: true, value: { accepted: false, reason: 'not-pending' } })
  }

  // ───────────────────────── streams ─────────────────────────

  /**
   * Open the mux stream on one connection: `session/subscribed` baseline per
   * attached session, optional `since` delta replay from persistence, then
   * live session/event + new-session forwarding.
   */
  const openMux = (conn: ApiConnection, payload: MuxOpenPayload | undefined): void => {
    const disposers = armStream(conn, 'mux')
    for (const session of ctx.sessions.list()) {
      postFrame(conn, 'mux', { type: 'session/subscribed', sessionId: session.id, lastSeq: session.seq - 1 })
    }
    // History sync: replay the durable delta above each supplied watermark.
    const since = payload?.since
    if (since !== undefined && typeof since === 'object') {
      void (async () => {
        for (const [rawId, lastSeq] of Object.entries(since)) {
          if (typeof lastSeq !== 'number' || !Number.isFinite(lastSeq)) continue
          const sessionId = SessionId(rawId)
          try {
            const live = ctx.sessions.get(sessionId)
            const events = live !== undefined
              ? live.snapshotEvents().filter(event => event.seq > lastSeq)
              : await readPersistedEvents(sessionId, Math.max(0, Math.floor(lastSeq) + 1))
            for (const event of events) {
              postFrame(conn, 'mux', { type: 'session/event', sessionId, event })
            }
          } catch (err) {
            // Unknown session or unreadable artifact: skip (the client's
            // reconnect path refetches history).
            warn(`api-bridge：mux 回放 ${rawId} 失败：`, errText(err))
          }
        }
      })()
    }
    disposers.push(
      ctx.on('session/event', (session, event) => {
        postFrame(conn, 'mux', { type: 'session/event', sessionId: session.id, event })
      }),
      ctx.on('session/created', (session) => {
        postFrame(conn, 'mux', { type: 'session/subscribed', sessionId: session.id, lastSeq: session.seq - 1 })
      }),
    )
  }

  /**
   * Open the host stream on one connection: the fixed single-workspace
   * baseline frame once, then lifecycle/status forwarding.
   */
  const openHost = (conn: ApiConnection): void => {
    const disposers = armStream(conn, 'host')
    void (async () => {
      try {
        postFrame(conn, 'host', { type: 'host/workspace-changed', workspace: await fixedWorkspaceView() })
        // Replay every already-existing session as a session-added frame —
        // sessions created during engine boot (before any SidePanel
        // connected) fired session/created into the void; the client's
        // session manager populates its summaries ONLY from these frames,
        // so without the replay the composer stays readOnly (no current
        // session selectable).
        for (const agent of ctx.agents.list()) {
          const events = agent.session.snapshotEvents()
          postFrame(conn, 'host', {
            type: 'host/session-added',
            sessionId: agent.id,
            blank: !events.some(event => event.type === 'turn/start'),
          })
        }
      } catch (err) {
        warn('api-bridge：host 流初始化帧失败：', errText(err))
      }
    })()
    disposers.push(
      ctx.on('session/created', (session) => {
        postFrame(conn, 'host', {
          type: 'host/session-added',
          sessionId: session.id,
          blank: !session.snapshotEvents().some(event => event.type === 'turn/start'),
        })
      }),
      ctx.on('session/disposed', (session) => {
        postFrame(conn, 'host', { type: 'host/session-removed', sessionId: session.id })
      }),
      ctx.on('agent/status', ({ agent, status }) => {
        postFrame(conn, 'host', { type: 'host/session-status', sessionId: agent.id, running: status === 'running' })
      }),
      ctx.on('agent/error', ({ agent, error }) => {
        postFrame(conn, 'host', { type: 'host/agent-error', sessionId: agent.id, message: errText(error) })
      }),
    )
  }

  // ───────────────────────── Port management ─────────────────────────

  const handleUpMessage = (conn: ApiConnection, message: unknown): void => {
    if (typeof message !== 'object' || message === null) return
    const m = message as { k?: unknown }
    switch (m.k) {
      case 'rpc': {
        const { rpcId, method, payload } = m as unknown as {
          rpcId?: unknown
          method?: unknown
          payload?: unknown
        }
        if (typeof rpcId !== 'string' || typeof method !== 'string') return
        handleRpc(conn, rpcId, method, payload)
        return
      }
      case 'respond': {
        const { rpcId, result } = m as unknown as { rpcId?: unknown; result?: unknown }
        if (typeof rpcId !== 'string' || typeof result !== 'object' || result === null) return
        const typed = result as { ok?: unknown }
        if (typed.ok === true) {
          handleRespond(conn, rpcId, { ok: true, value: (result as { value?: unknown }).value })
        } else {
          const error = (result as { error?: unknown }).error
          handleRespond(conn, rpcId, {
            ok: false,
            error: typeof error === 'object' && error !== null
              ? (error as ApiRpcError)
              : { code: 'bad-response', message: 'respond 结果格式非法', details: {} },
          })
        }
        return
      }
      case 'stream.open': {
        const { stream, payload } = m as unknown as { stream?: unknown; payload?: unknown }
        if (stream === 'mux') openMux(conn, payload as MuxOpenPayload | undefined)
        else if (stream === 'host') openHost(conn)
        return
      }
      case 'stream.close': {
        const { stream } = m as unknown as { stream?: unknown }
        if (stream === 'mux' || stream === 'host') closeStream(conn, stream)
        return
      }
      default:
        return
    }
  }

  // Credential invalidations: the chrome credentials service already fans
  // `credentials/updated` out on ctx after every committed set/unset (the
  // settings paths' internal key writes included); forward each one to the
  // ports so pushed refetches converge the SidePanel's credential-dependent
  // surfaces without polling.
  ctx.effect(() => {
    const dispose = ctx.on('credentials/reference-updated', (ref) => {
      broadcastRemoteEvent('credentials/updated', [ref])
    })
    return () => {
      dispose()
    }
  }, 'chrome-api-bridge: credentials fan-out')

  // Projection change feed → session/projection push frames (apiproxy
  // parity): the client's projection stores (todos, goals, titles) update
  // only from these frames, so without them the TodoDock/GoalBar stay empty
  // even though the engine projections carry data. Delivered only to
  // connections with an open mux stream (the client drops unopened-stream
  // frames itself, but the fake test ports do not — keep the wire honest).
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.onChanged((session, key, value, seq) => {
      for (const conn of [...connections]) {
        if (conn.muxDisposers === undefined) continue
        postFrame(conn, 'mux', {
          type: 'session/projection',
          sessionId: session.id,
          key,
          value,
          seq,
        })
      }
    })
  })

  if (isChromeRuntimeAvailable()) {
    ctx.effect(() => {
      const listener = (port: chrome.runtime.Port): void => {
        if (port.name !== API_PORT_NAME) return
        const conn: ApiConnection = { port, muxDisposers: undefined, hostDisposers: undefined }
        connections.add(conn)
        port.onDisconnect.addListener(() => {
          teardownConnection(conn)
        })
        port.onMessage.addListener((message) => {
          handleUpMessage(conn, message)
        })
        post(conn, { k: 'ready' })
      }
      try {
        chrome.runtime.onConnect.addListener(listener)
      } catch (err) {
        warn('api-bridge：注册 API Port 监听失败：', errText(err))
        return () => undefined
      }
      return () => {
        for (const conn of [...connections]) teardownConnection(conn)
        pendingResponders.clear()
        interactionChannelRef = undefined
        try {
          chrome.runtime.onConnect.removeListener(listener)
        } catch {
          // A runtime without removeListener (older mocks) keeps the slot;
          // the listener is name-gated and inert after teardown.
        }
      }
    }, 'chrome-api-bridge: port listener')
  } else {
    warn('api-bridge：chrome.runtime 不可用，未注册 API Port 监听')
  }
}
