/**
 * Chunk planning: the whole video splits into 5-minute core chunks with 20s
 * input overlaps; each utterance joins the chunk whose core range contains
 * its time midpoint. Utterances are deduplicated and evidence ids are minted
 * in chunk order so citations stay stable across queries.
 *
 * @module video-index/chunk-plan
 */

import { CHUNK_CORE_MS, CHUNK_OVERLAP_MS, SEGMENT_MERGE_GAP_MS } from './types.ts'
import type { CatalogChunk, ChunkFile, ChunkWindow, RawSegment, Utterance } from './types.ts'

/**
 * Normalize parsed segments: drop empty text, clamp inverted ranges, sort by
 * start time, then merge consecutive identical-text lines whose gap stays
 * within {@link SEGMENT_MERGE_GAP_MS} (repeated subtitle refreshes).
 * @param segments - the parsed segments from any source.
 * @returns the normalized, deduplicated segments, start-ordered.
 */
export function normalizeSegments(segments: RawSegment[]): RawSegment[] {
  const clamped = segments.map((segment) => {
    const startMs = Math.max(0, Math.floor(segment.startMs))
    const endMs = Math.max(0, Math.floor(segment.endMs))
    return { ...segment, startMs, endMs, text: segment.text.trim() }
  })
  const usable = clamped
    .filter(segment => segment.text !== '')
    .map(segment => ({ ...segment, endMs: Math.max(segment.startMs + 1, segment.endMs) }))
  const ordered = usable.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const merged: RawSegment[] = []
  for (const segment of ordered) {
    const previous = merged.at(-1)
    if (previous !== undefined && previous.text === segment.text && segment.startMs - previous.endMs <= SEGMENT_MERGE_GAP_MS) {
      previous.endMs = Math.max(previous.endMs, segment.endMs)
      continue
    }
    merged.push({ ...segment })
  }
  return merged
}

/**
 * Plan the chunk windows for one duration. The final chunk clips at the
 * duration; overlaps clip at 0 and the duration.
 * @param durationMs - the video duration (clamped to at least 1ms).
 * @returns the ordered chunk windows.
 */
export function planChunkWindows(durationMs: number): ChunkWindow[] {
  const duration = Math.max(1, Math.floor(durationMs))
  const windows: ChunkWindow[] = []
  for (let coreStartMs = 0; coreStartMs < duration; coreStartMs += CHUNK_CORE_MS) {
    const coreEndMs = Math.min(coreStartMs + CHUNK_CORE_MS, duration)
    windows.push({
      chunkId: String(windows.length).padStart(6, '0'),
      startMs: coreStartMs,
      endMs: coreEndMs,
      windowStartMs: Math.max(0, coreStartMs - CHUNK_OVERLAP_MS),
      windowEndMs: Math.min(duration, coreEndMs + CHUNK_OVERLAP_MS),
    })
  }
  return windows
}

/**
 * Assign normalized segments to the chunk whose core range contains each
 * segment's time midpoint; a segment past the duration joins the last chunk.
 * @param windows - the planned chunk windows.
 * @param segments - the normalized segments.
 * @returns one segment list per chunk, in chunk order.
 */
export function assignSegmentsToChunks(windows: ChunkWindow[], segments: RawSegment[]): RawSegment[][] {
  const assigned: RawSegment[][] = windows.map(() => [])
  if (windows.length === 0) return assigned
  for (const segment of segments) {
    const midpoint = Math.floor((segment.startMs + segment.endMs) / 2)
    const index = windows.findIndex(window => midpoint >= window.startMs && midpoint < window.endMs)
    const target = index >= 0 ? index : windows.length - 1
    const bucket = assigned[target]
    if (bucket !== undefined) bucket.push(segment)
  }
  return assigned
}

/**
 * Mint the chunk files with stable utterance/evidence ids in chunk order.
 * @param windows - the planned chunk windows.
 * @param assigned - one segment list per chunk (chunk order).
 * @returns the chunk files plus the catalog summaries (without video/revision fields).
 */
export function buildChunkFiles(windows: ChunkWindow[], assigned: RawSegment[][]): { files: ChunkFile[]; catalogChunks: CatalogChunk[] } {
  const files: ChunkFile[] = []
  const catalogChunks: CatalogChunk[] = []
  let sequence = 0
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index]
    if (window === undefined) continue
    const chunkSegments = assigned[index] ?? []
    const utterances: Utterance[] = chunkSegments.map((segment) => {
      sequence += 1
      return {
        utteranceId: `u${String(sequence).padStart(6, '0')}`,
        evidenceId: `EVID_${String(sequence).padStart(6, '0')}`,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
      }
    })
    const textLength = utterances.reduce((sum, utterance) => sum + utterance.text.length, 0)
    files.push({ chunkId: window.chunkId, startMs: window.startMs, endMs: window.endMs, utterances })
    catalogChunks.push({
      chunkId: window.chunkId,
      startMs: window.startMs,
      endMs: window.endMs,
      utteranceCount: utterances.length,
      textLength,
    })
  }
  return { files, catalogChunks }
}
