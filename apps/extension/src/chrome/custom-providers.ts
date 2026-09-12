/**
 * `llm-pi-ai`: hand-declared (custom) provider routes — the extension host's
 * edition of the pi-ai adapter family's user-declared gateways. The dsh
 * Models page's custom-provider card writes profiles into the `llm-pi-ai`
 * settings namespace (`providers.<route>` = `{ displayName?, apiKeyEnv?, api,
 * baseURL, models, headersText? }`); this module owns that namespace's schema
 * envelope, validates each profile, registers it live on `ctx.llm`, and serves
 * the facts the bridge reads (`llm.providers`, model catalog, model selection).
 *
 * Writes persist through the bridge's generic-namespace store (the same
 * `dsh-api-settings-namespaces` blob the onboarding acknowledgement rides),
 * so a profile survives engine restarts; `syncCustomProviders` re-reads that
 * blob after every write to the namespace and at engine boot.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  AdapterRegistrationHandle,
  DirectoryRegistrationHandle,
  LlmConfigurableProvider,
} from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from '@deepseek-ai/dsh-llm-deepseek/src/adapter.ts'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek/src/index.ts'
import type {
  DeepSeekAdapterOptions,
  DeepSeekCatalogModel,
  DeepSeekConnectionOptions,
} from '@deepseek-ai/dsh-llm-deepseek/src/adapter.ts'
import type { AnthropicCatalogModel } from './anthropic-adapter.ts'
import { attachmentResolverOf } from './attachment-store.ts'
import {
  RepairingAnthropicAdapter,
  RepairingDeepSeekAdapter,
  RepairingResponsesAdapter,
  resolveStoredApiKey,
} from './llm-providers.ts'
import type { ResponsesCatalogModel } from './responses-adapter.ts'
import { storageGet } from './storage-client.ts'

/** The settings namespace hand-declared provider profiles live in. */
export const CUSTOM_PROVIDER_NS = 'llm-pi-ai'

/**
 * Wire protocols the host's adapters can serve for a declared route, in the
 * settings-page order (the union the schema serves and the Models page renders
 * both follow this list).
 */
export const CUSTOM_PROTOCOLS = ['anthropic', 'openai', 'openai-responses'] as const

/** One protocol identifier of {@link CUSTOM_PROTOCOLS}. */
export type CustomProtocol = (typeof CUSTOM_PROTOCOLS)[number]

/** Request modalities a declared model may declare (the adapters' full set). */
export const CUSTOM_MODALITIES = ['text', 'image'] as const

/** One modality identifier of {@link CUSTOM_MODALITIES}. */
export type CustomModality = (typeof CUSTOM_MODALITIES)[number]

/** The generic-namespace storage key (kept in sync with api-bridge's store). */
const GENERIC_NS_STORAGE_KEY = 'dsh-api-settings-namespaces'

/** Rough context window for a declared route whose models omit one. */
const CTX_128K = DEFAULT_CONTEXT_WINDOW

/** Route id the settings card accepts (matches CustomProviderCard's pattern). */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * Header names a declared route may not set through `headersText`. The
 * credential is the credential seam's job (API Key → Bearer / x-api-key), and
 * content-type is fixed by both adapters' wire format, so an override here
 * would only quietly break authentication or serialization.
 */
const FORBIDDEN_HEADER_NAMES: ReadonlySet<string> = new Set(['authorization', 'content-type'])

/** Upper bound on usable headers one declared route may carry (anti-abuse). */
export const MAX_CUSTOM_HEADERS = 20

/**
 * RFC 9110 field-name token characters minus whitespace — what a header name
 * may be built from. The explicit no-whitespace test below runs first so the
 * common typo (`Name : value`, `My Header: v`) gets the actionable message.
 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^`|~0-9A-Za-z]+$/

/** One validated profile as the engine serves it. */
interface CustomProfile {
  route: string
  displayName: string
  protocol: CustomProtocol
  baseURL: string
  /** Credential ref the profile names ('' = keyless route). */
  apiKeyEnv: string
  models: Array<{
    id: string
    name: string
    contextWindow?: number
    /** Per-model output cap; omission falls back to the adapter's default. */
    maxTokens?: number
    /** Input modalities the profile declares; omission stays the text-only floor. */
    input?: CustomModality[]
  }>
  /** Parsed request headers this route sends; reserved names already refused at validation. */
  headers?: Record<string, string>
}

/**
 * Outcome of parsing one `headersText` field: the usable headers, or the
 * first line-level failure.
 */
export interface ParsedHeadersText {
  /** Headers to send, or undefined when nothing usable remains. */
  headers?: Record<string, string>
  /**
   * Why the text is unusable, without a route prefix (callers add
   * `provider "<route>"：`). Names the offending line.
   */
  failure?: string
}

/**
 * Parse the single-text-area form of a route's custom headers (`headersText`),
 * one `Header-Name: value` per line. Blank lines and `#` comment lines are
 * ignored; an entry whose value is empty is skipped rather than sent as an
 * empty header; a repeated name keeps its last value. Whitespace around names,
 * values, and lines never reaches the stored record.
 * @param raw - the text exactly as the settings field stores it.
 * @returns the parsed headers, or why the text was refused.
 */
export function parseHeadersText(raw: string): ParsedHeadersText {
  const headers: Record<string, string> = {}
  const lines = raw.split(/\r?\n/)
  for (const [index, line] of lines.map(candidate => candidate.trim()).entries()) {
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator === -1) {
      return { failure: `自定义请求头第 ${index + 1} 行缺少冒号，每行应为 "Header-Name: value"` }
    }
    const name = line.slice(0, separator).trim()
    if (/\s/.test(name)) {
      return { failure: `自定义请求头第 ${index + 1} 行的名称不能包含空格："${name}"` }
    }
    if (!HEADER_NAME_PATTERN.test(name)) {
      return { failure: `自定义请求头第 ${index + 1} 行的名称含有非法字符："${name}"` }
    }
    if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
      return {
        failure: `${name} 不允许在此配置：认证请填写 API Key，勿在此重复配置`,
      }
    }
    const value = line.slice(separator + 1).trim()
    if (value === '') continue
    headers[name] = value
    if (Object.keys(headers).length > MAX_CUSTOM_HEADERS) {
      return { failure: `自定义请求头最多 ${MAX_CUSTOM_HEADERS} 条` }
    }
  }
  return { ...(Object.keys(headers).length === 0 ? {} : { headers }) }
}

/**
 * Custom request headers of a declared route, read live for endpoint probes
 * (`llm.discoverModels`) so an interrogation asks the endpoint the way a real
 * request will. Undefined when the route is not declared or carries none.
 * @param provider - the route id the probe names.
 * @returns the parsed headers, or undefined.
 */
export function declaredRouteHeaders(provider: string): Readonly<Record<string, string>> | undefined {
  return live.get(provider)?.headers
}

/** Facts the bridge serves for one declared route (detached wire view). */
export interface CustomProviderFacts {
  route: string
  displayName: string
}

/** Directory-entry facts the bridge serves through `llm.providers`. */
export function customProviderViews(): LlmConfigurableProvider[] {
  return liveOrder.map(profile => ({
    provider: profile.route,
    displayName: profile.displayName,
    settingsNs: CUSTOM_PROVIDER_NS,
    settingsPath: ['providers', profile.route],
    declared: true,
  }))
}

/** Whether a hostname is one of the loopback aliases the host refuses. */
function isLoopbackHostname(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0'
}

/**
 * Loopback base URL the host legitimately targets: the local Ollama server.
 * The host refuses loopback for user-typed endpoints so a typed profile cannot
 * relay into the local network; this exact base URL stays allowed as a
 * reviewed, deliberate exception — a local Ollama is a legitimate declared
 * endpoint (the preset registry no longer ships an Ollama preset, but adding
 * one through the Models page remains a supported setup). The set holds exact
 * normalized URLs only — any other loopback or private address stays refused.
 */
const OFFICIAL_LOOPBACK_BASES: ReadonlySet<string> = new Set(['http://localhost:11434/v1'])

/**
 * Reject a URL a declared route (or a model probe) may not target. The
 * extension host only speaks plain HTTP(S) to public endpoints: loopback,
 * link-local, private, and reserved ranges are refused so a typed profile
 * cannot turn the host into a request relay into the local network. The sole
 * exception is the exact local Ollama base URL
 * ({@link OFFICIAL_LOOPBACK_BASES}) — a deliberate allowlist entry for a
 * legitimate local service, not a typed relay target.
 * @param raw - the baseURL as the profile stores it.
 * @returns the failure message, or undefined when the URL is acceptable.
 */
export function publicHttpUrlFailure(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'Base URL 不是合法的绝对地址'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Base URL 仅支持 http/https'
  }
  if (OFFICIAL_LOOPBACK_BASES.has(url.href.replace(/\/+$/, ''))) return undefined
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (isLoopbackHostname(host)) {
    return 'Base URL 不能指向本机（localhost/环回地址）'
  }
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its embedded v4 address.
  const v4 = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(v4)) {
    const [a, b] = v4.split('.').map(Number) as [number, number]
    if (a === 127 || a === 10 || a === 0 || a >= 224) return 'Base URL 不能指向环回/私有/保留地址'
    if (a === 172 && b >= 16 && b <= 31) return 'Base URL 不能指向私有地址'
    if (a === 192 && b === 168) return 'Base URL 不能指向私有地址'
    if (a === 169 && b === 254) return 'Base URL 不能指向链路本地地址'
  }
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return 'Base URL 不能指向私有/链路本地地址'
  }
  return undefined
}

/**
 * Validate one profile the settings card drafted, failing on the first field
 * the engine cannot serve — at the write, so the message names the field
 * while the user is still looking at it.
 * @param route - the route id being declared.
 * @param value - the raw profile object from the settings write.
 * @returns the failure message, or undefined when the profile is servable.
 */
export function customProfileFailure(route: string, value: unknown): string | undefined {
  if (!ROUTE_PATTERN.test(route)) return '路由 id 必须是小写字母开头的小写字母/数字/连字符串（如 acme-gateway）'
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `provider "${route}" 的配置必须是对象`
  }
  const profile = value as Record<string, unknown>
  const protocol = profile.api
  if (!(CUSTOM_PROTOCOLS as readonly string[]).includes(protocol as string)) {
    return `provider "${route}" 的 api 必须是 ${CUSTOM_PROTOCOLS.join(' / ')} 之一`
  }
  const baseURL = profile.baseURL
  if (typeof baseURL !== 'string' || baseURL.length === 0) {
    return `provider "${route}" 缺少 baseURL`
  }
  const urlFailure = publicHttpUrlFailure(baseURL)
  if (urlFailure !== undefined) return `provider "${route}"：${urlFailure}`
  if (!Array.isArray(profile.models) || profile.models.length === 0) {
    return `provider "${route}" 至少需要一个模型`
  }
  for (const model of profile.models) {
    const id = (model as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || id.length === 0) {
      return `provider "${route}" 的模型列表包含缺少 id 的条目`
    }
    const entry = model as { maxTokens?: unknown; input?: unknown }
    if (entry.maxTokens !== undefined
      && (typeof entry.maxTokens !== 'number' || !Number.isInteger(entry.maxTokens) || entry.maxTokens <= 0)) {
      return `provider "${route}" 的模型 "${id}" 的 maxTokens 必须是正整数`
    }
    if (entry.input !== undefined
      && (!Array.isArray(entry.input)
        || entry.input.length === 0
        || !entry.input.every(modality => (CUSTOM_MODALITIES as readonly unknown[]).includes(modality)))) {
      return `provider "${route}" 的模型 "${id}" 的 input 只能由 ${CUSTOM_MODALITIES.map(modality => `"${modality}"`).join(' / ')} 组成`
    }
  }
  const apiKeyEnv = profile.apiKeyEnv
  if (apiKeyEnv !== undefined && typeof apiKeyEnv !== 'string') {
    return `provider "${route}" 的 apiKeyEnv 必须是字符串`
  }
  if (profile.headersText !== undefined) {
    if (typeof profile.headersText !== 'string') {
      return `provider "${route}" 的 headersText 必须是字符串`
    }
    const headerFailure = parseHeadersText(profile.headersText).failure
    if (headerFailure !== undefined) return `provider "${route}"：${headerFailure}`
  }
  return undefined
}

// ───────────────────────── live registry state ─────────────────────────

/**
 * Profiles the engine currently serves, in storage order. The adapter
 * options thunks read this map live, so a profile edit (baseURL, models)
 * applies to the next request without re-registration.
 */
const live = new Map<string, CustomProfile>()
/**
 * Read a route's current profile for an adapter callback. The map is written
 * before any adapter for the route exists and an entry disappears only with
 * its adapter's disposer, so a missing entry here is an owner bug — fail loud.
 */
function liveProfile(route: string): CustomProfile {
  const profile = live.get(route)
  if (profile === undefined) throw new Error(`declared route "${route}" has no live profile`)
  return profile
}

/**
 * Catalog projection shared by the anthropic and responses routes: both wire
 * families take the same optional-field model shape, each typed at its own
 * wire boundary.
 */
function toOptionalFields(model: CustomProfile['models'][number]): {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  input?: CustomModality[]
} {
  return {
    id: model.id,
    name: model.name,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.input === undefined ? {} : { input: [...model.input] }),
  }
}
/** Storage order of `live` (the directory and catalog render in it). */
let liveOrder: CustomProfile[] = []
/** One adapter registration per declared route. */
const registered = new Map<string, AdapterRegistrationHandle>()
/** The single configurable-directory registration for all declared routes. */
let directory: DirectoryRegistrationHandle | undefined

function normalizeProfile(route: string, raw: Record<string, unknown>): CustomProfile | undefined {
  if (customProfileFailure(route, raw) !== undefined) return undefined
  const protocol = raw.api as CustomProtocol
  const models: CustomProfile['models'] = []
  for (const entry of raw.models as Array<Record<string, unknown>>) {
    const id = String(entry.id)
    const contextWindow = typeof entry.contextWindow === 'number' && entry.contextWindow > 0
      ? entry.contextWindow
      : undefined
    const maxTokens = typeof entry.maxTokens === 'number' && Number.isInteger(entry.maxTokens) && entry.maxTokens > 0
      ? entry.maxTokens
      : undefined
    const input = Array.isArray(entry.input) && entry.input.length > 0
      ? entry.input.filter(modality => modality === 'text' || modality === 'image')
      : undefined
    models.push({
      id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(input === undefined || input.length === 0 ? {} : { input: [...input] }),
    })
  }
  // Validation already ran, so the second parse cannot fail; it still runs
  // here because the stored text, not the parsed record, is what persists.
  const headers = parseHeadersText(typeof raw.headersText === 'string' ? raw.headersText : '').headers
  return {
    route,
    displayName: typeof raw.displayName === 'string' && raw.displayName !== '' ? raw.displayName : route,
    protocol,
    baseURL: String(raw.baseURL),
    apiKeyEnv: typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv : '',
    models,
    ...(headers === undefined ? {} : { headers }),
  }
}

/**
 * Read the declared-route table out of the generic-namespace storage blob
 * (the same store `settings.mutate` on `llm-pi-ai` persists through).
 */
export async function readDeclaredProfiles(): Promise<Record<string, unknown>> {
  try {
    const items = await storageGet([GENERIC_NS_STORAGE_KEY])
    const raw = items[GENERIC_NS_STORAGE_KEY] as
      | Record<string, { revision?: unknown; value?: Record<string, unknown> }>
      | undefined
    const ns = raw?.[CUSTOM_PROVIDER_NS]
    const providers = ns?.value?.providers
    if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return {}
    return providers as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * The DeepSeek-family adapter serving a declared `openai` route. The stock
 * catalog already carries the per-model output cap; this subclass adds the one
 * fact the family hardcodes — the declared route's input modalities replace the
 * text-only report, INTERSECTED with what this host can actually serialize.
 * The chat-completions serializer in `dsh-llm-deepseek` is text-only, so an
 * `image` in a declared profile's input must not reach the seam as a
 * capability: admitting one would let the prompt persist and then fail
 * mid-turn on every later replay. The wire part lands with the extension's
 * chat-completions image serialization (phase 2); until then the modality
 * reports honestly as text-only and the bridge refuses image prompts at
 * admission (`MODEL_DOES_NOT_SUPPORT_IMAGES`).
 */
class DeclaredOpenAiAdapter extends RepairingDeepSeekAdapter {
  readonly #route: string

  constructor(route: string, options: DeepSeekAdapterOptions) {
    super(options)
    this.#route = route
  }

  override async listModels(provider: string) {
    return (await super.listModels(provider)).map(info => this.withDeclaredInput(info))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return this.withDeclaredInput(await super.resolveModel(provider, model, signal))
  }

  private withDeclaredInput<I extends { id: string; inputModalities?: readonly string[] }>(info: I): I {
    const entry = live.get(this.#route)?.models.find(model => model.id === info.id)
    if (entry?.input === undefined) return info
    // The family adapter serializes text only in this host: the declared
    // image modality is dropped, not reported.
    const serializable = entry.input.filter(modality => modality !== 'image')
    return { ...info, inputModalities: serializable }
  }
}

function registerProfile(ctx: Context, profile: CustomProfile): void {
  live.set(profile.route, profile)
  const owner = `chrome-llm:${profile.route}`
  if (profile.protocol === 'anthropic') {
    const catalog = (): AnthropicCatalogModel[] => liveProfile(profile.route).models.map(toOptionalFields)
    const ref = profile.apiKeyEnv
    const adapter = new RepairingAnthropicAdapter({
      options: () => {
        const current = liveProfile(profile.route)
        return {
          baseURL: current.baseURL,
          apiKeyEnv: ref,
          models: catalog(),
          maxTokens: DEFAULT_MAX_TOKENS,
          defaultContextWindow: CTX_128K,
          streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
          ...current.headers === undefined ? {} : { headers: current.headers },
        }
      },
      resolveApiKey: connection => resolveStoredApiKey(owner, connection.apiKeyEnv),
      resolveImage: attachmentResolverOf(ctx),
    })
    registered.set(profile.route, ctx.llm.registerAdapter([profile.route], adapter))
    return
  }
  if (profile.protocol === 'openai-responses') {
    const catalog = (): ResponsesCatalogModel[] => liveProfile(profile.route).models.map(toOptionalFields)
    const ref = profile.apiKeyEnv
    const adapter = new RepairingResponsesAdapter({
      options: () => {
        const current = liveProfile(profile.route)
        return {
          baseURL: current.baseURL,
          apiKeyEnv: ref,
          models: catalog(),
          maxTokens: DEFAULT_MAX_TOKENS,
          defaultContextWindow: CTX_128K,
          streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
          ...current.headers === undefined ? {} : { headers: current.headers },
        }
      },
      resolveApiKey: connection => resolveStoredApiKey(owner, connection.apiKeyEnv),
      resolveImage: attachmentResolverOf(ctx),
    })
    registered.set(profile.route, ctx.llm.registerAdapter([profile.route], adapter))
    return
  }
  const catalog = (): DeepSeekCatalogModel[] => {
    const p = liveProfile(profile.route)
    return p.models.map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow ?? CTX_128K,
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    }))
  }
  const ref = profile.apiKeyEnv
  const adapter = new DeclaredOpenAiAdapter(profile.route, {
    options: (): DeepSeekConnectionOptions => {
      const current = liveProfile(profile.route)
      return {
        ...resolveAdapterOptions({
          apiKeyEnv: ref === '' ? 'KEYLESS_DECLARED_ROUTE' : ref,
          baseURL: current.baseURL,
          maxTokens: DEFAULT_MAX_TOKENS,
          defaultContextWindow: CTX_128K,
          models: catalog(),
          streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        }),
        ...(current.headers === undefined ? {} : { headers: current.headers }),
      }
    },
    resolveApiKey: (connection) => {
      const env = connection.apiKeyEnv as unknown as string
      return resolveStoredApiKey(owner, env === 'KEYLESS_DECLARED_ROUTE' ? '' : env)
    },
    resolveUserId: () => 'openbrowserharness-extension' as never,
    // The extension host mounts no official-API plugin extensions; every wire
    // request carries only this adapter's own fields.
    prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
  })
  registered.set(profile.route, ctx.llm.registerAdapter([profile.route], adapter))
}

/**
 * Re-read the declared-route table and make the registry match it: register
 * new routes, drop removed ones (edits apply through the live profile map),
 * and swap the configurable-directory registration. Invalid stored profiles
 * are skipped, not fatal — a hand-edited blob must not take the engine down.
 * @param ctx - the engine context (`ctx.llm` registry).
 * @returns the sync outcome for logging.
 */
export async function syncCustomProviders(ctx: Context): Promise<void> {
  const declared = await readDeclaredProfiles()
  const next: CustomProfile[] = []
  for (const [route, raw] of Object.entries(declared)) {
    const profile = raw === null || typeof raw !== 'object' ? undefined : normalizeProfile(route, raw as Record<string, unknown>)
    if (profile === undefined) {
      console.warn(`[custom-providers] 跳过无效的已声明路由 ${route}`)
      continue
    }
    next.push(profile)
  }
  const keep = new Set(next.map(profile => profile.route))
  for (const [route, handle] of registered) {
    if (keep.has(route)) continue
    handle()
    registered.delete(route)
    live.delete(route)
  }
  for (const profile of next) {
    if (registered.has(profile.route)) {
      live.set(profile.route, profile)
      continue
    }
    registerProfile(ctx, profile)
  }
  liveOrder = next
  const views = customProviderViews()
  if (directory === undefined) {
    if (views.length > 0) directory = ctx.llm.registerConfigurableProviders(views)
    return
  }
  if (views.length === 0) {
    directory()
    directory = undefined
    return
  }
  directory.replace(views)
}

/**
 * The `llm-pi-ai` namespace's serialized schema envelope. The dsh Models page
 * reads the wire-protocol union at `providers.<any-route>.api` to enable the
 * custom-provider entry point, and the editor walks the same nodes for the
 * per-route form.
 */
export const CUSTOM_PROVIDER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  dict: {
    providers: {
      type: 'dict',
      inner: {
        type: 'object',
        dict: {
          displayName: { type: 'string', meta: { description: '显示名称' } },
          apiKeyEnv: { type: 'string', meta: { role: 'credential-ref', description: 'API Key 引用名' } },
          api: {
            type: 'union',
            meta: { description: '接口协议' },
            list: [
              { type: 'const', value: 'anthropic', meta: { required: true } },
              { type: 'const', value: 'openai', meta: { required: true } },
              { type: 'const', value: 'openai-responses', meta: { required: true } },
            ],
          },
          baseURL: { type: 'string', meta: { description: 'API Base URL' } },
          headersText: {
            type: 'string',
            meta: {
              // schemastery's renderer-role slot (the same one `apiKeyEnv`'s
              // 'credential-ref' uses): surfaces that know the role render a
              // multi-line control; everything else degrades to a plain input.
              role: 'textarea',
              extra: {
                rows: 4,
                placeholder: 'X-Custom-Header: value\nX-Trace-Id: abc123',
              },
              description: '自定义请求头（可选；每行一条 "Header-Name: value"，# 开头为注释，最多 20 条）',
            },
          },
          models: {
            type: 'array',
            inner: {
              type: 'object',
              dict: {
                id: { type: 'string', meta: { required: true } },
                name: { type: 'string', meta: {} },
                contextWindow: { type: 'number', meta: { step: 1, min: 1 } },
                maxTokens: { type: 'number', meta: { step: 1, min: 1 } },
                input: {
                  type: 'array',
                  meta: { description: '输入模态' },
                  inner: {
                    type: 'union',
                    list: [
                      { type: 'const', value: 'text', meta: {} },
                      { type: 'const', value: 'image', meta: {} },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
  },
}

/**
 * Whether a provider route is one the user declared (registered through this
 * module) — the bridge's model-selection gate accepts presets plus these.
 */
export function isDeclaredRoute(provider: string): boolean {
  return live.has(provider)
}

/** First model id of a declared route, for the agent's model fallback. */
export function declaredRouteDefaultModel(provider: string): string | undefined {
  return live.get(provider)?.models[0]?.id
}
