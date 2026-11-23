/**
 * The caption runner (batch 275): SmolVLM2-256M through transformers.js's
 * vision model stack (AutoProcessor + AutoTokenizer + AutoModelForVision2Seq
 * — the `image-to-text` pipeline takes no prompt, so the chat-template path
 * is written out here). WebGPU-first: the device probe gates the capability,
 * because the wasm fallback of a generative VLM is not usable on the
 * interactive zoom path and OCR owns CPU-tier frame understanding. Weights
 * ride transformers.js's Cache-API cache; the remote host defaults to the
 * mirror for blocked origins.
 *
 * @module ai-runtime/caption-run
 */

// The browser entry only: the node entry pulls sharp/onnxruntime-node.
import { AutoModelForVision2Seq, AutoProcessor, AutoTokenizer, RawImage, Tensor, env, type PreTrainedModel, type PreTrainedTokenizer } from '@huggingface/transformers'

/** The model the caption capability ships with (official ONNX weights). */
export const CAPTION_MODEL_ID = 'HuggingFaceTB/SmolVLM2-256M-Video-Instruct'
/**
 * The dtype: the official SmolVLM2 WebGPU demo ships 'q4' (int4 weights,
 * full-precision activations) — the q4f16 and fp16 builds both produced
 * empty/prompt-echo generations on this machine's WebGPU EP during the
 * self-test. q4 total ≈ 258 MB, well inside the 1 GiB ceiling.
 */
export const CAPTION_DTYPE = 'q4' as const

/**
 * The user turn SmolVLM2 answers with: one dense sentence describing the
 * frame, kept in the agent's request language.
 */
const CAPTION_PROMPT = '用一句简短的中文描述这张画面里发生了什么。'

interface CaptionStack {
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>
  tokenizer: PreTrainedTokenizer
  model: PreTrainedModel
}

let stack: CaptionStack | undefined

/** The compute device the stack was built on (diagnostics + re-entrancy). */
let stackDevice: 'webgpu' | 'wasm' | undefined

/**
 * Whether the caption capability may run on this machine: a REAL WebGPU
 * adapter (SwiftShader counts as CPU and is refused — a generative VLM over
 * software rasterization is not a usable experience).
 * @param webgpuTier - the device probe's WebGPU tier.
 */
export function captionCapable(webgpuTier: 'real' | 'software' | 'unavailable'): boolean {
  return webgpuTier === 'real'
}

/**
 * Load (once) the processor/tokenizer/model stack. Downloads land in the
 * browser's Cache-API under the model id; `remoteHost` points at the mirror
 * so blocked origins still reach the weights.
 */
async function ensureStack(device: 'webgpu' | 'wasm'): Promise<CaptionStack> {
  if (stack !== undefined && stackDevice === device) return stack
  env.remoteHost = 'https://hf-mirror.com'
  env.allowLocalModels = false
  // The staged transformers.js onnxruntime (copyTransformersWasm) — without
  // this the loader fetches wasm from the CDN.
  const wasm = env.backends.onnx.wasm as { wasmPaths?: string } | undefined
  if (wasm !== undefined) // Absolute origin path: the loader runs inside a chunked worker module
  // whose import.meta.url is dist/chunks/, so a relative base would miss.
    wasm.wasmPaths = '/ort-tjs/'
  const processor = await AutoProcessor.from_pretrained(CAPTION_MODEL_ID)
  const tokenizer = await AutoTokenizer.from_pretrained(CAPTION_MODEL_ID)
  const model = await AutoModelForVision2Seq.from_pretrained(CAPTION_MODEL_ID, {
    dtype: CAPTION_DTYPE,
    device,
  })
  stack = { processor, tokenizer, model }
  stackDevice = device
  return stack
}

/**
 * Clean one caption output: strip the assistant-echo wrappers small VLMs
 * sometimes emit, drop chat-template specials that survive decoding, and
 * collapse whitespace.
 * @param text - the raw generation.
 */
export function cleanCaption(text: string): string {
  return text
    .replace(/^\s*(?:assistant|模型|回答)[:：]\s*/iu, '')
    .replace(/<\|[^|]*\|>/gu, '')
    .replace(/<\?xml[^>]*>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Caption one frame. Throws on inference failure — the caller (zoom/watch)
 * wraps this in its silent-degrade contract.
 * @param bitmap - the decoded frame (createImageBitmap of the PNG bytes).
 * @returns the cleaned caption sentence.
 */
export async function captionFrame(bitmap: ImageBitmap, device: 'webgpu' | 'wasm' = 'webgpu'): Promise<string> {
  const { processor, tokenizer, model } = await ensureStack(device)
  const conversation = [{
    role: 'user' as const,
    content: [
      { type: 'image' as const },
      { type: 'text' as const, text: CAPTION_PROMPT },
    ],
  }]
  const promptText = processor.apply_chat_template(conversation, { add_generation_prompt: true, tokenize: false }) as string
  // The multimodal processor (Idefics3 for SmolVLM2) expands the image token
  // stream itself, so text and image go through ONE processor call —
  // splitting them drops the row/col metadata the template needs. The
  // preprocessor reads pixels off RawImage only (its .size/.rgb() contract),
  // so the bitmap is copied onto a canvas and adopted from there.
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Offscreen 2D 上下文不可用')
  context.drawImage(bitmap, 0, 0)
  const raw = RawImage.fromCanvas(canvas)
  const inputs: unknown = await processor(promptText, [raw])
  const output: unknown = await model.generate({
    ...(inputs as Record<string, unknown>),
    max_new_tokens: 64,
    do_sample: false,
  })
  // generate() returns either a Tensor or a ModelOutput wrapper; the
  // sequences tensor is what the decoder reads. The decoded sequence
  // INCLUDES the prompt, and batch=1 lays it out as one flat row with the
  // prompt first — so the new tokens are just the tail after promptLen.
  const promptLen = inputIdsLength(inputs)
  const flat = sequenceData(output)
  const tokens = (promptLen > 0 && promptLen < flat.length ? flat.slice(promptLen) : flat.slice(-1)).map(Number)
  const decoded = tokenizer.decode(tokens, { skip_special_tokens: true })
  return cleanCaption(decoded)
}

/**
 * Download-and-warm the caption stack (the `aiLocal.install` verb for the
 * caption row): weights land in transformers.js's Cache-API cache so later
 * zoom/watch calls skip the download. Throws on failure — the caller folds
 * it into the row's state.
 */
export async function warmCaptionStack(): Promise<void> {
  await ensureStack('webgpu')
}

/**
 * Drop the caption weights' Cache-API cache (the `aiLocal.remove` verb).
 * transformers.js keeps all model artifacts under one cache name; deleting
 * it also drops any other transformers.js model the runtime hosts today —
 * the caption model is the only one, so the coarse delete is honest.
 */
export async function dropCaptionCache(): Promise<void> {
  await caches.delete('transformers-cache')
  stack = undefined
}

/**
 * The caption self-proof, worker-side: a red canvas must caption with red
 * (or at least non-empty — the 256M model's Chinese color vocabulary is
 * loose, so the assertion is non-empty text).
 */
export async function captionSelfTestInWorker(): Promise<{ lines: string[] }> {
  const canvas = new OffscreenCanvas(320, 320)
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Offscreen 2D 上下文不可用')
  context.fillStyle = '#cc2222'
  context.fillRect(0, 0, 320, 320)
  const bitmap = await createImageBitmap(canvas)
  try {
    const caption = await captionFrame(bitmap, 'webgpu')
    if (caption.length === 0) throw new Error('画面描述为空')
    return { lines: [caption] }
  } finally {
    bitmap.close()
  }
}

/** One property of an untyped object-like value (`undefined` when absent or unreadable). */
function propertyOf(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

/** The flattened `input_ids` row length of a processor output (0 when absent). */
function inputIdsLength(inputs: unknown): number {
  const dims = propertyOf(propertyOf(inputs, 'input_ids'), 'dims')
  const last = Array.isArray(dims) ? (dims.at(-1) as unknown) : undefined
  return typeof last === 'number' ? last : 0
}

/** The generated token ids: a Tensor, or a ModelOutput wrapper's `sequences` tensor (batch=1 lays its row out flat). */
function sequenceData(output: unknown): number[] {
  // A Tensor is the sequence itself; a ModelOutput wrapper carries it under `sequences`.
  const wrapped = output instanceof Tensor ? undefined : propertyOf(output, 'sequences')
  const data = propertyOf(wrapped !== undefined ? wrapped : output, 'data')
  const length = propertyOf(data, 'length')
  if (typeof length !== 'number') return []
  // A typed array and a plain array both expose numeric elements by index.
  const values: number[] = []
  for (let index = 0; index < length; index += 1) {
    const value = propertyOf(data, String(index))
    values.push(typeof value === 'number' ? value : Number(value))
  }
  return values
}
