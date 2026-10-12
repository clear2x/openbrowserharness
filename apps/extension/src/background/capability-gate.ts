/**
 * Service-worker-side capability gate: a tiny cached reader over
 * chrome.storage for the hot input/overlay paths (the 虚拟指针 overlay, the
 * humanized pacing, and any future per-call first-party switch).
 *
 * The cache exists so a per-gesture check never pays a storage round trip;
 * any `dsh-capability-*` change invalidates it immediately via the
 * top-level storage.onChanged listener (the MV3 registration requirement),
 * so a panel toggle reaches the very next gesture without a reload.
 */

import {
  CURSOR_CAPABILITY_KEY,
  HUMANIZED_INPUT_CAPABILITY_KEY,
  PRIVACY_MASK_CAPABILITY_KEY,
} from '../shared/capability-keys.ts'

const CACHE_TTL_MS = 2_000

const cache = new Map<string, { value: boolean; at: number }>()

/**
 * Whether one capability flag is on. A missing key reads as `fallback`; a
 * storage failure reads as `fallback` too — these gates decorate input and
 * display, they must never break dispatch.
 */
export async function capabilityEnabled(key: string, fallback: boolean): Promise<boolean> {
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  let value = fallback
  try {
    const stored = await chrome.storage.local.get(key)
    const flag = (stored as Record<string, { enabled?: unknown }>)[key]
    if (flag?.enabled === true) value = true
    else if (flag?.enabled === false) value = false
    else value = fallback
  } catch {
    value = fallback
  }
  cache.set(key, { value, at: Date.now() })
  return value
}

/** The 虚拟指针 overlay switch (default ON). */
export function cursorOverlayEnabled(): Promise<boolean> {
  return capabilityEnabled(CURSOR_CAPABILITY_KEY, true)
}

/** The 拟人化输入 switch (default ON): Bézier paths and keystroke pacing. */
export function humanizedInputEnabled(): Promise<boolean> {
  return capabilityEnabled(HUMANIZED_INPUT_CAPABILITY_KEY, true)
}

/** The 快照脱敏 switch (default ON): PII placeholders in snapshot text. */
export function privacyMaskEnabled(): Promise<boolean> {
  return capabilityEnabled(PRIVACY_MASK_CAPABILITY_KEY, true)
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged !== undefined) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    for (const key of Object.keys(changes)) {
      if (key.startsWith('dsh-capability-')) cache.delete(key)
    }
  })
}
