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
  ANIM_FREEZE_CAPABILITY_KEY,
  AUTO_SETTLE_CAPABILITY_KEY,
  BANNER_CLEAN_CAPABILITY_KEY,
  BEACON_BLOCK_CAPABILITY_KEY,
  BLOCK_MEDIA_CAPABILITY_KEY,
  CURSOR_CAPABILITY_KEY,
  HUMANIZED_INPUT_CAPABILITY_KEY,
  LAZY_LOAD_CAPABILITY_KEY,
  PRIVACY_MASK_CAPABILITY_KEY,
  SAFE_CLICK_CAPABILITY_KEY,
  SNAP_LEAN_CAPABILITY_KEY,
  SUBMIT_GUARD_CAPABILITY_KEY,
  TRACKING_CLEAN_CAPABILITY_KEY,
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

/** The 快照精简 switch (default OFF): drop long passive text from snapshots. */
export function snapLeanEnabled(): Promise<boolean> {
  return capabilityEnabled(SNAP_LEAN_CAPABILITY_KEY, false)
}

/** The 横幅遮罩清理 switch (default OFF): consent sweep before snapshots. */
export function bannerCleanEnabled(): Promise<boolean> {
  return capabilityEnabled(BANNER_CLEAN_CAPABILITY_KEY, false)
}

/** The 懒加载触发 switch (default OFF): pre-snapshot scroll sweep. */
export function lazyLoadEnabled(): Promise<boolean> {
  return capabilityEnabled(LAZY_LOAD_CAPABILITY_KEY, false)
}

/** The 动画冻结 switch (default OFF): kill animations for deterministic ops. */
export function animFreezeEnabled(): Promise<boolean> {
  return capabilityEnabled(ANIM_FREEZE_CAPABILITY_KEY, false)
}

/** The 链接净化 switch (default ON): strip tracking params on navigation. */
export function trackingCleanEnabled(): Promise<boolean> {
  return capabilityEnabled(TRACKING_CLEAN_CAPABILITY_KEY, true)
}

/** The 导航智能等待 switch (default ON): readyState settle after navigate. */
export function autoSettleEnabled(): Promise<boolean> {
  return capabilityEnabled(AUTO_SETTLE_CAPABILITY_KEY, true)
}

/** The 禁媒体加载 switch (default OFF): block image/video loads on attached tabs. */
export function blockMediaEnabled(): Promise<boolean> {
  return capabilityEnabled(BLOCK_MEDIA_CAPABILITY_KEY, false)
}

/** The 埋点屏蔽 switch (default OFF): no-op navigator.sendBeacon. */
export function beaconBlockEnabled(): Promise<boolean> {
  return capabilityEnabled(BEACON_BLOCK_CAPABILITY_KEY, false)
}

/** The 危险操作确认 switch (default OFF): danger-word clicks require approval. */
export function safeClickEnabled(): Promise<boolean> {
  return capabilityEnabled(SAFE_CLICK_CAPABILITY_KEY, false)
}

/** The 自动提交拦截 switch (default OFF): typeText never presses Enter. */
export function submitGuardEnabled(): Promise<boolean> {
  return capabilityEnabled(SUBMIT_GUARD_CAPABILITY_KEY, false)
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged !== undefined) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    for (const key of Object.keys(changes)) {
      if (key.startsWith('dsh-capability-')) cache.delete(key)
    }
  })
}
