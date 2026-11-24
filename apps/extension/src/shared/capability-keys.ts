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

/** chrome.storage key backing the 快照精简 capability (drop long passive text from snapshots). */
export const SNAP_LEAN_CAPABILITY_KEY = 'dsh-capability-snap-lean'

/** chrome.storage key backing the 横幅遮罩清理 capability (consent-banner sweep before snapshots). */
export const BANNER_CLEAN_CAPABILITY_KEY = 'dsh-capability-banner-clean'

/** chrome.storage key backing the 懒加载触发 capability (pre-snapshot scroll sweep). */
export const LAZY_LOAD_CAPABILITY_KEY = 'dsh-capability-lazy-load'

/** chrome.storage key backing the 动画冻结 capability (kill animations for deterministic ops). */
export const ANIM_FREEZE_CAPABILITY_KEY = 'dsh-capability-anim-freeze'

/** chrome.storage key backing the 链接净化 capability (strip tracking params on navigation). */
export const TRACKING_CLEAN_CAPABILITY_KEY = 'dsh-capability-tracking-clean'

/** chrome.storage key backing the 导航智能等待 capability (readyState settle after navigate). */
export const AUTO_SETTLE_CAPABILITY_KEY = 'dsh-capability-auto-settle'

/** chrome.storage key backing the 禁媒体加载 capability (block image/video loads on attached tabs). */
export const BLOCK_MEDIA_CAPABILITY_KEY = 'dsh-capability-block-media'

/** chrome.storage key backing the 埋点屏蔽 capability (no-op navigator.sendBeacon). */
export const BEACON_BLOCK_CAPABILITY_KEY = 'dsh-capability-beacon-block'

/** chrome.storage key backing the 危险操作确认 capability (danger-word clicks require approval). */
export const SAFE_CLICK_CAPABILITY_KEY = 'dsh-capability-safe-click'

/** chrome.storage key backing the 自动提交拦截 capability (typeText never presses Enter). */
export const SUBMIT_GUARD_CAPABILITY_KEY = 'dsh-capability-submit-guard'

/**
 * chrome.storage key backing the 页面脚本请求接口 capability: while OFF (the
 * default) the tool gate refuses a `page_evaluate` script that calls a site's
 * interface, because a task on a website is completed through real page
 * operations (navigation, clicks, typing, scrolling). Turned on only for an
 * explicitly requested interface crawl.
 */
export const SCRIPT_NETWORK_CAPABILITY_KEY = 'dsh-capability-script-network'

/**
 * chrome.storage key backing the PTC 模式 capability: when on, the next
 * engine boot composes the program-executor (`run_code`) instead of the
 * native direct-tool executor — the desktop demo:ptc deployment posture.
 */
export const PTC_MODE_CAPABILITY_KEY = 'dsh-capability-ptc-mode'

/**
 * chrome.storage key backing the MCP 服务器 capability: when on, the engine
 * document dials the local MCP bridge (scripts/mcp-bridge.mjs) and serves
 * JSON-RPC over it, so external harnesses and agents can drive this
 * extension through MCP. Toggled from the services panel, not preset chips.
 */
export const MCP_SERVER_CAPABILITY_KEY = 'dsh-capability-mcp-server'

/**
 * chrome.storage key backing the 工具按需加载 capability: when on, the
 * rarely used tool groups (team orchestration, scheduling, the file
 * workspace, background jobs) stay hidden until the model loads them with
 * `load_tools`, roughly halving every request's tool schema. Applies to
 * agents created after the change.
 */
export const TOOL_GROUPS_CAPABILITY_KEY = 'dsh-capability-tool-groups'

/** Per-key defaults: the value a missing flag reads as. */
export const CAPABILITY_FALLBACKS: Readonly<Record<string, boolean>> = {
  [SCREENSHOT_CAPABILITY_KEY]: false,
  [CURSOR_CAPABILITY_KEY]: true,
  [SITE_KNOWLEDGE_CAPABILITY_KEY]: true,
  [PRIVACY_MASK_CAPABILITY_KEY]: true,
  [HUMANIZED_INPUT_CAPABILITY_KEY]: true,
  [SNAP_LEAN_CAPABILITY_KEY]: false,
  [BANNER_CLEAN_CAPABILITY_KEY]: false,
  [LAZY_LOAD_CAPABILITY_KEY]: false,
  [ANIM_FREEZE_CAPABILITY_KEY]: false,
  [TRACKING_CLEAN_CAPABILITY_KEY]: true,
  [AUTO_SETTLE_CAPABILITY_KEY]: true,
  [BLOCK_MEDIA_CAPABILITY_KEY]: false,
  [BEACON_BLOCK_CAPABILITY_KEY]: false,
  [SAFE_CLICK_CAPABILITY_KEY]: false,
  [SUBMIT_GUARD_CAPABILITY_KEY]: false,
  [SCRIPT_NETWORK_CAPABILITY_KEY]: false,
  [MCP_SERVER_CAPABILITY_KEY]: false,
  [PTC_MODE_CAPABILITY_KEY]: false,
  [TOOL_GROUPS_CAPABILITY_KEY]: true,
}

/** Whether one value names a known capability (the generic RPC's allowlist). */
export function isCapabilityKey(key: unknown): key is string {
  return typeof key === 'string' && CAPABILITY_FALLBACKS[key] !== undefined
}
