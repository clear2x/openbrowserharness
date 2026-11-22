/**
 * The video-index engine: index (Bilibili, subtitle-first), query
 * (deterministic text/time/overview retrieval with cited evidence),
 * status/list/remove over the OPFS-backed store. Visual and ASR evidence
 * stay unwired in this slice; every query answers honestly about what the
 * index actually holds.
 *
 * @module video-index/engine
 */

import { createBilibiliFetcher, fetchBilibiliSubtitleSegments, fetchBilibiliVideo, parseBilibiliSource } from './bilibili.ts'
import type { BilibiliPageChannel } from './bilibili.ts'
import { assignSegmentsToChunks, buildChunkFiles, normalizeSegments, planChunkWindows } from './chunk-plan.ts'
import {
  QUERY_CONTEXT_MAX_CHARS,
  QUERY_CONTEXT_OVERVIEW_MAX_CHARS,
  QUERY_MAX_LINES,
  VideoIndexError,
} from './types.ts'
import type {
  ChunkCatalog,
  ChunkFile,
  IndexMetadata,
  RawSegment,
  RegistryEntry,
  RoutedQuery,
  SubtitleSource,
  VideoIndexToolValue,
} from './types.ts'
import { buildContextText, retrieveOverview, retrieveTextEvidence, retrieveTimeWindow } from './retrieval.ts'
import type { RetrievalCaps, RetrievalResult } from './retrieval.ts'
import { routeQuestion } from './router.ts'
import { VideoIndexStore } from './store.ts'
import type { IndexStoreFs } from './store.ts'
import { fetchAudioBytes, readAudioUrlViaPage } from './asr-audio.ts'

/** The audio-length ceiling for the synchronous ASR lane (8 minutes). */
const ASR_MAX_DURATION_MS = 8 * 60 * 1000
import { captureZoomFrame } from './zoom.ts'
import type { VideoZoomChannel, ZoomHost, ZoomOutcome } from './types.ts'

/** Everything the engine needs from the host: the fs seam plus the fetch lanes. */
export interface VideoIndexDeps {
  /** The narrow filesystem face (the extension's `ctx.fs`). */
  fs: IndexStoreFs
  /** The page-world channel; undefined keeps the direct lane only. */
  page?: BilibiliPageChannel
  /** The direct-lane fetch (tests inject; default `fetch`). */
  fetchImpl?: typeof fetch
  /** The frame-capture channel; undefined makes zoom report honestly. */
  zoom?: VideoZoomChannel
  /** The call-time attachment/llm services for zoom enrichment. */
  zoomHost?: ZoomHost
  /** The device's WebGPU tier, resolved lazily (caption enrichment gate). */
  captionTier?: () => Promise<'real' | 'software' | 'unavailable'>
  /**
   * Whether the caption model is installed (lifecycle row state) — the zoom
   * enrichment gate MUST check this: without it a fresh install would
   * silently stall the zoom call on a 258 MB download mid-call.
   */
  captionReady?: () => Promise<boolean>
  /**
   * The on-device usage ledger recorder (aiLocal.recordUsage) — every real
   * inference (OCR/caption/ASR/embed) lands here so the usage ledger and the
   * 本地 AI card both show real traces. Absent = no ledger (tests).
   */
  usageRecorder?: (entry: { capability: 'ocr' | 'caption' | 'asr' | 'embed'; model: string; durationMs: number; detail: string; selfTest?: boolean }) => Promise<void>
  /**
   * The local ASR seam (batch 276): ready answers whether the Whisper model
   * is installed WITHOUT triggering a download; transcribeUrl pulls the
   * audio container bytes and returns timestamped segments. Absent = the
   * index chain never tries ASR (capabilities.asr stays 'disabled').
   */
  asr?: {
    ready(): Promise<boolean>
    transcribeUrl(audioUrl: string, signal?: AbortSignal): Promise<Array<{ startMs: number; endMs: number; text: string }>>
  }
}

/**
 * Create the engine over one dependency set. The engine is stateless — all
 * durable state lives in the store — so creating one per tool call is safe.
 * @param deps - the host dependencies.
 * @returns the engine.
 */
export function createVideoIndexEngine(deps: VideoIndexDeps): {
  index(args: { url: string; page?: number }, signal?: AbortSignal): Promise<VideoIndexToolValue>
  query(args: { videoKey: string; question: string; mode?: string }, signal?: AbortSignal): Promise<VideoIndexToolValue>
  status(args: { videoKey: string }, signal?: AbortSignal): Promise<VideoIndexToolValue>
  list(signal?: AbortSignal): Promise<VideoIndexToolValue>
  remove(args: { videoKey: string }, signal?: AbortSignal): Promise<VideoIndexToolValue>
  zoom(args: { videoKey: string; timestampMs?: number }, signal?: AbortSignal): Promise<ZoomOutcome>
} {
  const store = new VideoIndexStore(deps.fs)
  const fetcher = createBilibiliFetcher(deps.page, deps.fetchImpl)

  /**
   * Require one published index, loading its metadata and catalog.
   * @param videoKey - the canonical key.
   * @param signal - aborts the reads.
   * @returns the metadata and catalog.
   */
  const requireIndex = async (videoKey: string, signal?: AbortSignal): Promise<{ metadata: IndexMetadata; catalog: ChunkCatalog }> => {
    const registry = await store.readRegistry(signal)
    const known = registry.some(entry => entry.videoKey === videoKey)
    const catalog = await store.readCatalog(videoKey, signal)
    if (!known || catalog === undefined) {
      throw new VideoIndexError(`索引不存在：${videoKey}——先用 action=index 建立（action=list 可查看现有索引）`, 'VIDEO_INDEX_NOT_FOUND')
    }
    const metadata = await store.readMetadata(videoKey, signal)
    if (metadata === undefined) {
      throw new VideoIndexError(`索引元数据缺失（索引可能损坏）：${videoKey}——请重新 index`, 'VIDEO_INDEX_CORRUPT')
    }
    return { metadata, catalog }
  }

  /**
   * Build the readChunk callback the retrievers take.
   * @param videoKey - the canonical key.
   * @param signal - aborts the reads.
   * @returns the chunk reader.
   */
  const readChunkFor = (videoKey: string, signal?: AbortSignal): ((chunkId: string) => Promise<ChunkFile | undefined>) => {
    return (chunkId: string) => store.readChunk(videoKey, chunkId, signal)
  }

  return {
    /**
     * Index one Bilibili video page: fetch the source facts, pull the best
     * subtitle track, chunk it, and publish. A video without usable
     * subtitles still indexes (capability `unavailable`) so queries answer
     * honestly instead of failing.
     */
    async index(args, signal) {
      if (args.url.trim() === '') {
        return { ok: false, action: 'index', error: '缺少 url：传 B 站视频页 URL 或 BV 号' }
      }
      const parsed = parseBilibiliSource(args.url)
      const requestedPage = args.page !== undefined ? args.page : parsed.page
      const source = await fetchBilibiliVideo(fetcher, parsed.bvid, requestedPage)
      let segments: RawSegment[] = []
      let subtitleSource: SubtitleSource = 'none'
      let subtitleLan: string | undefined
      for (const candidate of source.subtitles) {
        try {
          const parsedSegments = await fetchBilibiliSubtitleSegments(fetcher, candidate)
          if (parsedSegments.length > 0) {
            segments = parsedSegments
            subtitleSource = candidate.aiType === 0 ? 'bilibili-official' : 'bilibili-ai'
            subtitleLan = candidate.lan
            break
          }
        } catch {
          // One broken subtitle candidate degrades to the next; none working → honest unavailable.
          continue
        }
      }
      // Third lane (batch 276): no usable subtitle track and a mounted ASR
      // model → transcribe the audio stream locally. The audio URL comes
      // from the page's own playinfo (fixed template + CDN allowlist) and
      // the fetch rides no-referrer. Every failure degrades honestly; a
      // video longer than the ceiling is refused up front (transcription is
      // CPU-bound and the tool call is synchronous).
      let asrStatus: 'disabled' | 'unavailable' | 'ready' = 'disabled'
      let asrError: string | undefined
      if (segments.length === 0 && deps.asr !== undefined) {
        asrStatus = 'unavailable'
        try {
          if (source.durationMs > ASR_MAX_DURATION_MS) {
            throw new VideoIndexError(
              `视频时长超过本地转写上限（${String(Math.round(ASR_MAX_DURATION_MS / 60000))} 分钟）`,
              'VIDEO_INDEX_ASR_UNAVAILABLE',
            )
          }
          if (await deps.asr.ready() && deps.zoom !== undefined) {
            const canonicalUrl = `https://www.bilibili.com/video/${source.bvid}?p=${source.page}`
            const audioUrl = await readAudioUrlViaPage(deps.zoom, canonicalUrl, signal)
            const bytes = await fetchAudioBytes(deps.fetchImpl ?? fetch, audioUrl, signal)
            const asrStartedAt = Date.now()
            segments = await deps.asr.transcribeUrl(audioUrl, signal)
            void bytes
            await deps.usageRecorder?.({
              capability: 'asr',
              model: 'Whisper-base',
              durationMs: Date.now() - asrStartedAt,
              detail: `${segments.length} 条台词`,
            })
            if (segments.length > 0) {
              subtitleSource = 'asr'
              subtitleLan = 'auto'
              asrStatus = 'ready'
            }
          }
        } catch (error: unknown) {
          // The failure rides the index result — a silent degrade would hide
          // exactly the diagnosis the caller needs (CDN refused, decode
          // failed, worker timeout…).
          asrError = error instanceof Error ? error.message : String(error)
        }
      }
      const normalized = normalizeSegments(segments)
      const windows = planChunkWindows(source.durationMs)
      const assigned = assignSegmentsToChunks(windows, normalized)
      const { files, catalogChunks } = buildChunkFiles(windows, assigned)
      const videoKey = `bilibili:${source.bvid}:p${source.page}`
      const existingMetadata = await store.readMetadata(videoKey, signal)
      const revision = (existingMetadata?.revision ?? 0) + 1
      const indexedAt = Date.now()
      const utteranceCount = files.reduce((sum, file) => sum + file.utterances.length, 0)
      const metadata: IndexMetadata = {
        videoKey,
        kind: 'bilibili',
        bvid: source.bvid,
        page: source.page,
        url: `https://www.bilibili.com/video/${source.bvid}?p=${source.page}`,
        title: source.title,
        upName: source.upName,
        durationMs: source.durationMs,
        indexedAt,
        revision,
        capabilities: {
          subtitle: segments.length > 0 ? 'ready' : 'unavailable',
          subtitleSource,
          visual: 'unavailable',
          asr: asrStatus,
          ...(asrError === undefined ? {} : { asrError }),
        },
      }
      const catalog: ChunkCatalog = {
        videoKey,
        durationMs: source.durationMs,
        revision,
        chunkCount: files.length,
        chunks: catalogChunks,
      }
      const registryEntry: RegistryEntry = {
        videoKey,
        title: source.title,
        bvid: source.bvid,
        page: source.page,
        url: metadata.url,
        durationMs: source.durationMs,
        indexedAt,
        subtitleSource,
        utteranceCount,
      }
      await store.publishIndex({ videoKey, metadata, catalog, chunkFiles: files, registryEntry }, signal)
      const indexed: VideoIndexToolValue = {
        ok: true,
        action: 'index',
        videoKey,
        title: source.title,
        durationMs: source.durationMs,
        utteranceCount,
        chunkCount: files.length,
        subtitleSource,
      }
      if (subtitleLan !== undefined) indexed.subtitleLan = subtitleLan
      if (asrError !== undefined) indexed.asrError = asrError
      return indexed
    },

    /**
     * Query one published index. `auto` routes deterministically; explicit
     * modes bypass routing (visual answers honestly about the missing
     * capability; unparseable time questions are rejected with examples).
     */
    async query(args, signal) {
      if (args.question.trim() === '') {
        return { ok: false, action: 'query', error: '缺少 question' }
      }
      const { metadata, catalog } = await requireIndex(args.videoKey, signal)
      const routed = routeQuery(args.mode, args.question, catalog.durationMs)
      const caps: RetrievalCaps = { maxLines: QUERY_MAX_LINES, maxChars: QUERY_CONTEXT_MAX_CHARS }
      if (routed.mode === 'visual') {
        return {
          ok: true,
          action: 'query',
          videoKey: args.videoKey,
          mode: 'visual',
          durationMs: catalog.durationMs,
          matched: 0,
          truncated: false,
          evidence: [],
          context: buildContextText({
            header: '画面证据',
            lines: [],
            truncated: false,
            omitted: 0,
            durationMs: catalog.durationMs,
            note: '自动画面检索未接入；可先用文本/时间定位（如「第 12 分钟」），再用 zoom 动作（timestampMs=毫秒）截取该时间点的真实画面帧查看。',
          }),
        }
      }
      const capsForMode = routed.mode === 'overview'
        ? { maxLines: QUERY_MAX_LINES, maxChars: QUERY_CONTEXT_OVERVIEW_MAX_CHARS }
        : caps
      const readChunk = readChunkFor(args.videoKey, signal)
      let result: RetrievalResult
      if (routed.mode === 'text') {
        result = await retrieveTextEvidence(readChunk, catalog, args.question, capsForMode)
      } else if (routed.mode === 'overview') {
        result = await retrieveOverview(readChunk, catalog, args.question, capsForMode)
      } else {
        result = await retrieveTimeWindow(readChunk, catalog, routed.startMs ?? 0, routed.endMs ?? catalog.durationMs, capsForMode)
      }
      const noSubtitleNote = metadata.capabilities.subtitle === 'unavailable'
        ? '该视频未找到可用字幕——B 站 AI 字幕通常需要登录态，可在浏览器登录 B 站并打开该视频页后重建索引。'
        : undefined
      const header = HEADER_BY_MODE[routed.mode]
      const context = result.evidence.length === 0
        ? buildContextText({
          header,
          lines: [],
          truncated: false,
          omitted: 0,
          durationMs: catalog.durationMs,
          note: noSubtitleNote ?? TEXT_NO_MATCH_NOTE[routed.mode],
        })
        : buildContextText({
          header,
          lines: result.evidence,
          truncated: result.truncated,
          omitted: result.omitted,
          durationMs: catalog.durationMs,
        })
      return {
        ok: true,
        action: 'query',
        videoKey: args.videoKey,
        mode: routed.mode,
        durationMs: catalog.durationMs,
        matched: result.matched,
        truncated: result.truncated,
        evidence: result.evidence,
        context,
      }
    },

    /** One index's status: registry facts, capabilities, and frame evidence. */
    async status(args, signal) {
      const { metadata, catalog } = await requireIndex(args.videoKey, signal)
      const utteranceCount = catalog.chunks.reduce((sum, chunk) => sum + chunk.utteranceCount, 0)
      const frames = await store.readFrameEvidence(args.videoKey, signal)
      return {
        ok: true,
        action: 'status',
        videoKey: metadata.videoKey,
        title: metadata.title,
        durationMs: metadata.durationMs,
        utteranceCount,
        chunkCount: catalog.chunkCount,
        subtitleSource: metadata.capabilities.subtitleSource,
        capabilities: metadata.capabilities,
        revision: metadata.revision,
        frameCount: frames.length,
      }
    },

    /** Every published index, newest first. */
    async list(signal) {
      const registry = await store.readRegistry(signal)
      const entries = [...registry].sort((a, b) => b.indexedAt - a.indexedAt)
      return { ok: true, action: 'list', entries }
    },

    /** Delete one index (files + registry row); the original video is untouched. */
    async remove(args, signal) {
      const registry = await store.readRegistry(signal)
      if (!registry.some(entry => entry.videoKey === args.videoKey)) {
        throw new VideoIndexError(`索引不存在：${args.videoKey}`, 'VIDEO_INDEX_NOT_FOUND')
      }
      await store.removeIndex(args.videoKey, signal)
      return { ok: true, action: 'remove', videoKey: args.videoKey }
    },

    /**
     * Capture one frame at an absolute time: seek the video's tab and
     * screenshot the painted frame. Attachment commit and route gating stay
     * in the tool layer; a missing channel or a disabled 网页截图 capability
     * reports honestly instead of failing the turn.
     */
    async zoom(args, signal) {
      if (args.timestampMs === undefined || !Number.isFinite(args.timestampMs)) {
        return { ok: false, action: 'zoom', error: '缺少 timestampMs：要查看的画面时间点（毫秒，如 60000 = 第 1 分钟）' }
      }
      const { metadata } = await requireIndex(args.videoKey, signal)
      if (args.timestampMs < 0 || args.timestampMs > metadata.durationMs) {
        return { ok: false, action: 'zoom', videoKey: args.videoKey, durationMs: metadata.durationMs, error: `timestampMs 超出视频时长（0–${metadata.durationMs} ms）` }
      }
      if (deps.zoom === undefined) {
        return { ok: false, action: 'zoom', videoKey: args.videoKey, durationMs: metadata.durationMs, error: '画面截帧通道未接入' }
      }
      const outcome = await captureZoomFrame(deps.zoom, metadata.url, args.timestampMs, signal)
      return {
        ...outcome,
        videoKey: args.videoKey,
        timestampMs: args.timestampMs,
        durationMs: metadata.durationMs,
      }
    },
  }
}

/**
 * Resolve the effective query mode: explicit modes bypass routing; `auto`
 * routes from the question text. An explicit `time` question without a
 * parseable time reference is a caller error.
 * @param mode - the requested mode (`undefined` = auto).
 * @param question - the raw question.
 * @param durationMs - the indexed duration.
 * @returns the routed query.
 * @throws VideoIndexError on an unparseable explicit time question.
 */
function routeQuery(mode: string | undefined, question: string, durationMs: number): RoutedQuery {
  if (mode === undefined || mode === 'auto') return routeQuestion(question, durationMs)
  if (mode === 'text' || mode === 'overview') return { mode }
  if (mode === 'visual') return { mode: 'visual' }
  if (mode === 'time') {
    const routed = routeQuestion(question, durationMs)
    if (routed.mode !== 'time') {
      throw new VideoIndexError('问题里没有可识别的时间点——支持：第 N 分钟 / mm:ss / N 分 N 秒 / 前 N 分钟 / 后 N 分钟 / 片尾 / 开头', 'VIDEO_INDEX_INVALID_ARGS')
    }
    return routed
  }
  throw new VideoIndexError(`未知查询模式：${mode}`, 'VIDEO_INDEX_INVALID_ARGS')
}

/** Context header per retrieval mode. */
const HEADER_BY_MODE: Record<'text' | 'time' | 'overview', string> = {
  text: '问题命中的台词证据（按相关度排序）',
  time: '时间窗内的台词证据（按时间排序）',
  overview: '全片代表句（按时间顺序，每 5 分钟块 1 条）',
}

/** Honest no-match notes per mode (videos WITH subtitles). */
const TEXT_NO_MATCH_NOTE: Record<'text' | 'time' | 'overview', string> = {
  text: '没有命中的台词——试试换关键词，或用时间点提问（如「第 12 分钟」）。',
  time: '该时间窗内没有字幕台词。',
  overview: '索引内没有台词。',
}
