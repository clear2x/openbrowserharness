/**
 * Timed-text parsers for the video index: the Bilibili subtitle body JSON
 * plus SRT/VTT for the upcoming external-subtitle source. Parsers tolerate
 * presentational noise (tags, missing cues) and always return start-ordered
 * segments whose text is non-empty.
 *
 * @module video-index/subtitles
 */

import type { RawSegment } from './types.ts'

/**
 * One SRT/VTT cue timestamp: `hh:mm:ss[,_.]mmm`, or `mm:ss[,.]mmm` without
 * the hour field.
 */
const CUE_TIME_TOKEN_RE = /\d{1,3}:\d{1,2}:\d{1,2}[,.]\d{1,3}|\d{1,2}:\d{1,2}[,.]\d{1,3}/g

/**
 * Parse a Bilibili subtitle body (`{"body":[{"from":..,"to":..,"content":".."}]}`).
 * A missing or non-array `body` reads as no segments.
 * @param raw - the subtitle response body as text.
 * @returns segments sorted by start time; empty/whitespace-only cues dropped.
 * @throws SyntaxError when `raw` is not JSON.
 */
export function parseBilibiliSubtitleContent(raw: string): RawSegment[] {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return []
  const body = (parsed as { body?: unknown }).body
  if (!Array.isArray(body)) return []
  const segments: RawSegment[] = []
  for (const cue of body) {
    if (typeof cue !== 'object' || cue === null) continue
    const from = (cue as { from?: unknown }).from
    const to = (cue as { to?: unknown }).to
    const content = (cue as { content?: unknown }).content
    if (typeof from !== 'number' || typeof to !== 'number' || typeof content !== 'string') continue
    const text = stripCueMarkup(content)
    if (text === '') continue
    segments.push({ startMs: Math.max(0, Math.round(from * 1000)), endMs: Math.max(0, Math.round(to * 1000)), text })
  }
  return sortSegments(segments)
}

/**
 * Parse one SRT document. The cue timing line is identified by carrying two
 * timestamp tokens (start and end), not by a literal separator token, so
 * dialect variations parse the same way.
 * @param raw - the SRT text.
 * @returns segments sorted by start time.
 */
export function parseSrt(raw: string): RawSegment[] {
  return parseCueBlocks(raw.split(/\r?\n\r?\n/))
}

/**
 * Parse one WebVTT document. Header and `NOTE`/`STYLE`/`REGION` blocks are
 * skipped; a missing hour field (`mm:ss.mmm`) is accepted.
 * @param raw - the VTT text.
 * @returns segments sorted by start time.
 */
export function parseVtt(raw: string): RawSegment[] {
  const blocks = raw.split(/\r?\n\r?\n/).filter(block => !/^(WEBVTT|NOTE|STYLE|REGION)/i.test(block.trim()))
  return parseCueBlocks(blocks)
}

/**
 * Parse cue blocks: the timing line is the line carrying two timestamp
 * tokens; everything after it is cue text.
 * @param blocks - the raw document blocks.
 * @returns segments sorted by start time.
 */
function parseCueBlocks(blocks: string[]): RawSegment[] {
  const segments: RawSegment[] = []
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
    const timingIndex = lines.findIndex(line => twoTimeTokens(line) !== undefined)
    if (timingIndex < 0) continue
    const timingLine = lines[timingIndex]
    if (timingLine === undefined) continue
    const times = twoTimeTokens(timingLine)
    if (times === undefined) continue
    const text = stripCueMarkup(lines.slice(timingIndex + 1).join(' '))
    if (text === '') continue
    if (times[1] < times[0]) continue
    segments.push({ startMs: times[0], endMs: times[1], text })
  }
  return sortSegments(segments)
}

/**
 * Extract the start and end timestamps from one cue-timing line.
 * @param line - one trimmed document line.
 * @returns `[startMs, endMs]`, or undefined when the line lacks two timestamps.
 */
function twoTimeTokens(line: string): [number, number] | undefined {
  const tokens = line.match(CUE_TIME_TOKEN_RE)
  if (tokens === null || tokens.length < 2) return undefined
  const first = tokens[0]
  const second = tokens[1]
  if (first === undefined || second === undefined) return undefined
  const startMs = parseCueTime(first)
  const endMs = parseCueTime(second)
  if (startMs === undefined || endMs === undefined) return undefined
  return [startMs, endMs]
}

/**
 * Parse one SRT/VTT cue timestamp token.
 * @param raw - the timestamp token.
 * @returns milliseconds, or undefined when the token is not a cue timestamp.
 */
function parseCueTime(raw: string): number | undefined {
  const match = raw.match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/)
  if (match === null) return undefined
  const hourPart = match[1]
  const millisPart = match[4]
  if (hourPart === undefined || millisPart === undefined) return undefined
  const minutesPart = match[2]
  const secondsPart = match[3]
  if (minutesPart === undefined || secondsPart === undefined) return undefined
  const hours = Number(hourPart)
  const minutes = Number(minutesPart)
  const seconds = Number(secondsPart)
  const millis = Number(millisPart.padEnd(3, '0'))
  const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis
  return totalMs
}

/**
 * Strip presentational noise from cue text: HTML/ASS tags, speaker braces and
 * collapsed whitespace.
 * @param raw - the cue text.
 * @returns the cleaned text; empty string when nothing readable remains.
 */
function stripCueMarkup(raw: string): string {
  const withoutTags = raw.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '')
  return withoutTags.replace(/\s+/g, ' ').trim()
}

/**
 * Order segments by start time, then end time.
 * @param segments - the parsed segments.
 * @returns the same segments, start-ordered.
 */
function sortSegments(segments: RawSegment[]): RawSegment[] {
  return [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
}
