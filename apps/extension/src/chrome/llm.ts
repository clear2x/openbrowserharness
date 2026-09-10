/**
 * `chrome-llm`: registers every LLM provider preset on `ctx.llm` — the
 * browser-host edition of the multi-provider gateway.
 *
 * Why not mount `@deepseek-ai/dsh-llm-deepseek`'s plugin entry directly: its
 * apply resolves the endpoint through the launch-environment snapshot and the
 * anonymous user id through the harness home on disk — both Node-only
 * facilities whose import graph cannot enter the extension bundle. This
 * plugin registers adapter instances whose operation-local hooks read the
 * chrome.storage-backed settings cache instead (live per request):
 *
 * - OpenAI-compatible vendors reuse {@link DeepSeekAdapter} (it IS an
 *   OpenAI chat/completions client) with vendor connection facts;
 * - Anthropic rides the native Messages adapter;
 * - every preset lands in the configurable-provider directory so the real dsh
 *   settings/model surfaces list them natively.
 *
 * See `./llm-providers.ts` for the preset registry and registration.
 */

import type { Context } from '@deepseek-ai/cordis'
import { currentEngineConfig, initSettingsCache } from './settings-store'
import { DEFAULT_PROVIDER, registerExtensionProviders } from './llm-providers'
import { syncCustomProviders } from './custom-providers.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'chrome-llm'

/** The LLM registry service is required before registration. */
export const inject = ['llm']

/** This plugin has no config. */
export interface Config {}

/** The provider route engine defaults route through (live settings read). */
export function activeProviderId(): string {
  return currentEngineConfig().provider || DEFAULT_PROVIDER
}

export function apply(ctx: Context, _config: Config): void {
  void _config
  // Prime the synchronous settings cache and track storage changes so the
  // adapters' options thunks always answer with the latest committed values.
  initSettingsCache()
  registerExtensionProviders(ctx, () => currentEngineConfig())
  // Hand-declared provider routes (the `llm-pi-ai` namespace the dsh Models
  // page's custom-provider card writes) re-register from durable storage;
  // later writes to that namespace re-run this sync from the bridge.
  void syncCustomProviders(ctx)
}
