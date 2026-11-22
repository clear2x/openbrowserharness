/**
 * The ONNX runner for the OCR pipeline: lazy onnxruntime-web session
 * creation over the installed OPFS artifacts (`ort.env.wasm.wasmPaths`
 * points at the extension origin's staged `./ort/` CPU runtime), one frame
 * through det → boxes → rec → CTC. The runner owns no model state beyond
 * the two sessions; the pure math lives in `ocr.ts`.
 *
 * @module ai-runtime/ocr-run
 */
// The wasm-only entry: its loader requests the plain simd-threaded variant
// (the one vite stages), never the jsep/webgpu twin the main entry pulls.
import * as ort from 'onnxruntime-web/wasm'
import { ctcDecode, detInputFrom, recInputFrom, textBoxesFrom } from './ocr.ts'
import type { OcrOutcome } from './ocr.ts'
import { opfsModelStore } from './models.ts'
import { ModelDownloadError } from './models.ts'

// The staged CPU runtime (vite's copyOrtWasm puts the .wasm/.mjs pair at
// dist/ort/): relative to the extension origin the offscreen document runs
// on. Set before any session creation touches the wasm loader.
ort.env.wasm.wasmPaths = './ort/'
ort.env.wasm.numThreads = 1

/** The installed model directory layout (models.ts's publication layout). */
const MODEL_DIR = ['ocr-ppocr-mobile']
const DET_FILE = 'det.onnx'
const REC_FILE = 'rec.onnx'
const KEYS_FILE = 'keys.txt'

/** Session creation options: CPU threads stay modest beside the agent host. */
const SESSION_OPTIONS: ort.InferenceSession.SessionOptions = {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
}

/** The lazily created det/rec sessions (one per offscreen document). */
let detSession: ort.InferenceSession | undefined
let recSession: ort.InferenceSession | undefined
let dictionary: string[] | undefined

/** Read one installed artifact, failing with the model-not-installed code. */
async function artifact(name: string): Promise<Uint8Array> {
  const store = opfsModelStore()
  const bytes = await store.get([...MODEL_DIR, name])
  if (bytes === undefined || bytes.byteLength < 64) {
    throw new ModelDownloadError(`模型文件缺失或损坏：${name}（请先在服务面板安装本地 OCR 模型）`, 'MODEL_FETCH_FAILED')
  }
  return bytes
}

/**
 * Ensure both sessions and the dictionary exist. Created once and reused —
 * session creation dominates per-frame cost otherwise.
 */
async function ensureSessions(): Promise<void> {
  if (detSession === undefined) {
    detSession = await ort.InferenceSession.create(await artifact(DET_FILE), SESSION_OPTIONS)
  }
  if (recSession === undefined) {
    recSession = await ort.InferenceSession.create(await artifact(REC_FILE), SESSION_OPTIONS)
  }
  if (dictionary === undefined) {
    const bytes = await artifact(KEYS_FILE)
    const text = new TextDecoder().decode(bytes)
    // ppocr_keys_v1: one character per line, exactly as the graph's classes
    // enumerate them (minus the CTC blank the decoder owns).
    dictionary = text.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.length > 0)
  }
}

/**
 * Run one frame through the OCR pipeline on the CPU.
 * @param pixels - the frame's RGBA pixels.
 * @param width - the frame width.
 * @param height - the frame height.
 * @returns the recognized lines in reading order and the det box count.
 */
export async function runOcr(pixels: Uint8ClampedArray, width: number, height: number): Promise<OcrOutcome> {
  await ensureSessions()
  const det = detSession
  const rec = recSession
  const dict = dictionary
  if (det === undefined || rec === undefined || dict === undefined) {
    throw new ModelDownloadError('OCR 会话未初始化', 'MODEL_FETCH_FAILED')
  }
  const detInputName = det.inputNames[0]
  const detOutputName = det.outputNames[0]
  const recInputName = rec.inputNames[0]
  const recOutputName = rec.outputNames[0]
  if (detInputName === undefined || detOutputName === undefined || recInputName === undefined || recOutputName === undefined) {
    throw new ModelDownloadError('OCR 模型的输入/输出名缺失', 'MODEL_FETCH_FAILED')
  }
  const input = detInputFrom(pixels, width, height)
  const detResults = await det.run({ [detInputName]: new ort.Tensor('float32', input.data, [1, 3, input.height, input.width]) })
  const detOutput = detResults[detOutputName]
  const probMap = (detOutput?.data ?? new Float32Array(0)) as Float32Array
  const mapDims = (detOutput?.dims ?? []) as number[]
  const mapHeight = mapDims.at(-2) ?? 0
  const mapWidth = mapDims.at(-1) ?? 0
  const boxes = textBoxesFrom(probMap, mapWidth, mapHeight, width, height)
  if (boxes.length === 0) return { lines: [], boxes: 0 }
  const lines: string[] = []
  for (const box of boxes.slice(0, 12)) {
    const crop = recInputFrom(pixels, width, height, box)
    const recResults = await rec.run({ [recInputName]: new ort.Tensor('float32', crop.data, [1, 3, 48, crop.width]) })
    const output = recResults[recOutputName]
    const dims = (output?.dims ?? []) as number[]
    const timeSteps = dims.at(-2) ?? 0
    const classes = dims.at(-1) ?? 0
    const text = ctcDecode((output?.data ?? new Float32Array(0)) as Float32Array, timeSteps, classes, dict)
    const trimmed = text.trim()
    if (trimmed.length > 0) lines.push(trimmed)
  }
  return { lines, boxes: boxes.length }
}
