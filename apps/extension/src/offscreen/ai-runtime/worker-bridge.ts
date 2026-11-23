/**
 * The main-thread bridge to the on-device AI worker (batch 276 fix): every
 * model inference request is marshalled to `ai-worker.js` over postMessage
 * with an id-matched reply. The worker boundary exists because creating an
 * onnxruntime session on the offscreen main context was observed to
 * permanently stall the agent loop's LLM requests — so NOTHING in this
 * module may fall back to in-context inference.
 *
 * @module ai-runtime/worker-bridge
 */

/** One pending request's resolver. */
interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** The pending-request table and the lazily created worker. */
const pending = new Map<number, Pending>()
let worker: Worker | undefined
let nextId = 1

/** Default per-call budget: model warm-ups download, OCR/caption infer. */
const DEFAULT_TIMEOUT_MS = 420_000

/**
 * Drop the current worker (crashed or timed out). The next request creates a
 * fresh one; crashed workers never answer their pending messages, so the
 * timeout path terminates the corpse explicitly.
 */
function discardWorker(): void {
  worker?.terminate()
  worker = undefined
}

/**
 * Create the worker once. Module worker over the extension origin; the
 * onerror path (uncaught worker exception kills the worker) drops the corpse
 * so the next request rebuilds, and rejects everything pending.
 */
function ensureWorker(): Worker {
  if (worker !== undefined) return worker
  worker = new Worker(chrome.runtime.getURL('ai-worker.js'), { type: 'module' })
  worker.addEventListener('message', (event: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const message = event.data
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(message.error ?? 'AI worker 请求失败'))
  })
  worker.addEventListener('error', (event) => {
    discardWorker()
    const error = new Error(`AI worker 故障：${event.message}`)
    for (const [id, entry] of pending) {
      pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  })
  return worker
}

/** Attempts per request: the first, and one retry on a fresh worker. */
const DEFAULT_ATTEMPTS = 2
/** Slack past the transcription budget before the bridge gives up on the worker (ms). */
const TRANSCRIBE_TIMEOUT_MARGIN_MS = 60_000

/**
 * Send one request to the worker and await its reply. A worker crash or a
 * timeout terminates the current worker and retries ONCE on a fresh one —
 * a single worker crash (uncaught exception mid-inference) must not wedge
 * the capability permanently. A CPU-bound job whose timeout means "too slow
 * for this machine" passes one attempt instead: a retry would burn the same
 * budget again for the same answer.
 * @param kind - the request type (see ai-worker.ts).
 * @param payload - the request fields (pixels/dataUrl/audioBase64).
 * @param timeoutMs - the per-call budget (each attempt).
 * @param attempts - how many tries (default 2).
 * @param timeoutText - the timeout's message builder; the default names the kind and the seconds.
 * @returns the worker's reply.
 */
async function callWorker(
  kind: string,
  payload: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attempts = DEFAULT_ATTEMPTS,
  timeoutText: (seconds: number) => string = seconds => `AI worker 请求超时（${kind}，${String(seconds)}s）`,
): Promise<unknown> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const w = ensureWorker()
    const id = nextId
    nextId += 1
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          discardWorker()
          reject(new Error(timeoutText(Math.round(timeoutMs / 1000))))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        w.postMessage({ id, kind, ...payload })
      })
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error))
      discardWorker()
    }
  }
  throw lastError ?? new Error('AI worker 请求失败')
}

/** The warm-up verbs (downloads + pipeline creation, no inference). */
export const warmAsrInWorker = (): Promise<unknown> => callWorker('warmAsr', {})
export const warmCaptionInWorker = (): Promise<unknown> => callWorker('warmCaption', {})

/** One frame's OCR: pixels ride structured clone; returns OcrOutcome. */
export const ocrInWorker = (pixels: Uint8ClampedArray, width: number, height: number): Promise<unknown> =>
  callWorker('ocr', { pixels, width, height }, 180_000)

/** One frame's caption: the PNG data URL rides clone; returns { caption }. */
export const captionInWorker = (dataUrl: string): Promise<unknown> => callWorker('caption', { dataUrl }, 180_000)

/**
 * Audio transcription: decoded mono-16k samples in, the paced transcript out.
 * One attempt only — a timeout here means the machine could not finish even
 * the first window inside the budget, and running it again answers the same.
 * @param samples - decoded mono 16 kHz samples.
 * @param budgetMs - the transcription's wall-clock budget (ms).
 * @returns the worker's transcript (`AsrTranscript`).
 */
export const transcribeInWorker = (samples: Float32Array, budgetMs: number): Promise<unknown> =>
  callWorker('transcribe', { samples, budgetMs }, budgetMs + TRANSCRIBE_TIMEOUT_MARGIN_MS, 1, seconds =>
    `本地转写超时（已运行 ${String(seconds)} 秒）：这台设备的转写速度太慢，连第一段音频都没能完成。可改用带字幕的视频，或在性能更好的设备上重试。`)

/** The embedding row's semantic self-test (related vs unrelated passage). */
export const embedSelfTestInWorker = (related: string, unrelated: string): Promise<unknown> =>
  callWorker('embedSelfTest', { related, unrelated }, 240_000)

/** Embed one query and its passages (normalized vectors, row-major). */
export const embedInWorker = (query: string, passages: string[]): Promise<unknown> =>
  callWorker('embed', { query, passages }, 240_000)

/** Warm the embedding pipeline (downloads + pipeline creation). */
export const warmEmbedInWorker = (): Promise<unknown> => callWorker('warmEmbed', {}, DEFAULT_TIMEOUT_MS)

/** The OCR row's synthetic-frame self-test. */
export const ocrSelfTestInWorker = (): Promise<unknown> => callWorker('ocrSelfTest', {}, 180_000)

/** The caption row's red-canvas self-test. */
export const captionSelfTestInWorker = (): Promise<unknown> => callWorker('captionSelfTest', {}, 240_000)

/** The ASR row's speech self-test (decoded samples optional = load-only). */
export const asrSelfTestInWorker = (samples?: Float32Array): Promise<unknown> =>
  callWorker('asrSelfTest', samples === undefined ? {} : { samples }, DEFAULT_TIMEOUT_MS)
