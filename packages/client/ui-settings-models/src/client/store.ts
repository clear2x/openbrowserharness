/**
 * Models settings page store: one snapshot joining the configurable-provider
 * directory (`llm.providers`), the settings namespaces (`settings.describe`),
 * and the referenced credentials (`credentials.describe`). The host stays the
 * single fact source — every mutation writes through the wire and the page
 * re-renders from the next describe, pushed or refetched.
 */

import type { ConfigurableProviderView } from '@deepseek-ai/dsh-host-apiproxy/api/llm'
import type { CredentialView } from '@deepseek-ai/dsh-host-apiproxy/api/credentials'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-host-apiproxy/api/settings'
import type { LlmProviderInfo } from '@deepseek-ai/dsh-llm/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { getPath, hasPath, nodeAtPath, rehydrateSchema } from './path.ts'

/**
 * Any route key walks a dict schema to the same profile node, so the lookup
 * names one that cannot collide with a configured route.
 */
const PROBE_ROUTE = '\u0000probe'

/** One provider row after joining the configurable directory with live routes. */
export interface ProviderDirectoryEntry {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly active: boolean
  readonly declared?: boolean
  readonly error?: string
}

/**
 * Join declared configurable providers with the currently registered routes.
 * @param registered - live provider routes in registration order.
 * @param directory - declared configurable providers in declaration order.
 * @returns declared rows followed by live routes with no declaration.
 */
export function joinProviderDirectory(
  registered: readonly LlmProviderInfo[],
  directory: readonly ConfigurableProviderView[],
): ProviderDirectoryEntry[] {
  const active = new Set(registered.map(provider => provider.id))
  const declared = new Set(directory.map(entry => entry.provider))
  const rows: ProviderDirectoryEntry[] = directory.map(entry => ({
    provider: entry.provider,
    displayName: entry.displayName,
    settingsNs: entry.settingsNs,
    settingsPath: [...entry.settingsPath],
    active: active.has(entry.provider),
    ...entry.declared === undefined ? {} : { declared: entry.declared },
  }))
  for (const provider of registered) {
    if (declared.has(provider.id)) continue
    rows.push({
      provider: provider.id,
      displayName: provider.name,
      settingsNs: '',
      settingsPath: [],
      active: true,
    })
  }
  return rows
}

/**
 * The extension host's official-preset directory entries carry the preset's
 * connection facts (credential reference, endpoint, wire protocol, default
 * model) beyond the directory contract, which names only the settings address.
 * A host whose directory omits them degrades to the engine-settings base
 * layer, whose facts describe the ACTIVE provider alone.
 */
export interface OfficialProviderEntry extends ConfigurableProviderView {
  /** Credential reference the preset's key stores under. */
  keyEnv?: string
  /** The preset's own endpoint (the engine override applies only to the active one). */
  baseURL?: string
  /** Wire protocol the preset's endpoint speaks. */
  api?: string
  /** The preset's default model id. */
  defaultModel?: string
}

/** One provider row the page renders. */
export interface ProviderRow {
  /** The directory entry (route id, display name, settings address, live state). */
  entry: ConfigurableProviderView
  /** Whether any layer configures this provider (its profile resolves). */
  configured: boolean
  /** Whether the user layer alone carries the profile (removal restores the base). */
  removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  apiKeyEnv: string | undefined
  /** Credential state for {@link apiKeyEnv}, once described. */
  credential: CredentialView | undefined
}

/** Page snapshot. */
export interface ModelsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  /** Credential enrichment failure; provider/settings rows remain usable. */
  credentialError: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Every configurable provider joined with its configured/credential state. */
  rows: readonly ProviderRow[]
  /** Namespace views by ns, for the editor's schema/layers/secrets. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
}

/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the page still has
 * to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Derive the conventional credential reference for a provider route: the v1
 * page never asks for an environment-variable name, so a typed key stores
 * under this derived reference and the profile records it as `apiKeyEnv`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * The wire protocols a hand-declared route may name, read out of the owning
 * namespace's own schema. This stays a schema read rather than a wire field so
 * the choices the page offers cannot drift from the ones the adapter accepts:
 * both come from the same `Config`.
 * @param namespace - the namespace view whose schema declares the profile shape.
 * @returns the protocol identifiers, or an empty list when the schema has none.
 */
export function protocolChoices(namespace: SettingsNamespaceView | undefined): string[] {
  if (namespace === undefined) return []
  const node = nodeAtPath(rehydrateSchema(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = (node as { type?: string; list?: readonly { value?: unknown }[] } | undefined)
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function apiKeyEnvOf(namespace: SettingsNamespaceView | undefined, path: readonly string[]): string | undefined {
  if (namespace === undefined) return undefined
  const profile = getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/**
 * The credential reference a whole-section route keys through: its namespace's
 * base layer names it (the section itself has no per-route identity to carry
 * one), so the rail can address the stored key the same way a declared route's
 * profile does.
 */
function baseKeyRefOf(namespace: SettingsNamespaceView | undefined): string | undefined {
  if (namespace === undefined) return undefined
  const ref = getPath(namespace.base, ['apiKeyEnv'])
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/**
 * The redacted configured-fact at one secret path, as a placeholder credential
 * view. A whole-section route's key state arrives only through the namespace's
 * secret envelope (the value layer is redacted); the batched credential
 * describe below refines it with source and writability.
 */
function secretViewAt(namespace: SettingsNamespaceView, path: readonly string[]): CredentialView {
  const slot = namespace.secrets.find(secret =>
    secret.path.length === path.length && secret.path.every((key, at) => key === path[at]))
  return { configured: slot?.set === true, writable: true }
}

/** The models settings page controller (one per settings surface). */
export class ModelsSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle', error: null, credentialError: null, writable: false, rows: [], namespaces: new Map(),
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param api - the wire face (settings/credentials/llm domains).
   */
  constructor(private readonly api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>) {}

  /**
   * Refresh the whole page snapshot: directory and namespaces in parallel,
   * then one batched credential describe over every referenced ref. A
   * failure keeps the last good rows and surfaces the error.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let providers: ConfigurableProviderView[]
    let writable: boolean
    let views: SettingsNamespaceView[]
    try {
      const [providersResponse, settingsResponse] = await Promise.all([
        this.api.llm.providers({}),
        this.api.settings.describe({}),
      ])
      if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
      if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
      providers = providersResponse.result.value.providers
      writable = settingsResponse.result.value.writable
      views = settingsResponse.result.value.namespaces
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = error instanceof Error ? error.message : String(error)
      })
      return
    }
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const rows: ProviderRow[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && hasPath(namespace.user, entry.settingsPath)
        && !hasPath(namespace.base, entry.settingsPath)
      // A whole-section route keys through its base layer and reports the key
      // state through the secret envelope; the describe pass below refines it.
      // The official preset names its own reference on the directory entry, so
      // the rail row addresses its own key — the base layer's reference
      // belongs to the ACTIVE provider alone and only stands in for a host
      // whose entry omits `keyEnv`.
      const wholeSection = entry.settingsPath.length === 0
      const official = wholeSection ? entry as OfficialProviderEntry : undefined
      const baseRef = baseKeyRefOf(namespace)
      const apiKeyEnv = wholeSection
        ? official?.keyEnv !== undefined ? official.keyEnv : baseRef
        : apiKeyEnvOf(namespace, entry.settingsPath)
      // The secret envelope describes the ACTIVE provider's key, so only the
      // row that owns that reference may read it; every other whole-section
      // row waits for the credential describe below.
      const credential = wholeSection && namespace !== undefined
        && apiKeyEnv !== undefined && apiKeyEnv === baseRef
        ? secretViewAt(namespace, ['apiKeyEnv'])
        : undefined
      return {
        entry,
        configured,
        removable,
        apiKeyEnv,
        credential,
      }
    })
    const refs = [...new Set(rows.flatMap(row => row.apiKeyEnv === undefined ? [] : [row.apiKeyEnv]))]
    let credentials: Record<string, CredentialView> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      try {
        const response = await this.api.credentials.describe({ refs })
        // Credential state is an enrichment for the Models page: neither a
        // business rejection nor a transport failure fails the load. The
        // onboarding projection below retains the failure distinction.
        if (response.result.ok) credentials = response.result.value.credentials
        else credentialError = response.result.error.message
      } catch (error) {
        credentialError = messageOf(error)
      }
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.credentialError = credentialError
      s.writable = writable
      s.rows = rows.map(row => ({
        ...row,
        ...row.apiKeyEnv !== undefined && credentials[row.apiKeyEnv] !== undefined
          ? { credential: credentials[row.apiKeyEnv] }
          : {},
      }))
      s.namespaces = namespaces
    })
  }
}

/**
 * Whether a joined row can serve model requests as it stands: the route is
 * registered with the adapter registry, and whatever credential its resolved
 * profile names is stored. A profile naming no reference authenticates through
 * the provider's own path (the Bedrock chain, Vertex ADC, a gateway that needs
 * nothing), as does a live route with no settings address at all, so neither
 * owes this page a key. The rail's status dot is green exactly for this.
 * @param row - one joined provider row.
 * @returns whether the user already has this provider to talk to.
 */
export function providerUsable(row: ProviderRow): boolean {
  if (!row.entry.active) return false
  if (row.apiKeyEnv === undefined) return true
  return row.credential?.configured === true
}

/**
 * The default model id of one provider row: the preset's default model for an
 * official row (the directory entry names each preset's own default; a host
 * whose entries omit it falls back to the engine-settings base layer, whose
 * model is the ACTIVE preset's), or the first stored model of a declared
 * route. A row with neither shows no caption.
 * @param namespaces - the loaded namespace views by ns.
 * @param row - one provider row.
 * @returns the default model id, or undefined when the join cannot name one.
 */
export function defaultModelOf(
  namespaces: ReadonlyMap<string, SettingsNamespaceView>,
  row: ProviderRow,
): string | undefined {
  if (row.entry.settingsNs === 'llm-deepseek') {
    const official = row.entry as OfficialProviderEntry
    if (official.defaultModel !== undefined && official.defaultModel.length > 0) return official.defaultModel
    const base = namespaces.get('llm-deepseek')?.base
    if (typeof base === 'object' && base !== null) {
      const model = (base as { model?: unknown }).model
      if (typeof model === 'string' && model.length > 0) return model
    }
    return undefined
  }
  const profile = getPath(namespaces.get(row.entry.settingsNs)?.value, row.entry.settingsPath)
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return undefined
  const stored = (profile as { models?: unknown }).models
  if (!Array.isArray(stored) || stored.length === 0) return undefined
  const first = stored[0]
  if (typeof first !== 'object' || first === null) return undefined
  const id = (first as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * The minimal path ops carrying `after` over `before`, both as the page sees
 * them. Only fields a panel observed are named; fields absent from both sides
 * produce no op, which is why route edits are path-addressed rather than a
 * rebuilt section.
 * @param base - path of the edited subtree inside the user section.
 * @param before - the subtree as loaded, or undefined when it is new.
 * @param after - the subtree as edited.
 * @returns ordered set/unset ops; empty when nothing changed.
 */
export function pathOps(
  base: readonly string[],
  before: unknown,
  after: Record<string, unknown>,
): SettingsPathOpView[] {
  const previous = typeof before === 'object' && before !== null && !Array.isArray(before)
    ? before as Record<string, unknown>
    : {}
  const ops: SettingsPathOpView[] = []
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(previous[key]) === JSON.stringify(value)) continue
    ops.push({ op: 'set', path: [...base, key], value })
  }
  for (const key of Object.keys(previous)) {
    if (!(key in after)) ops.push({ op: 'unset', path: [...base, key] })
  }
  return ops
}
