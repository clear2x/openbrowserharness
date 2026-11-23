/**
 * The on-device AI runtime manager: the catalog view the UI and later
 * pipelines consume, the cached device probe, and the per-model lifecycle
 * state persisted under `ai-local/state.json` in the extension's OPFS world.
 * Download/load machinery lands with the first concrete (non-planned) entry;
 * this face already owns the state vocabulary so that batch only adds the
 * transfer, not a second store.
 *
 * @module ai-runtime/manager
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { AI_LOCAL_CATALOG, assertCatalogWithinBudget } from './catalog.ts'
import type { AiLocalModelSpec } from './catalog.ts'
import { probeDeviceEnvironment } from './device.ts'
import { installModel, modelInstalled, opfsModelStore, removeModel as removeModelFiles, OCR_PPOCR_MOBILE_SPEC } from './models.ts'
import type { ModelBytesStore, DownloadProgress, ModelSpec } from './models.ts'
import { captionCapable } from './caption-run.ts'
import { decodeTo16k, dropTransformersCache } from './asr-run.ts'
import { dropEmbedCache, warmEmbedPipeline } from './embed-run.ts'
import { asrSelfTestInWorker, captionSelfTestInWorker, embedSelfTestInWorker, ocrSelfTestInWorker, warmAsrInWorker, warmCaptionInWorker } from './worker-bridge.ts'
import { AiLocalError } from './types.ts'
import type { AiLocalStateFile, AiLocalUsageEntry, AiLocalUsageFile, DeviceProbe, ModelEntryState } from './types.ts'

/**
 * The narrow filesystem face the manager needs — the same structural subset
 * the video-index store uses, so both the OPFS provider and the test memory
 * double satisfy it.
 */
export interface AiLocalFs {
  resolve(path: string, opts?: { signal?: AbortSignal }): Promise<unknown>
  readText(target: unknown, signal?: AbortSignal): Promise<string>
  writeText(target: unknown, content: string): Promise<unknown>
  deleteFile(target: unknown): Promise<unknown>
}

/** The OPFS path of the persisted state file. */
const STATE_PATH = 'ai-local/state.json'

/** The OPFS path of the usage ledger. */
const USAGE_PATH = 'ai-local/usage.json'

/** The usage ledger's row cap (newest kept). */
const USAGE_CAP = 50

/**
 * The downloadable spec per catalog id. Later capability batches append
 * their spec here alongside flipping their catalog row to `planned: false`.
 */
const SPEC_BY_ID: Record<string, typeof OCR_PPOCR_MOBILE_SPEC> = {
  'ocr-ppocr-mobile': OCR_PPOCR_MOBILE_SPEC,
}

/** How long one device probe answer stays authoritative. */
const PROBE_TTL_MS = 10_000

/** One catalog row as the UI/RPC sees it (spec + live state + gating). */
export interface AiLocalCatalogEntryView {
  id: string
  label: string
  task: AiLocalModelSpec['task']
  purposeZh: string
  declaredBytes: number
  minDevice: AiLocalModelSpec['minDevice']
  planned: boolean
  /** Lifecycle state: `planned` rows report `unavailable`, others their file state. */
  state: 'unavailable' | 'ready' | 'failed'
  readyAt?: number
  sizeBytes?: number
  error?: string
}

/**
 * The manager over one fs seam. Mount-time catalog validation fails loud
 * (misconfiguration is never silently skipped), and every state write
 * survives an absent or unreadable file as the empty default.
 */
export class AiLocalManager extends Service {
  private readonly fs: AiLocalFs
  private readonly probeFn: () => Promise<DeviceProbe>
  private readonly specs: readonly AiLocalModelSpec[]
  private readonly bytesStore: ModelBytesStore
  private probeCache: { at: number; probe: DeviceProbe } | undefined
  private installs: Map<string, Promise<number>> = new Map()

  constructor(
    ctx: Context,
    fs: AiLocalFs,
    probeFn: () => Promise<DeviceProbe> = probeDeviceEnvironment,
    catalog: readonly AiLocalModelSpec[] = AI_LOCAL_CATALOG,
    bytesStore: ModelBytesStore = opfsModelStore(),
  ) {
    // Register as the `aiLocal` service so inject declarations (the api
    // bridge's) can see it; the base removes it with the owning fiber.
    super(ctx, 'aiLocal')
    this.fs = fs
    this.probeFn = probeFn
    this.specs = catalog
    this.bytesStore = bytesStore
    assertCatalogWithinBudget(catalog)
  }

  /**
   * Probe the machine tiers, answering from a fresh-enough cache so the
   * panel's periodic refreshes do not re-request adapters.
   */
  async probe(): Promise<DeviceProbe & { at: number }> {
    if (this.probeCache !== undefined && Date.now() - this.probeCache.at < PROBE_TTL_MS) {
      return { ...this.probeCache.probe, at: this.probeCache.at }
    }
    const probe = await this.probeFn()
    this.probeCache = { at: Date.now(), probe }
    return { ...probe, at: this.probeCache.at }
  }

  /**
   * The full catalog view: every spec joined with its persisted state and
   * the device gating verdict (`planned` rows stay `unavailable` until their
   * landing batch ships the download path).
   */
  async catalog(): Promise<{ device: DeviceProbe & { at: number }; models: AiLocalCatalogEntryView[] }> {
    const device = await this.probe()
    const state = await this.readState()
    return {
      device,
      models: this.specs.map((spec) => {
        const row = state.models[spec.id]
        const base: AiLocalCatalogEntryView = {
          id: spec.id,
          label: spec.label,
          task: spec.task,
          purposeZh: spec.purposeZh,
          declaredBytes: spec.declaredBytes,
          minDevice: spec.minDevice,
          planned: spec.planned,
          state: spec.planned ? 'unavailable' : (row?.state ?? 'unavailable'),
        }
        if (row === undefined) return base
        return {
          ...base,
          ...(row.readyAt === undefined ? {} : { readyAt: row.readyAt }),
          ...(row.sizeBytes === undefined ? {} : { sizeBytes: row.sizeBytes }),
          ...(row.error === undefined ? {} : { error: row.error }),
        }
      }),
    }
  }

  /**
   * Record one model as ready (its landing batch calls this after a verified
   * download/load).
   * @param id - the catalog id.
   * @param sizeBytes - the measured artifact size (also the 1 GiB re-check).
   */
  async markReady(id: string, sizeBytes: number): Promise<void> {
    this.assertKnownDownloadable(id)
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > 1024 * 1024 * 1024) {
      throw new AiLocalError(`模型 ${id} 的实测体积 ${String(sizeBytes)} 超出 1GB 约定`, 'AI_LOCAL_MODEL_UNAVAILABLE')
    }
    const row: ModelEntryState = { state: 'ready', readyAt: Date.now(), sizeBytes }
    await this.writeRow(id, row)
  }

  /**
   * Record one model's failure (its landing batch surfaces the error in the
   * card and allows retry).
   */
  async markFailed(id: string, error: string): Promise<void> {
    this.assertKnownDownloadable(id)
    await this.writeRow(id, { state: 'failed', error })
  }

  /**
   * Install one downloadable model. The OCR row streams artifacts into the
   * OPFS model directory; the caption row warms transformers.js's pipeline
   * (weights land in its Cache-API cache, WebGPU required). Concurrent
   * calls for the same id share one in-flight install.
   * @param id - the catalog id.
   * @param onProgress - per-artifact download progress (OPFS rows only).
   * @returns the installed byte total where known.
   */
  async install(id: string, onProgress?: DownloadProgress): Promise<{ ok: boolean; sizeBytes?: number; error?: string }> {
    this.assertKnownDownloadable(id)
    const existing = this.installs.get(id)
    if (existing !== undefined) return this.awaitInstall(id, existing)
    const run = id === 'caption-smolvlm2-256m'
      ? this.warmCaption()
      : id === 'asr-whisper-base'
        ? this.warmAsr()
        : id === 'embed-e5-small'
          ? this.warmEmbed()
          : this.installOcrFiles(SPEC_BY_ID[id], onProgress)
    this.installs.set(id, run)
    return this.awaitInstall(id, run)
  }

  /** The OCR row's OPFS download (the spec is required to exist here). */
  private async installOcrFiles(spec: ModelSpec | undefined, onProgress?: DownloadProgress): Promise<number> {
    if (spec === undefined) {
      throw new AiLocalError('模型没有可安装的文件清单', 'AI_LOCAL_MODEL_UNAVAILABLE')
    }
    return installModel(spec, this.bytesStore, onProgress ?? (() => undefined))
  }

  /**
   * Retry a transformers.js warm: its downloader has no retry of its own,
   * and the mirror origin serves large artifacts with intermittent
   * connection failures — three attempts with linear backoff covers them.
   */
  private async warmWithRetry(warm: () => Promise<void>): Promise<void> {
    let lastError: unknown = undefined
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await warm()
        return
      } catch (error: unknown) {
        lastError = error
        await new Promise(resolve => setTimeout(resolve, 3000 * (attempt + 1)))
      }
    }
    throw lastError instanceof Error ? lastError : new AiLocalError(String(lastError), 'AI_LOCAL_MODEL_UNAVAILABLE')
  }

  /**
   * The caption row's install: gate on a real GPU adapter (the pipeline
   * would silently fall to wasm otherwise), then warm the pipeline.
   */
  private async warmCaption(): Promise<number> {
    const probe = await this.probe()
    if (!captionCapable(probe.webgpu)) {
      throw new AiLocalError('画面描述需要真实 GPU（WebGPU）；此机器将依赖本地 OCR 通道', 'AI_LOCAL_MODEL_UNAVAILABLE')
    }
    await this.warmWithRetry(async () => { await warmCaptionInWorker() })
    return 258 * 1024 * 1024
  }

  /**
   * The ASR row's install: CPU-tier by contract (offline indexing), no
   * device gate. Same transformers.js cache family as the caption row.
   */
  private async warmAsr(): Promise<number> {
    await this.warmWithRetry(async () => { await warmAsrInWorker() })
    return 74 * 1024 * 1024
  }

  /**
   * The embedding row's install: CPU-tier (118M encoder — embeddings are the
   * one task where CPU is fully competitive). Same transformers.js cache
   * family as caption/ASR.
   */
  private async warmEmbed(): Promise<number> {
    await this.warmWithRetry(async () => { await warmEmbedPipeline() })
    return 113 * 1024 * 1024
  }

  /** Fold one install run into the state file, clearing the in-flight map. */
  private async awaitInstall(id: string, run: Promise<number>): Promise<{ ok: boolean; sizeBytes?: number; error?: string }> {
    try {
      const sizeBytes = await run
      await this.writeRow(id, { state: 'ready', readyAt: Date.now(), sizeBytes })
      return { ok: true, sizeBytes }
    } catch (error: unknown) {
      const detail = error instanceof Error
        ? `${error.message} :: ${(error.stack ?? '').slice(0, 200)}`
        : String(error)
      await this.writeRow(id, { state: 'failed', error: detail }).catch(() => undefined)
      return { ok: false, error: detail }
    } finally {
      this.installs.delete(id)
    }
  }

  /**
   * Reconcile the persisted rows with the OPFS ground truth: a row claims
   * ready only while the published manifest still exists (a cleared browser
   * storage or manual OPFS wipe downgrades the row instead of lying).
   */
  async reconcileFromDisk(): Promise<void> {
    const state = await this.readState()
    for (const [id, spec] of Object.entries(SPEC_BY_ID)) {
      const row = state.models[id]
      if (row !== undefined && row.state === 'ready' && !(await modelInstalled(spec, this.bytesStore))) {
        await this.writeRow(id, undefined)
      }
    }
  }

  /**
   * Render a synthetic frame and push it through the real pipeline of `id`
   * (default: the OCR row's det+rec; the caption row runs its VLM on a red
   * canvas and answers with a description naming the color) — the install's
   * end-to-end self-proof: a mis-shaped graph, a misaligned dictionary, or
   * a broken runtime shows up here, not at the first real video frame.
   * @param id - the catalog id (defaults to the OCR row).
   * @returns the recognized lines, plus ok=false with the reason when the
   *   model is not installed or inference fails.
   */
  async selfTest(id = 'ocr-ppocr-mobile', audioBase64?: string): Promise<{ ok: boolean; lines?: string[]; error?: string }> {
    try {
      // Every inference runs in the AI worker — the main context must never
      // create an onnxruntime session (see worker-bridge.ts header).
      if (id === 'caption-smolvlm2-256m') {
        const startedAt = Date.now()
        const result = await captionSelfTestInWorker() as { lines?: string[] }
        await this.recordUsage({ capability: 'caption', model: 'SmolVLM2-256M', durationMs: Date.now() - startedAt, detail: (result.lines ?? []).join(' ').slice(0, 80), selfTest: true })
        return { ok: true, ...(result.lines === undefined ? {} : { lines: result.lines }) }
      }
      if (id === 'asr-whisper-base') {
        // AudioContext lives on the main context only: decode here, infer in
        // the worker.
        let samples: Float32Array | undefined
        if (audioBase64 !== undefined && audioBase64.length > 0) {
          const binary = atob(audioBase64)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) ?? 0
          samples = await decodeTo16k(bytes.buffer)
        }
        const startedAt = Date.now()
        const result = await asrSelfTestInWorker(samples) as { lines?: string[] }
        await this.recordUsage({ capability: 'asr', model: 'Whisper-base', durationMs: Date.now() - startedAt, detail: (result.lines ?? []).join(' ').slice(0, 80), selfTest: true })
        return { ok: true, ...(result.lines === undefined ? {} : { lines: result.lines }) }
      }
      if (id === 'embed-e5-small') {
        // The property the DOM pre-filter depends on: a paraphrase of the
        // query must outrank a topic-unrelated passage.
        const startedAt = Date.now()
        const result = await embedSelfTestInWorker(
          '点击这个按钮即可登录账号',
          '今天下午天气预报显示有雷阵雨',
        ) as { relatedScore?: number; unrelatedScore?: number }
        const related = result.relatedScore ?? 0
        const unrelated = result.unrelatedScore ?? 0
        if (related <= unrelated) {
          throw new Error(`嵌入语义排序异常（相关 ${related.toFixed(3)} ≤ 无关 ${unrelated.toFixed(3)}）`)
        }
        await this.recordUsage({ capability: 'embed', model: 'e5-small', durationMs: Date.now() - startedAt, detail: `相关 ${related.toFixed(3)} > 无关 ${unrelated.toFixed(3)}`, selfTest: true })
        return { ok: true, lines: [`相关 ${related.toFixed(3)} > 无关 ${unrelated.toFixed(3)}`] }
      }
      if (!(await modelInstalled(OCR_PPOCR_MOBILE_SPEC, this.bytesStore))) {
        return { ok: false, error: 'OCR 模型未安装' }
      }
      const startedAt = Date.now()
      const width = 640
      const height = 160
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      if (context === null) return { ok: false, error: 'Offscreen 2D 上下文不可用' }
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, height)
      context.fillStyle = '#000000'
      context.font = '48px sans-serif'
      context.fillText('字幕测试 00:42', 40, 100)
      const outcome = await ocrSelfTestInWorker() as { lines?: string[] }
      const lines = outcome.lines ?? []
      await this.recordUsage({ capability: 'ocr', model: 'PP-OCRv4-mobile', durationMs: Date.now() - startedAt, detail: (lines.join(' ') || '(空)').slice(0, 80), selfTest: true })
      return { ok: lines.length > 0, ...(lines.length > 0 ? { lines } : {}) }
    } catch (error: unknown) {
      if (error instanceof Error) {
        return { ok: false, error: `${error.message} :: ${(error.stack ?? '').slice(0, 260)}` }
      }
      return { ok: false, error: String(error) }
    }
  }

  /**
   * Clear one model's state (the remove action; planned rows have no state
   * to clear and report unknown). Published artifacts go with it: OPFS rows
   * zero their manifest, the caption row drops its Cache-API cache.
   */
  async removeModel(id: string): Promise<{ ok: boolean }> {
    this.assertKnownDownloadable(id)
    if (id === 'caption-smolvlm2-256m' || id === 'asr-whisper-base' || id === 'embed-e5-small') {
      // One transformers.js cache hosts all three models — removing any
      // clears every artifact, so all three rows' state entries go with it.
      await dropTransformersCache()
      await dropEmbedCache()
      await this.writeRow('caption-smolvlm2-256m', undefined)
      await this.writeRow('asr-whisper-base', undefined)
      await this.writeRow('embed-e5-small', undefined)
    } else {
      const spec = SPEC_BY_ID[id]
      if (spec !== undefined) await removeModelFiles(spec, this.bytesStore)
      await this.writeRow(id, undefined)
    }
    return { ok: true }
  }

  /** Unknown or planned ids never enter the state file. */
  private assertKnownDownloadable(id: string): void {
    const spec = this.specs.find(entry => entry.id === id)
    if (spec === undefined) {
      throw new AiLocalError(`未知模型：${id}`, 'AI_LOCAL_MODEL_UNKNOWN')
    }
    if (spec.planned) {
      throw new AiLocalError(`模型 ${id} 尚未开放下载（roadmap 行）`, 'AI_LOCAL_MODEL_UNAVAILABLE')
    }
  }

  /** Merge one row into the persisted state file. */
  private async writeRow(id: string, row: ModelEntryState | undefined): Promise<void> {
    const state = await this.readState()
    const models = Object.fromEntries(
      Object.entries(state.models).filter(([key]) => key !== id),
    )
    if (row !== undefined) {
      models[id] = row
    }
    const target = await this.fs.resolve(STATE_PATH)
    await this.fs.writeText(target, JSON.stringify({ version: 1, models }))
  }

  /**
   * Read the persisted state file; an absent or unreadable file is the empty
   * default (the file is a cache of lifecycle facts, never an authority).
   */
  private async readState(): Promise<AiLocalStateFile> {
    try {
      const target = await this.fs.resolve(STATE_PATH)
      const text = await this.fs.readText(target)
      const parsed = JSON.parse(text) as Partial<AiLocalStateFile>
      if (parsed.version === 1 && typeof parsed.models === 'object' && parsed.models !== null) {
        return { version: 1, models: parsed.models }
      }
    } catch {
      // Absent or corrupt state starts clean; the next write recreates it.
    }
    return { version: 1, models: {} }
  }

  /**
   * Record one real on-device inference (the usage ledger the 本地 AI card
   * and probes read back). Appends to `ai-local/usage.json`, newest first,
   * capped so the file stays small. Never throws — the ledger is a nicety
   * and must not break the inference caller.
   * @param entry - the capability, model, duration, and result summary.
   */
  async recordUsage(entry: Omit<AiLocalUsageEntry, 'ts'>): Promise<void> {
    try {
      const entries = await this.readUsage()
      entries.unshift({ ...entry, ts: Date.now() })
      const capped = entries.slice(0, USAGE_CAP)
      const target = await this.fs.resolve(USAGE_PATH)
      await this.fs.writeText(target, JSON.stringify({ version: 1, entries: capped }))
    } catch {
      // Ledger write failures are invisible to the inference caller.
    }
  }

  /** Read the usage ledger, newest first. */
  async usage(): Promise<{ entries: AiLocalUsageEntry[] }> {
    return { entries: await this.readUsage() }
  }

  /** Read the usage ledger; absent or corrupt file is the empty ledger. */
  private async readUsage(): Promise<AiLocalUsageEntry[]> {
    try {
      const target = await this.fs.resolve(USAGE_PATH)
      const text = await this.fs.readText(target)
      const parsed = JSON.parse(text) as Partial<AiLocalUsageFile>
      if (parsed.version === 1 && Array.isArray(parsed.entries)) {
        return parsed.entries
      }
    } catch {
      // Absent or corrupt ledger starts empty.
    }
    return []
  }
}

export type { AiLocalModelSpec } from './catalog.ts'
