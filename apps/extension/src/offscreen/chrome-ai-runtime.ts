/**
 * `chrome-ai-runtime`: the on-device AI runtime service (`ctx.aiLocal`) —
 * the model catalog with its hard 1 GiB ceiling, the device-tier probe
 * (WebGPU real vs SwiftShader fallback vs missing, built-in Gemini Nano),
 * and the per-model lifecycle state over the extension's OPFS world. The
 * inference engines themselves land with each capability batch (OCR, caption,
 * ASR, embeddings) on top of this face; nothing here loads a model yet.
 *
 * @module chrome-ai-runtime
 */
import type { Context } from '@deepseek-ai/cordis'
import { AiLocalManager } from './ai-runtime/manager.ts'

/** This module carries no config today. */
export interface Config {}

/** The module reads the OPFS fs seam for the lifecycle state file. */
export const inject = ['fs'] as const

/**
 * Mount the manager on the context. Catalog validation runs here, so a
 * size-budget violation fails the composition loudly at boot.
 * @param ctx - the cordis context.
 * @param _config - unused config.
 */
export function apply(ctx: Context, _config: Config): void {
  void _config
  // The Service base registers the instance as the `aiLocal` service (the
  // api bridge's inject declaration sees it); `ctx.fs` satisfies the
  // manager's narrow face structurally, so no cast bridges the type planes.
  new AiLocalManager(ctx, ctx.fs)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The on-device AI runtime: catalog view, device probe, lifecycle state. */
    aiLocal: AiLocalManager
  }
}
