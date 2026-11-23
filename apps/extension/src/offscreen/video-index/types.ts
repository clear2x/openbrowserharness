/**
 * Shared vocabulary for the extension's subtitle-first long-video index: the
 * Sense Now design (全片建索引、问题驱动补证据) ported onto extension
 * primitives. Indexing pulls text evidence from the Bilibili API lanes,
 * storage lives in OPFS through `ctx.fs`, and queries are deterministic (no
 * extra model calls). Visual and ASR evidence are not wired in this slice;
 * capabilities report that honestly instead of faking `ready`.
 *
 * @module video-index/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Core chunk length: the whole video splits into these atomic retrievable units. */
export const CHUNK_CORE_MS = 5 * 60_000

/** Overlap padded on each side of a chunk's core range; overlap utterances belong to the chunk whose core holds their midpoint. */
export const CHUNK_OVERLAP_MS = 20_000

/** Consecutive subtitle lines with identical text within this gap merge into one utterance. */
export const SEGMENT_MERGE_GAP_MS = 1_000

/** Default model-visible character budget for one query context. */
export const QUERY_CONTEXT_MAX_CHARS = 6_000

/** Character budget for a deep-style overview query (more representative lines). */
export const QUERY_CONTEXT_OVERVIEW_MAX_CHARS = 12_000

/** Max utterance lines one query context may carry. */
export const QUERY_MAX_LINES = 60

/** Max characters one remote fetch (API or subtitle body) may return. */
export const REMOTE_FETCH_MAX_CHARS = 5_000_000

/** Time window one bare timestamp ("03:20") opens for retrieval. */
export const TIME_POINT_WINDOW_MS = 30_000

/** Machine-routable failure codes for the video-index surface. */
export const VIDEO_INDEX_ERROR_CODES = [
  'VIDEO_INDEX_INVALID_URL',
  'VIDEO_INDEX_FETCH_FAILED',
  'VIDEO_INDEX_API_ERROR',
  'VIDEO_INDEX_NOT_FOUND',
  'VIDEO_INDEX_INVALID_ARGS',
  'VIDEO_INDEX_CORRUPT',
  'VIDEO_INDEX_ASR_UNAVAILABLE',
] as const

/** One machine-routable video-index failure code. */
export type VideoIndexErrorCode = typeof VIDEO_INDEX_ERROR_CODES[number]

/**
 * Typed error for expected video-index failures. The tool layer reports
 * `error` to the model instead of throwing, so the agent can react (retry
 * with a full URL, re-index, adjust the question) rather than crashing.
 */
export class VideoIndexError extends HarnessError {
  override readonly code: VideoIndexErrorCode

  constructor(message: string, code: VideoIndexErrorCode) {
    super(message, code)
    this.name = 'VideoIndexError'
    this.code = code
  }
}

/** One timed subtitle/caption line before chunk assignment. */
export interface RawSegment {
  startMs: number
  endMs: number
  text: string
}

/** One planned chunk: the core retrieval range plus its overlap-padded input window. */
export interface ChunkWindow {
  chunkId: string
  /** Core range (what `time` questions resolve against). */
  startMs: number
  endMs: number
  /** Input window (core padded by the overlap on each side). */
  windowStartMs: number
  windowEndMs: number
}

/** One deduplicated, chunk-assigned, evidence-cited utterance. */
export interface Utterance {
  /** Stable per-video sequence id (`u000001`). */
  utteranceId: string
  /** Stable per-video citation id (`EVID_000001`), minted in chunk order. */
  evidenceId: string
  startMs: number
  endMs: number
  text: string
}

/** Which layer supplied the indexed text. */
export type SubtitleSource = 'bilibili-official' | 'bilibili-ai' | 'asr' | 'none'

/**
 * Capability facts the index records honestly. `visual` stays `unavailable`
 * until the frame-capture slice lands.
 */
export interface IndexCapabilities {
  subtitle: 'ready' | 'unavailable'
  subtitleSource: SubtitleSource
  visual: 'unavailable'
  /** `disabled` = no ASR model mounted; `unavailable` = tried and failed; `ready` = transcript via local Whisper. */
  asr: 'disabled' | 'unavailable' | 'ready'
  /** Present when `asr` is `unavailable`: the lane's failure reason. */
  asrError?: string
  /** Present when the local transcript stops before the video's end: the audio length it covers. */
  asrCoveredMs?: number
}

/** Wall-clock split of one local transcription: where the wait went. */
export interface AsrTimings {
  /** The audio stream download (ms). */
  fetchMs: number
  /** Decode to mono 16 kHz samples (ms). */
  decodeMs: number
  /** The worker's inference (ms). */
  transcribeMs: number
}

/** The local ASR seam's transcript: the segments and how much audio they cover. */
export interface AsrTranscriptOutcome {
  segments: Array<{ startMs: number; endMs: number; text: string }>
  /** Length of the audio the segments were drawn from; below the video's duration when the run was cut short. */
  coveredMs?: number
  /** True when the transcription's budget ended the run before the audio's end. */
  truncated?: boolean
  /** Where the wait went; absent when the seam does not time itself. */
  timings?: AsrTimings
}

/** The index's durable header (`metadata.json`). */
export interface IndexMetadata {
  videoKey: string
  kind: 'bilibili'
  bvid: string
  page: number
  url: string
  title: string
  upName: string
  durationMs: number
  indexedAt: number
  revision: number
  capabilities: IndexCapabilities
}

/** Per-chunk catalog summary — the cheap first stage for status/list display. */
export interface CatalogChunk {
  chunkId: string
  startMs: number
  endMs: number
  utteranceCount: number
  textLength: number
}

/** `chunks/catalog.json` — its presence marks a published index (written last). */
export interface ChunkCatalog {
  videoKey: string
  durationMs: number
  revision: number
  chunkCount: number
  chunks: CatalogChunk[]
}

/** `chunks/<id>.json` — one chunk's utterances. */
export interface ChunkFile {
  chunkId: string
  startMs: number
  endMs: number
  utterances: Utterance[]
}

/** One cited evidence line the model sees in a query context. */
export interface EvidenceRef {
  evidenceId: string
  startMs: number
  endMs: number
  text: string
}

/** Query routing result. */
export type QueryMode = 'text' | 'time' | 'overview' | 'visual'

export interface RoutedQuery {
  mode: QueryMode
  /** Inclusive time-window bounds for `time` mode. */
  startMs?: number
  endMs?: number
}

/**
 * The zoom channel the engine needs for on-demand frame capture: seek a
 * bilibili video tab, screenshot the painted frame, and hand back the PNG
 * bytes. Attachment commit and route gating live in the tool layer.
 */
export interface VideoZoomChannel {
  tabs(): Promise<Array<{ tabId: number; url: string }>>
  /** Evaluate one fixed expression in the page world; returns its string result. */
  evaluate(tabId: number, expression: string): Promise<string>
  navigate(tabId: number, url: string): Promise<void>
  openTab(url: string): Promise<{ tabId: number }>
  closeTab(tabId: number): Promise<void>
  /** The provider's capability-gated capture (throws the panel hint when off). */
  screenshot(tabId: number): Promise<{ data: Uint8Array; width: number; height: number }>
}

/** The engine-level zoom outcome: frame facts, no attachment yet. */
export interface ZoomOutcome {
  ok: boolean
  action: 'zoom'
  videoKey?: string
  timestampMs?: number
  durationMs?: number
  /** The captured frame; absent on failure. */
  frame?: {
    data: Uint8Array
    width: number
    height: number
    /** Absolute video time the player actually painted (ms). */
    seekedToMs: number
  }
  /** Burned-in subtitle lines the local OCR engine read off the frame. */
  ocrLines?: string[]
  /** The local VLM's one-sentence description of the frame (WebGPU tier). */
  caption?: string
  error?: string
}

/** The model-facing result of one query. */
export interface QueryOutcome {
  videoKey: string
  mode: QueryMode
  durationMs: number
  matched: number
  truncated: boolean
  /** The model-visible evidence text (cited lines, coverage notes). */
  context: string
  evidence: EvidenceRef[]
}

/** One registry row — the lightweight catalog of all indexes. */
export interface RegistryEntry {
  videoKey: string
  title: string
  bvid: string
  page: number
  url: string
  durationMs: number
  indexedAt: number
  subtitleSource: SubtitleSource
  utteranceCount: number
}

/**
 * One persisted frame-evidence entry: a zoom capture's durable attachment
 * reference (the bytes live in the content-addressed attachment store; the
 * index records who/when/what for citation).
 */
export interface FrameEvidenceEntry {
  /** Stable per-video citation id (`FRAME_000001`). */
  frameId: string
  attachmentId: string
  mediaType: string
  /** The attachment display name (names the offload placeholder). */
  file: string
  /** The absolute video time the frame captures. */
  startMs: number
  width: number
  height: number
  createdAt: number
}

/**
 * The model-facing tool outcome. One flat shape across actions keeps the
 * tool's output schema honest: fields populate per action, everything else
 * stays absent.
 */
export interface VideoIndexToolValue {
  ok: boolean
  action: 'index' | 'query' | 'status' | 'list' | 'remove' | 'zoom'
  /** Set when `ok` is false: the localized, actionable failure. */
  error?: string
  videoKey?: string
  title?: string
  durationMs?: number
  utteranceCount?: number
  chunkCount?: number
  subtitleSource?: SubtitleSource
  /** Present when the ASR lane was attempted and failed (index action). */
  asrError?: string
  /** Present when the local transcript stops before the video's end (index, status): the audio length it covers. */
  asrCoveredMs?: number
  /** Set only when a subtitle track was actually used (absent otherwise). */
  subtitleLan?: string
  mode?: QueryMode
  /** Frame-evidence entries the index holds (status). */
  frameCount?: number
  /** Set by the zoom action: the requested frame time. */
  timestampMs?: number
  /** Set by the zoom action: the persisted frame's citation id. */
  frameId?: string
  matched?: number
  truncated?: boolean
  context?: string
  evidence?: EvidenceRef[]
  entries?: RegistryEntry[]
  capabilities?: IndexCapabilities
  revision?: number
  /** Set by the zoom action: the durably committed frame attachment. */
  image?: {
    attachmentId: string
    mediaType: 'image/png'
    bytes: number
    width: number
    height: number
    name?: string
  }
  /** Absolute video time the player actually painted for the zoom frame. */
  seekedToMs?: number
  /** Burned-in subtitle lines the local OCR read off the zoom frame. */
  ocrLines?: string[]
  /** The local VLM's one-sentence description of the zoom frame. */
  caption?: string
}

/**
 * The zoom enrichment services, resolved at call time (the composition row
 * mounts before their provider rows register). Structural faces keep this
 * module free of attachment/llm imports; the real services satisfy them.
 */
export interface ZoomHost {
  /** The durable attachment store face, or undefined when none is mounted. */
  attachments(): {
    imageLimits: { maxImageBytes: number; maxMessageImageBytes: number }
    saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<{
      attachmentId: string
      mediaType: string
      bytes: number
      width: number
      height: number
      name?: string
    }>
  } | undefined
  /** The llm service face for route gating, or undefined when absent. */
  llm(): {
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[] }>
  } | undefined
}
