/**
 * Locale keys for the built-in capability switches. `shared/capability-keys.ts`
 * owns the keys and their zh labels; this table names the dictionary entry of
 * each label so the panels can show it in the active locale. A capability
 * without an entry keeps its key as the label.
 *
 * @module extension-shell-locales-capabilities
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
  SCREENSHOT_CAPABILITY_KEY,
  SITE_KNOWLEDGE_CAPABILITY_KEY,
  SNAP_LEAN_CAPABILITY_KEY,
  SUBMIT_GUARD_CAPABILITY_KEY,
  TOOL_GROUPS_CAPABILITY_KEY,
  TRACKING_CLEAN_CAPABILITY_KEY,
} from '../../shared/capability-keys.ts'
import type { ShellLocaleKey, ShellTranslate } from './index.ts'

const CAPABILITY_LABEL_KEYS: Readonly<Record<string, ShellLocaleKey>> = {
  [SCREENSHOT_CAPABILITY_KEY]: 'capability.screenshot',
  [CURSOR_CAPABILITY_KEY]: 'capability.virtualCursor',
  [SITE_KNOWLEDGE_CAPABILITY_KEY]: 'capability.siteKnowledge',
  [PRIVACY_MASK_CAPABILITY_KEY]: 'capability.privacyMask',
  [HUMANIZED_INPUT_CAPABILITY_KEY]: 'capability.humanizedInput',
  [SNAP_LEAN_CAPABILITY_KEY]: 'capability.snapLean',
  [BANNER_CLEAN_CAPABILITY_KEY]: 'capability.bannerClean',
  [LAZY_LOAD_CAPABILITY_KEY]: 'capability.lazyLoad',
  [ANIM_FREEZE_CAPABILITY_KEY]: 'capability.animFreeze',
  [TRACKING_CLEAN_CAPABILITY_KEY]: 'capability.trackingClean',
  [AUTO_SETTLE_CAPABILITY_KEY]: 'capability.autoSettle',
  [BLOCK_MEDIA_CAPABILITY_KEY]: 'capability.blockMedia',
  [BEACON_BLOCK_CAPABILITY_KEY]: 'capability.beaconBlock',
  [SAFE_CLICK_CAPABILITY_KEY]: 'capability.safeClick',
  [SUBMIT_GUARD_CAPABILITY_KEY]: 'capability.submitGuard',
  [TOOL_GROUPS_CAPABILITY_KEY]: 'capability.toolGroups',
}

/**
 * The dictionary entry of one capability's label.
 * @param key - a capability storage key.
 * @returns the entry, or undefined when the capability has no label entry.
 */
export function capabilityLabelKey(key: string): ShellLocaleKey | undefined {
  return CAPABILITY_LABEL_KEYS[key]
}

/**
 * Whether one capability has a label entry (the panels list only these).
 * @param key - a capability storage key.
 * @returns true when the label has a dictionary entry.
 */
export function hasCapabilityLabel(key: string): boolean {
  return Object.hasOwn(CAPABILITY_LABEL_KEYS, key)
}

/**
 * The label of one capability in the active locale.
 * @param t - the shell translate.
 * @param key - a capability storage key.
 * @returns the localized label, or the key when it has no entry.
 */
export function capabilityLabel(t: ShellTranslate, key: string): string {
  const entry = capabilityLabelKey(key)
  return entry === undefined ? key : t(entry)
}
