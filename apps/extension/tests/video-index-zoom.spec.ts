/**
 * The zoom slice: seek-expression builders, tab resolution (reuse/navigate/
 * open), the capture flow's honest failures, the engine's zoom wiring, and
 * the tool layer's attachment/route enrichment. The real CDP capture is
 * exercised by the automation probe (scenario C).
 * @module video-index-zoom
 */
import { describe, expect, it } from 'vitest'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { buildPlayerProbeExpression, buildSeekExpression, captureZoomFrame, parseSeekResult, resolveZoomTab } from '../src/offscreen/video-index/zoom.ts'
import { createVideoIndexEngine } from '../src/offscreen/video-index/engine.ts'
import { runVideoIndexAction } from '../src/offscreen/chrome-video-index-tool.ts'
import type { VideoZoomChannel } from '../src/offscreen/video-index/types.ts'
import type { IndexStoreFs } from '../src/offscreen/video-index/store.ts'
import { VideoIndexStore } from '../src/offscreen/video-index/store.ts'
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
      children.set(direct, rest.includes('/') ? 'directory' : 'file')
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

/** Seed one published index for BVSEED00001 p1 (60s) over the given fs. */
async function seedIndex(fs: IndexStoreFs): Promise<void> {
  const store = new VideoIndexStore(fs)
  const metadata = {
    videoKey: 'bilibili:BVSEED00001:p1', kind: 'bilibili' as const, bvid: 'BVSEED00001', page: 1,
    url: 'https://www.bilibili.com/video/BVSEED00001', title: '种子视频', upName: '', durationMs: 60_000,
    indexedAt: 1, revision: 1,
    capabilities: { subtitle: 'ready' as const, subtitleSource: 'bilibili-official' as const, visual: 'unavailable' as const, asr: 'disabled' as const },
  }
  const catalog = { videoKey: 'bilibili:BVSEED00001:p1', durationMs: 60_000, revision: 1, chunkCount: 1, chunks: [{ chunkId: '000000', startMs: 0, endMs: 60_000, utteranceCount: 1, textLength: 4 }] }
  const chunkFile = { chunkId: '000000', startMs: 0, endMs: 60_000, utterances: [{ utteranceId: 'u000001', evidenceId: 'EVID_000001', startMs: 5000, endMs: 9000, text: '台词' }] }
  await store.publishIndex({
    videoKey: 'bilibili:BVSEED00001:p1', metadata, catalog, chunkFiles: [chunkFile],
    registryEntry: { videoKey: 'bilibili:BVSEED00001:p1', title: '种子视频', bvid: 'BVSEED00001', page: 1, url: metadata.url, durationMs: 60_000, indexedAt: 1, subtitleSource: 'bilibili-official', utteranceCount: 1 },
  })
}

/** A zoom channel whose page has a video element and seekable clock. */
function fakeZoomChannel(options?: { player?: boolean }): VideoZoomChannel & { opened: string[]; navigated: number[]; closed: number[] } {
  const state: { opened: string[]; navigated: number[]; closed: number[] } = { opened: [], navigated: [], closed: [] }
  const channel = {
    opened: state.opened,
    navigated: state.navigated,
    closed: state.closed,
    tabs: async () => [{ tabId: 7, url: 'https://www.bilibili.com/video/BVSEED00001' }],
    evaluate: async (_tabId: number, expression: string) => {
      if (expression.includes("querySelector('video') != null")) {
        return options?.player === false ? 'false' : 'true'
      }
      return JSON.stringify({ ok: true, duration: 60 })
    },
    navigate: async (tabId: number, url: string) => { state.navigated.push(tabId); void url },
    openTab: async (url: string) => { state.opened.push(url); return { tabId: 9 } },
    closeTab: async (tabId: number) => { state.closed.push(tabId) },
    screenshot: async () => ({ data: new Uint8Array([137, 80, 78, 71]), width: 64, height: 48 }),
  }
  return channel
}

describe('expression builders', () => {
  it('interpolates only the numeric second into the fixed seek template', () => {
    const expression = buildSeekExpression(12.5)
    expect(expression).toContain('v.currentTime = 12.5')
    expect(expression).toContain("querySelector('video')")
    expect(buildPlayerProbeExpression()).toContain("querySelector('video') != null")
  })
  it('parses seek results and rejects unusable bodies', () => {
    expect(parseSeekResult('{"ok":true,"duration":60}')).toEqual({ ok: true, duration: 60 })
    expect(parseSeekResult('{"ok":false,"reason":"no-video"}')).toEqual({ ok: false, reason: 'no-video' })
    expect(parseSeekResult('not-json')).toBeUndefined()
    expect(parseSeekResult('[]')).toBeUndefined()
  })
})

describe('resolveZoomTab', () => {
  it('reuses a matching tab without navigating', async () => {
    const channel = fakeZoomChannel()
    const resolved = await resolveZoomTab(channel, 'https://www.bilibili.com/video/BVSEED00001')
    expect(resolved).toEqual({ tabId: 7, navigated: false })
    expect(channel.navigated).toHaveLength(0)
    expect(channel.opened).toHaveLength(0)
  })
  it('navigates a part-mismatched tab and opens one when absent', async () => {
    const mismatched = fakeZoomChannel()
    mismatched.tabs = async () => [{ tabId: 7, url: 'https://www.bilibili.com/video/BVSEED00001?p=2' }]
    const navigated = await resolveZoomTab(mismatched, 'https://www.bilibili.com/video/BVSEED00001')
    expect(navigated).toEqual({ tabId: 7, navigated: true })
    expect(mismatched.navigated).toHaveLength(1)
    const empty = fakeZoomChannel()
    empty.tabs = async () => []
    const opened = await resolveZoomTab(empty, 'https://www.bilibili.com/video/BVSEED00001')
    expect(opened).toEqual({ tabId: 9, navigated: true })
    expect(empty.opened).toEqual(['https://www.bilibili.com/video/BVSEED00001'])
  })
})

describe('captureZoomFrame', () => {
  it('seeks, settles, and returns the frame bytes', async () => {
    const channel = fakeZoomChannel()
    const outcome = await captureZoomFrame(channel, 'https://www.bilibili.com/video/BVSEED00001', 30_000)
    expect(outcome.ok).toBe(true)
    expect(outcome.frame).toMatchObject({ width: 64, height: 48, seekedToMs: 30_000 })
    expect(outcome.frame?.data.byteLength).toBe(4)
  })
  it('reports a missing player honestly', async () => {
    const channel = fakeZoomChannel({ player: false })
    const outcome = await captureZoomFrame(channel, 'https://www.bilibili.com/video/BVSEED00001', 30_000)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('播放器')
  }, 15_000)
})

describe('engine zoom wiring', () => {
  it('reports honestly without a channel and rejects out-of-range times', async () => {
    const fs = new MemoryIndexFs()
    await seedIndex(fs)
    const engine = createVideoIndexEngine({ fs })
    const noChannel = await engine.zoom({ videoKey: 'bilibili:BVSEED00001:p1', timestampMs: 30_000 })
    expect(noChannel.ok).toBe(false)
    expect(noChannel.error).toContain('画面截帧通道未接入')
    const withChannel = createVideoIndexEngine({ fs, zoom: fakeZoomChannel() })
    const outOfRange = await withChannel.zoom({ videoKey: 'bilibili:BVSEED00001:p1', timestampMs: 61_000 })
    expect(outOfRange.ok).toBe(false)
    expect(outOfRange.error).toContain('超出视频时长')
    const missing = withChannel.zoom({ videoKey: 'bilibili:BVNOPE00001:p1', timestampMs: 30_000 })
    await expect(missing).rejects.toThrow('索引不存在')
  })
  it('captures through the engine when the channel is wired', async () => {
    const fs = new MemoryIndexFs()
    await seedIndex(fs)
    const engine = createVideoIndexEngine({ fs, zoom: fakeZoomChannel() })
    const outcome = await engine.zoom({ videoKey: 'bilibili:BVSEED00001:p1', timestampMs: 30_000 })
    expect(outcome.ok).toBe(true)
    expect(outcome.frame).toMatchObject({ seekedToMs: 30_000 })
  })
  it('captures by video page URL with no index: opens the canonical page and names no key', async () => {
    const channel = fakeZoomChannel()
    channel.tabs = async () => []
    const engine = createVideoIndexEngine({ fs: new MemoryIndexFs(), zoom: channel })
    const outcome = await engine.zoom({ videoKey: '', url: 'https://www.bilibili.com/video/BVSEED00001?t=3', timestampMs: 30_000 })
    expect(outcome.ok).toBe(true)
    expect(outcome.videoKey).toBeUndefined()
    expect(outcome.frame).toMatchObject({ seekedToMs: 30_000 })
    expect(channel.opened).toEqual(['https://www.bilibili.com/video/BVSEED00001?p=1'])
  })
  it('reports a zoom that names neither a key nor a URL, and one whose URL is not a Bilibili video page', async () => {
    const engine = createVideoIndexEngine({ fs: new MemoryIndexFs(), zoom: fakeZoomChannel() })
    const neither = await engine.zoom({ videoKey: '', timestampMs: 30_000 })
    expect(neither.ok).toBe(false)
    expect(neither.error).toContain('缺少 videoKey 或 url')
    await expect(engine.zoom({ videoKey: '', url: 'https://example.com/video/BVSEED00001', timestampMs: 30_000 })).rejects.toThrow('只接受 bilibili.com')
  })
})

describe('tool-layer zoom enrichment', () => {
  const fakeAttachments = () => ({
    imageLimits: { maxImageBytes: 1_000_000, maxMessageImageBytes: 1_000_000 },
    saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => ({
      attachmentId: 'att-1', mediaType: input.mediaType, bytes: input.data.byteLength, width: 64, height: 48,
      ...(input.name === undefined ? {} : { name: input.name }),
    }),
  })
  const imageRouteLlm = () => ({ resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) })
  const textRouteLlm = () => ({ resolveModelInfo: async () => ({ inputModalities: ['text'] }) })
  const routedAgent = {
    session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-v4-flash' } }) },
    options: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  }

  it('commits the frame through attachments and returns the image reference', async () => {
    const fs = new MemoryIndexFs()
    await seedIndex(fs)
    const deps = { fs, zoom: fakeZoomChannel(), zoomHost: { attachments: fakeAttachments, llm: imageRouteLlm } }
    const outcome = await runVideoIndexAction(
      { action: 'zoom', videoKey: 'bilibili:BVSEED00001:p1', timestampMs: 30_000 },
      deps,
      { signal: new AbortController().signal, agent: routedAgent },
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.image).toMatchObject({ attachmentId: 'att-1', mediaType: 'image/png', bytes: 4, width: 64, height: 48 })
    expect(outcome.seekedToMs).toBe(30_000)
    // The frame lands in the index's evidence store with a citation id.
    expect(outcome.frameId).toBe('FRAME_000001')
    const store = new VideoIndexStore(fs)
    const frames = await store.readFrameEvidence('bilibili:BVSEED00001:p1')
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ frameId: 'FRAME_000001', attachmentId: 'att-1', startMs: 30_000, file: 'video-zoom-30000-1.png' })
    const second = await runVideoIndexAction(
      { action: 'zoom', videoKey: 'bilibili:BVSEED00001:p1', timestampMs: 45_000 },
      deps,
      { signal: new AbortController().signal, agent: routedAgent },
    )
    expect(second.frameId).toBe('FRAME_000002')
  })
  it('commits a zoom by video page URL with no index behind it and files no evidence', async () => {
    const fs = new MemoryIndexFs()
    const deps = { fs, zoom: fakeZoomChannel(), zoomHost: { attachments: fakeAttachments, llm: imageRouteLlm } }
    const outcome = await runVideoIndexAction(
      { action: 'zoom', url: 'https://www.bilibili.com/video/BVSEED00001', timestampMs: 30_000 },
      deps,
      { signal: new AbortController().signal, agent: routedAgent },
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.image).toMatchObject({ attachmentId: 'att-1', mediaType: 'image/png' })
    expect(outcome.frameId).toBeUndefined()
    expect(await new VideoIndexStore(fs).readFrameEvidence('bilibili:BVSEED00001:p1')).toHaveLength(0)
  })
  it('refuses honestly when the model route lacks image input', async () => {
    const fs = new MemoryIndexFs()
    await seedIndex(fs)
    const deps = { fs, zoom: fakeZoomChannel(), zoomHost: { attachments: fakeAttachments, llm: textRouteLlm } }
    const outcome = await runVideoIndexAction(
      { action: 'zoom', videoKey: 'bilibili:BVSEED00001:p1', timestampMs: 30_000 },
      deps,
      { signal: new AbortController().signal, agent: routedAgent },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('未声明图片输入')
  })
  it('passes the screenshot capability refusal through verbatim', async () => {
    const fs = new MemoryIndexFs()
    await seedIndex(fs)
    const gated = fakeZoomChannel()
    gated.screenshot = async () => { throw new Error('网页截图能力未启用：请在侧栏「用户插件」面板中勾选开启') }
    const deps = { fs, zoom: gated, zoomHost: { attachments: fakeAttachments, llm: imageRouteLlm } }
    const outcome = await runVideoIndexAction(
      { action: 'zoom', videoKey: 'bilibili:BVSEED00001:p1', timestampMs: 30_000 },
      deps,
      { signal: new AbortController().signal, agent: routedAgent },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('网页截图能力未启用')
  })
  it('rejects a missing timestamp', async () => {
    const fs = new MemoryIndexFs()
    await seedIndex(fs)
    const engine = createVideoIndexEngine({ fs, zoom: fakeZoomChannel() })
    const outcome = await engine.zoom({ videoKey: 'bilibili:BVSEED00001:p1' })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('缺少 timestampMs')
  })
})
