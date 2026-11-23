/**
 * The `video_index` tool surface: registration shape over fake seams, the
 * dispatcher's wiring (expected failures report `error` instead of throwing),
 * and the model-facing render texts. The engine behavior itself is covered
 * by video-index-engine.spec.ts.
 * @module video-index-tool
 */
import { describe, expect, it } from 'vitest'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { apply, asrOutcomeFromWorker, Config, registerVideoIndexTool, resolveAsrBudgetMs, runVideoIndexAction } from '../src/offscreen/chrome-video-index-tool.ts'
import { DEFAULT_ASR_BUDGET_MS } from '../src/offscreen/ai-runtime/asr-pacing.ts'
import type { VideoIndexActionArgs } from '../src/offscreen/chrome-video-index-tool.ts'
import { renderText } from '../src/offscreen/video-index/render.ts'
import type { FsDirEntry, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { VideoIndexToolValue } from '../src/offscreen/video-index/types.ts'

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

/** Canned direct-lane fetch: one video with an official subtitle track. */
const fakeFetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('/x/web-interface/view')) {
    return new Response(JSON.stringify({ code: 0, data: { bvid: 'BVTOOL00001', aid: 9, title: '工具视频', desc: '', duration: 120, owner: { name: 'UP' }, cid: 5, pages: [{ page: 1, cid: 5, duration: 120 }] } }), { status: 200 })
  }
  if (url.includes('/x/player/v2')) {
    return new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh', subtitle_url: '//aisubtitle.hdslb.com/cc.json', ai_type: 0 }] } } }), { status: 200 })
  }
  if (url.includes('aisubtitle.hdslb.com')) {
    return new Response(JSON.stringify({ body: [{ from: 5, to: 9, content: '工具测试台词' }] }), { status: 200 })
  }
  return new Response('{}', { status: 200 })
})

const SIGNAL = new AbortController().signal

describe('registration', () => {
  it('registers exactly one video_index tool', () => {
    const registered: Array<{ name: string }> = []
    const ctx = {
      tools: { register: (tool: { name: string }): void => { registered.push(tool) } },
      fs: new MemoryIndexFs(),
      browser: { provider: { tabs: async () => [], evaluate: async () => '' } },
    }
    apply(ctx as never, {})
    expect(registered.map(tool => tool.name)).toEqual(['video_index'])
  })
  it('registerVideoIndexTool accepts injected deps for tests', () => {
    const registered: Array<{ name: string }> = []
    const tools = { register: (tool: unknown): void => { registered.push(tool as { name: string }) } }
    registerVideoIndexTool(tools, { fs: new MemoryIndexFs() })
    expect(registered.map(tool => tool.name)).toEqual(['video_index'])
  })
})

describe('dispatcher', () => {
  it('indexes through the direct lane and reports the key', async () => {
    const outcome = await runVideoIndexAction(
      { action: 'index', url: 'https://www.bilibili.com/video/BVTOOL00001' },
      { fs: new MemoryIndexFs(), fetchImpl: fakeFetch },
      { signal: SIGNAL },
    )
    expect(outcome).toMatchObject({ ok: true, action: 'index', videoKey: 'bilibili:BVTOOL00001:p1', subtitleSource: 'bilibili-official' })
  })
  it('answers a retrieval with the evidence context', async () => {
    const fs = new MemoryIndexFs()
    await runVideoIndexAction({ action: 'index', url: 'BVTOOL00001' }, { fs, fetchImpl: fakeFetch }, { signal: SIGNAL })
    const outcome = await runVideoIndexAction(
      { action: 'query', videoKey: 'bilibili:BVTOOL00001:p1', question: '工具测试' },
      { fs, fetchImpl: fakeFetch },
      { signal: SIGNAL },
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.context).toContain('工具测试台词 (EVID_000001)')
  })
  it('reports an unknown index as an error instead of throwing', async () => {
    const outcome = await runVideoIndexAction(
      { action: 'remove', videoKey: 'bilibili:BVNOPE:p1' },
      { fs: new MemoryIndexFs(), fetchImpl: fakeFetch },
      { signal: SIGNAL },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('索引不存在')
  })
  it('rejects a blank index source', async () => {
    const outcome = await runVideoIndexAction({ action: 'index', url: '  ' }, { fs: new MemoryIndexFs(), fetchImpl: fakeFetch }, { signal: SIGNAL })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('缺少 url')
  })
})

describe('renderText', () => {
  it('renders the failure, index, list-empty, and query shapes', () => {
    expect(renderText({ ok: false, action: 'index', error: '原因' })).toBe('失败：原因')
    const index = renderText({
      ok: true, action: 'index', videoKey: 'bilibili:BV1:p1', title: '标题',
      durationMs: 125_000, utteranceCount: 3, chunkCount: 1, subtitleSource: 'bilibili-official',
    })
    expect(index).toContain('已建立索引：标题（时长 0:02:05，3 条台词')
    expect(index).toContain('索引键 bilibili:BV1:p1')
    expect(renderText({ ok: true, action: 'list' })).toContain('还没有任何索引')
    expect(renderText({ ok: true, action: 'query', context: '证据正文' })).toBe('证据正文')
  })
})

/** Type-level guard: tool args stay assignable to the dispatcher input. */
type ArgsCheck = VideoIndexActionArgs extends never ? never : VideoIndexToolValue['action']
const argsCheck: ArgsCheck = 'index'
void argsCheck

describe('local transcription seam (批280-F)', () => {
  it('narrows the worker transcript reply and refuses a malformed one', () => {
    const reply = {
      segments: [{ start: 1.004, end: 2, text: '台词' }, { start: null, end: 3, text: '坏块' }, 'junk'],
      processedMs: 100_000.4,
      truncated: true,
    }
    expect(asrOutcomeFromWorker(reply)).toEqual({
      segments: [{ startMs: 1004, endMs: 2000, text: '台词' }],
      coveredMs: 100_000,
      truncated: true,
    })
    expect(asrOutcomeFromWorker({ segments: [{ start: 3, end: null, text: '无结束' }] }))
      .toEqual({ segments: [{ startMs: 3000, endMs: 3000, text: '无结束' }] })
    expect(() => asrOutcomeFromWorker({ segments: 'nope' })).toThrow('转写结果缺少台词列表')
    expect(() => asrOutcomeFromWorker(null)).toThrow('转写结果格式异常')
  })

  it('resolves the transcription budget from the config', () => {
    expect(Config({})).toEqual({ asrBudgetMs: DEFAULT_ASR_BUDGET_MS })
    expect(Config({ asrBudgetMs: 45_000 })).toEqual({ asrBudgetMs: 45_000 })
    expect(resolveAsrBudgetMs({})).toBe(DEFAULT_ASR_BUDGET_MS)
    expect(resolveAsrBudgetMs({ asrBudgetMs: 45_000 })).toBe(45_000)
  })

  it('states the transcript coverage in the index and status renders', () => {
    const index = renderText({
      ok: true, action: 'index', title: '标题', videoKey: 'bilibili:BV1:p1', durationMs: 409_000,
      utteranceCount: 40, chunkCount: 1, subtitleSource: 'asr', asrCoveredMs: 300_000,
    })
    expect(index).toContain('本地转写覆盖 0:00:00–0:05:00，其后 0:01:49 未转写')
    const status = renderText({ ok: true, action: 'status', videoKey: 'bilibili:BV1:p1', durationMs: 409_000, subtitleSource: 'asr', asrCoveredMs: 409_000 })
    expect(status).not.toContain('未转写')
  })

  it('keeps the output schema open for the coverage field at both depths', () => {
    interface Registered {
      output: { schema: { properties: Record<string, { type?: string; properties?: Record<string, unknown> }> } }
    }
    const registered: Registered[] = []
    registerVideoIndexTool({ register: (tool: unknown) => { registered.push(tool as Registered) } }, { fs: new MemoryIndexFs() })

    const schema = registered[0]?.output.schema

    expect(schema?.properties.asrCoveredMs).toEqual({ type: 'integer' })
    expect(schema?.properties.capabilities?.properties?.asrCoveredMs).toEqual({ type: 'integer' })
  })
})
