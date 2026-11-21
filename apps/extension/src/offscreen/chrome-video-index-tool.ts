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
import { commitImageEvidence } from './image-evidence.ts'
import type { VideoIndexCallContext } from './image-evidence.ts'
import { createVideoIndexEngine } from './video-index/engine.ts'
import { renderText } from './video-index/render.ts'
import { VideoIndexStore } from './video-index/store.ts'
import { VideoIndexError } from './video-index/types.ts'
import type { VideoIndexDeps } from './video-index/engine.ts'
import type { VideoIndexToolValue, ZoomHost, ZoomOutcome } from './video-index/types.ts'

/** Tools carry no config today. */
export interface Config {}

/** Services the tool reads: the tool registry, the OPFS world, the browser seam. */
export const inject = ['tools', 'fs', 'browser'] as const

/** The one tool call's deadline (network fetches plus chunk writes). */
const TOOL_TIMEOUT_MS = 120_000

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
  // Evidence-index persistence is best-effort: the frame itself is already
  // durably committed through the attachment lane.
  try {
    const store = new VideoIndexStore(deps.fs)
    const appended = await store.appendFrameEvidence(outcome.videoKey ?? '', {
      attachmentId: committed.image.attachmentId,
      mediaType: committed.image.mediaType,
      file: name,
      startMs: outcome.timestampMs ?? 0,
      width: committed.image.width,
      height: committed.image.height,
      createdAt: Date.now(),
    }, exec.signal)
    return { ...base, image, frameId: appended.frameId }
  } catch (err: unknown) {
    void err
    return { ...base, image }
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
      const request = args.timestampMs === undefined ? { videoKey } : { videoKey, timestampMs: args.timestampMs }
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
    description: '字幕优先的长视频索引问答（B 站）。先用 index 动作建立全片索引（从 B 站拉取官方/AI 字幕，零下载建索引），再用提问动作检索；返回带 [mm:ss–mm:ss] 时间戳与 EVID 编号的台词证据，引用时给出时间点。要看某个时间点的画面 → zoom 动作（timestampMs）截取真实视频帧返回给你（需网页截图能力开启且模型支持图片输入）。提问建议：整片概览 → 问「整个视频讲了什么」；定位 → 问「第 12 分钟」「片尾」「开头」；找内容 → 直接给关键词；看画面 → 先文本定位再 zoom。索引存于扩展 OPFS；列表动作查看，删除动作只删索引不删原视频。',
    parameters: {
      action: {
        type: 'string',
        enum: ['index', 'query', 'status', 'list', 'remove', 'zoom'],
        required: true,
        description: 'index=建索引；query=按问题检索证据；status=单个索引状态；list=列出全部索引；remove=删除索引；zoom=按时间点截取画面帧',
      },
      url: { type: 'string', description: 'B 站视频页 URL（https://www.bilibili.com/video/BV…，可带 ?p=N）或 BV 号；index 时必填' },
      page: { type: 'integer', description: '分P 页码（默认 1）' },
      videoKey: { type: 'string', description: '索引键（index 的返回值给出）；其余动作必填' },
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
 * @param _config - unused config.
 */
export function apply(ctx: Context, _config: Config): void {
  void _config
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
  }, {
    attachments: () => ctx.get('attachments'),
    llm: () => ctx.get('llm'),
  })
}
