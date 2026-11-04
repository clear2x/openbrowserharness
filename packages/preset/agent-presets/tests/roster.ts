/** Shared accessors for the roster specs. */
import type { Context } from '@deepseek-ai/cordis'
import type AgentPresets from '@deepseek-ai/dsh-agent-presets'
import type { Config } from '@deepseek-ai/dsh-agent-presets'

/**
 * Raw plugin config as the schema receives it. The roster's `Config` schema is
 * typed at its RESOLVED output — the volatile selection fields arrive as live
 * references the schema itself creates — so every harness's raw literal passes
 * through this cast unchanged and keeps resolving defaults at mount.
 * @param raw - the raw composition config for the roster plugin.
 * @returns the value `ctx.plugin(AgentPresets, …)` accepts.
 */
export function rosterConfig(raw: Partial<Config>): Config {
  return raw as Config
}

/**
 * The fork's roster service occupies the `agentPresets` slot at runtime, while
 * the merged `Context` declaration still carries the upstream registry twin's
 * type; roster reads narrow through this view.
 * @param ctx - context the roster service was composed into.
 * @returns the mounted roster service.
 */
export function rosterOf(ctx: Context): AgentPresets {
  return ctx.agentPresets as unknown as AgentPresets
}
