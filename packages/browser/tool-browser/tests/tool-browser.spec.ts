/**
 * dsh-tool-browser coverage: tool registration and config toggles, the
 * browser-operation prompt section, snapshot render format and caps, click
 * index/selector resolution with coordinate fallback, and defensive Chinese
 * argument errors — all against a scripted provider over the real seam.
 * @module @deepseek-ai/dsh-tool-browser/tests/tool-browser
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import BrowserRuntimeService from '@deepseek-ai/dsh-browser'
import type { BrowserProvider, PageElementInfo, PageScreenshot, PageSnapshot, TabInfo } from '@deepseek-ai/dsh-browser'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import * as toolBrowser from '../src/index.ts'
import { PAGE_SNAPSHOT_MAX_ELEMENTS } from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** A scripted provider recording every call. */
class ScriptedProvider implements BrowserProvider {
  readonly id = 'scripted'
  readonly calls: string[] = []
  /** Per-method behaviors a test overrides. */
  behavior: Partial<Record<keyof BrowserProvider, (...args: unknown[]) => unknown>> = {}
  snapshotElements: PageElementInfo[] = []
  tabsValue: TabInfo[] = [
    { tabId: 7, title: '活动页', url: 'https://active.example', active: true, windowId: 1, index: 0 },
    { tabId: 9, title: '后台页', url: 'https://bg.example', active: false, windowId: 1, index: 1 },
  ]

  private record<T>(method: keyof BrowserProvider, fallback: () => T): Promise<T> {
    this.calls.push(method)
    const override = this.behavior[method]
    if (override !== undefined) return Promise.resolve(override() as T)
    return Promise.resolve(fallback())
  }

  tabs(): Promise<TabInfo[]> {
    return this.record('tabs', () => this.tabsValue)
  }

  switchTab(): Promise<void> {
    return this.record('switchTab', () => undefined)
  }

  openTab(): Promise<TabInfo> {
    return this.record('openTab', () => ({ tabId: 11, title: '新页', url: 'https://new.example', active: true, windowId: 1, index: 2 }))
  }

  closeTab(): Promise<void> {
    return this.record('closeTab', () => undefined)
  }

  navigate(): Promise<void> {
    return this.record('navigate', () => undefined)
  }

  snapshot(): Promise<PageSnapshot> {
    return this.record('snapshot', () => ({
      tabId: 7,
      url: 'https://active.example/page',
      title: '示例页',
      timestamp: 1234,
      viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 900 },
      elements: this.snapshotElements,
    }))
  }

  lastScreenshot: { tabId: number; fullPage: boolean } | undefined

  screenshot(tabId: number, opts?: { fullPage?: boolean }): Promise<PageScreenshot> {
    this.lastScreenshot = { tabId, fullPage: opts?.fullPage === true }
    return this.record('screenshot', () => ({ data: new Uint8Array([1]), mediaType: 'image/png' as const, width: 3, height: 4 }))
  }

  clickSelector(): Promise<void> {
    return this.record('clickSelector', () => undefined)
  }

  clickPoint(): Promise<void> {
    return this.record('clickPoint', () => undefined)
  }

  typeText(): Promise<void> {
    return this.record('typeText', () => undefined)
  }

  pressKey(): Promise<void> {
    return this.record('pressKey', () => undefined)
  }

  scroll(): Promise<void> {
    return this.record('scroll', () => undefined)
  }

  waitFor(): Promise<void> {
    return this.record('waitFor', () => undefined)
  }

  evaluate<T>(): Promise<T> {
    return this.record<T>('evaluate', () => '页面文本' as unknown as T)
  }
}

/** One addressable plus one shadow-DOM element. */
function standardElements(): PageElementInfo[] {
  return [
    {
      index: 0, tag: 'input', selector: '#q', text: '', placeholder: '搜索',
      rect: { x: 0, y: 0, width: 100, height: 20 }, center: { x: 50, y: 10 }, interactive: true,
    },
    {
      index: 1, tag: 'button', selector: '', text: '影子按钮', inShadowDom: true,
      rect: { x: 10, y: 30, width: 40, height: 20 }, center: { x: 30, y: 40 }, interactive: true,
    },
  ]
}

/** Mount the full stack with a scripted provider registered on the seam. */
async function setup(config: toolBrowser.Config = {}, elements = standardElements()) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(BrowserRuntimeService)
  const provider = new ScriptedProvider()
  provider.snapshotElements = elements
  const disposeProvider = ctx.browser.register(provider)
  await ctx.plugin(toolBrowser, config)
  return { ctx, provider, disposeProvider }
}

let callCounter = 0
/** Execute one registered tool through the real pipeline. */
function callTool(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const ALL_TOOLS = [
  'tabs_list', 'tabs_switch', 'tabs_open', 'tabs_close',
  'page_navigate', 'page_snapshot', 'page_click', 'page_type',
  'page_press_key', 'page_scroll', 'page_wait_for', 'page_extract_text',
  'page_evaluate',
]

describe('dsh-tool-browser: registration and config', () => {
  it('registers all thirteen tools and the guidance prompt section by default', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([...ALL_TOOLS].sort())
    const assembled = await ctx.systemPrompt.assemble()
    const section = assembled.sections.find(entry => entry.name === 'tool:browser')
    expect(section?.text).toContain('快照优先')
    expect(section?.text).toContain('坐标回退')
  })

  it('config toggles drop exactly one tool group', async () => {
    const tabsOff = await setup({ tabs: false })
    expect(tabsOff.ctx.tools.schemas().map(schema => schema.name)).not.toContain('tabs_list')
    expect(tabsOff.ctx.tools.schemas().map(schema => schema.name)).toContain('page_snapshot')

    const pageOff = await setup({ page: false })
    expect(pageOff.ctx.tools.schemas().map(schema => schema.name)).toContain('tabs_list')
    expect(pageOff.ctx.tools.schemas().map(schema => schema.name)).not.toContain('page_snapshot')
  })

  it('tools stay visible without a provider and fail with the seam Chinese error', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(BrowserRuntimeService)
    await ctx.plugin(toolBrowser)
    const result = await callTool(ctx, 'tabs_list', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('尚未注册任何浏览器 provider')
  })
})

describe('dsh-tool-browser: tabs tools', () => {
  it('tabs_list renders every tab with the active marker', async () => {
    const { ctx } = await setup()
    const result = await callTool(ctx, 'tabs_list', {})
    expect(result.isError).toBe(false)
    expect(text(result)).toBe([
      '浏览器共 2 个标签页（* 为活动标签页）：',
      '[7] * 活动页 — https://active.example',
      '[9]   后台页 — https://bg.example',
    ].join('\n'))
  })

  it('tabs_switch / tabs_open / tabs_close reach the provider with validated ids', async () => {
    const { ctx, provider } = await setup()
    await callTool(ctx, 'tabs_switch', { tab_id: 9 })
    await callTool(ctx, 'tabs_open', { url: 'https://new.example' })
    await callTool(ctx, 'tabs_close', { tab_id: 7 })
    expect(provider.calls).toEqual(['switchTab', 'openTab', 'closeTab'])

    const bad = await callTool(ctx, 'tabs_switch', { tab_id: -3 })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toContain('tab_id 必须是非负整数')
    const blankUrl = await callTool(ctx, 'tabs_open', { url: '   ' })
    expect(blankUrl.isError).toBe(true)
    expect(text(blankUrl)).toContain('url 必须是非空字符串')
  })
})

describe('dsh-tool-browser: page tools', () => {
  it('page_snapshot renders the header plus one line per element and caps at 40', async () => {
    const many: PageElementInfo[] = Array.from({ length: 57 }, (_, i) => ({
      index: i, tag: 'a', selector: `#a${i}`, text: `链接${i}`,
      rect: { x: i, y: 0, width: 1, height: 1 }, center: { x: i, y: 0 }, interactive: true,
    }))
    const { ctx } = await setup({}, many)
    const result = await callTool(ctx, 'page_snapshot', { tab_id: 7 })
    expect(result.isError).toBe(false)
    const rendered = text(result).split('\n')
    expect(rendered[0]).toBe('标签页 7 快照：示例页')
    expect(rendered[1]).toBe('URL: https://active.example/page')
    expect(rendered[2]).toBe('视口 1280x720，滚动位置 (0, 900)')
    expect(rendered[3]).toBe('[0] <a> selector="#a0" text="链接0" center=(0,0)')
    expect(rendered).toHaveLength(3 + PAGE_SNAPSHOT_MAX_ELEMENTS + 1)
    expect(rendered.at(-1)).toContain('共 57 个元素，仅显示前 40 个')
  })

  it('page_snapshot marks unaddressable elements with the coordinate hint', async () => {
    const { ctx } = await setup()
    const rendered = text(await callTool(ctx, 'page_snapshot', { tab_id: 7 })).split('\n')
    expect(rendered[3]).toBe('[0] <input> selector="#q" text="" center=(50,10)')
    expect(rendered[4]).toBe('[1] <button> (shadow/iframe→用坐标) text="影子按钮" center=(30,40)')
  })

  it('page_click resolves an index through a fresh snapshot and clicks the selector', async () => {
    const { ctx, provider } = await setup()
    const result = await callTool(ctx, 'page_click', { tab_id: 7, index: 0 })
    expect(result.isError).toBe(false)
    expect(provider.calls).toEqual(['snapshot', 'clickSelector'])
    expect(text(result)).toContain('selector "#q"')
  })

  it('page_click falls back to coordinates for empty selectors and failed selector clicks', async () => {
    const shadow = await setup()
    const shadowResult = await callTool(shadow.ctx, 'page_click', { tab_id: 7, index: 1 })
    expect(shadowResult.isError).toBe(false)
    expect(shadow.provider.calls).toEqual(['snapshot', 'clickPoint'])
    expect(text(shadowResult)).toContain('(30, 40)')
    expect(text(shadowResult)).toContain('shadow DOM/iframe')

    const failing = await setup()
    failing.provider.behavior['clickSelector'] = () => { throw new Error('detached') }
    const fallback = await callTool(failing.ctx, 'page_click', { tab_id: 7, index: 0 })
    expect(fallback.isError).toBe(false)
    expect(failing.provider.calls).toEqual(['snapshot', 'clickSelector', 'clickPoint'])
    expect(text(fallback)).toContain('selector 点击失败，已回退坐标点击')
  })

  it('page_click by selector falls back to snapshot coordinates when the direct click fails', async () => {
    const { ctx, provider } = await setup()
    provider.behavior['clickSelector'] = () => { throw new Error('gone') }
    const result = await callTool(ctx, 'page_click', { tab_id: 7, selector: '#q' })
    expect(result.isError).toBe(false)
    expect(provider.calls).toEqual(['clickSelector', 'snapshot', 'clickPoint'])
  })

  it('page_click rejects both-addressing and neither-addressing calls in Chinese', async () => {
    const { ctx } = await setup()
    const both = await callTool(ctx, 'page_click', { tab_id: 7, index: 0, selector: '#q' })
    expect(both.isError).toBe(true)
    expect(text(both)).toContain('index 与 selector 只能提供一个')
    const neither = await callTool(ctx, 'page_click', { tab_id: 7 })
    expect(neither.isError).toBe(true)
    expect(text(neither)).toContain('index（来自最近一次 page_snapshot）或 selector 之一')
    const outOfRange = await callTool(ctx, 'page_click', { tab_id: 7, index: 99 })
    expect(outOfRange.isError).toBe(true)
    expect(text(outOfRange)).toContain('没有 index 为 99 的元素')
  })

  it('page_type forwards submit and rejects blank selector/text', async () => {
    const { ctx, provider } = await setup()
    const result = await callTool(ctx, 'page_type', { tab_id: 7, selector: '#q', text: 'hello', submit: true })
    expect(result.isError).toBe(false)
    expect(provider.calls).toEqual(['typeText'])
    expect(text(result)).toContain('并按回车提交')

    const blank = await callTool(ctx, 'page_type', { tab_id: 7, selector: '  ', text: 'x' })
    expect(text(blank)).toContain('selector 必须是非空的 CSS selector')
    const emptyText = await callTool(ctx, 'page_type', { tab_id: 7, selector: '#q', text: '' })
    expect(text(emptyText)).toContain('text 必须是非空字符串')
  })

  it('page_press_key accepts single keys and modifier combos (provider validates)', async () => {
    const { ctx, provider } = await setup()
    const ok = await callTool(ctx, 'page_press_key', { tab_id: 7, key: 'Enter' })
    expect(ok.isError).toBe(false)
    const combo = await callTool(ctx, 'page_press_key', { tab_id: 7, key: 'Ctrl+Shift+A' })
    expect(combo.isError).toBe(false)
    expect(provider.calls).toEqual(['pressKey', 'pressKey'])
  })

  it('page_scroll validates the pixel amount', async () => {
    const { ctx, provider } = await setup()
    const ok = await callTool(ctx, 'page_scroll', { tab_id: 7, direction: 'down', amount_px: 300 })
    expect(ok.isError).toBe(false)
    expect(provider.calls).toEqual(['scroll'])
    const bad = await callTool(ctx, 'page_scroll', { tab_id: 7, direction: 'down', amount_px: 0 })
    expect(text(bad)).toContain('amount_px 必须是正整数')
  })

  it('page_wait_for bounds the model-supplied timeout', async () => {
    const { ctx } = await setup()
    const ok = await callTool(ctx, 'page_wait_for', { tab_id: 7, selector: '.result', timeout_ms: 500 })
    expect(ok.isError).toBe(false)
    expect(text(ok)).toContain('已在')
    const over = await callTool(ctx, 'page_wait_for', { tab_id: 7, selector: '.result', timeout_ms: 60000 })
    expect(text(over)).toContain('timeout_ms 不能超过 30000')
  })

  it('page_extract_text truncates at 4000 characters and reports the selector', async () => {
    const { ctx, provider } = await setup()
    provider.behavior['evaluate'] = () => 'x'.repeat(4500)
    const result = await callTool(ctx, 'page_extract_text', { tab_id: 7 })
    expect(result.isError).toBe(false)
    const rendered = text(result)
    expect(rendered).toHaveLength(4000 + '\n（文本超过 4000 字符已被截断；需要后半部分时请用更窄的 selector。）'.length)
    expect(rendered).toContain('已被截断')

    provider.behavior['evaluate'] = () => null
    const missing = await callTool(ctx, 'page_extract_text', { tab_id: 7, selector: '#gone' })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('未匹配到任何元素')
  })

  it('page_navigate renders the re-snapshot reminder', async () => {
    const { ctx, provider } = await setup()
    const result = await callTool(ctx, 'page_navigate', { tab_id: 7, url: 'https://next.example' })
    expect(result.isError).toBe(false)
    expect(provider.calls).toEqual(['navigate'])
    expect(text(result)).toContain('重新 page_snapshot')
  })

  it('page_evaluate forwards the expression and serializes scalar and structured results', async () => {
    const { ctx, provider } = await setup()
    provider.behavior['evaluate'] = () => 42
    const scalar = await callTool(ctx, 'page_evaluate', { tab_id: 7, expression: '1 + 1' })
    expect(scalar.isError).toBe(false)
    expect(provider.calls).toEqual(['evaluate'])
    expect(text(scalar)).toBe('标签页 7 执行结果：42')

    provider.behavior['evaluate'] = () => ({ title: '示例', items: [1, null, true] })
    const structured = await callTool(ctx, 'page_evaluate', { tab_id: 7, expression: 'document.title' })
    expect(text(structured)).toBe('标签页 7 执行结果：{"title":"示例","items":[1,null,true]}')

    provider.behavior['evaluate'] = () => null
    const empty = await callTool(ctx, 'page_evaluate', { tab_id: 7, expression: 'void 0' })
    expect(text(empty)).toBe('标签页 7 执行结果：null')
  })

  it('page_evaluate rejects a blank expression without touching the provider', async () => {
    const { ctx, provider } = await setup()
    const blank = await callTool(ctx, 'page_evaluate', { tab_id: 7, expression: '   ' })
    expect(blank.isError).toBe(true)
    expect(text(blank)).toContain('expression 必须是非空的 JavaScript 表达式')
    expect(provider.calls).toEqual([])
  })

  it('page_evaluate reports a failing page script as the tool error', async () => {
    const { ctx, provider } = await setup()
    provider.behavior['evaluate'] = () => {
      throw new Error('页面脚本执行失败：Uncaught（ReferenceError: gone is not defined）[行 1]')
    }
    const failing = await callTool(ctx, 'page_evaluate', { tab_id: 7, expression: 'gone()' })
    expect(failing.isError).toBe(true)
    expect(text(failing)).toContain('页面脚本执行失败')
    expect(text(failing)).toContain('ReferenceError: gone is not defined')
  })

  it('page_evaluate truncates oversized render output and notes the cap', async () => {
    const { ctx, provider } = await setup()
    provider.behavior['evaluate'] = () => 'y'.repeat(4500)
    const oversized = await callTool(ctx, 'page_evaluate', { tab_id: 7, expression: 'document.body.innerText' })
    expect(oversized.isError).toBe(false)
    const rendered = text(oversized)
    // A string result serializes as a JSON string: the truncated slice opens
    // with the quote and stops after 3999 of the 4500 characters.
    expect(rendered).toBe(`标签页 7 执行结果：${JSON.stringify('y'.repeat(4500)).slice(0, 4000)}\n（结果超过 4000 字符已被截断）`)
  })
})

// ── page_screenshot: capture → durable commit → image block ──

/** Exact-route fake adapter; stream is unreachable in these tests. */
class VisionCatalogAdapter extends LlmAdapter {
  constructor(private readonly models: LlmModelInfo[]) {
    super()
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const resolved = this.models.find(candidate => candidate.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: resolved?.name ?? model,
      ...resolved?.inputModalities === undefined ? {} : { inputModalities: [...resolved.inputModalities] },
    })
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('page_screenshot tests never stream')
  }
}

/** In-memory attachment store double: records saves, fixed-geometry refs. */
class MemoryShotStore extends AttachmentStore {
  readonly saved: SaveImageAttachment[] = []
  readonly imageLimits: ImageAttachmentLimits = {
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    maxImageBytes: 5_000_000,
    maxImagePixels: 100_000_000,
    maxMessageImageBytes: 5_000_000,
    maxImagesPerMessage: 8,
  }

  async validateImage(): Promise<void> {}

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    return {
      attachmentId: AttachmentId('mem-shot-1'),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 9,
      height: 7,
    }
  }

  async readImage(): Promise<StoredImageAttachment> {
    throw new Error('page_screenshot tests never read attachments back')
  }
}

/** Mount the screenshot stack: seam + tools + attachments + routed llm. */
async function setupShot(models: LlmModelInfo[]) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(BrowserRuntimeService)
  const provider = new ScriptedProvider()
  ctx.browser.register(provider)
  await ctx.plugin(MemoryShotStore)
  const store = ctx.attachments as MemoryShotStore
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['visual'], new VisionCatalogAdapter(models))
  await ctx.plugin(toolBrowser, { tabs: true, page: true })
  return { ctx, provider, store }
}

/** A calling agent stub pinned to one routed provider/model. */
function shotAgentOn(model: string): object {
  return {
    options: {},
    session: {
      header: {},
      requestHeader: () => ({ config: { provider: 'visual', model } }),
      append: () => undefined,
    },
  }
}

let shotCounter = 0

/** Execute one page_screenshot call through the real pipeline. */
function callShot(ctx: Context, agent: object, args: Record<string, unknown>) {
  shotCounter += 1
  const ids = ['shot-call-a', 'shot-call-b', 'shot-call-c', 'shot-call-d', 'shot-call-e']
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(ids[shotCounter - 1] ?? 'shot-call-x'),
    name: 'page_screenshot',
    arguments: args,
    agent: agent as never,
  })
}

describe('page_screenshot', () => {
  it('captures through the provider, commits durably, and renders the image block', async () => {
    const { ctx, provider, store } = await setupShot([
      { provider: 'visual', id: 'vision-model', name: 'Vision', inputModalities: ['text', 'image'] },
    ])
    const result = await callShot(ctx, shotAgentOn('vision-model'), { tab_id: 7 })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable')
    expect(provider.calls).toContain('screenshot')
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0]?.mediaType).toBe('image/png')
    const value = result.value as { tabId: number; url: string; captured: string; image: Record<string, unknown> }
    expect(value.tabId).toBe(7)
    expect(value.url).toBe('https://active.example')
    expect(value.captured).toBe('viewport')
    expect(value.image.mediaType).toBe('image/png')
    expect(value.image.width).toBe(9)
    expect(value.image.height).toBe(7)
  })

  it('passes the full-page scope through to the provider', async () => {
    const { ctx, provider } = await setupShot([
      { provider: 'visual', id: 'vision-model', name: 'Vision', inputModalities: ['text', 'image'] },
    ])
    const result = await callShot(ctx, shotAgentOn('vision-model'), { tab_id: 7, full_page: true })
    expect(result.isError).toBe(false)
    expect(provider.calls).toContain('screenshot')
    expect(provider.lastScreenshot).toEqual({ tabId: 7, fullPage: true })
  })

  it('refuses a text-only model before any provider call', async () => {
    const { ctx, provider, store } = await setupShot([
      { provider: 'visual', id: 'text-model', name: 'Text', inputModalities: ['text'] },
    ])
    const result = await callShot(ctx, shotAgentOn('text-model'), { tab_id: 7 })

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable')
    expect(result.error.message).toContain('does not declare image input')
    expect(provider.calls).not.toContain('screenshot')
    expect(store.saved).toEqual([])
  })
})
