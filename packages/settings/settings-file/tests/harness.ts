/** Test accessors shared by the settings-file specs. */
import type { Context } from '@deepseek-ai/cordis'
import { FileSettingsProvider } from '../src/index.ts'

/**
 * The `settings` slot holds this fork's provider at runtime, while the static
 * `Context.settings` declaration is the upstream profile-form service; every
 * provider-only read goes through this narrowed view.
 * @param ctx - context the provider was mounted into.
 * @returns the mounted file-backed provider.
 */
export function settingsOf(ctx: Context): FileSettingsProvider {
  return ctx.settings as unknown as FileSettingsProvider
}
