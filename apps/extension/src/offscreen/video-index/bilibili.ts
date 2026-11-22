/**
 * The Bilibili source adapter: subtitle-first indexing over the Bilibili API
 * lanes. Every request URL is validated against a hardcoded host allowlist
 * (the model never chooses a target — this is the extension's SSRF posture),
 * and the fetch runs on one of two lanes:
 *
 * - page lane: one fixed fetch expression evaluated inside an open
 *   bilibili.com tab (cookies and the real browser UA; needed for AI
 *   subtitles which require a login state). No model-authored code crosses
 *   this seam — the expression template is fixed.
 * - direct lane: a plain extension fetch with `credentials: 'include'`.
 *
 * @module video-index/bilibili
 */

import { parseBilibiliSubtitleContent } from './subtitles.ts'
import { REMOTE_FETCH_MAX_CHARS, VideoIndexError } from './types.ts'
import type { RawSegment } from './types.ts'

/** Hosts the adapter may call for the Bilibili API. */
export const BILIBILI_API_HOSTS = ['api.bilibili.com'] as const

/** Hosts the adapter may call for subtitle bodies. */
export const BILIBILI_SUBTITLE_HOSTS = ['aisubtitle.hdslb.com'] as const

/** Hosts a tab may be on for the page lane to engage. */
const PAGE_LANE_HOST_SUFFIX = 'bilibili.com'

/** One subtitle candidate from the player API's subtitle list. */
export interface BilibiliSubtitleCandidate {
  lan: string
  url: string
  /** 0 marks an officially uploaded CC subtitle; positive values mark AI subtitles. */
  aiType: number
}

/** The source facts one Bilibili index needs. */
export interface BilibiliVideoSource {
  bvid: string
  aid: string
  cid: string
  page: number
  title: string
  upName: string
  desc: string
  durationMs: number
  subtitles: BilibiliSubtitleCandidate[]
}

/**
 * The page-world channel the adapter needs (a narrow slice of the browser
 * seam so tests inject fakes). The lane always fetches text, so evaluate is
 * a string-valued seam, not a generic one.
 */
export interface BilibiliPageChannel {
  tabs(): Promise<Array<{ tabId: number; url: string }>>
  evaluate(tabId: number, expression: string): Promise<string>
}

/**
 * Parse a Bilibili source input: a full https video URL (optionally `?p=N`)
 * or a bare BV id.
 * @param input - the user/model-supplied source.
 * @returns the parsed bvid and 1-based page.
 * @throws VideoIndexError on short links, wrong hosts, non-https schemes, or
 *   non-BV video paths.
 */
export function parseBilibiliSource(input: string): { bvid: string; page: number } {
  const trimmed = input.trim()
  if (/^BV[0-9A-Za-z]{6,12}$/.test(trimmed)) {
    return { bvid: trimmed, page: 1 }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new VideoIndexError(`无法解析为 B 站视频来源（既不是 BV 号也不是有效 URL）：${trimmed}（${reason}）`, 'VIDEO_INDEX_INVALID_URL')
  }
  if (url.protocol !== 'https:') {
    throw new VideoIndexError(`B 站来源必须是 https URL：${trimmed}`, 'VIDEO_INDEX_INVALID_URL')
  }
  if (url.hostname === 'b23.tv') {
    throw new VideoIndexError('暂不支持 b23.tv 短链——请先在浏览器打开短链，再提交完整视频页 URL', 'VIDEO_INDEX_INVALID_URL')
  }
  const hostOk = url.hostname === 'bilibili.com' || url.hostname === 'www.bilibili.com' || url.hostname === 'm.bilibili.com'
  if (!hostOk) {
    throw new VideoIndexError(`只接受 bilibili.com 的视频页 URL：${trimmed}`, 'VIDEO_INDEX_INVALID_URL')
  }
  const pathMatch = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{6,12})\/?$/)
  if (pathMatch === null || pathMatch[1] === undefined) {
    throw new VideoIndexError(`URL 路径不是 /video/BV… 形式的视频页：${trimmed}`, 'VIDEO_INDEX_INVALID_URL')
  }
  const rawPage = url.searchParams.get('p')
  const page = rawPage === null ? 1 : Number.parseInt(rawPage, 10)
  if (!Number.isInteger(page) || page < 1) {
    throw new VideoIndexError(`分P 参数无效：${trimmed}`, 'VIDEO_INDEX_INVALID_URL')
  }
  return { bvid: pathMatch[1], page }
}

/**
 * Validate one request URL: https scheme, no userinfo, and an exact host
 * match against the allowlist.
 * @param raw - the URL to validate.
 * @param allowedHosts - the exact hosts allowed.
 * @returns the validated URL string.
 * @throws VideoIndexError on any mismatch.
 */
export function assertAllowedUrl(raw: string, allowedHosts: readonly string[]): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new VideoIndexError(`URL 无法解析：${raw}（${reason}）`, 'VIDEO_INDEX_INVALID_URL')
  }
  if (url.protocol !== 'https:') {
    throw new VideoIndexError(`只允许 https URL：${raw}`, 'VIDEO_INDEX_INVALID_URL')
  }
  if (url.username !== '' || url.password !== '') {
    throw new VideoIndexError(`URL 不允许携带用户信息：${raw}`, 'VIDEO_INDEX_INVALID_URL')
  }
  if (!allowedHosts.includes(url.hostname)) {
    throw new VideoIndexError(`URL 域名不在允许列表内：${raw}`, 'VIDEO_INDEX_INVALID_URL')
  }
  return url.toString()
}

/**
 * The media-CDN variant of {@link assertAllowedUrl}: the audio streams live
 * on rotating per-CDN subdomains (`xy…x…xy.mcdn.bilivideo.cn`), so a host or
 * its dot-suffixed subdomain passes (`evilbilivideo.cn` does not — the dot
 * is required). Everything else keeps the strict rules above.
 */
export function assertAllowedMediaUrl(raw: string, allowedHosts: readonly string[]): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new VideoIndexError(`URL 无法解析：${raw}（${reason}）`, 'VIDEO_INDEX_INVALID_URL')
  }
  if (url.protocol !== 'https:') {
    throw new VideoIndexError(`只允许 https URL：${raw}`, 'VIDEO_INDEX_INVALID_URL')
  }
  if (url.username !== '' || url.password !== '') {
    throw new VideoIndexError(`URL 不允许携带用户信息：${raw}`, 'VIDEO_INDEX_INVALID_URL')
  }
  const host = url.hostname
  const allowed = allowedHosts.some(entry => host === entry || host.endsWith(`.${entry}`))
  if (!allowed) {
    throw new VideoIndexError(`URL 域名不在允许列表内：${raw}`, 'VIDEO_INDEX_INVALID_URL')
  }
  return url.toString()
}

/**
 * Build the fixed page-lane fetch expression for one validated URL. The
 * template is fixed — the URL is the only interpolated part, and it is
 * JSON-quoted, so no model-authored code can cross the seam.
 * @param url - a validated https URL.
 * @returns the expression to evaluate in the page world.
 */
export function buildPageFetchExpression(url: string): string {
  return `fetch(${JSON.stringify(url)}, { credentials: 'include' }).then(r => r.text())`
}

/**
 * Whether one tab URL is an open bilibili.com page (the page lane's host).
 * @param rawUrl - the tab's URL.
 * @returns true when the tab can host the page-lane fetch.
 */
export function isBilibiliTab(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:' && url.hostname.endsWith(PAGE_LANE_HOST_SUFFIX)
  } catch {
    // chrome:// and other unparseable tab URLs are simply not Bilibili tabs.
    return false
  }
}

/**
 * The page lane's tab pick: a tab whose URL is the video's own /video/BV…
 * page first (attaching the debugger to the tab the user is actually using
 * is the expected behavior), then any other bilibili.com tab — the fetch
 * only needs the site's cookies, which every bilibili tab carries.
 * @param rawUrl - the tab's URL.
 * @returns the rank (lower = preferred).
 */
export function bilibiliTabRank(rawUrl: string): number {
  if (rawUrl.includes('/video/BV')) return 0
  return 1
}

/**
 * Create the Bilibili fetcher. Each call re-picks the lane: when a
 * bilibili.com tab is open the page lane carries cookies and the real UA;
 * otherwise the direct lane fetches from the extension context. A page-lane
 * failure (debugger unattached, tab closed mid-flight) falls back to the
 * direct lane instead of failing the fetch — the page lane is an
 * optimization, not a dependency.
 * @param pageChannel - the page-world channel, or undefined to disable the page lane.
 * @param fetchImpl - the direct-lane fetch (tests inject; default `fetch`).
 * @returns the fetcher returning one response body as text.
 */
export function createBilibiliFetcher(
  pageChannel: BilibiliPageChannel | undefined,
  fetchImpl: typeof fetch = globalThis.fetch,
): { fetchText(url: string): Promise<string> } {
  const runPageLane = async (url: string): Promise<string | undefined> => {
    if (pageChannel === undefined) return undefined
    const tabs = (await pageChannel.tabs())
      .filter(entry => isBilibiliTab(entry.url))
      .sort((a, b) => bilibiliTabRank(a.url) - bilibiliTabRank(b.url))
    const tab = tabs.at(0)
    if (tab === undefined) return undefined
    return pageChannel.evaluate(tab.tabId, buildPageFetchExpression(url))
  }
  const runDirectLane = async (url: string): Promise<string> => {
    let response: Response
    try {
      response = await fetchImpl(url, { credentials: 'include' })
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new VideoIndexError(
        `网络请求失败：${url}（${reason}）。若需要登录态字幕，可在浏览器登录 B 站并打开该视频页后重试`,
        'VIDEO_INDEX_FETCH_FAILED',
      )
    }
    if (!response.ok) {
      throw new VideoIndexError(`网络请求失败：${url}（HTTP ${response.status}）`, 'VIDEO_INDEX_FETCH_FAILED')
    }
    const text = await response.text()
    if (text.length > REMOTE_FETCH_MAX_CHARS) {
      throw new VideoIndexError(`响应超出单次抓取上限：${url}`, 'VIDEO_INDEX_FETCH_FAILED')
    }
    return text
  }
  return {
    async fetchText(url: string): Promise<string> {
      let pageLaneError: string | undefined
      try {
        const pageText = await runPageLane(url)
        if (pageText !== undefined) return pageText
      } catch (err) {
        // The page lane is an optimization: a broken debugger session or a
        // closed tab must not kill the fetch — the direct lane needs no
        // debugger. Record the reason for the both-lanes-failed message.
        pageLaneError = err instanceof Error ? err.message : String(err)
      }
      try {
        return await runDirectLane(url)
      } catch (err) {
        if (pageLaneError === undefined) throw err
        throw new VideoIndexError(
          `页面通道与直连通道均失败（页面通道：${pageLaneError}；直连：${err instanceof Error ? err.message : String(err)}）`,
          'VIDEO_INDEX_FETCH_FAILED',
        )
      }
    },
  }
}

/**
 * Unwrap one Bilibili API JSON envelope.
 * @param text - the response body text.
 * @param url - the request URL (for error messages).
 * @returns the envelope's `data` payload.
 * @throws VideoIndexError on unparseable bodies, non-zero codes, or a missing data field.
 */
export function unwrapBiliEnvelope(text: string, url: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new VideoIndexError(`B 站接口响应无法解析为 JSON：${url}`, 'VIDEO_INDEX_API_ERROR')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new VideoIndexError(`B 站接口响应不是 JSON 对象：${url}`, 'VIDEO_INDEX_API_ERROR')
  }
  const code = (parsed as { code?: unknown }).code
  const message = (parsed as { message?: unknown }).message
  if (typeof code !== 'number') {
    throw new VideoIndexError(`B 站接口响应缺少 code 字段：${url}`, 'VIDEO_INDEX_API_ERROR')
  }
  if (code !== 0) {
    const detail = typeof message === 'string' && message !== '' ? message : '无错误详情'
    throw new VideoIndexError(`B 站接口返回 code=${code}：${detail}（${url}）`, 'VIDEO_INDEX_API_ERROR')
  }
  return (parsed as { data?: unknown }).data
}

/** Read one string field from an unknown object. */
function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read one number field from an unknown object. */
function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read one object field from an unknown object. */
function readObject(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = obj[key]
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * Fetch the video source facts for one Bilibili video page.
 * @param fetcher - the fetcher from {@link createBilibiliFetcher}.
 * @param bvid - the parsed BV id.
 * @param page - the 1-based page (分P).
 * @returns the source facts including the subtitle candidates (official first).
 * @throws VideoIndexError on API errors or a missing requested page.
 */
export async function fetchBilibiliVideo(
  fetcher: { fetchText(url: string): Promise<string> },
  bvid: string,
  page: number,
): Promise<BilibiliVideoSource> {
  const viewUrl = assertAllowedUrl(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, BILIBILI_API_HOSTS)
  const viewData = unwrapBiliEnvelope(await fetcher.fetchText(viewUrl), viewUrl)
  if (typeof viewData !== 'object' || viewData === null) {
    throw new VideoIndexError(`B 站视频信息响应缺少 data：${viewUrl}`, 'VIDEO_INDEX_API_ERROR')
  }
  const view = viewData as Record<string, unknown>
  const bvidConfirmed = readString(view, 'bvid') ?? bvid
  const aidRaw = view.aid
  const aid = typeof aidRaw === 'number' ? String(aidRaw) : readString(view, 'aid') ?? ''
  const title = readString(view, 'title') ?? bvidConfirmed
  const owner = readObject(view, 'owner')
  const upName = owner === undefined ? '' : readString(owner, 'name') ?? ''
  const desc = readString(view, 'desc') ?? ''
  const baseDurationSec = readNumber(view, 'duration') ?? 0
  const pages = Array.isArray(view.pages) ? view.pages : []
  let cid: number | undefined
  let durationSec = baseDurationSec
  let pageFound = false
  for (const entry of pages) {
    if (typeof entry !== 'object' || entry === null) continue
    const pageEntry = entry as Record<string, unknown>
    if (readNumber(pageEntry, 'page') !== page) continue
    cid = readNumber(pageEntry, 'cid')
    durationSec = readNumber(pageEntry, 'duration') ?? durationSec
    pageFound = true
    break
  }
  if (!pageFound) {
    if (page !== 1) {
      throw new VideoIndexError(`该视频没有第 ${page} 个分P：${title}`, 'VIDEO_INDEX_API_ERROR')
    }
    cid = readNumber(view, 'cid')
  }
  if (cid === undefined) {
    throw new VideoIndexError(`B 站视频信息缺少 cid：${viewUrl}`, 'VIDEO_INDEX_API_ERROR')
  }
  const playerUrl = assertAllowedUrl(`https://api.bilibili.com/x/player/v2?aid=${encodeURIComponent(aid)}&cid=${String(cid)}`, BILIBILI_API_HOSTS)
  const playerData = unwrapBiliEnvelope(await fetcher.fetchText(playerUrl), playerUrl)
  let subtitles: BilibiliSubtitleCandidate[] = []
  if (typeof playerData === 'object' && playerData !== null) {
    subtitles = pickSubtitleCandidates(playerData as Record<string, unknown>)
  }
  return {
    bvid: bvidConfirmed,
    aid,
    cid: String(cid),
    page,
    title,
    upName,
    desc,
    durationMs: Math.max(0, Math.round(durationSec * 1000)),
    subtitles,
  }
}

/**
 * Extract and order the subtitle candidates from a player-API data payload.
 * Official CC subtitles come first; AI subtitles follow.
 * @param playerData - the player API's `data` object.
 * @returns the validated candidates (https, allowlisted hosts only).
 */
export function pickSubtitleCandidates(playerData: Record<string, unknown>): BilibiliSubtitleCandidate[] {
  const subtitleInfo = readObject(playerData, 'subtitle')
  if (subtitleInfo === undefined) return []
  const list = Array.isArray(subtitleInfo.subtitles) ? subtitleInfo.subtitles : []
  const candidates: BilibiliSubtitleCandidate[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    const rawUrl = readString(entry, 'subtitle_url')
    if (rawUrl === undefined) continue
    const normalizedUrl = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl
    let url: string
    try {
      url = assertAllowedUrl(normalizedUrl, BILIBILI_SUBTITLE_HOSTS)
    } catch {
      // A subtitle on a foreign host is skipped, not fatal — the next candidate may work.
      continue
    }
    const aiTypeRaw = readNumber(entry, 'ai_type')
    candidates.push({ lan: readString(entry, 'lan') ?? '', url, aiType: aiTypeRaw ?? 0 })
  }
  return candidates.sort((a, b) => (a.aiType === 0 ? 0 : 1) - (b.aiType === 0 ? 0 : 1))
}

/**
 * Fetch and parse one subtitle body.
 * @param fetcher - the fetcher from {@link createBilibiliFetcher}.
 * @param candidate - one allowlisted subtitle candidate.
 * @returns the parsed segments.
 * @throws VideoIndexError when the fetch fails or the body is not parseable JSON.
 */
export async function fetchBilibiliSubtitleSegments(
  fetcher: { fetchText(url: string): Promise<string> },
  candidate: BilibiliSubtitleCandidate,
): Promise<RawSegment[]> {
  const text = await fetcher.fetchText(candidate.url)
  return parseBilibiliSubtitleContent(text)
}
