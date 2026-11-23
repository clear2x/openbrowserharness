/**
 * Video-index engine: the pure pieces (normalize/plan/route/score/context)
 * plus an end-to-end index → query → remove cycle over a memory fs and an
 * injected direct-lane fetch. The real OPFS provider and the SW CDP page
 * lane are exercised by the automation probes on a real profile.
 * @module video-index-engine
 */
import { describe, expect, it } from 'vitest'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { assignSegmentsToChunks, buildChunkFiles, normalizeSegments, planChunkWindows } from '../src/offscreen/video-index/chunk-plan.ts'
import { routeQuestion } from '../src/offscreen/video-index/router.ts'
import {
  buildContextText,
  extractTerms,
  formatTimestamp,
  normalizeForMatch,
  scoreUtterance,
} from '../src/offscreen/video-index/retrieval.ts'
import { encodeKeyPath, VideoIndexStore } from '../src/offscreen/video-index/store.ts'
import type { IndexStoreFs } from '../src/offscreen/video-index/store.ts'
import { createVideoIndexEngine } from '../src/offscreen/video-index/engine.ts'
import type { AsrTranscriptOutcome, VideoZoomChannel } from '../src/offscreen/video-index/types.ts'
import type { FsDirEntry, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'

/** One in-memory file world that structurally satisfies the store's fs face. */
class MemoryIndexFs {
  private readonly files = new Map<string, string>()

  async resolve(path: string): Promise<FsTarget> {
    return { targetKey: FsTargetKey(path), displayPath: path }
  }

  async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const content = this.files.get(target.displayPath)
    if (content === undefined) return undefined
    return { version: FsVersion('mem-1'), type: 'file', size: content.length }
  }

  async readText(target: FsTarget): Promise<string> {
    const content = this.files.get(target.displayPath)
    if (content === undefined) throw new FsError(`missing: ${target.displayPath}`, 'FS_NOT_FOUND')
    return content
  }

  async writeText(target: FsTarget, content: string): Promise<unknown> {
    this.files.set(target.displayPath, content)
    return { operation: 'update' }
  }

  async listDir(target: FsTarget): Promise<FsDirEntry[]> {
    const prefix = target.displayPath
    const children = new Map<string, 'file' | 'directory'>()
    for (const path of this.files.keys()) {
      if (!path.startsWith(`${prefix}/`)) continue
      const rest = path.slice(prefix.length + 1)
      const direct = rest.split('/')[0]
      if (direct === undefined || direct === '') continue
      const isDir = rest.includes('/')
      children.set(direct, isDir ? 'directory' : 'file')
    }
    return [...children.entries()].map(([name, type]) => ({
      name,
      type,
      target: { targetKey: FsTargetKey(`${prefix}/${name}`), displayPath: `${prefix}/${name}` },
    }))
  }

  async deleteFile(target: FsTarget): Promise<unknown> {
    this.files.delete(target.displayPath)
    return { removed: true }
  }
}

/** Build one memory fs typed as the store's narrow face. */
function memoryFs(): IndexStoreFs {
  return new MemoryIndexFs()
}

/** One Bilibili view-API envelope for the fake fetch. */
function biliView(bvid: string, durationSec: number): unknown {
  return {
    code: 0,
    data: {
      bvid,
      aid: 100,
      title: `视频-${bvid}`,
      desc: '简介',
      duration: durationSec,
      owner: { name: '测试UP' },
      cid: 77,
      pages: [{ page: 1, cid: 77, duration: durationSec }],
    },
  }
}

/** One player-API envelope with a subtitle list. */
function biliPlayer(subtitles: unknown[]): unknown {
  return { code: 0, data: { subtitle: { subtitles } } }
}

/** One subtitle body (no envelope). */
function biliBody(lines: Array<[number, number, string]>): unknown {
  return { body: lines.map(([from, to, content]) => ({ from, to, content })) }
}

/**
 * Route a fake direct-lane fetch by URL: the canned view/player/subtitle
 * responses keyed by bvid (bvid without subtitles → empty list).
 * @param withSubtitles - whether the canned player response carries subtitles.
 * @returns a fetch-compatible function.
 */
function fakeFetch(withSubtitles: boolean): typeof fetch {
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const bvidMatch = url.match(/bvid=(BV[0-9A-Za-z]+)/)
    const bvid = bvidMatch?.[1] ?? 'BVTEST00001'
    if (url.includes('/x/web-interface/view')) {
      return new Response(JSON.stringify(biliView(bvid, 180)), { status: 200 })
    }
    if (url.includes('/x/player/v2')) {
      const subtitles = withSubtitles
        ? [
          { lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/ai.json', ai_type: 1 },
          { lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/cc.json', ai_type: 0 },
        ]
        : []
      return new Response(JSON.stringify(biliPlayer(subtitles)), { status: 200 })
    }
    if (url.includes('aisubtitle.hdslb.com/cc.json')) {
      return new Response(JSON.stringify(biliBody([
        [10, 14, '第一句台词'],
        [20, 24, '第二句台词'],
        [130, 134, '压力测试关键词出现在这里'],
      ])), { status: 200 })
    }
    if (url.includes('aisubtitle.hdslb.com/ai.json')) {
      return new Response('not-json', { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }
  return impl
}

describe('segment normalization', () => {
  it('drops empty text, clamps inverted ranges, merges repeated refresh lines', () => {
    const merged = normalizeSegments([
      { startMs: 1000, endMs: 500, text: '倒序' },
      { startMs: 2000, endMs: 3000, text: '重复' },
      { startMs: 3500, endMs: 4200, text: '重复' },
      { startMs: 6000, endMs: 7000, text: '  ' },
      { startMs: 9000, endMs: 10000, text: '独立句' },
    ])
    expect(merged).toEqual([
      { startMs: 1000, endMs: 1001, text: '倒序' },
      { startMs: 2000, endMs: 4200, text: '重复' },
      { startMs: 9000, endMs: 10000, text: '独立句' },
    ])
  })
})

describe('chunk planning', () => {
  it('splits a long video into overlapping windows and assigns by midpoint', () => {
    const windows = planChunkWindows(11 * 60_000)
    expect(windows).toHaveLength(3)
    expect(windows[0]).toMatchObject({ startMs: 0, endMs: 300_000, windowStartMs: 0, windowEndMs: 320_000 })
    expect(windows[2]).toMatchObject({ startMs: 600_000, endMs: 660_000, windowEndMs: 660_000 })
    const assigned = assignSegmentsToChunks(windows, [{ startMs: 295_000, endMs: 305_000, text: '跨中点' }])
    expect(assigned[0]).toHaveLength(0)
    expect(assigned[1]).toHaveLength(1)
    const built = buildChunkFiles(windows, assigned)
    expect(built.files[1]?.utterances[0]?.evidenceId).toBe('EVID_000001')
    expect(built.catalogChunks).toHaveLength(3)
  })
})

describe('query routing', () => {
  it('parses the time words against the duration', () => {
    const duration = 20 * 60_000
    expect(routeQuestion('第 2 分钟在讲什么', duration)).toEqual({ mode: 'time', startMs: 120_000, endMs: 180_000 })
    expect(routeQuestion('03:20 说了什么', duration)).toEqual({ mode: 'time', startMs: 200_000, endMs: 230_000 })
    expect(routeQuestion('后 5 分钟', duration)).toEqual({ mode: 'time', startMs: 15 * 60_000, endMs: duration })
    expect(routeQuestion('前 3 分钟', duration)).toEqual({ mode: 'time', startMs: 0, endMs: 180_000 })
    expect(routeQuestion('片尾', duration)).toEqual({ mode: 'time', startMs: duration - 60_000, endMs: duration })
    expect(routeQuestion('开头', duration)).toEqual({ mode: 'time', startMs: 0, endMs: 60_000 })
  })
  it('routes overview and plain text questions', () => {
    expect(routeQuestion('整个视频讲了什么', 600_000).mode).toBe('overview')
    expect(routeQuestion('总结一下重点', 600_000).mode).toBe('overview')
    expect(routeQuestion('机器学习是怎么工作的', 600_000).mode).toBe('text')
  })
})

describe('scoring and context', () => {
  it('normalizes, extracts terms, and ranks exact-phrase hits first', () => {
    expect(normalizeForMatch('Hello, 世界!')).toBe('hello世界')
    expect(extractTerms('机器 学习 AB')).toEqual(['机器', '学习', 'ab'])
    const terms = extractTerms('压力测试')
    const hit = scoreUtterance('这里讲压力测试', normalizeForMatch('压力测试'), terms)
    const miss = scoreUtterance('完全不相关', normalizeForMatch('压力测试'), terms)
    expect(hit).toBeGreaterThan(0)
    expect(miss).toBe(0)
  })
  it('formats timestamps and the context header/footer', () => {
    expect(formatTimestamp(65_000)).toBe('1:05')
    expect(formatTimestamp(3_725_000)).toBe('1:02:05')
    const text = buildContextText({
      header: '测试',
      lines: [{ evidenceId: 'EVID_000001', startMs: 10_000, endMs: 14_000, text: '台词' }],
      truncated: true,
      omitted: 2,
      durationMs: 180_000,
    })
    expect(text).toContain('[0:10–0:14] 台词 (EVID_000001)')
    expect(text).toContain('预算截断：还有 2 条')
    const empty = buildContextText({ header: '测试', lines: [], truncated: false, omitted: 0, durationMs: 180_000, note: '提示语' })
    expect(empty).toBe('没有可引用的文本证据。提示语')
  })
})

describe('store helpers', () => {
  it('encodes unsafe key characters injectively and keeps paths inside the root', () => {
    const encoded = encodeKeyPath('bilibili:BV1:p1')
    expect(encoded).not.toContain(':')
    expect(encoded).toContain('=3a')
    expect(encodeKeyPath('a=b')).toContain('=3d')
  })
  it('publishes an index and reads it back; absence reads as undefined', async () => {
    const fs = memoryFs()
    const store = new VideoIndexStore(fs)
    expect(await store.readCatalog('bilibili:BV1:p1')).toBeUndefined()
    const metadata = {
      videoKey: 'bilibili:BV1:p1', kind: 'bilibili' as const, bvid: 'BV1', page: 1, url: 'u',
      title: 't', upName: '', durationMs: 60_000, indexedAt: 1, revision: 1,
      capabilities: { subtitle: 'ready' as const, subtitleSource: 'bilibili-official' as const, visual: 'unavailable' as const, asr: 'disabled' as const },
    }
    const catalog = { videoKey: 'bilibili:BV1:p1', durationMs: 60_000, revision: 1, chunkCount: 1, chunks: [{ chunkId: '000000', startMs: 0, endMs: 60_000, utteranceCount: 1, textLength: 2 }] }
    const chunkFile = { chunkId: '000000', startMs: 0, endMs: 60_000, utterances: [{ utteranceId: 'u000001', evidenceId: 'EVID_000001', startMs: 0, endMs: 1000, text: '台词' }] }
    await store.publishIndex({
      videoKey: 'bilibili:BV1:p1', metadata, catalog, chunkFiles: [chunkFile],
      registryEntry: { videoKey: 'bilibili:BV1:p1', title: 't', bvid: 'BV1', page: 1, url: 'u', durationMs: 60_000, indexedAt: 1, subtitleSource: 'bilibili-official', utteranceCount: 1 },
    })
    expect(await store.readCatalog('bilibili:BV1:p1')).toMatchObject({ chunkCount: 1 })
    expect(await store.readChunk('bilibili:BV1:p1', '000000')).toMatchObject({ utterances: [{ evidenceId: 'EVID_000001' }] })
    expect((await store.readRegistry()).map(entry => entry.videoKey)).toEqual(['bilibili:BV1:p1'])
    await store.removeIndex('bilibili:BV1:p1')
    expect(await store.readRegistry()).toEqual([])
    expect(await store.readCatalog('bilibili:BV1:p1')).toBeUndefined()
  })
})

describe('engine end-to-end', () => {
  it('indexes with the official subtitle lane, answers all three query modes, and removes', async () => {
    const fs = memoryFs()
    const engine = createVideoIndexEngine({ fs, fetchImpl: fakeFetch(true) })
    const indexed = await engine.index({ url: 'https://www.bilibili.com/video/BVTEST00001' })
    expect(indexed.ok).toBe(true)
    expect(indexed).toMatchObject({ videoKey: 'bilibili:BVTEST00001:p1', subtitleSource: 'bilibili-official', chunkCount: 1, utteranceCount: 3 })
    const text = await engine.query({ videoKey: 'bilibili:BVTEST00001:p1', question: '压力测试' })
    expect(text.ok).toBe(true)
    expect(text.context).toContain('压力测试关键词出现在这里 (EVID_000003)')
    const overview = await engine.query({ videoKey: 'bilibili:BVTEST00001:p1', question: '整个视频讲了什么' })
    expect(overview.mode).toBe('overview')
    expect(overview.evidence).toHaveLength(1)
    const timed = await engine.query({ videoKey: 'bilibili:BVTEST00001:p1', question: '第 2 分钟' })
    expect(timed.mode).toBe('time')
    expect((timed.evidence ?? []).map(line => line.text)).toContain('压力测试关键词出现在这里')
    const listed = await engine.list()
    expect(listed.entries).toHaveLength(1)
    const status = await engine.status({ videoKey: 'bilibili:BVTEST00001:p1' })
    expect(status.capabilities).toMatchObject({ subtitle: 'ready', visual: 'unavailable', asr: 'disabled' })
    const removed = await engine.remove({ videoKey: 'bilibili:BVTEST00001:p1' })
    expect(removed.ok).toBe(true)
    await expect(engine.query({ videoKey: 'bilibili:BVTEST00001:p1', question: '压力测试' })).rejects.toThrow('索引不存在')
  })
  it('indexes a subtitle-less video honestly and says so on query', async () => {
    const fs = memoryFs()
    const engine = createVideoIndexEngine({ fs, fetchImpl: fakeFetch(false) })
    const indexed = await engine.index({ url: 'BVTEST00001' })
    expect(indexed).toMatchObject({ ok: true, subtitleSource: 'none', utteranceCount: 0 })
    const answered = await engine.query({ videoKey: 'bilibili:BVTEST00001:p1', question: '讲了什么' })
    expect(answered.context).toContain('没有可引用的文本证据')
    expect(answered.context).toContain('登录 B 站')
  })
})

/** A zoom channel whose video page exposes one audio stream — what the ASR lane reads before transcribing. */
function fakeAsrZoomChannel(): VideoZoomChannel {
  const unused = async (): Promise<never> => {
    throw new Error('the ASR lane does not use this channel member')
  }
  return {
    tabs: async () => [{ tabId: 7, url: 'https://www.bilibili.com/video/BVTEST00001' }],
    evaluate: async () => JSON.stringify({ baseUrl: 'https://upos-sz-mirror.bilivideo.com/audio.m4s' }),
    navigate: unused,
    openTab: unused,
    closeTab: unused,
    screenshot: unused,
  }
}

type FakeTranscribeUrl = () => Promise<AsrTranscriptOutcome>

/** The engine over the subtitle-less fake fetch with a mounted local ASR seam. */
function asrEngine(transcribeUrl: FakeTranscribeUrl, usage?: Array<{ capability: string; detail: string }>) {
  return createVideoIndexEngine({
    fs: memoryFs(),
    fetchImpl: fakeFetch(false),
    zoom: fakeAsrZoomChannel(),
    ...(usage === undefined ? {} : {
      usageRecorder: async (entry: { capability: 'ocr' | 'caption' | 'asr' | 'embed'; model: string; durationMs: number; detail: string }) => {
        usage.push(entry)
      },
    }),
    asr: { ready: async () => true, transcribeUrl },
  })
}

describe('engine local transcription coverage (批280-F)', () => {
  const videoKey = 'bilibili:BVTEST00001:p1'

  it('records where a cut-short transcript stops and says so on query and status', async () => {
    const usage: Array<{ capability: string; detail: string }> = []
    const engine = asrEngine(async () => ({
      segments: [
        { startMs: 1000, endMs: 4000, text: '本地转写的第一句' },
        { startMs: 70_000, endMs: 74_000, text: '覆盖范围内的第二句' },
      ],
      coveredMs: 100_000,
      truncated: true,
      timings: { fetchMs: 1_200, decodeMs: 340, transcribeMs: 149_960 },
    }), usage)

    const indexed = await engine.index({ url: 'BVTEST00001' })

    expect(indexed).toMatchObject({ ok: true, subtitleSource: 'asr', subtitleLan: 'auto', utteranceCount: 2, asrCoveredMs: 100_000 })
    expect(indexed).not.toHaveProperty('asrError')
    expect(usage).toEqual([expect.objectContaining({
      capability: 'asr',
      detail: '2 条台词（转写覆盖到 1:40）（取流 1.2s · 解码 0.3s · 转写 150s）',
    })])
    const answered = await engine.query({ videoKey, question: '覆盖范围' })
    expect(answered.context).toContain('[1:10–1:14] 覆盖范围内的第二句 (EVID_000002)')
    expect(answered.context).toContain('只覆盖 0:00–1:40；其后 1:20 未转写')
    const beyond = await engine.query({ videoKey, question: '第 3 分钟' })
    expect(beyond.context).toContain('没有可引用的文本证据')
    expect(beyond.context).toContain('其后 1:20 未转写')
    const status = await engine.status({ videoKey })
    expect(status.asrCoveredMs).toBe(100_000)
    expect(status.capabilities).toMatchObject({ subtitleSource: 'asr', asr: 'ready', asrCoveredMs: 100_000 })
  })

  it('leaves coverage absent when the transcript reaches the end', async () => {
    const engine = asrEngine(async () => ({ segments: [{ startMs: 0, endMs: 2000, text: '全程转写' }], coveredMs: 180_000, truncated: false }))

    const indexed = await engine.index({ url: 'BVTEST00001' })

    expect(indexed).toMatchObject({ ok: true, subtitleSource: 'asr', utteranceCount: 1 })
    expect(indexed).not.toHaveProperty('asrCoveredMs')
    expect((await engine.status({ videoKey })).capabilities).not.toHaveProperty('asrCoveredMs')
    expect((await engine.query({ videoKey, question: '全程' })).context).not.toContain('未转写')
  })

  it('treats a transcript marked cut short that still reaches the end as complete', async () => {
    const engine = asrEngine(async () => ({ segments: [{ startMs: 0, endMs: 2000, text: '到结尾' }], coveredMs: 500_000, truncated: true }))

    const indexed = await engine.index({ url: 'BVTEST00001' })

    expect(indexed).toMatchObject({ ok: true, subtitleSource: 'asr' })
    expect(indexed).not.toHaveProperty('asrCoveredMs')
  })

  it('explains an unavailable transcript lane when the paced run stopped before any speech', async () => {
    const engine = asrEngine(async () => ({ segments: [], coveredMs: 60_000, truncated: true }))

    const indexed = await engine.index({ url: 'BVTEST00001' })

    expect(indexed).toMatchObject({ ok: true, subtitleSource: 'none', utteranceCount: 0, asrCoveredMs: 60_000 })
    expect(indexed.asrError).toContain('时限内只转写到 1:00，其间未识别出台词')
  })

  it('carries the local lane failure into the index result instead of throwing', async () => {
    const engine = asrEngine(async () => {
      throw new Error('本地转写超时（已运行 360 秒）')
    })

    const indexed = await engine.index({ url: 'BVTEST00001' })

    expect(indexed).toMatchObject({ ok: true, subtitleSource: 'none', utteranceCount: 0, asrError: '本地转写超时（已运行 360 秒）' })
    expect((await engine.status({ videoKey })).capabilities).toMatchObject({ asr: 'unavailable', asrError: '本地转写超时（已运行 360 秒）' })
  })
})
