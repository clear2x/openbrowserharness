/**
 * The extension's permission-mode vocabulary, shared by the engine (the
 * gate's matrix and the `permission/mode` log event), the api-bridge RPC
 * face, and the SidePanel switcher. Pure data: no cordis, no chrome — both
 * bundles can carry it.
 *
 * The modes govern how the gate treats BROWSER operations (click/type/
 * navigate/script/tab management) and file changes (write/edit):
 * - `ask-always`: every page-touching operation asks first;
 * - `ask-change`: only change-class operations (anything that adds, modifies,
 *   or deletes content — typed text, scripts, navigation, tab open/close,
 *   file writes) ask; browsing (click/scroll/snapshot) runs freely;
 * - `full`: nothing asks.
 *
 * A new session folds to `full` (the user's requested out-of-box posture:
 * the agent acts without asking); the switcher restores either ask mode at
 * any time and the choice persists per session.
 *
 * @module shared/permission-mode
 */

/** The three user-facing permission modes, in switcher order. */
export const PERMISSION_MODES = ['ask-always', 'ask-change', 'full'] as const

/** One mode's wire value. */
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** The mode a session folds to before its first `permission/mode` event. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'full'

/** Type guard for wire validation of an untrusted mode string. */
export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value)
}
