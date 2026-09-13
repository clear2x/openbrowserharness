/**
 * Shared chrome.storage.local settings store for the engine host.
 *
 * Layout:
 * - credential keys (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, …) — one API key
 *   per provider, owned by the credentials seam;
 * - `dsh-engine-settings` — `{ provider?, profiles? }`: the ACTIVE provider
 *   route plus a per-provider profile map `{ [id]: { baseUrl?, model? } }`.
 *   Each provider's baseUrl/model are cached SEPARATELY, so switching routes
 *   and switching back never loses what was typed for the other provider
 *   (the single-field layout migrated on first read).
 *
 * Reads are cached in memory and refreshed by a storage.onChanged listener so
 * the LLM adapter's synchronous per-operation options thunk always sees the
 * latest committed values without awaiting storage on the request path.
 */

import type { EngineSettings } from '../shared/protocol'
import { onStorageChanged, storageGet, storageRemove, storageSet } from './storage-client'

const SETTINGS_KEY = 'dsh-engine-settings'
const API_KEY_STORAGE_KEY = 'DEEPSEEK_API_KEY'

export const DEFAULT_MODEL = 'deepseek-v4-flash'
export const DEFAULT_PROVIDER = 'deepseek'

/**
 * Validate one persisted active-provider route against the adapter universe
 * (preset ids + declared custom routes) before the engine composes. A route
 * whose custom profile was deleted would otherwise strand every request with
 * `NO_ADAPTER` until a manual model switch — the fallback rewrites it to the
 * stock provider so a stale pointer self-heals across restarts.
 * @param persisted - the raw stored `provider` value (absent = stock default).
 * @param presetIds - every preset route that always has an adapter.
 * @param declaredRoutes - every custom route currently declared in storage.
 * @returns the provider to compose with, and whether a stale pointer was
 *   rewritten (the caller persists the correction and logs loudly).
 */
export function resolveActiveProvider(
  persisted: string | undefined,
  presetIds: readonly string[],
  declaredRoutes: readonly string[],
): { provider: string; corrected: boolean } {
  const id = typeof persisted === 'string' && persisted.trim() !== '' ? persisted.trim() : DEFAULT_PROVIDER
  if (presetIds.includes(id) || declaredRoutes.includes(id)) return { provider: id, corrected: false }
  return { provider: DEFAULT_PROVIDER, corrected: true }
}

/** One provider's cached profile ('' fields mean "use the preset default"). */
interface ProviderProfile {
  baseUrl?: string
  model?: string
}

interface StoredEngineSettings {
  provider?: string
  profiles?: Record<string, ProviderProfile>
  /** Legacy single-provider fields; migrated into profiles on first read. */
  baseUrl?: string
  model?: string
}

/** Read a raw string from settings storage; '' when absent. */
export async function readStorageString(key: string): Promise<string> {
  const items = await storageGet([key])
  const value = items[key]
  return typeof value === 'string' ? value : ''
}

/** Write (or remove, when empty) one string key. */
export async function writeStorageString(key: string, value: string): Promise<void> {
  if (value === '') {
    await storageRemove([key])
  } else {
    await storageSet({ [key]: value })
  }
}

// ───────────────────────── synchronous settings cache ─────────────────────────

export interface ResolvedEngineConfig {
  provider: string
  baseUrl: string
  model: string
}

const cache: ResolvedEngineConfig & { profiles: Record<string, ProviderProfile> } = {
  provider: DEFAULT_PROVIDER,
  baseUrl: '',
  model: '',
  profiles: {},
}

function effectiveOf(id: string): { baseUrl: string; model: string } {
  const profile = cache.profiles[id] ?? {}
  return {
    baseUrl: typeof profile.baseUrl === 'string' ? profile.baseUrl.trim() : '',
    model: typeof profile.model === 'string' ? profile.model.trim() : '',
  }
}

async function refreshCache(): Promise<void> {
  const items = await storageGet([SETTINGS_KEY])
  const raw = items[SETTINGS_KEY] as StoredEngineSettings | undefined
  const provider = typeof raw?.provider === 'string' && raw.provider.trim() !== ''
    ? raw.provider.trim()
    : DEFAULT_PROVIDER
  const profiles: Record<string, ProviderProfile> =
    raw?.profiles !== null && typeof raw?.profiles === 'object' && raw.profiles !== undefined
      ? (raw.profiles as Record<string, ProviderProfile>)
      : {}
  // Legacy migration: single-field baseUrl/model belong to the recorded
  // (or default) provider of the pre-profiles era.
  if (raw?.profiles === undefined && (raw?.baseUrl !== undefined || raw?.model !== undefined)) {
    const legacy: ProviderProfile = {}
    if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim() !== '') legacy.baseUrl = raw.baseUrl.trim()
    if (typeof raw.model === 'string' && raw.model.trim() !== '') legacy.model = raw.model.trim()
    if (Object.keys(legacy).length > 0) profiles[provider] = legacy
  }
  cache.provider = provider
  cache.profiles = profiles
  const effective = effectiveOf(provider)
  cache.baseUrl = effective.baseUrl
  cache.model = effective.model
}

/**
 * Prime the synchronous cache and keep it live against storage changes.
 * Idempotent; call once during offscreen boot before the LLM adapter
 * registers.
 */
export function initSettingsCache(): void {
  void refreshCache()
  try {
    onStorageChanged((area) => {
      if (area !== 'local') return
      void refreshCache()
    })
  } catch {
    // Storage events unavailable: settings changes require an engine reload.
  }
}

/** The current (cached, synchronous) engine config for the adapter thunk. */
export function currentEngineConfig(): ResolvedEngineConfig {
  return { provider: cache.provider, baseUrl: cache.baseUrl, model: cache.model }
}

/** One provider's cached profile (live view; '' means preset default). */
export function providerProfile(id: string): { baseUrl: string; model: string } {
  return effectiveOf(id)
}

/** The resolved engine settings (API key mirrored from the credential key). */
export async function readEngineSettings(): Promise<EngineSettings> {
  const apiKey = await readStorageString(API_KEY_STORAGE_KEY)
  return {
    apiKey,
    provider: cache.provider,
    baseUrl: cache.baseUrl,
    model: cache.model,
  }
}

/**
 * Persist the non-secret settings. baseUrl/model write into the profile of
 * the ACTIVE provider (after any provider switch in the same patch), so each
 * provider keeps its own endpoint/model; empty strings clear the field.
 */
export async function writeEngineSettings(patch: Partial<EngineSettings>): Promise<void> {
  const items = await storageGet([SETTINGS_KEY])
  const raw = items[SETTINGS_KEY] as StoredEngineSettings | undefined
  const merged: StoredEngineSettings = { ...raw, profiles: { ...(raw?.profiles ?? {}) } }
  if (patch.provider !== undefined) {
    const v = patch.provider.trim()
    if (v === '' || v === DEFAULT_PROVIDER) delete merged.provider
    else merged.provider = v
  }
  const activeProvider = merged.provider ?? DEFAULT_PROVIDER
  const profiles: Record<string, ProviderProfile> = merged.profiles ?? {}
  // Legacy single-field migration (write path): fold raw baseUrl/model into
  // the pre-profiles active provider BEFORE applying this patch, so the
  // values survive the delete below.
  if (raw?.profiles === undefined && (raw?.baseUrl !== undefined || raw?.model !== undefined)) {
    const legacy: ProviderProfile = {}
    if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim() !== '') legacy.baseUrl = raw.baseUrl.trim()
    if (typeof raw.model === 'string' && raw.model.trim() !== '') legacy.model = raw.model.trim()
    if (Object.keys(legacy).length > 0) profiles[activeProvider] = legacy
  }
  const profile: ProviderProfile = { ...(profiles[activeProvider] ?? {}) }
  let touched = false
  if (patch.baseUrl !== undefined) {
    const v = patch.baseUrl.trim()
    if (v === '') delete profile.baseUrl
    else profile.baseUrl = v
    touched = true
  }
  if (patch.model !== undefined) {
    const v = patch.model.trim()
    if (v === '') delete profile.model
    else profile.model = v
    touched = true
  }
  if (touched) profiles[activeProvider] = profile
  delete merged.baseUrl
  delete merged.model
  if (Object.keys(profiles).length === 0) delete merged.profiles
  else merged.profiles = profiles
  const hasKeys = Object.keys(merged).length > 0
  if (hasKeys) {
    await storageSet({ [SETTINGS_KEY]: merged })
  } else {
    await storageRemove([SETTINGS_KEY])
  }
  await refreshCache()
}
