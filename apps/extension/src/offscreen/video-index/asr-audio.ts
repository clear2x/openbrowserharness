/**
 * The ASR audio lane (batch 276): locate the video's audio stream and pull
 * its bytes for local transcription. The stream URL comes from the video
 * page's own `window.__playinfo__` through one fixed expression template
 * (the model never authors evaluated code), validated against the media CDN
 * allowlist; the fetch rides `referrerPolicy: 'no-referrer'` because the
 * extension origin's referer is not on the CDN's allowlist and Bilibili's
 * CDN accepts empty-referer requests.
 *
 * @module video-index/asr-audio
 */
import { assertAllowedMediaUrl } from './bilibili.ts'
import { VideoIndexError } from './types.ts'
import type { VideoZoomChannel } from './types.ts'

/** The media CDN hosts the audio streams live on. */
export const BILIBILI_MEDIA_HOSTS = ['bilivideo.com', 'bilivideo.cn'] as const

/** How long the playinfo poll waits for the page to expose __playinfo__. */
const PLAYINFO_POLL_MS = 1_000
const PLAYINFO_POLL_COUNT = 20

/** delay(ms, signal) — the zoom lane's poll pacing helper, restated here. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new VideoIndexError('已取消', 'VIDEO_INDEX_INVALID_ARGS'))
    }, { once: true })
  })
}

/**
 * The one fixed expression the page lane evaluates: read the first audio
 * stream's URL from the player's own playinfo blob. No interpolation, no
 * model-authored code.
 */
const PLAYINFO_EXPRESSION = `JSON.stringify((() => {
  const entry = window.__playinfo__?.data?.dash?.audio?.[0]
  if (entry === undefined || entry === null) return null
  return { baseUrl: entry.baseUrl ?? entry.base_url ?? '', backupUrl: Array.isArray(entry.backup_url) ? entry.backup_url[0] ?? '' : '' }
})())`

/**
 * Read the audio stream URL from an open video page: resolve the tab the
 * same way zoom does, poll for the playinfo blob, and validate the URL
 * against the media allowlist.
 * @param channel - the zoom channel (tab management + page evaluate).
 * @param videoUrl - the video's canonical page URL.
 * @param signal - the caller's cancellation.
 * @returns the validated audio stream URL.
 */
export async function readAudioUrlViaPage(
  channel: VideoZoomChannel,
  videoUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const { resolveZoomTab } = await import('./zoom.ts')
  const { tabId } = await resolveZoomTab(channel, videoUrl)
  for (let poll = 0; poll < PLAYINFO_POLL_COUNT; poll += 1) {
    signal?.throwIfAborted()
    const raw = await channel.evaluate(tabId, PLAYINFO_EXPRESSION)
    try {
      const parsed = JSON.parse(raw) as { baseUrl?: unknown; backupUrl?: unknown } | null
      const url = typeof parsed?.baseUrl === 'string' && parsed.baseUrl !== '' ? parsed.baseUrl : typeof parsed?.backupUrl === 'string' ? parsed.backupUrl : ''
      if (url !== '') {
        return assertAllowedMediaUrl(url, BILIBILI_MEDIA_HOSTS)
      }
    } catch (error: unknown) {
      if (error instanceof VideoIndexError) throw error
      // A non-JSON evaluate answer (page not ready) keeps the poll going.
    }
    await delay(PLAYINFO_POLL_MS, signal)
  }
  throw new VideoIndexError('视频页没有暴露音频流信息（__playinfo__ 缺失）——页面可能未加载完成或该视频不支持音频直读', 'VIDEO_INDEX_ASR_UNAVAILABLE')
}

/**
 * Fetch the audio bytes. `no-referrer` is the load-bearing part: the CDN's
 * anti-leech list rejects the extension origin, but serves empty-referer
 * requests.
 * @param fetchImpl - the direct-lane fetch (tests inject).
 * @param url - the validated stream URL.
 * @param signal - the caller's cancellation.
 * @returns the raw audio container bytes.
 */
export async function fetchAudioBytes(
  fetchImpl: typeof fetch,
  url: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetchImpl(url, signal === undefined ? { referrerPolicy: 'no-referrer' } : { referrerPolicy: 'no-referrer', signal })
  if (!response.ok) {
    throw new VideoIndexError(`音频流拉取失败：HTTP ${String(response.status)}`, 'VIDEO_INDEX_ASR_UNAVAILABLE')
  }
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength < 1024) {
    throw new VideoIndexError(`音频流为空（${String(bytes.byteLength)}B）`, 'VIDEO_INDEX_ASR_UNAVAILABLE')
  }
  return bytes
}
