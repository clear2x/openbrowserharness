/**
 * Provider-preset registry for the extension host.
 *
 * The official group ships exactly one preset — DeepSeek. Every other
 * endpoint (OpenAI-compatible, Anthropic Messages, Responses, a local Ollama)
 * is a hand-declared route (`./custom-providers.ts`) the user adds through the
 * Models page's 添加供应商 flow. The preset registers as a live `ctx.llm` route
 * plus a configurable directory entry, so the REAL dsh settings/model surfaces
 * list it natively. Its protocol is `openai`: the DeepSeek adapter IS an
 * OpenAI-compatible chat/completions client (`${baseURL}/chat/completions`,
 * Bearer auth). The native Anthropic Messages adapter (`./anthropic-adapter.ts`)
 * serves hand-declared routes that pick the `anthropic` wire protocol.
 *
 * API keys live in the credentials seam under the preset's own ref
 * (`DEEPSEEK_API_KEY`; a declared route derives `<ROUTE>_API_KEY`). A keyless
 * preset rides the `KEYLESS_LOCAL_ENDPOINT` sentinel, and the local Ollama
 * endpoint stays reachable through the exact-URL allowlist in
 * `./custom-providers.ts` (a local service is its legitimate declared
 * endpoint).
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError, MessageId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmConfigurableProvider,
  Message,
  StreamChunk,
  ToolCallBlock,
  ToolResultBlock,
} from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DeepSeekAdapter,
} from '@deepseek-ai/dsh-llm-deepseek/src/adapter.ts'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek/src/index.ts'
import type {
  DeepSeekAdapterOptions,
  DeepSeekCatalogModel,
  DeepSeekConnectionOptions,
} from '@deepseek-ai/dsh-llm-deepseek/src/adapter.ts'
import { AnthropicAdapter } from './anthropic-adapter.ts'
import { storageGet } from './storage-client'
import type { AnthropicCatalogModel } from './anthropic-adapter.ts'
import { ResponsesAdapter } from './responses-adapter.ts'
import { attachmentResolverOf } from './attachment-store.ts'
import { readStorageString } from './settings-store'
import { onStorageChanged } from './storage-client'

/** One advisory catalog entry of a preset. */
export interface PresetModelEntry {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label. */
  name: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Input modalities the preset declares; omission stays the text-only floor. */
  input?: ReadonlyArray<'text' | 'image'>
  /**
   * Reasoning effort ids the model accepts ('off' | 'low' | 'high' | 'max').
   * Anthropic-route presets surface these as catalog reasoning levels and the
   * adapter maps them to wire thinking; openai-route presets are effort-declared
   * by the shared adapter and need no entry.
   */
  reasoningEfforts?: ReadonlyArray<'off' | 'low' | 'high' | 'max'>
}

/** One vendor preset: connection defaults plus the advisory model catalog. */
export interface ProviderPreset {
  /** `ctx.llm` route key (`deepseek`). */
  id: string
  /** Display name in configuration surfaces. */
  label: string
  /** Display name under the settings-surface contract (mirrors `label`). */
  displayName: string
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  defaultModel: string
  models: PresetModelEntry[]
  /** Credential ref holding this provider's API key ('' = keyless). */
  keyEnv: string
  /** Rough context window for resolveModel when the catalog omits one. */
  contextWindow?: number
  /** Anthropic-route auth scheme: `bearer` adds Authorization from the resolved key (gateway compat). */
  authMode?: 'bearer'
  /** Per-request output cap the provider accepts; needed when the gateway rejects the engine default. */
  maxTokens?: number
  hint?: string
}

const CTX_1M = DEFAULT_CONTEXT_WINDOW
const CTX_128K = 128_000
const CTX_200K = 200_000

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    displayName: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    keyEnv: 'DEEPSEEK_API_KEY',
    contextWindow: CTX_1M,
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', input: ['text'] },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', input: ['text'] },
    ],
  },
  {
    id: 'zhipu',
    label: '智谱',
    displayName: '智谱 BigModel',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.3-flash',
    keyEnv: 'ZHIPU_API_KEY',
    contextWindow: CTX_200K,
    models: [
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', input: ['text', 'image'] },
      { id: 'glm-5.3', name: 'GLM-5.3', input: ['text', 'image'] },
      { id: 'glm-5.3v', name: 'GLM-5.3V', input: ['text', 'image'] },
    ],
  },
  {
    // The GLM Coding Plan: a subscription whose key is SEPARATE from the
    // normal platform key (docs.bigmodel.cn/cn/coding-plan/quick-start) and
    // whose endpoints differ per protocol. The Anthropic Messages endpoint is
    // the one Claude Code drives, so the preset rides the anthropic adapter
    // with Bearer auth (the scheme ANTHROPIC_AUTH_TOKEN uses).
    id: 'zhipu-coding',
    label: '智谱 Coding Plan',
    displayName: '智谱 Coding Plan',
    protocol: 'anthropic',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    defaultModel: 'glm-5.3',
    keyEnv: 'ZHIPU_CODING_API_KEY',
    contextWindow: CTX_1M,
    maxTokens: 131_072,
    authMode: 'bearer',
    models: [
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', input: ['text', 'image'], reasoningEfforts: ['off', 'high'] },
      { id: 'glm-5.3', name: 'GLM-5.3', input: ['text', 'image'], reasoningEfforts: ['off', 'high'] },
    ],
  },
]

export const DEFAULT_PROVIDER = 'deepseek'

// ── User-added models on official presets ──
//
// The launch presets carry a fixed catalog, but a provider keeps shipping new
// models between releases. User-added rows live in the generic settings
// namespace below (the same chrome.storage blob the settings face CAS-writes)
// as `{ models: { <presetId>: DraftModel[] } }`, and the adapter catalogs
// merge them at read time: `options()` is a thunk the engine re-invokes per
// request, so a `setPresetUserModels` call applies to the very next request
// with no re-registration.

/** Settings namespace holding user-added models per official preset. */
export const PRESET_MODELS_NS = 'llm-preset-models'

/** The storage-shaped user-model table: preset id → added rows. */
export type PresetUserModels = Record<string, Array<{ id: string; contextWindow?: number; maxTokens?: number; input?: string[] }>>

let presetUserModels: PresetUserModels = {}

/**
 * Install the user-added model table (the bridge calls this after every write
 * to {@link PRESET_MODELS_NS}; boot seeds it once from storage).
 * @param value - the parsed namespace value; anything malformed is ignored.
 */
export function setPresetUserModels(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  const models = (value as Record<string, unknown>).models
  if (models === null || typeof models !== 'object' || Array.isArray(models)) return
  const out: PresetUserModels = {}
  for (const [presetId, rows] of Object.entries(models as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue
    const parsed = rows
      .map(row => (row !== null && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string'
        ? {
          id: (row as { id: string }).id,
          ...typeof (row as { contextWindow?: unknown }).contextWindow === 'number' ? { contextWindow: (row as { contextWindow: number }).contextWindow } : {},
          ...typeof (row as { maxTokens?: unknown }).maxTokens === 'number' ? { maxTokens: (row as { maxTokens: number }).maxTokens } : {},
          ...(Array.isArray((row as { input?: unknown }).input)
              && (row as { input: unknown[] }).input.every(item => item === 'text' || item === 'image')
            ? { input: (row as { input: Array<'text' | 'image'> }).input }
            : {}),
        }
        : undefined))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
    if (parsed.length > 0) out[presetId] = parsed
  }
  presetUserModels = out
}

/** Rows the user added for one preset (storage wire shape). */
export function userModelsOf(presetId: string): PresetUserModels[string] | undefined {
  return presetUserModels[presetId]
}

/**
 * Read the namespace blob once at boot and seed the merge table. The write
 * path keeps it fresh afterwards (the bridge calls the setter), so a one-shot
 * read is enough.
 */
export async function loadPresetUserModels(): Promise<void> {
  try {
    const items = await storageGet(['dsh-api-settings-namespaces'])
    const raw = (items)['dsh-api-settings-namespaces']
    if (raw === null || typeof raw !== 'object') return
    const entry = (raw as Record<string, unknown>)[PRESET_MODELS_NS]
    if (entry === null || typeof entry !== 'object') return
    setPresetUserModels(entry)
  } catch {
    // A storage outage leaves the preset catalogs at their shipped rows — the
    // nicety must never block adapter registration.
  }
}

/** Merge user-added rows into one preset's catalog (preset rows win on id). */
function withUserModels(preset: ProviderPreset, base: PresetModelEntry[]): PresetModelEntry[] {
  const rows = presetUserModels[preset.id]
  if (rows === undefined) return base
  const known = new Set(base.map(entry => entry.id))
  const additions = rows
    .filter(row => !known.has(row.id))
    .map((row): PresetModelEntry => ({
      id: row.id,
      name: row.id,
      ...(Array.isArray(row.input) ? { input: [...row.input] as Array<'text' | 'image'> } : {}),
    }))
  return additions.length === 0 ? base : [...base, ...additions]
}

// ───────────────────────── durable-history repair ─────────────────────────

/** Wire filler for a tool call whose result never landed in the durable log. */
const FAILED_TOOL_RESULT_TEXT = '(Tool execution was interrupted; no result was recorded. This turn already failed — do not retry it automatically.)'

/**
 * Repair model-request history at the wire boundary. A turn that failed while
 * tools were executing leaves an assistant `tool-call` block whose matching
 * `tool-result` never entered the log; serialized verbatim it becomes a
 * `tool_calls` message with no following tool message, which every
 * OpenAI-compatible and Anthropic endpoint rejects — bricking every later
 * turn of that session. Each unanswered call gains a synthetic error result,
 * merged into the next user message when one directly follows (strict
 * gateways reject consecutive user turns). The repair touches only the
 * outgoing request, never the durable log.
 * @param messages - derived history from the session surface.
 * @returns history safe to serialize; a stable shallow copy when intact.
 */
export function repairToolCallHistory(messages: readonly Message[]): Message[] {
  const answered = new Set<string>()
  for (const message of messages) {
    if (message.role === 'user') {
      for (const block of message.content) {
        if (block.type === 'tool-result') answered.add(block.toolCallId)
      }
    }
  }
  let repaired = false
  const out: Message[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message === undefined) continue
    out.push(message)
    if (message.role !== 'assistant') continue
    const unanswered = message.content.filter(
      (block): block is ToolCallBlock => block.type === 'tool-call' && !answered.has(block.id),
    )
    if (unanswered.length === 0) continue
    const fillers: ToolResultBlock[] = unanswered.map(block => ({
      type: 'tool-result',
      toolCallId: block.id,
      content: [{ type: 'text', text: FAILED_TOOL_RESULT_TEXT }],
      isError: true,
    }))
    const next = messages[i + 1]
    if (next !== undefined && next.role === 'user') {
      out.push({ ...next, content: [...fillers, ...next.content] })
      i++
    } else {
      const first = unanswered[0]
      if (first === undefined) continue
      out.push({
        id: MessageId(`repair:${first.id}`),
        role: 'user',
        content: fillers,
        source: { kind: 'tool', callId: first.id },
      })
    }
    repaired = true
  }
  return repaired ? out : [...messages]
}

/** DeepSeekAdapter that repairs derived history before serialization (custom routes reuse it). */
export class RepairingDeepSeekAdapter extends DeepSeekAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* super.stream({ ...options, messages: repairToolCallHistory(options.messages) })
  }
}

/** AnthropicAdapter that repairs derived history before serialization (custom routes reuse it). */
export class RepairingAnthropicAdapter extends AnthropicAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* super.stream({ ...options, messages: repairToolCallHistory(options.messages) })
  }
}

/** ResponsesAdapter that repairs derived history before serialization (custom routes reuse it). */
export class RepairingResponsesAdapter extends ResponsesAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* super.stream({ ...options, messages: repairToolCallHistory(options.messages) })
  }
}

/**
 * DeepSeekAdapter that reports a preset's declared input modalities. The
 * deepseek family's catalog hardcodes the text-only floor, so without this
 * overlay a preset model declaring a wider modality set would resolve as
 * text-only at the seam — the same trick the declared-route adapter in
 * `./custom-providers.ts` uses, reading the static preset instead of a live
 * profile.
 */
class PresetOpenAiAdapter extends RepairingDeepSeekAdapter {
  constructor(
    private readonly preset: ProviderPreset,
    options: DeepSeekAdapterOptions,
  ) {
    super(options)
  }

  override async listModels(provider: string) {
    return (await super.listModels(provider)).map(info => this.withDeclaredInput(info))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return this.withDeclaredInput(await super.resolveModel(provider, model, signal))
  }

  private withDeclaredInput<I extends { id: string; inputModalities?: readonly string[] }>(info: I): I {
    const entry = this.preset.models.find(entry => entry.id === info.id)
    return entry?.input === undefined ? info : { ...info, inputModalities: [...entry.input] }
  }
}

export function presetOf(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(preset => preset.id === id)
}

/** Credential ref for one provider (custom → generic ref). */
export function keyRefOf(preset: ProviderPreset): string {
  return preset.keyEnv === '' ? '' : preset.keyEnv
}

/**
 * The settings namespace the bridge exposes for provider configuration.
 * Mirrors the `llm-deepseek` adapter family's own section name: the Models
 * page keys its official-provider form (credential + endpoint probe) off this
 * namespace, so the preset row renders a real editor instead of an
 * unknown-namespace hint.
 */
export const PROVIDER_SETTINGS_NS = 'llm-deepseek'

/** Directory entries the dsh configuration surfaces consume. */
export function configurableProviderViews(): LlmConfigurableProvider[] {
  return PROVIDER_PRESETS.map(preset => ({
    provider: preset.id,
    displayName: preset.label,
    settingsNs: PROVIDER_SETTINGS_NS,
    settingsPath: [],
  }))
}

/**
 * In-memory API-key cache: per-request resolution reads the cache instead of
 * a storage round-trip; any committed storage change (a key saved/removed
 * through the settings or credentials surfaces) invalidates the whole map.
 */
const apiKeyCache = new Map<string, string>()

/**
 * Per-preset key resolution through the chrome.storage credential refs (cached).
 * Generic form (exported for custom-provider routes): same cache, same rules.
 */
export async function resolveStoredApiKey(owner: string, ref: string): Promise<string> {
  if (ref === '') return '' // keyless endpoint
  const cached = apiKeyCache.get(ref)
  if (cached !== undefined) return cached
  const stored = await readStorageString(ref)
  if (stored.length > 0) {
    const usable = assertUsableApiKey(stored, owner, ref)
    apiKeyCache.set(ref, usable)
    return usable
  }
  throw new LlmError(
    `provider 路由 "${owner}" 没有可用的 API key；请在「设置」中保存 ${ref}`,
    'MISSING_CREDENTIAL',
  )
}

/** Per-preset key resolution through the chrome.storage credential refs (cached). */
async function resolvePresetApiKey(preset: ProviderPreset, ref: string): Promise<string> {
  return resolveStoredApiKey(`chrome-llm:${preset.id}`, ref)
}

/**
 * Register every preset on `ctx.llm` (adapters + configurable directory).
 * The active provider's baseUrl/model come from engine settings; inactive
 * presets ride their catalog defaults.
 */
export type ActiveProviderState = { provider: string; baseUrl: string; model: string }

export function registerExtensionProviders(
  ctx: Context,
  active: () => ActiveProviderState,
): void {
  const liveBase = (preset: ProviderPreset): string => {
    const state = active()
    return preset.id === state.provider && state.baseUrl.trim() !== '' ? state.baseUrl.trim() : preset.baseUrl
  }
  const liveModels = (preset: ProviderPreset) => {
    const state = active()
    const catalog = withUserModels(preset, preset.models)
    return preset.id === state.provider && state.model.trim() !== ''
      ? withActiveModel(preset, state.model.trim())
      : catalog
  }

  for (const preset of PROVIDER_PRESETS) {
    if (preset.protocol === 'anthropic') {
      const catalog = (): AnthropicCatalogModel[] => liveModels(preset).map(model => ({
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        ...(preset.contextWindow === undefined ? {} : { contextWindow: preset.contextWindow }),
        ...(model.input === undefined ? {} : { input: [...model.input] }),
        ...(model.reasoningEfforts === undefined ? {} : { reasoningEfforts: [...model.reasoningEfforts] }),
      }))
      const ref = keyRefOf(preset)
      const adapter = new RepairingAnthropicAdapter({
        options: () => ({
          baseURL: liveBase(preset),
          apiKeyEnv: ref,
          models: catalog(),
          maxTokens: preset.maxTokens ?? DEFAULT_MAX_TOKENS,
          defaultContextWindow: preset.contextWindow ?? CTX_128K,
          streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
          ...(preset.authMode === 'bearer'
            ? { authHeaders: (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` }) }
            : {}),
        }),
        resolveApiKey: connection => resolvePresetApiKey(preset, connection.apiKeyEnv),
        resolveImage: attachmentResolverOf(ctx),
      })
      ctx.llm.registerAdapter([preset.id], adapter)
      continue
    }

    const catalog = (): DeepSeekCatalogModel[] => liveModels(preset).map(model => ({
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      contextWindow: preset.contextWindow ?? CTX_128K,
    }))
    const ref = keyRefOf(preset)
    const adapter = new PresetOpenAiAdapter(preset, {
      options: (): DeepSeekConnectionOptions => resolveAdapterOptions({
        apiKeyEnv: ref === '' ? 'KEYLESS_LOCAL_ENDPOINT' : ref,
        baseURL: liveBase(preset),
        maxTokens: DEFAULT_MAX_TOKENS,
        defaultContextWindow: preset.contextWindow ?? CTX_128K,
        models: catalog(),
        streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      }),
      resolveApiKey: (connection) => {
        const env = connection.apiKeyEnv as unknown as string
        return resolvePresetApiKey(preset, env === 'KEYLESS_LOCAL_ENDPOINT' ? '' : env)
      },
      resolveUserId: () => 'openbrowserharness-extension' as never,
      // The extension host mounts no official-API plugin extensions; every
      // wire request carries only this adapter's own fields.
      prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
    })
    ctx.llm.registerAdapter([preset.id], adapter)
  }

  ctx.llm.registerConfigurableProviders(configurableProviderViews())

  // Key cache invalidation: any committed chrome.storage.local change (keys
  // are written through the credentials surface) drops the cached keys so the
  // next request resolves fresh values.
  onStorageChanged((area) => {
    if (area === 'local') apiKeyCache.clear()
  })
}

/** Ensure the active model leads the advisory catalog without duplicating. */
function withActiveModel(preset: ProviderPreset, model: string): PresetModelEntry[] {
  if (preset.models.some(entry => entry.id === model)) return preset.models
  return [{ id: model, name: model }, ...preset.models]
}
