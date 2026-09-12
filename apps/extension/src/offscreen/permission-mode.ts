/**
 * `permission-mode`: the extension's session-scoped permission knob. Three
 * user-facing modes (ask-always / ask-change / full — see
 * `shared/permission-mode`) decide which tool calls the gate asks about; the
 * consumer of the folded value is the `chrome-tool-gate` pre-execute listener,
 * and the writer is the SidePanel switcher through the api-bridge's
 * `session.permission.set` RPC.
 *
 * The mode is log-durable like every other collaboration knob: the service
 * appends `permission/mode` (whole-value replace, last one wins) and the fold
 * replays from the session log alone, so resume and fork restore it without a
 * live mirror.
 *
 * This module declares the `permission/mode` log event, so the generated
 * persistence catalog must include it (`pnpm run gen-persistence-catalog`); a
 * log written here stays readable after a cold resume.
 *
 * @module permission-mode
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '../shared/permission-mode.ts'

/** Name this plugin registers under (the composition row and module map key). */
export const name = 'permission-mode'

/** The mode vocabulary lives in `shared/permission-mode` (sidepanel + bridge + engine). */
export { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, isPermissionMode } from '../shared/permission-mode.ts'
export type { PermissionMode } from '../shared/permission-mode.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's permission mode from this point on: log-only, whole-value
     * replace, last one wins; a log with none folds to
     * {@link DEFAULT_PERMISSION_MODE}. The mode is a user collaboration knob —
     * it never reaches the model transcript and changes only which tool calls
     * the gate asks about.
     */
    'permission/mode': { mode: PermissionMode }
  }
}

/**
 * The mode in force at the end of the given events: the last `permission/mode`
 * wins, with no entry folding to the fallback (the composition default).
 * @param events - the session log or any prefix of it.
 * @param fallback - the value when no event names the mode yet.
 * @returns the effective permission mode.
 */
export function effectivePermissionMode(
  events: readonly SessionEvent[],
  fallback: PermissionMode = DEFAULT_PERMISSION_MODE,
): PermissionMode {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'permission/mode') return event.data.mode
  }
  return fallback
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    permissionMode: PermissionModeService
  }
}

/**
 * `ctx.permissionMode`: reads the folded mode and writes mode selections.
 * The append is a UI-knob write (safe outside a turn); repeat selections of
 * the current mode are a no-op so the log never fills with redundant events.
 */
export class PermissionModeService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'permissionMode')
  }

  /**
   * Read the effective mode for one agent's session.
   * @param agent - the agent whose session log applies.
   * @returns the folded mode.
   */
  effectiveOf(agent: Agent): { mode: PermissionMode } {
    return { mode: effectivePermissionMode(agent.session.snapshotEvents()) }
  }

  /**
   * Select the mode. The `permission/mode` event appends immediately, so the
   * gate's very next decision follows the switch — including mid-turn.
   * @param agent - the agent whose session is switched.
   * @param mode - the selected mode.
   * @returns the state after the selection.
   */
  set(agent: Agent, mode: PermissionMode): { mode: PermissionMode } {
    if (effectivePermissionMode(agent.session.snapshotEvents()) !== mode) {
      agent.session.append('permission/mode', { mode })
    }
    return this.effectiveOf(agent)
  }
}

export default PermissionModeService
