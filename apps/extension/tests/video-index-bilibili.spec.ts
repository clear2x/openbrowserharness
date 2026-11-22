/**
 * The Bilibili source adapter: URL parsing and the host allowlist (the SSRF
 * posture), the two fetch lanes' selection, envelope unwrapping, and
 * subtitle-candidate ordering. The live Bilibili CDN is exercised by the
 * automation probes on a real profile.
 * @module video-index-bilibili
 */
import { describe, expect, it, vi } from 'vitest'
import {
  assertAllowedUrl,
  bilibiliTabRank,
  buildPageFetchExpression,
  createBilibiliFetcher,
  fetchBilibiliSubtitleSegments,
  isBilibiliTab,
  parseBilibiliSource,
  pickSubtitleCandidates,
  unwrapBiliEnvelope,
} from '../src/offscreen/video-index/bilibili.ts'
import { VideoIndexError } from '../src/offscreen/video-index/types.ts'
import type { BilibiliPageChannel } from '../src/offscreen/video-index/bilibili.ts'

describe('parseBilibiliSource', () => {
  it('accepts a bare BV id, a full video URL, and a paged URL', () => {
    expect(parseBilibiliSource('BV1xx411c7mD')).toEqual({ bvid: 'BV1xx411c7mD', page: 1 })
    expect(parseBilibiliSource('https://www.bilibili.com/video/BV1xx411c7mD/')).toEqual({ bvid: 'BV1xx411c7mD', page: 1 })
    expect(parseBilibiliSource('https://www.bilibili.com/video/BV1xx411c7mD?p=2')).toEqual({ bvid: 'BV1xx411c7mD', page: 2 })
  })
  it('rejects short links, non-https, foreign hosts, and non-video paths', () => {
    expect(() => parseBilibiliSource('https://b23.tv/abc')).toThrow('b23.tv')
    expect(() => parseBilibiliSource('http://www.bilibili.com/video/BV1xx411c7mD')).toThrow('https')
    expect(() => parseBilibiliSource('https://example.com/video/BV1xx411c7mD')).toThrow('bilibili.com')
    expect(() => parseBilibiliSource('https://www.bilibili.com/watch/BV1xx411c7mD')).toThrow('/video/BV')
    expect(() => parseBilibiliSource('not a url')).toThrow('BV')
  })
})

describe('assertAllowedUrl', () => {
  it('requires https, no userinfo, and an exact allowlisted host', () => {
    expect(assertAllowedUrl('https://api.bilibili.com/x?bvid=BV1', ['api.bilibili.com'])).toContain('api.bilibili.com')
    expect(() => assertAllowedUrl('http://api.bilibili.com/x', ['api.bilibili.com'])).toThrow(VideoIndexError)
    expect(() => assertAllowedUrl('https://evil.com/x', ['api.bilibili.com'])).toThrow('允许列表')
    expect(() => assertAllowedUrl('https://user@api.bilibili.com/x', ['api.bilibili.com'])).toThrow('用户信息')
    expect(() => assertAllowedUrl('https://api.bilibili.com.evil.com/x', ['api.bilibili.com'])).toThrow('允许列表')
  })
})

describe('page lane plumbing', () => {
  it('builds one fixed fetch expression with the quoted URL', () => {
    const expression = buildPageFetchExpression('https://api.bilibili.com/x?a=1')
    expect(expression).toContain('fetch("https://api.bilibili.com/x?a=1"')
    expect(expression).toContain("credentials: 'include'")
  })
  it('treats only https bilibili.com tabs as page-lane hosts', () => {
    expect(isBilibiliTab('https://www.bilibili.com/video/BV1')).toBe(true)
    expect(isBilibiliTab('https://space.bilibili.com/1/dynamic')).toBe(true)
    expect(isBilibiliTab('http://www.bilibili.com/video/BV1')).toBe(false)
    expect(isBilibiliTab('https://evil.com/')).toBe(false)
    expect(isBilibiliTab('chrome://extensions')).toBe(false)
  })
})

describe('createBilibiliFetcher lane selection', () => {
  it('uses the page lane when a bilibili tab is open', async () => {
    const evaluate = vi.fn(async () => 'page-body')
    const pageChannel: BilibiliPageChannel = {
      tabs: async () => [{ tabId: 7, url: 'https://www.bilibili.com/video/BV1' }],
      evaluate,
    }
    const direct = vi.fn()
    const fetcher = createBilibiliFetcher(pageChannel, direct)
    const text = await fetcher.fetchText('https://api.bilibili.com/x?a=1')
    expect(text).toBe('page-body')
    expect(evaluate).toHaveBeenCalledWith(7, expect.stringContaining('https://api.bilibili.com/x?a=1'))
    expect(direct).not.toHaveBeenCalled()
  })
  it('falls back to the direct lane when no tab matches and surfaces HTTP failures', async () => {
    const pageChannel: BilibiliPageChannel = {
      tabs: async () => [{ tabId: 7, url: 'https://example.com/' }],
      evaluate: vi.fn(),
    }
    const direct = (async () => new Response('body', { status: 200 })) as unknown as typeof fetch
    const fetcher = createBilibiliFetcher(pageChannel, direct)
    await expect(fetcher.fetchText('https://api.bilibili.com/x')).resolves.toBe('body')
    const failing = (async () => new Response('no', { status: 412 })) as unknown as typeof fetch
    const failingFetcher = createBilibiliFetcher(undefined, failing)
    await expect(failingFetcher.fetchText('https://api.bilibili.com/x')).rejects.toThrow('412')
  })

  it('a failing page lane (debugger unattached) degrades to the direct lane instead of failing the fetch', async () => {
    const evaluate = vi.fn(async () => { throw new Error('调试器已附加，但初始化失败：Not attached') })
    const pageChannel: BilibiliPageChannel = {
      tabs: async () => [{ tabId: 7, url: 'https://www.bilibili.com/video/BV1' }],
      evaluate,
    }
    const direct = (async () => new Response('direct-body', { status: 200 })) as unknown as typeof fetch
    const fetcher = createBilibiliFetcher(pageChannel, direct)
    await expect(fetcher.fetchText('https://api.bilibili.com/x')).resolves.toBe('direct-body')
    expect(evaluate).toHaveBeenCalledOnce()
  })

  it('both lanes failing names each lane in the error', async () => {
    const pageChannel: BilibiliPageChannel = {
      tabs: async () => [{ tabId: 7, url: 'https://www.bilibili.com/video/BV1' }],
      evaluate: async () => { throw new Error('Not attached') },
    }
    const direct = (async () => new Response('no', { status: 412 })) as unknown as typeof fetch
    const fetcher = createBilibiliFetcher(pageChannel, direct)
    const error = await fetcher.fetchText('https://api.bilibili.com/x').then(
      () => { throw new Error('expected rejection') },
      (err: unknown) => err as Error,
    )
    expect(error.message).toContain('页面通道与直连通道均失败')
    expect(error.message).toContain('Not attached')
    expect(error.message).toContain('412')
  })

  it('ranks a /video/BV tab ahead of any other bilibili tab', () => {
    expect(bilibiliTabRank('https://www.bilibili.com/video/BV1jbyuznECm/')).toBe(0)
    expect(bilibiliTabRank('https://www.bilibili.com/')).toBe(1)
    const calls: Array<number> = []
    const pageChannel: BilibiliPageChannel = {
      tabs: async () => [
        { tabId: 1, url: 'https://www.bilibili.com/' },
        { tabId: 2, url: 'https://www.bilibili.com/video/BV1jbyuznECm/' },
      ],
      evaluate: async (tabId: number) => { calls.push(tabId); return 'page-body' },
    }
    const fetcher = createBilibiliFetcher(pageChannel, async () => new Response('{}'))
    return fetcher.fetchText('https://api.bilibili.com/x').then(() => {
      expect(calls).toEqual([2])
    })
  })
})

describe('unwrapBiliEnvelope', () => {
  it('returns data on code 0 and raises typed API errors otherwise', () => {
    expect(unwrapBiliEnvelope('{"code":0,"data":{"a":1}}', 'u')).toEqual({ a: 1 })
    expect(() => unwrapBiliEnvelope('{"code":-412,"message":"请求被拦截"}', 'u')).toThrow('code=-412')
    expect(() => unwrapBiliEnvelope('not-json', 'u')).toThrow('无法解析为 JSON')
    expect(() => unwrapBiliEnvelope('[]', 'u')).toThrow('不是 JSON 对象')
  })
})

describe('pickSubtitleCandidates', () => {
  it('orders official first, normalizes protocol-relative urls, drops foreign hosts', () => {
    const candidates = pickSubtitleCandidates({
      subtitle: {
        subtitles: [
          { lan: 'ai', subtitle_url: '//aisubtitle.hdslb.com/ai.json', ai_type: 1 },
          { lan: 'zh', subtitle_url: '//aisubtitle.hdslb.com/cc.json', ai_type: 0 },
          { lan: 'x', subtitle_url: '//evil.com/s.json' },
          { lan: 'y' },
        ],
      },
    })
    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({ lan: 'zh', aiType: 0, url: 'https://aisubtitle.hdslb.com/cc.json' })
    expect(candidates[1]?.aiType).toBe(1)
  })
  it('parses a candidate body into segments', async () => {
    const fetcher = { fetchText: async () => '{"body":[{"from":1,"to":2,"content":"你好"}]}' }
    const segments = await fetchBilibiliSubtitleSegments(fetcher, { lan: 'zh', url: 'https://aisubtitle.hdslb.com/cc.json', aiType: 0 })
    expect(segments).toEqual([{ startMs: 1000, endMs: 2000, text: '你好' }])
  })
})
