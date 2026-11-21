/**
 * `chrome-sense-now-tool`: the model-facing `sense_now` tool — the extension
 * port of Sense Now's companion watching. The agent drives the loop: each
 * `watch` call captures a bounded round of the user's active-window visible
 * tab (JPEG frames over the `dsh-sense` channel), diffs them on a 32×18
 * luminance grid, keeps the frames that cross the pace bar, and montages the
 * kept set into one sheet image committed through the durable attachment
 * lane. A `watch` round lasts ~4s — the agent re-calls to keep watching,
 * which is the queue-model replacement for Sense Now's blocking watch.
 * 「网页截图」capability gates every capture; `say` rides the render text.
 *
 * @module chrome-sense-now-tool
 */
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-browser'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { commitImageEvidence } from './image-evidence.ts'
import type { VideoIndexCallContext } from './image-evidence.ts'
import { gridDiff, sampleGrid, shouldKeepFrame } from './sense-now/grid.ts'
import type { FrameGrid, WatchPace } from './sense-now/grid.ts'
import { sheetLayout } from './sense-now/sheets.ts'
import type { SheetFrame } from './sense-now/sheets.ts'
import { SenseWatchSessions } from './sense-now/session.ts'
import type { SenseWatchSession } from './sense-now/session.ts'
import { isCapabilityEnabled, SCREENSHOT_CAPABILITY_KEY } from '../chrome/browser-provider.ts'
import { SENSE_CHANNEL } from '../shared/protocol.ts'
import type { SenseCaptureResponse } from '../shared/protocol.ts'
import { VideoIndexError } from './video-index/types.ts'
import type { ZoomHost } from './video-index/types.ts'

/** Tools carry no config today. */
export interface Config {}

/** Services the tool reads: the tool registry, the browser seam. */
export const inject = ['tools', 'browser'] as const

/** The one tool call's deadline (a watch round captures four spaced frames). */
const TOOL_TIMEOUT_MS = 60_000

/** Frames captured per watch round (spaced below the 2/s capture quota). */
const WATCH_ROUND_FRAMES = 4

/** Spacing between a round's captures (ms) — respects the 2/s quota. */
const WATCH_ROUND_SPACING_MS = 900

/** The session registry (one live watch). */
const sessions = new SenseWatchSessions()

/** One-shot sheet counter for attachment display names. */
let sheetSeq = 0

/** The model-facing argument record for one tool call. */
export interface SenseNowActionArgs {
  action: 'watch' | 'peek' | 'status' | 'stop'
  pace?: WatchPace
  say?: string
}

/** One committed sheet reference (attachment-store fields). */
export interface SenseNowImageRef {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
}

/**
 * The model-facing tool outcome (output-schema shaped: no frame bytes — the
 * sheet rides the render's image block).
 */
export interface SenseNowToolValue {
  ok: boolean
  action: SenseNowActionArgs['action']
  error?: string
  sessionId?: string
  pace?: WatchPace
  changed?: boolean
  rounds?: number
  keptTotal?: number
  image?: SenseNowImageRef
}

/**
 * Send one capture request to the service worker and await the outcome
 * (the download-tool's channel pattern).
 * @param windowId - the target window, or undefined for the focused one.
 * @returns the capture response.
 */
function requestCapture(windowId: number | undefined): Promise<SenseCaptureResponse> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { channel: SENSE_CHANNEL, ...(windowId === undefined ? {} : { windowId }) },
        (response: unknown) => {
          if (chrome.runtime.lastError !== undefined) {
            resolve({ ok: false, error: chrome.runtime.lastError.message ?? '陪看采集通道不可用' })
            return
          }
          resolve((response ?? { ok: false, error: '陪看采集通道无响应' }) as SenseCaptureResponse)
        },
      )
    } catch (err: unknown) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

/**
 * Decode one JPEG data URL into the sampling grid (the offscreen document
 * owns the canvas). createImageBitmap avoids the DOM Image element entirely
 * — `new Image().decode()` never settles in a hidden offscreen document.
 * @param dataUrl - the captured frame.
 * @returns the grid plus intrinsic size.
 */
async function decodeGrid(dataUrl: string): Promise<{ grid: FrameGrid; width: number; height: number }> {
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  const width = bitmap.width
  const height = bitmap.height
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    throw new VideoIndexError('画布 2D 上下文不可用', 'VIDEO_INDEX_API_ERROR')
  }
  ctx.drawImage(bitmap, 0, 0)
  const { data } = ctx.getImageData(0, 0, width, height)
  bitmap.close()
  return { grid: sampleGrid(data, width, height), width, height }
}

/**
 * Load one data URL image as a bitmap.
 * @param dataUrl - the image URL.
 * @returns the decoded bitmap.
 */
async function loadBitmap(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob()
  return createImageBitmap(blob)
}

/**
 * Capture one frame and diff it against the session's last grid.
 * @param session - the live session.
 * @param roundIndex - zero-based index within this round.
 * @returns the decoded capture plus the keep decision.
 */
async function captureAndDiff(session: SenseWatchSession, roundIndex: number): Promise<{ dataUrl: string; kept: boolean }> {
  const response = await requestCapture(session.windowId)
  if (!response.ok || response.dataUrl === undefined) {
    throw new VideoIndexError(response.error ?? '陪看采集失败', 'VIDEO_INDEX_FETCH_FAILED')
  }
  const decoded = await decodeGrid(response.dataUrl)
  const diff = session.lastGrid === undefined ? { mean: 1, spikes: 0 } : gridDiff(session.lastGrid, decoded.grid)
  const kept = shouldKeepFrame(diff, session.pace, roundIndex)
  session.lastGrid = decoded.grid
  session.lastCaptureAt = Date.now()
  return { dataUrl: response.dataUrl, kept }
}

/**
 * Commit one sheet: montage, byte-convert, and durable-commit.
 * @param session - the live session (elapsed time labels).
 * @param frames - the kept frames (≤ 4).
 * @param host - the call-time attachment/llm services.
 * @param exec - the calling execution.
 * @returns the committed image reference, or the honest refusal.
 */
async function commitSheet(
  session: SenseWatchSession,
  frames: SheetFrame[],
  host: ZoomHost | undefined,
  exec: VideoIndexCallContext,
): Promise<{ ok: true; image: SenseNowImageRef } | { ok: false; error: string }> {
  const sheetFrames = frames.slice(0, 4)
  const first = await loadBitmap(sheetFrames[0]?.dataUrl ?? '')
  const layout = sheetLayout(sheetFrames.length, first.width, first.height)
  const canvas = document.createElement('canvas')
  canvas.width = layout.canvasW
  canvas.height = layout.canvasH
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    throw new VideoIndexError('画布 2D 上下文不可用', 'VIDEO_INDEX_API_ERROR')
  }
  for (let index = 0; index < sheetFrames.length; index += 1) {
    const frame = sheetFrames[index]
    const position = layout.positions[index]
    if (frame === undefined || position === undefined) continue
    const image = index === 0 ? first : await loadBitmap(frame.dataUrl)
    ctx.drawImage(image, position.x, position.y, layout.cellW, layout.cellH)
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(position.x, position.y, 96, 18)
    ctx.fillStyle = '#ffffff'
    ctx.font = '12px monospace'
    ctx.fillText(`#${String(index + 1)} ${frame.atSec.toFixed(1)}s`, position.x + 4, position.y + 13)
  }
  const dataUrl = canvas.toDataURL('image/jpeg', 0.6)
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  sheetSeq += 1
  const committed = await commitImageEvidence(
    { data: bytes, width: layout.canvasW, height: layout.canvasH },
    host,
    exec,
    `sense-watch-${String(session.sessionId)}-${String(sheetSeq)}.jpg`,
  )
  if (!committed.ok) return committed
  const mediaType = committed.image.mediaType === 'image/png' ? 'image/png' : 'image/jpeg'
  return { ok: true, image: { ...committed.image, mediaType } }
}

/**
 * Run one tool call through the watch state machine, reporting expected
 * failures as `{ ok: false, error }` instead of throwing.
 * @param args - the parsed tool arguments.
 * @param host - the call-time attachment/llm services for sheet commit.
 * @param exec - the calling execution (route gating for images).
 * @returns the model-facing outcome.
 */
export async function runSenseNowAction(
  args: SenseNowActionArgs,
  host: ZoomHost | undefined,
  exec: VideoIndexCallContext,
): Promise<SenseNowToolValue> {
  const capability = await isCapabilityEnabled(SCREENSHOT_CAPABILITY_KEY, false)
  if (!capability) {
    return { ok: false, action: args.action, error: '网页截图能力未启用：请在侧栏「用户插件」面板中勾选「网页截图」' }
  }
  try {
    if (args.action === 'watch') {
      const live = sessions.active()
      const session = sessions.start(live?.windowId, args.pace)
      const kept: SheetFrame[] = []
      for (let roundIndex = 0; roundIndex < WATCH_ROUND_FRAMES; roundIndex += 1) {
        const { dataUrl, kept: frameKept } = await captureAndDiff(session, roundIndex)
        if (frameKept) {
          kept.push({ dataUrl, atSec: (Date.now() - session.startedAt) / 1000, kept: true })
          session.keptTotal += 1
        }
        if (roundIndex < WATCH_ROUND_FRAMES - 1) {
          await new Promise(resolve => setTimeout(resolve, WATCH_ROUND_SPACING_MS))
        }
      }
      session.rounds += 1
      if (kept.length === 0) {
        return { ok: true, action: 'watch', sessionId: session.sessionId, pace: session.pace, changed: false, rounds: session.rounds, keptTotal: session.keptTotal }
      }
      const committed = await commitSheet(session, kept, host, exec)
      if (!committed.ok) {
        return { ok: false, action: 'watch', sessionId: session.sessionId, pace: session.pace, error: committed.error }
      }
      return {
        ok: true, action: 'watch', sessionId: session.sessionId, pace: session.pace, changed: true,
        rounds: session.rounds, keptTotal: session.keptTotal, image: committed.image,
      }
    }
    if (args.action === 'peek') {
      const live = sessions.active()
      const session = sessions.start(live?.windowId, args.pace)
      const { dataUrl, kept } = await captureAndDiff(session, session.rounds === 0 ? 0 : 1)
      session.rounds += 1
      if (!kept) {
        return { ok: true, action: 'peek', sessionId: session.sessionId, changed: false, rounds: session.rounds, keptTotal: session.keptTotal }
      }
      const committed = await commitSheet(session, [{ dataUrl, atSec: (Date.now() - session.startedAt) / 1000, kept: true }], host, exec)
      if (!committed.ok) {
        return { ok: false, action: 'peek', sessionId: session.sessionId, error: committed.error }
      }
      return {
        ok: true, action: 'peek', sessionId: session.sessionId, changed: true,
        rounds: session.rounds, keptTotal: session.keptTotal, image: committed.image,
      }
    }
    if (args.action === 'status') {
      const live = sessions.active()
      if (live === undefined) {
        return { ok: true, action: 'status' }
      }
      return { ok: true, action: 'status', sessionId: live.sessionId, pace: live.pace, rounds: live.rounds, keptTotal: live.keptTotal }
    }
    if (args.action === 'stop') {
      const live = sessions.active()
      const removed = live === undefined ? false : sessions.stop(live.sessionId)
      return { ok: true, action: 'stop', ...(live?.sessionId === undefined ? {} : { sessionId: live.sessionId }), changed: removed }
    }
    return { ok: false, action: args.action, error: '未知动作' }
  } catch (err: unknown) {
    if (err instanceof VideoIndexError) {
      return { ok: false, action: args.action, error: err.message }
    }
    throw err
  }
}

/**
 * Build the model-facing content blocks for one outcome: the summary text
 * (with the user-facing `say` line) plus the sheet image when present.
 * @param value - the tool outcome.
 * @param say - the user-facing narration line.
 * @returns the content blocks.
 */
function renderBlocks(value: SenseNowToolValue, say: string | undefined): ContentBlock[] {
  let text: string
  if (!value.ok) {
    text = `失败：${value.error ?? '未知原因'}`
  } else if (value.action === 'watch' || value.action === 'peek') {
    const changed = value.changed === true
    text = changed
      ? `陪看拼图已提交（${String(value.image?.width ?? 0)}×${String(value.image?.height ?? 0)}，累计保留 ${String(value.keptTotal ?? 0)} 帧）。引用画面时说明对应时间点。`
      : '本轮无显著画面变化——继续 watch 会在下一轮再采样；长时间无变化可 pace=calm 降噪。'
  } else if (value.action === 'status') {
    text = value.sessionId === undefined
      ? '当前没有进行中的陪看会话——用 watch 开始。'
      : `陪看会话 ${value.sessionId}：pace ${value.pace ?? '-'}，${String(value.rounds ?? 0)} 轮 / 累计保留 ${String(value.keptTotal ?? 0)} 帧。`
  } else {
    text = value.changed === true ? `陪看已结束（会话 ${value.sessionId ?? ''}）。` : '本来就没有进行中的陪看会话。'
  }
  if (say !== undefined && say !== '') {
    text += `\n[对用户说] ${say}`
  }
  if (value.image === undefined || value.ok !== true) {
    return [{ type: 'text', text }]
  }
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

/**
 * Register the `sense_now` tool. Split from apply() so tests drive it with
 * fake seams.
 * @param tools - the tool registry face (ctx.tools).
 * @param host - the call-time attachment/llm services.
 */
export function registerSenseNowTool(tools: { register(tool: unknown): void }, host?: ZoomHost): void {
  tools.register(defineTool({
    name: 'sense_now',
    description: '实时陪看：采样用户当前窗口的可见页面，差分留帧后把拼图返回给你，一边看一边讲解。每次 watch 是一轮有界采样（约 4 秒 4 帧），返回拼图或「无显著变化」；要持续看就连续调用 watch（不要结束回合）；用户嫌密/贵就 pace=calm。say 参数写你要让用户听到的话（会显示在会话轨迹）。开始前用 peek 单帧快看；status 查会话；stop 结束。需要「网页截图」能力开启，且模型支持图片输入。',
    parameters: {
      action: {
        type: 'string',
        enum: ['watch', 'peek', 'status', 'stop'],
        required: true,
        description: 'watch=采样一轮（连续陪看就反复调用）；peek=单帧快看；status=会话状态；stop=结束陪看',
      },
      pace: { type: 'string', enum: ['calm', 'normal', 'dense'], description: '留帧密度：calm=只留硬切、normal=默认、dense=高密度；用户嫌密/贵立即换 calm' },
      say: { type: 'string', description: '要对用户说的话（随结果展示在会话轨迹）' },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          error: { type: 'string' },
          sessionId: { type: 'string' },
          pace: { type: 'string' },
          changed: { type: 'boolean' },
          rounds: { type: 'integer' },
          keptTotal: { type: 'integer' },
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (args, value) => renderBlocks(value as SenseNowToolValue, (args as { say?: string }).say),
    },
    async execute(args, exec) {
      return runSenseNowAction(args, host, exec)
    },
    presentCall: () => ({ card: 'generic', title: '实时陪看', kind: 'read' }),
  }))
}

/**
 * Register the tool on the real seams.
 * @param ctx - the cordis context.
 * @param _config - unused config.
 */
export function apply(ctx: Context, _config: Config): void {
  void _config
  registerSenseNowTool(ctx.tools, {
    attachments: () => ctx.get('attachments'),
    llm: () => ctx.get('llm'),
  })
}
