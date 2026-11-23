/**
 * The ASR runner (batch 276): Whisper-base through transformers.js's
 * automatic-speech-recognition pipeline with timestamped chunks. CPU (wasm)
 * is the honest tier here — transcription is an offline indexing step where
 * a minute of waiting beats no index at all, and the interactive zoom path
 * is owned by OCR + caption. Weights ride transformers.js's Cache-API cache;
 * the remote host defaults to the mirror for blocked origins.
 *
 * @module ai-runtime/asr-run
 */

// The browser entry only: the node entry pulls sharp/onnxruntime-node.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { ASR_WINDOW_S, asrNextWindowFits, planAsrCuts } from './asr-pacing.ts'

/** The model the ASR capability ships with (quantized, ~73 MB total). */
export const ASR_MODEL_ID = 'Xenova/whisper-base'
/** int8 weights: the quantized pair the ASR pipeline resolves by default. */
export const ASR_DTYPE = 'q8' as const

/** Whisper's input sample rate. */
export const TARGET_SAMPLE_RATE = 16_000

/** One transcribed segment with its absolute-time window (seconds). */
export interface AsrSegment {
  start: number
  end: number
  text: string
}

let asrPipeline: AutomaticSpeechRecognitionPipeline | undefined

/**
 * Load (once) the ASR pipeline. Downloads land in the browser's Cache-API
 * cache under the model id; the mirror hosts the weights when the direct
 * origin is unreachable.
 */
async function ensurePipeline(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (asrPipeline !== undefined) return asrPipeline
  env.remoteHost = 'https://hf-mirror.com'
  env.allowLocalModels = false
  const wasm = env.backends.onnx.wasm as { wasmPaths?: string } | undefined
  if (wasm !== undefined) // Absolute origin path: the loader runs inside a chunked worker module
  // whose import.meta.url is dist/chunks/, so a relative base would miss.
    wasm.wasmPaths = '/ort-tjs/'
  asrPipeline = await pipeline('automatic-speech-recognition', ASR_MODEL_ID, {
    dtype: ASR_DTYPE,
    device: 'wasm',
  })
  return asrPipeline
}

/**
 * Resample decoded audio to mono 16 kHz Float32 — Whisper's input contract.
 * Uses an OfflineAudioContext render, so the input may be any rate/channels
 * the browser's decodeAudioData produced.
 * @param audio - the decoded buffer.
 * @returns mono 16 kHz samples.
 */
export async function resampleTo16k(audio: AudioBuffer): Promise<Float32Array> {
  if (audio.sampleRate === TARGET_SAMPLE_RATE && audio.numberOfChannels === 1) {
    return audio.getChannelData(0).slice()
  }
  const frames = Math.ceil(audio.duration * TARGET_SAMPLE_RATE)
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = audio
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}

/**
 * Clean one transcript segment: strip Whisper's hallucination boilerplate
 * and collapse whitespace.
 * @param text - the raw chunk text.
 */
export function cleanTranscript(text: string): string {
  return text
    .replace(/^(?:字幕由|字幕|Subtitles? by)[^\n。]*/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** The outcome of one transcription: the segments and how much audio they cover. */
export interface AsrTranscript {
  segments: AsrSegment[]
  /** Length of the audio the segments were drawn from (ms). */
  processedMs: number
  /** True when the pacing budget ended the run before the audio's end. */
  truncated: boolean
}

/** The pipeline options of every window (the unpaced call uses the same). */
type AsrCallOptions = NonNullable<Parameters<AutomaticSpeechRecognitionPipeline>[1]>

/**
 * Transcribe one window of samples and place its chunks on the audio's own
 * timeline.
 * @param pipe - the warm ASR pipeline.
 * @param samples - one window of mono 16 kHz samples.
 * @param offsetS - where the window starts on the audio's timeline (seconds).
 * @param options - the pipeline options.
 * @returns the window's segments in time order, timestamps clamped to the window.
 */
async function transcribeWindow(
  pipe: AutomaticSpeechRecognitionPipeline,
  samples: Float32Array,
  offsetS: number,
  options: AsrCallOptions,
): Promise<AsrSegment[]> {
  const windowS = samples.length / TARGET_SAMPLE_RATE
  const output = await pipe(samples, options)
  const segments: AsrSegment[] = []
  for (const chunk of asrChunksOf(output)) {
    const [start, end] = chunk.timestamp
    const text = cleanTranscript(chunk.text)
    if (start === null || start === undefined) continue
    if (text.length === 0) continue
    const absoluteStart = offsetS + Math.min(Math.max(start, 0), windowS)
    const absoluteEnd = end === null || end === undefined
      ? absoluteStart
      : offsetS + Math.min(Math.max(end, start), windowS)
    segments.push({ start: absoluteStart, end: absoluteEnd, text })
  }
  return segments
}

/**
 * Transcribe mono 16 kHz audio into timestamped segments. Throws on
 * inference failure — the caller (the index chain) reports an honest
 * degraded outcome instead of publishing an empty index.
 * @param audio - mono 16 kHz samples.
 * @param language - the ISO language hint (undefined = auto-detect).
 * @param budgetMs - the wall-clock budget (ms). Given, the audio is
 *   transcribed window by window and the measured rate decides after every
 *   window whether the next one still fits; a run that cannot finish returns
 *   the transcript so far with `truncated`. Absent, the whole audio is one call.
 * @returns the segments in time order; timestamps may be null when Whisper
 *   could not align a chunk (the caller drops those).
 */
export async function transcribe(audio: Float32Array, language?: string, budgetMs?: number): Promise<AsrTranscript> {
  const pipe = await ensurePipeline()
  const options: AsrCallOptions = {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    ...(language === undefined ? {} : { language, task: 'transcribe' }),
  }
  const processedMs = (samples: number): number => (samples / TARGET_SAMPLE_RATE) * 1000
  if (budgetMs === undefined) {
    return { segments: await transcribeWindow(pipe, audio, 0, options), processedMs: processedMs(audio.length), truncated: false }
  }
  const startedAt = Date.now()
  const segments: AsrSegment[] = []
  let start = 0
  for (const cut of [...planAsrCuts(audio, TARGET_SAMPLE_RATE), audio.length]) {
    segments.push(...await transcribeWindow(pipe, audio.subarray(start, cut), start / TARGET_SAMPLE_RATE, options))
    const done = processedMs(cut)
    if (!asrNextWindowFits({
      processedMs: done,
      remainingMs: processedMs(audio.length - cut),
      elapsedMs: Date.now() - startedAt,
      budgetMs,
      windowMs: ASR_WINDOW_S * 1000,
    })) {
      return { segments, processedMs: done, truncated: cut < audio.length }
    }
    start = cut
  }
  return { segments, processedMs: processedMs(audio.length), truncated: false }
}

/**
 * Download-and-warm the ASR pipeline (the `aiLocal.install` verb for the
 * asr row): weights land in transformers.js's Cache-API cache so later
 * index runs skip the download. Throws on failure.
 */
export async function warmAsrPipeline(): Promise<void> {
  await ensurePipeline()
}

/**
 * Decode one audio file's bytes (any container the browser's decodeAudioData
 * handles: wav/mp4/m4a/webm) and resample to mono 16 kHz.
 * @param bytes - the audio file bytes.
 * @returns mono 16 kHz samples.
 */
export async function decodeTo16k(bytes: ArrayBuffer): Promise<Float32Array> {
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(bytes)
    return await resampleTo16k(decoded)
  } finally {
    void context.close()
  }
}

/**
 * Drop the transformers.js Cache-API cache (shared with the caption row —
 * one cache name hosts both models, so a remove of either clears both; the
 * manager clears both rows' state entries with it).
 */
export async function dropTransformersCache(): Promise<void> {
  await caches.delete('transformers-cache')
  asrPipeline = undefined
}

/** One raw Whisper chunk, validated from the pipeline's untyped output. */
export interface RawAsrChunk {
  timestamp: [number | null, number | null]
  text: string
}

/**
 * Narrow the ASR pipeline's untyped output to its usable chunks: the
 * pipeline answers a chunk list, a per-stride list of lists, or an object
 * carrying `chunks`. A malformed chunk (no two-entry timestamp) is dropped.
 * @param output - whatever the pipeline call resolved to.
 * @returns the well-formed chunks.
 */
export function asrChunksOf(output: unknown): RawAsrChunk[] {
  const isList = (value: unknown): value is unknown[] => Array.isArray(value)
  let source: unknown[]
  const first = isList(output) ? output[0] : undefined
  if (isList(output)) source = isList(first) ? first : output
  else if (output !== null && typeof output === 'object') {
    const chunks = (output as { chunks?: unknown }).chunks
    source = isList(chunks) ? chunks : []
  } else source = []
  const chunks: RawAsrChunk[] = []
  for (const item of source) {
    if (item === null || typeof item !== 'object') continue
    const { timestamp, text } = item as { timestamp?: unknown; text?: unknown }
    if (!isList(timestamp) || timestamp.length < 2) continue
    const [start, end] = timestamp as [number | null, number | null]
    chunks.push({ timestamp: [start, end], text: typeof text === 'string' ? text : '' })
  }
  return chunks
}
