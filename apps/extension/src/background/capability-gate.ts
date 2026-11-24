/**
 * The cached reader of the first-party capability switches for the hot
 * per-call paths: the input/overlay gestures in the service worker (the
 * 虚拟指针 overlay, the humanized pacing) and the tool gate in the offscreen
 * engine (危险操作确认, 直接请求站点接口).
 *
 * Reads go through `chrome/storage-client.ts`, never `chrome.storage`
 * directly: an offscreen document receives no chrome.storage bindings, so the
 * direct API throws there and a reader built on it answers the default in the
 * engine whatever the panel shows. The client uses the local API where it
 * exists and routes through the service worker elsewhere.
 *
 * The cache exists so a per-gesture check never pays a storage round trip;
 * any local change clears it at once (the service worker's own change event,
 * its rebroadcast elsewhere), so a panel toggle reaches the very next call
 * without a reload.
 */

import { onStorageChanged, storageGet } from '../chrome/storage-client.ts'
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
  SCRIPT_NETWORK_CAPABILITY_KEY,
  SNAP_LEAN_CAPABILITY_KEY,
  SUBMIT_GUARD_CAPABILITY_KEY,
  TRACKING_CLEAN_CAPABILITY_KEY,
} from '../shared/capability-keys.ts'

const CACHE_TTL_MS = 2_000

const cache = new Map<string, { value: boolean; at: number }>()

/**
 * Whether one capability flag is on. A missing key reads as `fallback`; a
 * storage failure reads as `fallback` too — these switches decorate input and
 * gate calls, they must never break dispatch — and the failure is reported.
 * @param key - one of the `dsh-capability-*` keys.
 * @param fallback - the switch's default, read when the key is missing or unreadable.
 * @returns whether the switch is on.
 */
export async function capabilityEnabled(key: string, fallback: boolean): Promise<boolean> {
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  let value = fallback
  try {
    const stored = await storageGet([key])
    const flag = (stored as Record<string, { enabled?: unknown }>)[key]
    if (flag?.enabled === true) value = true
    else if (flag?.enabled === false) value = false
  } catch (error) {
    console.warn(`[capability-gate] 能力开关 ${key} 读取失败，按默认值 ${String(fallback)} 处理：`, error)
  }
  cache.set(key, { value, at: Date.now() })
  return value
}

onStorageChanged((area) => {
  if (area === 'local') cache.clear()
})

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

/**
 * The 直接请求站点接口 switch (default OFF): while it is off, the agent may
 * not make a site's API be requested directly — not from a page script or a
 * program, not by opening or fetching an API address, not through `video_index`.
 */
export function directSiteApiEnabled(): Promise<boolean> {
  return capabilityEnabled(SCRIPT_NETWORK_CAPABILITY_KEY, false)
}
