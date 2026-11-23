/**
 * The on-device AI worker (batch 276 fix): every model inference — OCR,
 * caption, ASR, and the pipeline warm-ups — runs HERE, in a dedicated
 * module worker, never on the offscreen document's main execution context.
 * Creating an onnxruntime session on the main context was observed to
 * permanently stall the agent loop's LLM requests (the video-index probe's
 * bisection: install-without-load passes, install breaks every subsequent
 * turn), so the worker boundary is the product contract, not an
 * optimization.
 *
 * Protocol: one request `{ id, kind, ... }` in, one reply `{ id, ok,
 * result | error }` out. Binary payloads (frame pixels, audio bytes) ride
 * structured clone.
 *
 * @module ai-worker
 */
import { captionFrame, captionSelfTestInWorker, warmCaptionStack } from './ai-runtime/caption-run.ts'
import { transcribe, warmAsrPipeline } from './ai-runtime/asr-run.ts'
import { DEFAULT_ASR_BUDGET_MS } from './ai-runtime/asr-pacing.ts'
import { runOcr } from './ai-runtime/ocr-run.ts'
import { embedSelfTestInWorker, embedQueryAndPassages, warmEmbedPipeline } from './ai-runtime/embed-run.ts'

interface WorkerRequest {
  id: number
  kind: 'warmAsr' | 'warmCaption' | 'warmEmbed' | 'ocr' | 'caption' | 'transcribe' | 'ocrSelfTest' | 'captionSelfTest' | 'asrSelfTest' | 'embedSelfTest' | 'embed'
  /** The RGBA frame pixels (ocr), a PNG data URL (caption), or decoded mono-16k samples (asr). */
  pixels?: Uint8ClampedArray
  width?: number
  height?: number
  dataUrl?: string
  samples?: Float32Array
  /** The transcription's wall-clock budget in ms (transcribe); an unusable value takes the default. */
  budgetMs?: number
  query?: string
  passages?: string[]
  related?: string
  unrelated?: string
}

/** Reply to the main thread with a settled result. */
function reply(id: number, ok: boolean, result?: unknown, error?: string): void {
  const message = { id, ok, ...(ok ? { result } : { error: error ?? '未知错误' }) }
  self.postMessage(message)
}

/** One request's handler; every failure is a rejected reply, never a throw. */
async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.kind) {
    case 'warmAsr':
      await warmAsrPipeline()
      return { warmed: true }
    case 'warmCaption':
      await warmCaptionStack()
      return { warmed: true }
    case 'warmEmbed':
      await warmEmbedPipeline()
      return { warmed: true }
    case 'embed': {
      if (request.query === undefined || request.passages === undefined) throw new Error('embed 请求缺 query/passages')
      const out = await embedQueryAndPassages(request.query, request.passages)
      return { query: out.query, passages: out.passages, dim: out.dim }
    }
    case 'embedSelfTest': {
      if (request.related === undefined || request.unrelated === undefined) throw new Error('embedSelfTest 缺对照文本')
      return await embedSelfTestInWorker(request.related, request.unrelated)
    }
    case 'ocr': {
      if (request.pixels === undefined || request.width === undefined || request.height === undefined) {
        throw new Error('ocr 请求缺帧数据')
      }
      return await runOcr(request.pixels, request.width, request.height)
    }
    case 'caption': {
      if (request.dataUrl === undefined) throw new Error('caption 请求缺帧数据')
      const blob = await (await fetch(request.dataUrl)).blob()
      const bitmap = await createImageBitmap(blob)
      try {
        return { caption: await captionFrame(bitmap, 'webgpu') }
      } finally {
        bitmap.close()
      }
    }
    case 'transcribe': {
      // AudioContext does not exist in worker globals: the caller decodes
      // and resamples on the main context; this side only infers. The run
      // is paced against the budget: a machine too slow for the whole audio
      // returns the windows it finished, not a timeout.
      if (request.samples === undefined) throw new Error('transcribe 请求缺音频采样')
      const budgetMs = typeof request.budgetMs === 'number' && Number.isFinite(request.budgetMs) && request.budgetMs > 0
        ? request.budgetMs
        : DEFAULT_ASR_BUDGET_MS
      return await transcribe(request.samples, undefined, budgetMs)
    }
    case 'ocrSelfTest': {
      const width = 640
      const height = 160
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')
      if (context === null) throw new Error('Offscreen 2D 上下文不可用')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, height)
      context.fillStyle = '#000000'
      context.font = '48px sans-serif'
      context.fillText('字幕测试 00:42', 40, 100)
      const image = context.getImageData(0, 0, width, height)
      return await runOcr(image.data, width, height)
    }
    case 'captionSelfTest':
      return await captionSelfTestInWorker()
    case 'asrSelfTest': {
      if (request.samples === undefined) {
        await warmAsrPipeline()
        return { lines: ['(管线加载自证通过;未提供音频)'] }
      }
      const segments = (await transcribe(request.samples)).segments
      const joined = segments.map(segment => segment.text).join(' ').trim()
      if (joined.length === 0) throw new Error('转写为空')
      return { lines: [joined] }
    }
    default:
      // postMessage is a wire boundary: a kind outside the union can still arrive.
      throw new Error(`未知 worker 请求类型：${String((request as { kind: unknown }).kind)}`)
  }
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (typeof request?.id !== 'number' || typeof request?.kind !== 'string') return
  handle(request).then(
    (result) => { reply(request.id, true, result) },
    (error: unknown) => {
      reply(request.id, false, undefined, error instanceof Error ? `${error.message} :: ${(error.stack ?? '').slice(0, 200)}` : String(error))
    },
  )
})
