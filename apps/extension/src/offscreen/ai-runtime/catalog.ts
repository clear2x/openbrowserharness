/**
 * The on-device model catalog: every model the runtime may ever load, with a
 * HARD 1 GiB per-model size ceiling. Entries ship in two states — `planned`
 * rows are the announced roadmap (visible in the services card, no download
 * path yet), while later batches flip entries to concrete, downloadable
 * specs. Size budgets are product decisions, not runtime checks alone: the
 * {@link assertCatalogWithinBudget} gate runs in tests and at mount, so a
 * catalog edit that breaks the ceiling fails loudly instead of shipping.
 *
 * @module ai-runtime/catalog
 */
import { AiLocalError } from './types.ts'

/** The hard per-model ceiling: no on-device model may exceed 1 GiB. */
export const MAX_MODEL_BYTES = 1024 * 1024 * 1024

/** One catalog entry's inference task family. */
export type AiLocalTask = 'embedding' | 'ocr' | 'caption' | 'asr'

/** One declared on-device model. */
export interface AiLocalModelSpec {
  /** The stable id (OPFS/state keys derive from it). */
  id: string
  /** The user-facing name. */
  label: string
  /** The task family (drives which pipeline loads the entry). */
  task: AiLocalTask
  /** The one-line product purpose shown in the services card. */
  purposeZh: string
  /** The declared (or estimated, for planned rows) download size. */
  declaredBytes: number
  /** `webgpu` entries refuse to load without a real GPU adapter. */
  minDevice: 'any' | 'webgpu'
  /** Planned rows are roadmap-only: no download, no load. */
  planned: boolean
}

/**
 * The shipped catalog. Sizes are the quantized artifact sizes the landing
 * batches pin (estimates until then); every row stays far below the ceiling.
 */
export const AI_LOCAL_CATALOG: readonly AiLocalModelSpec[] = [
  {
    id: 'embed-e5-small',
    label: 'multilingual-e5-small 嵌入',
    task: 'embedding',
    purposeZh: '页面元素语义预筛（page_find_related，首次使用自动下载）',
    declaredBytes: 113 * 1024 * 1024,
    minDevice: 'any',
    planned: false,
  },
  {
    id: 'ocr-ppocr-mobile',
    label: 'PaddleOCR 移动版 识别',
    task: 'ocr',
    purposeZh: '视频帧烧录字幕提取（无字幕视频的 CPU 主力，中文强）',
    declaredBytes: 16 * 1024 * 1024,
    minDevice: 'any',
    planned: false,
  },
  {
    id: 'caption-smolvlm2-256m',
    label: 'SmolVLM2-256M 视频描述',
    task: 'caption',
    purposeZh: '视频帧生成画面描述（WebGPU 真机档，首次使用自动下载）',
    declaredBytes: 258 * 1024 * 1024,
    minDevice: 'webgpu',
    planned: false,
  },
  {
    id: 'asr-whisper-base',
    label: 'Whisper base 转写',
    task: 'asr',
    purposeZh: '无字幕视频的本地语音转写（多语言，后台索引档，首次使用自动下载）',
    declaredBytes: 74 * 1024 * 1024,
    minDevice: 'any',
    planned: false,
  },
  {
    id: 'asr-whisper-small',
    label: 'Whisper small 转写',
    task: 'asr',
    purposeZh: '无字幕视频的本地语音转写（更高质量的中文档）',
    declaredBytes: 280 * 1024 * 1024,
    minDevice: 'any',
    planned: true,
  },
]

/**
 * Validate the catalog invariants loudly: unique ids, positive sizes, and the
 * hard 1 GiB ceiling on every row.
 * @param catalog - the catalog to validate.
 * @throws AiLocalError when any invariant breaks.
 */
export function assertCatalogWithinBudget(catalog: readonly AiLocalModelSpec[]): void {
  const seen = new Set<string>()
  for (const spec of catalog) {
    if (seen.has(spec.id)) {
      throw new AiLocalError(`模型 id 重复：${spec.id}`, 'AI_LOCAL_CATALOG_INVALID')
    }
    seen.add(spec.id)
    if (!Number.isInteger(spec.declaredBytes) || spec.declaredBytes <= 0 || spec.declaredBytes > MAX_MODEL_BYTES) {
      throw new AiLocalError(
        `模型 ${spec.id} 的声明体积 ${String(spec.declaredBytes)} 违反 1GB 上限约定`,
        'AI_LOCAL_CATALOG_INVALID',
      )
    }
  }
}
