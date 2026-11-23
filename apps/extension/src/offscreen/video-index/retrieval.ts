/**
 * Deterministic retrieval over the chunk files: term scoring for text
 * questions, coverage-based representative selection for whole-video
 * questions, and window filtering for time questions. All three produce the
 * same cited evidence lines (`[mm:ss–mm:ss] 台词 (EVID_x)`) under a hard
 * character budget, with honest truncation notes instead of silent cuts.
 *
 * @module video-index/retrieval
 */

import type { ChunkCatalog, ChunkFile, EvidenceRef, Utterance } from './types.ts'

/** Minimum utterance text length for an overview representative line. */
const OVERVIEW_MIN_TEXT_CHARS = 8

/** Characters one evidence line adds beyond the utterance text (timestamps + citation). */
const EVID_LINE_OVERHEAD_CHARS = 24

/**
 * Lowercase and strip punctuation/whitespace so CJK and latin terms match
 * across spacing and width variants.
 * @param text - the raw text.
 * @returns the normalized matching text.
 */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * Extract match terms: contiguous letter/number runs of length ≥ 2 (CJK runs
 * and latin/digit words), longest first.
 * @param question - the raw question.
 * @returns the terms, longest first.
 */
export function extractTerms(question: string): string[] {
  const runs = question.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)
  if (runs === null) return []
  return runs.sort((a, b) => b.length - a.length)
}

/**
 * Score one utterance text against the question. An exact question substring
 * dominates; otherwise term occurrence counts weighted by term length.
 * @param text - the raw utterance text.
 * @param normalizedQuestion - the normalized question.
 * @param terms - the extracted terms.
 * @returns the relevance score (0 when nothing matches).
 */
export function scoreUtterance(text: string, normalizedQuestion: string, terms: string[]): number {
  const normalized = normalizeForMatch(text)
  let score = 0
  if (normalizedQuestion.length >= 6 && normalized.includes(normalizedQuestion)) {
    score += 200
  }
  for (const term of terms) {
    let cursor = 0
    for (;;) {
      const at = normalized.indexOf(term, cursor)
      if (at < 0) break
      score += term.length
      cursor = at + term.length
    }
  }
  return score
}

/** Per-query retrieval caps shared by all modes. */
export interface RetrievalCaps {
  maxLines: number
  maxChars: number
}

/** One scored utterance candidate. */
interface ScoredUtterance {
  utterance: Utterance
  score: number
}

/** The shared retrieval result: evidence lines plus honest truncation facts. */
export interface RetrievalResult {
  evidence: EvidenceRef[]
  matched: number
  truncated: boolean
  omitted: number
}

/**
 * Text retrieval: score every utterance across the whole index, keep the
 * best lines (score > 0), ranked by score then time. Zero-hit questions
 * return no evidence — the caller reports the honest no-match wording.
 * @param readChunk - reads one chunk file (undefined when absent).
 * @param catalog - the index catalog.
 * @param question - the raw question.
 * @param caps - the per-query caps.
 * @returns the evidence lines and truncation facts.
 */
export async function retrieveTextEvidence(
  readChunk: (chunkId: string) => Promise<ChunkFile | undefined>,
  catalog: ChunkCatalog,
  question: string,
  caps: RetrievalCaps,
): Promise<RetrievalResult> {
  const normalizedQuestion = normalizeForMatch(question)
  const terms = extractTerms(question)
  const scored: ScoredUtterance[] = []
  let scanned = 0
  for (const summary of catalog.chunks) {
    const chunk = await readChunk(summary.chunkId)
    if (chunk === undefined) continue
    scanned += chunk.utterances.length
    for (const utterance of chunk.utterances) {
      const score = scoreUtterance(utterance.text, normalizedQuestion, terms)
      if (score > 0) scored.push({ utterance, score })
    }
  }
  scored.sort((a, b) => b.score - a.score || a.utterance.startMs - b.utterance.startMs)
  return capEvidence(scored.map(entry => entry.utterance), caps, scanned)
}

/**
 * Overview retrieval: per chunk, the best-scoring utterance, or the first
 * substantive one when nothing matches — 1 line per 5-minute chunk so the
 * answer covers the whole video instead of the top hits of the opening.
 * @param readChunk - reads one chunk file (undefined when absent).
 * @param catalog - the index catalog.
 * @param question - the raw question (terms bias the representative line).
 * @param caps - the per-query caps.
 * @returns the evidence lines and truncation facts.
 */
export async function retrieveOverview(
  readChunk: (chunkId: string) => Promise<ChunkFile | undefined>,
  catalog: ChunkCatalog,
  question: string,
  caps: RetrievalCaps,
): Promise<RetrievalResult> {
  const terms = extractTerms(question)
  const candidates: ScoredUtterance[] = []
  for (const summary of catalog.chunks) {
    const chunk = await readChunk(summary.chunkId)
    if (chunk === undefined) continue
    let best: ScoredUtterance | undefined
    for (const utterance of chunk.utterances) {
      const score = scoreUtterance(utterance.text, '', terms)
      if (score > 0 && (best === undefined || score > best.score)) {
        best = { utterance, score }
        continue
      }
      if (best === undefined && utterance.text.length >= OVERVIEW_MIN_TEXT_CHARS) {
        best = { utterance, score: 0 }
      }
    }
    if (best !== undefined) candidates.push(best)
  }
  const ordered = candidates.sort((a, b) => a.utterance.startMs - b.utterance.startMs)
  return capEvidence(ordered.map(entry => entry.utterance), caps, candidates.length)
}

/**
 * Time-window retrieval: the utterances overlapping the window, time-ordered.
 * @param readChunk - reads one chunk file (undefined when absent).
 * @param catalog - the index catalog.
 * @param startMs - window start (inclusive).
 * @param endMs - window end (exclusive).
 * @param caps - the per-query caps.
 * @returns the evidence lines and truncation facts.
 */
export async function retrieveTimeWindow(
  readChunk: (chunkId: string) => Promise<ChunkFile | undefined>,
  catalog: ChunkCatalog,
  startMs: number,
  endMs: number,
  caps: RetrievalCaps,
): Promise<RetrievalResult> {
  const collected = await collectWindowUtterances(readChunk, catalog, startMs, endMs)
  const ordered = collected.sort((a, b) => a.startMs - b.startMs)
  return capEvidence(ordered, caps, ordered.length)
}

/**
 * Collect the utterances overlapping `[startMs, endMs)` from the chunks that
 * overlap the window.
 * @param readChunk - reads one chunk file (undefined when absent).
 * @param catalog - the index catalog.
 * @param startMs - window start (inclusive).
 * @param endMs - window end (exclusive).
 * @returns the overlapping utterances.
 */
async function collectWindowUtterances(
  readChunk: (chunkId: string) => Promise<ChunkFile | undefined>,
  catalog: ChunkCatalog,
  startMs: number,
  endMs: number,
): Promise<Utterance[]> {
  const utterances: Utterance[] = []
  for (const summary of catalog.chunks) {
    if (summary.endMs <= startMs) continue
    if (summary.startMs >= endMs) continue
    const chunk = await readChunk(summary.chunkId)
    if (chunk === undefined) continue
    for (const utterance of chunk.utterances) {
      if (utterance.endMs <= startMs) continue
      if (utterance.startMs >= endMs) continue
      utterances.push(utterance)
    }
  }
  return utterances
}

/**
 * Apply the line and character caps: cut once the budget exhausts and report
 * the truncation facts honestly.
 * @param utterances - the ranked utterances.
 * @param caps - the per-query caps.
 * @param matched - the total utterances scanned for the question.
 * @returns the evidence lines plus truncation facts.
 */
function capEvidence(utterances: Utterance[], caps: RetrievalCaps, matched: number): RetrievalResult {
  const evidence: EvidenceRef[] = []
  let usedChars = 0
  for (const utterance of utterances) {
    const lineChars = utterance.text.length + EVID_LINE_OVERHEAD_CHARS
    if (evidence.length >= caps.maxLines || usedChars + lineChars > caps.maxChars) {
      const remaining = utterances.length - evidence.length
      const result: RetrievalResult = { evidence, matched, truncated: remaining > 0, omitted: remaining }
      return result
    }
    evidence.push({
      evidenceId: utterance.evidenceId,
      startMs: utterance.startMs,
      endMs: utterance.endMs,
      text: utterance.text,
    })
    usedChars += lineChars
  }
  return { evidence, matched: Math.max(matched, evidence.length), truncated: false, omitted: 0 }
}

/**
 * Format one timestamp as `mm:ss` (or `h:mm:ss` at or past one hour).
 * @param ms - the timestamp in milliseconds.
 * @returns the display timestamp.
 */
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * The sentence that tells the model where a local transcript stops: what
 * comes after the covered span was never transcribed, so a miss there says
 * nothing about the video.
 * @param coveredMs - the audio length the transcript covers.
 * @param durationMs - the video's duration.
 * @returns the note; an empty string when the transcript reaches the end.
 */
export function asrCoverageNote(coveredMs: number, durationMs: number): string {
  if (coveredMs >= durationMs) return ''
  return `注意：本索引由本地转写建立，只覆盖 0:00–${formatTimestamp(coveredMs)}；其后 ${formatTimestamp(durationMs - coveredMs)} 未转写（本机转写速度有限），该时段的内容无法从索引回答，不要据此断定视频没有讲到。`
}

/**
 * Assemble the model-visible context text from the evidence lines.
 * @param params.header - the mode-specific header line.
 * @param params.lines - the evidence lines (already cap-limited).
 * @param params.truncated - whether the budget cut lines.
 * @param params.omitted - how many lines the budget cut.
 * @param params.durationMs - the indexed duration (for the header).
 * @param params.note - appended after the no-evidence wording.
 * @param params.coverageNote - appended in every outcome (a transcript that stops early).
 * @returns the model-visible context text; the honest no-evidence wording when empty.
 */
export function buildContextText(params: {
  header: string
  lines: EvidenceRef[]
  truncated: boolean
  omitted: number
  durationMs: number
  note?: string
  coverageNote?: string
}): string {
  const coverage = params.coverageNote === undefined || params.coverageNote === '' ? '' : `\n${params.coverageNote}`
  if (params.lines.length === 0) {
    const base = '没有可引用的文本证据。'
    return `${params.note === undefined ? base : `${base}${params.note}`}${coverage}`
  }
  const lines = params.lines.map(line =>
    `[${formatTimestamp(line.startMs)}–${formatTimestamp(line.endMs)}] ${line.text} (${line.evidenceId})`,
  )
  const footer = params.truncated
    ? `\n（预算截断：还有 ${params.omitted} 条证据未展示——可换更具体的关键词或用时间点缩小范围）`
    : ''
  const header = `${params.header}（视频时长 ${formatTimestamp(params.durationMs)}，共 ${params.lines.length} 条）：`
  return `${header}\n${lines.join('\n')}${footer}${coverage}`
}
