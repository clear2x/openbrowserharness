/**
 * Deterministic query routing: parse one question into a retrieval mode
 * (time / overview / text) without an extra model call, mirroring Sense
 * Now's routing table. Time words resolve against the indexed duration so
 * "片尾" style questions hit the last chunk, not the first.
 *
 * @module video-index/router
 */

import { TIME_POINT_WINDOW_MS } from './types.ts'
import type { RoutedQuery } from './types.ts'

/** Phrases whose question asks about the whole video (coverage-based selection). */
const OVERVIEW_RE = /(整个|整部|整集|全片|总结|概要|概括|大意|讲了什么|主要(内容|论点|观点|情节)|主题|脉络|结构|重点)/

/** Phrases that pin one end of the video. */
const END_RE = /(片尾|结尾|最后|末尾|结尾处)/
/** Phrases that pin the video's start. */
const START_RE = /(开头|开始|片头)/
/** "前 N 分钟" — the first N minutes. */
const FIRST_MINUTES_RE = /前\s*(\d{1,3})\s*分/
/** "后 N 分钟" — the last N minutes. */
const LAST_MINUTES_RE = /后\s*(\d{1,3})\s*分/
/** "第 N 分钟" — the Nth minute. */
const NTH_MINUTE_RE = /第\s*(\d{1,3})\s*分/
/** "N 分 N 秒" or "N 分" as an absolute point. */
const MIN_SEC_RE = /(\d{1,3})\s*分\s*(\d{1,2})\s*秒/
/** "mm:ss" / "h:mm:ss" as an absolute point. */
const CLOCK_RE = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/

/**
 * Parse a time reference from one question.
 * @param question - the raw question text.
 * @param durationMs - the indexed duration; end-of-video phrases resolve against it.
 * @returns the time window, or undefined when the question carries no time reference.
 */
export function parseTimeWindow(question: string, durationMs: number): { startMs: number; endMs: number } | undefined {
  const duration = Math.max(1, durationMs)
  if (END_RE.test(question)) {
    return { startMs: Math.max(0, duration - 60_000), endMs: duration }
  }
  if (START_RE.test(question)) {
    return { startMs: 0, endMs: Math.min(60_000, duration) }
  }
  const firstMinutes = question.match(FIRST_MINUTES_RE)
  if (firstMinutes !== null && firstMinutes[1] !== undefined) {
    const spanMs = Number(firstMinutes[1]) * 60_000
    return { startMs: 0, endMs: Math.min(duration, spanMs) }
  }
  const lastMinutes = question.match(LAST_MINUTES_RE)
  if (lastMinutes !== null && lastMinutes[1] !== undefined) {
    const spanMs = Number(lastMinutes[1]) * 60_000
    return { startMs: Math.max(0, duration - spanMs), endMs: duration }
  }
  const nthMinute = question.match(NTH_MINUTE_RE)
  if (nthMinute !== null && nthMinute[1] !== undefined) {
    const pointMs = Number(nthMinute[1]) * 60_000
    return { startMs: pointMs, endMs: Math.min(duration, pointMs + 60_000) }
  }
  const clock = question.match(CLOCK_RE)
  if (clock !== null) {
    const pointMs = clock[3] === undefined
      ? (Number(clock[1]) * 60 + Number(clock[2])) * 1000
      : (Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) * 1000
    return { startMs: pointMs, endMs: Math.min(duration, pointMs + TIME_POINT_WINDOW_MS) }
  }
  const minSec = question.match(MIN_SEC_RE)
  if (minSec !== null) {
    const pointMs = (Number(minSec[1]) * 60 + Number(minSec[2])) * 1000
    return { startMs: pointMs, endMs: Math.min(duration, pointMs + TIME_POINT_WINDOW_MS + 1000) }
  }
  return undefined
}

/**
 * Route one question in auto mode: a parseable time reference wins, then
 * whole-video phrasing, then plain text retrieval.
 * @param question - the raw question text.
 * @param durationMs - the indexed duration.
 * @returns the routed mode (and window for `time`).
 */
export function routeQuestion(question: string, durationMs: number): RoutedQuery {
  const timeWindow = parseTimeWindow(question, durationMs)
  if (timeWindow !== undefined) {
    return { mode: 'time', startMs: timeWindow.startMs, endMs: timeWindow.endMs }
  }
  if (OVERVIEW_RE.test(question)) {
    return { mode: 'overview' }
  }
  return { mode: 'text' }
}
