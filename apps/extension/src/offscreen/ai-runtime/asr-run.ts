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

/**
 * Transcribe mono 16 kHz audio into timestamped segments. Throws on
 * inference failure — the caller (the index chain) reports an honest
 * degraded outcome instead of publishing an empty index.
 * @param audio - mono 16 kHz samples.
 * @param language - the ISO language hint (undefined = auto-detect).
 * @returns segments in time order; timestamps may be null when Whisper
 *   could not align a chunk (the caller drops those).
 */
export async function transcribe(audio: Float32Array, language?: string): Promise<AsrSegment[]> {
  const pipe = await ensurePipeline()
  const output = await pipe(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    ...(language === undefined ? {} : { language, task: 'transcribe' }),
  })
  const chunks = Array.isArray(output) ? output[0]?.chunks : output.chunks
  const segments: AsrSegment[] = []
  for (const chunk of chunks ?? []) {
    const [start, end] = chunk.timestamp as [number | null, number | null]
    const text = cleanTranscript(String(chunk.text ?? ''))
    if (start === null || start === undefined) continue
    if (text.length === 0) continue
    segments.push({ start, end: end ?? start, text })
  }
  return segments
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
