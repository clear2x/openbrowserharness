/**
 * Model-facing browser tools over `ctx.browser`: tab management and page
 * automation (snapshot-first, index/selector addressing with coordinate
 * fallback). This package owns schemas, defensive validation, prompt guidance,
 * caps, and presentation, never a concrete provider — execution always goes
 * through the seam, and an unregistered provider fails with a structured
 * Chinese error at execution time while the tool stays visible.
 * @module @deepseek-ai/dsh-tool-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the `systemPrompt` Context merge in through the declared
// agent dependency (its runtime-types re-export carries the augmentation).
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-browser'
import { applyTabsTools } from './tabs.ts'
import { applyPageTools, BROWSER_GUIDANCE_SECTION_NAME, BROWSER_GUIDANCE_TEXT } from './page.ts'
import { applyScreenshotTool } from './screenshot.ts'
import { TASK_PERSISTENCE_TEXT } from './page.ts'

export { applyTabsTools } from './tabs.ts'
export {
  applyPageTools,
  BROWSER_GUIDANCE_SECTION_NAME,
  BROWSER_GUIDANCE_TEXT,
  formatEvaluateOutput,
  formatSnapshotOutput,
  PAGE_SNAPSHOT_MAX_ELEMENTS,
  parsePageClickArgs,
} from './page.ts'
export { applyScreenshotTool } from './screenshot.ts'
export { parseTabId } from './args.ts'
export { PAGE_EVALUATE_MAX_CHARS, PAGE_EXTRACT_TEXT_MAX_CHARS } from './page.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-browser'

/** Services required by the browser tool suite. */
export const inject = ['browser', 'tools', 'systemPrompt']

/** Plugin config: which browser tool groups to register. Both default to true. */
export interface Config {
  /** Register the `tabs_*` tools. Defaults to true. */
  tabs?: boolean
  /** Register the `page_*` tools. Defaults to true. */
  page?: boolean
}

export const Config: z<Config> = z.object({
  tabs: z.boolean().default(true),
  page: z.boolean().default(true),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/**
 * Register the enabled browser tool groups and the shared browser-operation
 * guidance section. `tabs`/`page` default to true; a deployment that wants
 * only one group disables the other in config. Registrations are effect-
 * scoped, so disposing the plugin fiber unregisters everything.
 * @param ctx - context carrying `tools`, `browser`, and `systemPrompt`.
 * @param config - tool-group toggles (defaults applied by schemastery).
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  ctx.systemPrompt.section({
    name: BROWSER_GUIDANCE_SECTION_NAME,
    order: 113,
    text: BROWSER_GUIDANCE_TEXT,
  })
  ctx.systemPrompt.section({
    name: 'task:persistence',
    order: 112,
    text: TASK_PERSISTENCE_TEXT,
  })
  if (resolved.tabs) applyTabsTools(ctx)
  if (resolved.page) applyPageTools(ctx)
  // page_screenshot is composition-conditional: without a mounted attachment
  // store the deployment cannot durably commit image bytes, so the tool never
  // registers; the execute body keeps a defensive re-check for direct callers.
  ctx.inject(['attachments'], (shotCtx) => {
    applyScreenshotTool(shotCtx)
  })
}
