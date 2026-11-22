/**
 * Shared vocabulary for the on-device AI runtime (`chrome-ai-runtime`): the
 * device-tier probe result, the per-model entry states, and the one coded
 * error the surface reports. Every model runs INSIDE the extension (an
 * offscreen Web Worker over WebGPU or WASM, or the browser's built-in
 * Gemini Nano) — no external inference server, per the v0.7.x product line.
 *
 * @module ai-runtime/types
 */

/** One coded failure of the local-AI surface. */
export class AiLocalError extends Error {
  /** The stable machine-readable failure code. */
  readonly code: AiLocalErrorCode

  constructor(message: string, code: AiLocalErrorCode) {
    super(message)
    this.name = 'AiLocalError'
    this.code = code
  }
}

/** The closed set of local-AI failure codes. */
export type AiLocalErrorCode =
  | 'AI_LOCAL_CATALOG_INVALID'
  | 'AI_LOCAL_MODEL_UNKNOWN'
  | 'AI_LOCAL_MODEL_UNAVAILABLE'
  | 'AI_LOCAL_STATE_IO'

/**
 * The WebGPU tier of the host machine. `software` is Chromium's fallback
 * adapter (SwiftShader): WebGPU exists but every matmul runs on the CPU, so
 * model gating must treat it as the CPU tier, not as a GPU.
 */
export type WebGpuTier = 'real' | 'software' | 'unavailable'

/**
 * The browser built-in Gemini Nano (Prompt API) tier. `unsupported` means
 * this browser build does not expose `LanguageModel` at all (e.g. an Edge
 * version without the built-in AI work).
 */
export type NanoTier = 'ready' | 'downloadable' | 'unavailable' | 'unsupported'

/** The resolved capability tiers of the current browser/machine pair. */
export interface DeviceProbe {
  webgpu: WebGpuTier
  geminiNano: NanoTier
}

/** The pure probe inputs, so tests drive the mapping without real globals. */
export interface DeviceProbeInput {
  /** The adapter verdict, or `null` when WebGPU is missing or errored. */
  webgpuAdapter: 'real' | 'software' | null
  /** `LanguageModel.availability()`'s verdict, or `null` when absent/throwing. */
  nanoAvailability: 'available' | 'downloadable' | 'downloading' | 'unavailable' | null
}

/** One model's persisted lifecycle state (the OPFS state file's row). */
export interface ModelEntryState {
  state: 'ready' | 'failed'
  readyAt?: number
  sizeBytes?: number
  error?: string
}

/** The OPFS-persisted runtime state (`ai-local/state.json`). */
export interface AiLocalStateFile {
  version: 1
  models: Record<string, ModelEntryState>
}

/** The on-device inference capability that produced one usage record. */
export type AiLocalCapability = 'ocr' | 'caption' | 'asr' | 'embed'

/**
 * One on-device inference record (the usage ledger's row): what ran, on
 * which model, how long it took, and a short result summary — the real
 * trace the 本地 AI card and probes read back.
 */
export interface AiLocalUsageEntry {
  /** Epoch ms of the inference completion. */
  ts: number
  capability: AiLocalCapability
  /** The model label that ran (e.g. `PP-OCRv4-mobile`, `Whisper-base`). */
  model: string
  /** Wall-clock duration of the inference call (ms). */
  durationMs: number
  /** Short result summary (line counts, top score, first line…). */
  detail: string
  /** Present when the run was a pipeline self-test rather than real work. */
  selfTest?: boolean
}

/** The OPFS-persisted usage ledger (`ai-local/usage.json`). */
export interface AiLocalUsageFile {
  version: 1
  entries: AiLocalUsageEntry[]
}
