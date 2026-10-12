/**
 * The first-party capability keys and their panel-facing defaults, shared by
 * every context that reads or toggles them (the SW gates, the offscreen
 * providers and api-bridge, the SidePanel panel).
 *
 * A key's fallback IS its default: missing storage reads as the fallback, so
 * opt-in capabilities (screenshot) and default-on capabilities (everything
 * else) both degrade to their shipped posture on a storage outage.
 */

/** chrome.storage key backing the user-opt-in 网页截图 capability. */
export const SCREENSHOT_CAPABILITY_KEY = 'dsh-capability-screenshot'

/** chrome.storage key backing the 虚拟指针 overlay capability. */
export const CURSOR_CAPABILITY_KEY = 'dsh-capability-virtual-cursor'

/** chrome.storage key backing the 站点速查注入 master switch. */
export const SITE_KNOWLEDGE_CAPABILITY_KEY = 'dsh-capability-site-knowledge'

/** chrome.storage key backing the 快照脱敏 capability (PII placeholders in snapshot text). */
export const PRIVACY_MASK_CAPABILITY_KEY = 'dsh-capability-privacy-mask'

/** chrome.storage key backing the 拟人化输入 capability (Bézier paths + keystroke pacing). */
export const HUMANIZED_INPUT_CAPABILITY_KEY = 'dsh-capability-humanized-input'

/** Per-key defaults: the value a missing flag reads as. */
export const CAPABILITY_FALLBACKS: Readonly<Record<string, boolean>> = {
  [SCREENSHOT_CAPABILITY_KEY]: false,
  [CURSOR_CAPABILITY_KEY]: true,
  [SITE_KNOWLEDGE_CAPABILITY_KEY]: true,
  [PRIVACY_MASK_CAPABILITY_KEY]: true,
  [HUMANIZED_INPUT_CAPABILITY_KEY]: true,
}

/** Whether one value names a known capability (the generic RPC's allowlist). */
export function isCapabilityKey(key: unknown): key is string {
  return typeof key === 'string' && CAPABILITY_FALLBACKS[key] !== undefined
}
