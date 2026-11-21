/**
 * On-demand frame capture (zoom): resolve the bilibili tab for one indexed
 * video (reuse an open tab, else open the canonical page), seek its player
 * to the requested time, and capture the painted frame. Every expression is
 * a fixed template over numeric interpolation — the model picks a timestamp,
 * never authors code. Attachment commit and route gating stay in the tool
 * layer; this module produces the frame bytes plus honest failure facts.
 *
 * @module video-index/zoom
 */

import { VideoIndexError } from './types.ts'
import type { VideoZoomChannel, ZoomOutcome } from './types.ts'

/** Wait between the seek and the capture (the player needs one paint). */
const SEEK_SETTLE_MS = 1_000

/** Poll count for the player element after opening/navigating a tab. */
const PLAYER_POLL_COUNT = 10

/** Poll interval for the player element. */
const PLAYER_POLL_MS = 700

/**
 * Build the fixed seek expression for one absolute time. The template only
 * interpolates the numeric second — no model-authored code crosses the seam.
 * @param seconds - the absolute seek target (0-based, fractional allowed).
 * @returns the page-world expression returning a JSON string.
 */
export function buildSeekExpression(seconds: number): string {
  return `(() => { const v = document.querySelector('video'); if (!v) { return JSON.stringify({ ok: false, reason: 'no-video' }) } v.pause(); v.currentTime = ${seconds}; return JSON.stringify({ ok: true, duration: v.duration }) })()`
}

/**
 * Build the fixed player-probe expression.
 * @returns the page-world expression returning 'true'/'false' as text.
 */
export function buildPlayerProbeExpression(): string {
  return '(() => { return String(document.querySelector(\'video\') != null) })()'
}

/**
 * Parse one seek-expression result.
 * @param raw - the expression's string result.
 * @returns the parsed facts, or undefined when the result is not usable JSON.
 */
export function parseSeekResult(raw: string): { ok: boolean; reason?: string; duration?: number } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const ok = (parsed as { ok?: unknown }).ok
  if (typeof ok !== 'boolean') return undefined
  const reason = (parsed as { reason?: unknown }).reason
  const duration = (parsed as { duration?: unknown }).duration
  return {
    ok,
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(typeof duration === 'number' && Number.isFinite(duration) ? { duration } : {}),
  }
}

/**
 * Resolve the tab to drive: an open tab whose URL is the video's page (any
 * part) is navigated to the indexed part when it differs; with no matching
 * tab the canonical page opens in the background.
 * @param channel - the zoom channel.
 * @param videoUrl - the indexed video's canonical URL (carries bvid and part).
 * @returns the tab id to seek and capture.
 */
export async function resolveZoomTab(channel: VideoZoomChannel, videoUrl: string): Promise<{ tabId: number; navigated: boolean }> {
  const parsed = new URL(videoUrl)
  const bvid = parsed.pathname.match(/\/video\/(BV[0-9A-Za-z]{6,12})/)?.[1]
  if (bvid === undefined) {
    throw new VideoIndexError(`索引元数据里的视频 URL 无法解析出 BV 号：${videoUrl}`, 'VIDEO_INDEX_CORRUPT')
  }
  const pageParam = parsed.searchParams.get('p') ?? '1'
  const tabs = await channel.tabs()
  const existing = tabs.find(tab => tab.url.includes(`/video/${bvid}`))
  if (existing !== undefined) {
    let needsNavigation = false
    try {
      const tabUrl = new URL(existing.url)
      needsNavigation = (tabUrl.searchParams.get('p') ?? '1') !== pageParam
    } catch {
      needsNavigation = true
    }
    if (needsNavigation) {
      await channel.navigate(existing.tabId, videoUrl)
      return { tabId: existing.tabId, navigated: true }
    }
    return { tabId: existing.tabId, navigated: false }
  }
  const opened = await channel.openTab(videoUrl)
  return { tabId: opened.tabId, navigated: true }
}

/**
 * Run one zoom capture: resolve the tab, wait for the player, seek, settle,
 * and screenshot. The caller owns timestamp validation against the duration.
 * @param channel - the zoom channel.
 * @param videoUrl - the indexed video's canonical URL.
 * @param timestampMs - the absolute seek target.
 * @param signal - the caller's cancellation.
 * @returns the frame outcome (frame absent on failure).
 */
export async function captureZoomFrame(
  channel: VideoZoomChannel,
  videoUrl: string,
  timestampMs: number,
  signal?: AbortSignal,
): Promise<ZoomOutcome> {
  const { tabId } = await resolveZoomTab(channel, videoUrl)
  try {
    let playerReady = false
    for (let poll = 0; poll < PLAYER_POLL_COUNT; poll += 1) {
      const probe = await channel.evaluate(tabId, buildPlayerProbeExpression())
      if (probe === 'true') {
        playerReady = true
        break
      }
      await delay(PLAYER_POLL_MS, signal)
    }
    if (!playerReady) {
      return { ok: false, action: 'zoom', error: '该标签页没有加载出播放器（video 元素）——请确认视频页已加载完成' }
    }
    const seekRaw = await channel.evaluate(tabId, buildSeekExpression(timestampMs / 1000))
    const seek = parseSeekResult(seekRaw)
    if (seek === undefined) {
      return { ok: false, action: 'zoom', error: `播放器 seek 返回不可解析：${rawExcerpt(seekRaw)}` }
    }
    if (!seek.ok) {
      return { ok: false, action: 'zoom', error: `播放器 seek 失败：${seek.reason ?? '未知原因'}` }
    }
    await delay(SEEK_SETTLE_MS, signal)
    const captured = await channel.screenshot(tabId)
    return {
      ok: true,
      action: 'zoom',
      frame: {
        data: captured.data,
        width: captured.width,
        height: captured.height,
        seekedToMs: timestampMs,
      },
    }
  } catch (err: unknown) {
    return { ok: false, action: 'zoom', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Abortable delay.
 * @param ms - the delay duration.
 * @param signal - the caller's cancellation.
 */
async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) throw new VideoIndexError('已取消', 'VIDEO_INDEX_INVALID_ARGS')
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Bounded excerpt of one raw expression result (error text only).
 * @param raw - the raw result.
 * @returns at most 120 characters.
 */
function rawExcerpt(raw: string): string {
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
}
