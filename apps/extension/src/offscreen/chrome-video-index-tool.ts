/**
 * `chrome-video-index-tool`: the model-facing `video_index` tool — the
 * extension-native mirror of Sense Now's subtitle-first long-video index.
 * Indexing pulls text evidence from the Bilibili video page (official CC
 * subtitles first, AI subtitles ride the page lane's login state); retrieval
 * is deterministic and answers with cited, timestamped evidence lines. The
 * tool needs no approval gate: request records are built once at the top and
 * every remote URL is validated against a hardcoded host allowlist; the page
 * lane runs one fixed expression template — the model never chooses a fetch
 * target and never authors the evaluated code.
 *
 * @module chrome-video-index-tool
 */
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-browser'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { modelInstalled, opfsModelStore, OCR_PPOCR_MOBILE_SPEC } from './ai-runtime/models.ts'
import { DEFAULT_ASR_BUDGET_MS } from './ai-runtime/asr-pacing.ts'
import { fetchAudioBytes } from './video-index/asr-audio.ts'
import { captionCapable } from './ai-runtime/caption-run.ts'
import { decodeTo16k } from './ai-runtime/asr-run.ts'
import { captionInWorker, ocrInWorker, transcribeInWorker } from './ai-runtime/worker-bridge.ts'
import { commitImageEvidence } from './image-evidence.ts'
import type { VideoIndexCallContext } from './image-evidence.ts'
import { createVideoIndexEngine } from './video-index/engine.ts'
import { renderText } from './video-index/render.ts'
import { VideoIndexStore } from './video-index/store.ts'
import { VideoIndexError } from './video-index/types.ts'
import type { AsrTranscriptOutcome } from './video-index/types.ts'
import type { VideoIndexDeps } from './video-index/engine.ts'
import type { VideoIndexToolValue, ZoomHost, ZoomOutcome } from './video-index/types.ts'

/** Deployment-varying budget of the local transcription lane; every field has a documented default. */
export interface Config {
  /**
   * Wall-clock budget of one local transcription in ms (default 300000). A
   * machine too slow for the whole audio stops there and keeps the
   * transcript so far.
   */
  asrBudgetMs?: number
}

/** Schemastery config with the loaded defaults. */
export const Config: z<Config> = z.object({
  asrBudgetMs: z.number().step(1).min(1_000).default(DEFAULT_ASR_BUDGET_MS),
})

/** Services the tool reads: the tool registry, the OPFS world, the browser seam. */
export const inject = ['tools', 'fs', 'browser'] as const

/**
 * Resolve the transcription budget from the loaded config.
 * @param config - the plugin config (already through the schema when the loader built it).
 * @returns the budget in ms; the default when the field is absent.
 */
export function resolveAsrBudgetMs(config: Config): number {
  return config.asrBudgetMs ?? DEFAULT_ASR_BUDGET_MS
}

/**
 * The one tool call's deadline. It sits above the transcription budget plus
 * the worker bridge's slack (budget + 60 s, one attempt): a slow machine
 * ends with a partial transcript inside the deadline, never with the
 * deadline itself.
 */
const TOOL_TIMEOUT_MS = 480_000

/** The model-facing argument record for one tool call. */
export interface VideoIndexActionArgs {
  action: 'index' | 'query' | 'status' | 'list' | 'remove' | 'zoom'
  url?: string
  page?: number
  videoKey?: string
  question?: string
  mode?: string
  timestampMs?: number
}

/** One-shot zoom counter for attachment display names. */
let zoomSeq = 0

/**
 * Read burned-in subtitle lines off one captured frame with the local OCR
 * engine. Best-effort and optional: an uninstalled model, a decode failure,
 * or a crashed inference degrades to no lines — the frame itself is still
 * committed, so the zoom path never fails because OCR did.
 * @param frame - the captured PNG frame.
 * @returns the recognized lines, empty when OCR is unavailable or found nothing.
 */
async function readFrameSubtitles(
  frame: { data: Uint8Array; width: number; height: number },
  recorder: VideoIndexDeps['usageRecorder'] | undefined,
): Promise<string[]> {
  const startedAt = Date.now()
  try {
    if (!(await modelInstalled(OCR_PPOCR_MOBILE_SPEC, opfsModelStore()))) return []
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(frame.data)], { type: 'image/png' }))
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d')
      if (context === null) return []
      context.drawImage(bitmap, 0, 0)
      const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height)
      const outcome = await ocrInWorker(imageData.data, bitmap.width, bitmap.height) as { lines?: string[] }
      const lines = outcome.lines ?? []
      await recorder?.({
        capability: 'ocr',
        model: 'PP-OCRv4-mobile',
        durationMs: Date.now() - startedAt,
        detail: (lines.join(' ') || '(未识别出文本)').slice(0, 80),
      })
      return lines
    } finally {
      bitmap.close()
    }
  } catch {
    return []
  }
}

/**
 * Describe the frame with the local VLM (WebGPU tier only — the wasm
 * fallback of a generative VLM is not usable on the interactive path).
 * Best-effort: an unloaded pipeline, a blocked adapter, or an inference
 * failure degrades to undefined.
 */
async function readFrameCaption(
  frame: { data: Uint8Array; width: number; height: number },
  tier: (() => Promise<'real' | 'software' | 'unavailable'>) | undefined,
  recorder: VideoIndexDeps['usageRecorder'] | undefined,
): Promise<string | undefined> {
  const startedAt = Date.now()
  try {
    if (tier === undefined) return undefined
    if (!captionCapable(await tier())) return undefined
    // The frame rides a data URL — ImageBitmap cannot cross the worker
    // boundary with the request envelope's other fields intact.
    const blob = new Blob([new Uint8Array(frame.data)], { type: 'image/png' })
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') resolve(reader.result)
        else reject(new Error('帧数据读取结果不是 data URL'))
      }
      reader.onerror = () => { reject(new Error('帧数据读取失败')) }
      reader.readAsDataURL(blob)
    })
    const outcome = await captionInWorker(dataUrl) as { caption?: string }
    const caption = outcome.caption
    if (caption !== undefined) {
      await recorder?.({
        capability: 'caption',
        model: 'SmolVLM2-256M',
        durationMs: Date.now() - startedAt,
        detail: caption.slice(0, 80),
      })
    }
    return caption
  } catch {
    return undefined
  }
}

/**
 * Commit one captured frame through the shared image-evidence lane, persist
 * the citation into the index's frame-evidence store, and fold the
 * reference into the tool value. Gates run in the shared commit; the
 * wrapper only maps the outcome onto the tool value.
 * @param outcome - the engine's frame outcome.
 * @param deps - the host dependencies (the fs seam for the evidence index).
 * @param host - the call-time attachment/llm services.
 * @param exec - the tool-execution context.
 * @returns the final tool value (image reference, frame bytes dropped).
 */
async function commitZoomFrame(
  outcome: ZoomOutcome,
  deps: VideoIndexDeps,
  host: ZoomHost | undefined,
  exec: VideoIndexCallContext,
): Promise<VideoIndexToolValue> {
  const base: VideoIndexToolValue = {
    ok: outcome.ok,
    action: 'zoom',
    ...(outcome.videoKey === undefined ? {} : { videoKey: outcome.videoKey }),
    ...(outcome.timestampMs === undefined ? {} : { timestampMs: outcome.timestampMs }),
    ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
    ...(outcome.frame === undefined ? {} : { seekedToMs: outcome.frame.seekedToMs }),
  }
  if (!outcome.ok || outcome.frame === undefined) {
    return { ...base, ok: false, error: outcome.error ?? '截帧失败' }
  }
  zoomSeq += 1
  const name = `video-zoom-${String(outcome.timestampMs ?? 0)}-${String(zoomSeq)}.png`
  const committed = await commitImageEvidence(outcome.frame, host, exec, name)
  if (!committed.ok) {
    return { ...base, ok: false, error: committed.error }
  }
  const image = { ...committed.image, mediaType: 'image/png' as const }
  // The local enrichment reads ride the committed frame; neither blocks nor
  // fails the zoom (OCR degrades to [], caption degrades to undefined).
  // Caption additionally gates on the installed row — an uninstalled model
  // must NEVER trigger its download inside a zoom call.
  const ocrLines = await readFrameSubtitles(outcome.frame, deps.usageRecorder)
  const captionInstalled = deps.captionReady === undefined || await deps.captionReady()
  const caption = captionInstalled
    ? await readFrameCaption(outcome.frame, deps.captionTier, deps.usageRecorder)
    : undefined
  const enriched: VideoIndexToolValue = {
    ...base,
    image,
    ...(ocrLines.length > 0 ? { ocrLines } : {}),
    ...(caption === undefined || caption.length === 0 ? {} : { caption }),
  }
  // Evidence-index persistence is best-effort and needs an index to file the
  // frame under: a zoom by video page URL has none, and its frame is already
  // durably committed through the attachment lane.
  if (outcome.videoKey === undefined) return enriched
  try {
    const store = new VideoIndexStore(deps.fs)
    const appended = await store.appendFrameEvidence(outcome.videoKey, {
      attachmentId: committed.image.attachmentId,
      mediaType: committed.image.mediaType,
      file: name,
      startMs: outcome.timestampMs ?? 0,
      width: committed.image.width,
      height: committed.image.height,
      createdAt: Date.now(),
    }, exec.signal)
    return { ...enriched, frameId: appended.frameId }
  } catch (err: unknown) {
    void err
    return enriched
  }
}

/**
 * Run one tool call through the engine, reporting expected failures as
 * `{ ok: false, error }` instead of throwing. Zoom outcomes pass through
 * the attachment/route enrichment before returning.
 * @param args - the parsed tool arguments.
 * @param deps - the host dependencies (fs seam + fetch lanes + zoom services).
 * @param exec - the calling execution (cancellation signal + agent for route gating).
 * @returns the model-facing outcome.
 */
export async function runVideoIndexAction(
  args: VideoIndexActionArgs,
  deps: VideoIndexDeps,
  exec: VideoIndexCallContext,
): Promise<VideoIndexToolValue> {
  const signal = exec.signal
  const engine = createVideoIndexEngine(deps)
  const ask = (request: { videoKey: string; question: string; mode?: string }): Promise<VideoIndexToolValue> =>
    engine.query(request, signal)
  const action = args.action
  const url = args.url ?? ''
  const videoKey = args.videoKey ?? ''
  const question = args.question ?? ''
  const mode = args.mode
  try {
    if (action === 'index') {
      const request = args.page === undefined ? { url } : { url, page: args.page }
      return await engine.index(request, signal)
    }
    if (action === 'query') {
      const request = mode === undefined ? { videoKey, question } : { videoKey, question, mode }
      return await ask(request)
    }
    if (action === 'status') {
      const request = { videoKey }
      return await engine.status(request, signal)
    }
    if (action === 'list') {
      const outcome = await engine.list(signal)
      return outcome
    }
    if (action === 'remove') {
      const request = { videoKey }
      return await engine.remove(request, signal)
    }
    if (action === 'zoom') {
      const request = {
        videoKey,
        ...(args.url === undefined ? {} : { url: args.url }),
        ...(args.timestampMs === undefined ? {} : { timestampMs: args.timestampMs }),
      }
      const outcome = await engine.zoom(request, signal)
      return await commitZoomFrame(outcome, deps, deps.zoomHost, exec)
    }
    const unknown: never = action
    return { ok: false, action: unknown, error: '未知动作' }
  } catch (err: unknown) {
    if (err instanceof VideoIndexError) {
      return { ok: false, action, error: err.message }
    }
    throw err
  }
}

/** The output schema literal, kept at module scope to stay readable. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    action: { type: 'string', required: true },
    error: { type: 'string' },
    videoKey: { type: 'string' },
    title: { type: 'string' },
    durationMs: { type: 'integer' },
    utteranceCount: { type: 'integer' },
    chunkCount: { type: 'integer' },
    subtitleSource: { type: 'string' },
    subtitleLan: { type: 'string' },
    asrError: { type: 'string' },
    asrCoveredMs: { type: 'integer' },
    mode: { type: 'string' },
    matched: { type: 'integer' },
    truncated: { type: 'boolean' },
    context: { type: 'string' },
    revision: { type: 'integer' },
    frameCount: { type: 'integer' },
    frameId: { type: 'string' },
    timestampMs: { type: 'integer' },
    seekedToMs: { type: 'integer' },
    image: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', enum: ['image/png'], required: true },
        bytes: { type: 'integer', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
        name: { type: 'string' },
      },
    },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subtitle: { type: 'string', required: true },
        subtitleSource: { type: 'string', required: true },
        visual: { type: 'string', required: true },
        asr: { type: 'string', required: true },
        asrError: { type: 'string' },
        asrCoveredMs: { type: 'integer' },
      },
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          evidenceId: { type: 'string', required: true },
          startMs: { type: 'integer', required: true },
          endMs: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      },
    },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          videoKey: { type: 'string', required: true },
          title: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
          indexedAt: { type: 'integer', required: true },
          subtitleSource: { type: 'string', required: true },
          utteranceCount: { type: 'integer', required: true },
        },
      },
    },
  },
} as const

/**
 * Register the `video_index` tool. Split from apply() so tests drive it with
 * fake seams.
 * @param tools - the tool registry face (ctx.tools).
 * @param deps - the host dependencies captured at registration time.
 * @param host - the call-time zoom enrichment services (attachments + llm).
 */
export function registerVideoIndexTool(tools: { register(tool: unknown): void }, deps: VideoIndexDeps, host?: ZoomHost): void {
  if (host !== undefined) deps.zoomHost = host
  tools.register(defineTool({
    name: 'video_index',
    description: 'B 站视频的画面证据与索引问答。zoom 动作直接传视频页 URL 和时间点（timestampMs），打开视频页、把真实播放器定位到该时刻并截取画面帧返回（帧里的烧录字幕会被本地 OCR 读出）——不请求 B 站接口，默认可用（需网页截图能力开启且模型支持图片输入）。index 动作要直接请求 B 站接口拉取字幕建全片索引（无字幕时转而下载音频做本地转写），这会触发风控、有封号风险，默认被禁止：只有用户明确要求并已在内置能力里开启「直接请求站点接口」时才用；开启后先用 index 建索引，再用 query 按问题检索带 [mm:ss–mm:ss] 时间戳与 EVID 编号的台词证据。索引存于扩展 OPFS；列表动作查看，删除动作只删索引不删原视频。',
    parameters: {
      action: {
        type: 'string',
        enum: ['index', 'query', 'status', 'list', 'remove', 'zoom'],
        required: true,
        description: 'zoom=按时间点截取画面帧（传 url 或 videoKey）；query=按问题检索证据；index=建索引（直接请求 B 站接口，默认禁止）；status=单个索引状态；list=列出全部索引；remove=删除索引',
      },
      url: { type: 'string', description: 'B 站视频页 URL（https://www.bilibili.com/video/BV…，可带 ?p=N）或 BV 号；index 时必填；zoom 时可代替 videoKey 直接传（不需要索引）' },
      page: { type: 'integer', description: '分P 页码（默认 1）' },
      videoKey: { type: 'string', description: '索引键（index 的返回值给出）；query/status/remove 时必填；zoom 时可改传 url' },
      question: { type: 'string', description: '问题；提问动作必填' },
      mode: { type: 'string', enum: ['auto', 'text', 'time', 'overview', 'visual'], description: '查询模式，默认 auto（自动路由）' },
      timestampMs: { type: 'integer', description: 'zoom 的画面时间点（毫秒，60000 = 第 1 分钟）；zoom 时必填' },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => renderBlocks(value as VideoIndexToolValue),
    },
    async execute(args, exec) {
      return runVideoIndexAction(args, deps, exec)
    },
    presentCall: () => ({ card: 'generic', title: '视频索引', kind: 'other' }),
  }))
}

/**
 * Build the model-facing content blocks for one outcome: the render text,
 * plus the image block when a zoom frame was committed.
 * @param value - the tool outcome.
 * @returns the content blocks (text, then image for zoom evidence).
 */
function renderBlocks(value: VideoIndexToolValue): ContentBlock[] {
  const text = renderText(value)
  if (value.ok && value.action === 'zoom' && value.image !== undefined) {
    return [
      { type: 'text', text },
      {
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(value.image.attachmentId),
          mediaType: value.image.mediaType,
          bytes: value.image.bytes,
          width: value.image.width,
          height: value.image.height,
          ...(value.image.name === undefined ? {} : { name: value.image.name }),
        },
      },
    ]
  }
  return [{ type: 'text', text }]
}

/**
 * Register the tool on the real seams: the OPFS fs and the browser seam.
 * The provider is resolved lazily at call time — this row mounts before the
 * provider row in the composition line, and the seam's `provider` getter
 * throws until a provider registers.
 * @param ctx - the cordis context.
 * @param config - the plugin config (the transcription budget).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const asrBudgetMs = resolveAsrBudgetMs(config)
  const provider = () => ctx.browser.provider
  registerVideoIndexTool(ctx.tools, {
    fs: ctx.fs,
    page: {
      tabs: () => provider().tabs(),
      evaluate: (tabId: number, expression: string): Promise<string> =>
        provider().evaluate<string>(tabId, expression),
    },
    zoom: {
      tabs: () => provider().tabs(),
      evaluate: (tabId: number, expression: string): Promise<string> =>
        provider().evaluate<string>(tabId, expression),
      navigate: (tabId: number, url: string) => provider().navigate(tabId, url),
      openTab: (url: string) => provider().openTab(url, { active: false }),
      closeTab: (tabId: number) => provider().closeTab(tabId),
      screenshot: (tabId: number) => provider().screenshot(tabId),
    },
    // The caption gate reads the device tier lazily: this row mounts before
    // chrome-ai-runtime in the composition line, and the aiLocal probe cache
    // makes repeat zooms cheap.
    captionTier: async () => {
      const aiLocal = ctx.get('aiLocal') as { probe(): Promise<{ webgpu: 'real' | 'software' | 'unavailable' }> } | undefined
      if (aiLocal === undefined) return 'unavailable'
      return (await aiLocal.probe()).webgpu
    },
    // The usage ledger recorder: every real OCR/caption/ASR inference lands
    // in the aiLocal ledger (the 本地 AI card and probes read it back).
    usageRecorder: async (entry) => {
      await ctx.get('aiLocal')?.recordUsage(entry)
    },
    // The caption readiness gate reads the persisted aiLocal row — the zoom
    // enrichment must never trigger a download mid-call.
    captionReady: async () => {
      const aiLocal = ctx.get('aiLocal') as { catalog(): Promise<{ models: Array<{ id: string; state: string }> }> } | undefined
      if (aiLocal === undefined) return false
      const view = await aiLocal.catalog()
      return view.models.some(model => model.id === 'caption-smolvlm2-256m' && model.state === 'ready')
    },
    // The local ASR seam: readiness reads the persisted aiLocal row (no
    // download side effect), and transcribeUrl chains the fetch/decode/
    // transcribe pipeline from ai-runtime. The engine only calls this after
    // the subtitle lanes produced nothing.
    asr: {
      ready: async () => {
        const aiLocal = ctx.get('aiLocal') as { catalog(): Promise<{ models: Array<{ id: string; state: string }> }> } | undefined
        if (aiLocal === undefined) return false
        const view = await aiLocal.catalog()
        return view.models.some(model => model.id === 'asr-whisper-base' && model.state === 'ready')
      },
      transcribeUrl: async (audioUrl: string, signal?: AbortSignal) => {
        // Decode on the main context (AudioContext is main-only), infer in
        // the worker under the configured budget. Each stage is timed: the
        // ledger then says where a slow transcription spent its wait.
        const fetchBegan = performance.now()
        const bytes = await fetchAudioBytes((globalThis as { fetch: typeof fetch }).fetch, audioUrl, signal)
        const decodeBegan = performance.now()
        const samples = await decodeTo16k(bytes)
        const transcribeBegan = performance.now()
        const outcome = asrOutcomeFromWorker(await transcribeInWorker(samples, asrBudgetMs))
        return {
          ...outcome,
          timings: {
            fetchMs: Math.round(decodeBegan - fetchBegan),
            decodeMs: Math.round(transcribeBegan - decodeBegan),
            transcribeMs: Math.round(performance.now() - transcribeBegan),
          },
        }
      },
    },
  }, {
    attachments: () => ctx.get('attachments'),
    llm: () => ctx.get('llm'),
  })
}

/**
 * Narrow the worker's transcript reply to the ASR seam's outcome. The reply
 * crosses the worker boundary, so every field is checked; a reply without a
 * well-formed segment list is a failure, not an empty transcript.
 * @param raw - the worker's reply.
 * @returns the transcript in milliseconds.
 */
export function asrOutcomeFromWorker(raw: unknown): AsrTranscriptOutcome {
  if (raw === null || typeof raw !== 'object') throw new Error('转写结果格式异常')
  const { segments, processedMs, truncated } = raw as { segments?: unknown; processedMs?: unknown; truncated?: unknown }
  if (!Array.isArray(segments)) throw new Error('转写结果缺少台词列表')
  const mapped = segments.flatMap((item: unknown) => {
    if (item === null || typeof item !== 'object') return []
    const { start, end, text } = item as { start?: unknown; end?: unknown; text?: unknown }
    if (typeof start !== 'number' || !Number.isFinite(start) || typeof text !== 'string') return []
    const startMs = Math.round(start * 1000)
    const endMs = typeof end === 'number' && Number.isFinite(end) ? Math.round(end * 1000) : startMs
    return [{ startMs, endMs, text }]
  })
  return {
    segments: mapped,
    ...(typeof processedMs === 'number' && Number.isFinite(processedMs) && processedMs > 0 ? { coveredMs: Math.round(processedMs) } : {}),
    ...(truncated === true ? { truncated: true } : {}),
  }
}
