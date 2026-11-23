// @vitest-environment jsdom
/**
 * page_find_related (batch 277, hardened in batch 280): the in-page
 * collector tags every candidate with a unique marker selector — the fix
 * for the rank-position-passed-off-as-snapshot-index hazard, where
 * `page_click({index})` after a find resolved to whatever the last
 * snapshot listed first. Pins the collector's DOM contract, the wire-result
 * validation, the ranking, the model-not-ready error path, and the render.
 * @module @deepseek-ai/dsh-extension/tests/page-find-tool
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

const embedInWorker = vi.hoisted(() => vi.fn<(query: string, passages: string[]) => Promise<unknown>>())

vi.mock('../src/offscreen/ai-runtime/worker-bridge.ts', () => ({
  embedInWorker: (query: string, passages: string[]) => embedInWorker(query, passages),
}))

import {
  COLLECT_EXPRESSION,
  collectFindCandidates,
  elementEmbedText,
  FIND_COLLECT_CAP,
  FIND_MARKER_ATTRIBUTE,
  markerSelector,
  parseCollectedElements,
  type FindCollectorEnvironment,
} from '../src/offscreen/page-find-collector.ts'
import { apply, formatFindOutput, type PageFindRelatedValue } from '../src/offscreen/chrome-page-find-tool.ts'

/** Every element rendered at a visible 120×32 box. */
const visibleEnvironment: FindCollectorEnvironment = {
  rectOf: () => ({ width: 120, height: 32 }),
  isVisible: () => true,
}

const collect = (environment: FindCollectorEnvironment = visibleEnvironment) =>
  collectFindCandidates(document, environment, FIND_MARKER_ATTRIBUTE, FIND_COLLECT_CAP)

/** The element a marker selector resolves to. */
const resolvedBy = (selector: string): Element | null => document.querySelector(selector)

beforeEach(() => {
  embedInWorker.mockReset()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('find collector markers', () => {
  it('gives every visible control a selector that resolves to exactly that element', () => {
    document.body.innerHTML = `
      <nav><a href="/home">首页</a><a href="/news">新闻频道</a></nav>
      <section><button>查看本周雷阵雨预警</button></section>
      <section><input placeholder="请输入账号"><input type="password" placeholder="请输入密码"><button>登录账号</button></section>
      <section><button>订阅电子报</button></section>`
    const collected = collect()
    expect(collected).toHaveLength(7)
    const selectors = new Set(collected.map(element => element.selector))
    expect(selectors.size).toBe(7)
    for (const element of collected) {
      const target = resolvedBy(element.selector)
      expect(target, `${element.selector} must resolve`).not.toBeNull()
      expect(target?.textContent || target?.getAttribute('placeholder')).toContain(
        element.text || element.placeholder || '',
      )
    }
    expect(resolvedBy(collected[5]?.selector ?? '')?.textContent).toBe('登录账号')
  })

  it('addresses controls that carry no id, aria-label, or name at all', () => {
    // The batch-277 collector returned an empty selector for these — the
    // model had a ranked hit it could not act on.
    document.body.innerHTML = '<div><button><span>提交</span></button><a href="/x"><b>详情</b></a></div>'
    const collected = collect()
    expect(collected.map(element => element.selector)).toEqual([markerSelector(1), markerSelector(2)])
    expect(resolvedBy(markerSelector(1))?.tagName).toBe('BUTTON')
    expect(resolvedBy(markerSelector(2))?.tagName).toBe('A')
  })

  it('skips unrendered elements and elements with no text signal', () => {
    document.body.innerHTML = '<button id="zero">零尺寸</button><button id="blank"></button><button id="ok">有字</button>'
    const collected = collectFindCandidates(document, {
      rectOf: element => (element.id === 'zero' ? { width: 0, height: 0 } : { width: 10, height: 10 }),
      isVisible: () => true,
    }, FIND_MARKER_ATTRIBUTE, FIND_COLLECT_CAP)
    expect(collected.map(element => element.text)).toEqual(['有字'])
  })

  it('skips elements the visibility probe reports hidden', () => {
    document.body.innerHTML = '<button id="hidden">隐藏</button><button id="shown">可见</button>'
    const collected = collectFindCandidates(document, {
      rectOf: () => ({ width: 10, height: 10 }),
      isVisible: element => element.id !== 'hidden',
    }, FIND_MARKER_ATTRIBUTE, FIND_COLLECT_CAP)
    expect(collected.map(element => element.text)).toEqual(['可见'])
  })

  it('clears stale markers so a dropped element keeps no address', () => {
    document.body.innerHTML = '<button id="a">甲</button><button id="b">乙</button>'
    collect()
    expect(document.querySelectorAll(`[${FIND_MARKER_ATTRIBUTE}]`)).toHaveLength(2)
    document.getElementById('a')?.remove()
    document.body.insertAdjacentHTML('beforeend', '<button id="c">丙</button>')
    const recollected = collect()
    expect(recollected.map(element => element.text)).toEqual(['乙', '丙'])
    expect(document.getElementById('b')?.getAttribute(FIND_MARKER_ATTRIBUTE)).toBe('1')
    expect(document.querySelectorAll(`[${FIND_MARKER_ATTRIBUTE}]`)).toHaveLength(2)
  })

  it('respects the collection cap', () => {
    document.body.innerHTML = Array.from({ length: 6 }, (_, index) => `<button>按钮${String(index)}</button>`).join('')
    const collected = collectFindCandidates(document, visibleEnvironment, FIND_MARKER_ATTRIBUTE, 4)
    expect(collected).toHaveLength(4)
    expect(document.querySelectorAll(`[${FIND_MARKER_ATTRIBUTE}]`)).toHaveLength(4)
  })

  it('derives roles and folds aria-label / placeholder into the record and the embedding text', () => {
    document.body.innerHTML = '<input placeholder="搜索"><a href="/x">链接</a><div role="tab">设置</div>'
    const [search, link, tab] = collect()
    expect(search).toMatchObject({ tag: 'input', role: 'textbox', placeholder: '搜索', text: '' })
    expect(link).toMatchObject({ tag: 'a', role: 'link', text: '链接' })
    expect(tab).toMatchObject({ tag: 'div', role: 'tab', text: '设置' })
    expect(elementEmbedText(search ?? { tag: '', text: '', selector: '' })).toBe('搜索')
    expect(elementEmbedText({ tag: 'input', text: '', selector: '', ariaLabel: '账号', placeholder: '手机号' })).toBe('账号 手机号')
  })
})

describe('find collector page expression', () => {
  it('invokes the serialized collector immediately with its arguments (no name binding)', () => {
    expect(COLLECT_EXPRESSION.startsWith('(function')).toBe(true)
    expect(COLLECT_EXPRESSION).toContain(')(document, ({')
    expect(COLLECT_EXPRESSION).toContain(JSON.stringify(FIND_MARKER_ATTRIBUTE))
    expect(COLLECT_EXPRESSION).not.toMatch(/var [A-Za-z_$][\w$]* = function/)
  })
})

describe('find wire-result validation', () => {
  it('keeps well-formed records and drops everything else', () => {
    const parsed = parseCollectedElements([
      { tag: 'button', text: '甲', selector: markerSelector(1), role: 'button', ariaLabel: '', placeholder: '搜索' },
      { tag: 'a', text: 42, selector: markerSelector(2) },
      { tag: 'a', text: '乙' },
      'junk',
      null,
      { tag: 'a', text: '丙', selector: markerSelector(3), role: '' },
    ])
    expect(parsed).toEqual([
      { tag: 'button', text: '甲', selector: markerSelector(1), role: 'button', placeholder: '搜索' },
      { tag: 'a', text: '丙', selector: markerSelector(3) },
    ])
    expect(parseCollectedElements(null)).toEqual([])
    expect(parseCollectedElements('[]')).toEqual([])
  })
})

/** A registered tool's execution face. */
interface ExecutableTool {
  execute(args: { tab_id: number; task: string; top_k?: number }, exec: unknown): Promise<PageFindRelatedValue>
}

/** Boot the tool against a fake browser seam; returns the registered tool. */
function bootTool(evaluate: (tabId: number, expression: string) => Promise<unknown>): ExecutableTool {
  const registered: ExecutableTool[] = []
  const ctx = {
    tools: { register: (tool: ExecutableTool): void => { registered.push(tool) } },
    get: () => undefined,
    browser: { provider: { evaluate } },
  }
  apply(ctx as unknown as Context, {})
  expect(registered).toHaveLength(1)
  return registered[0] as ExecutableTool
}

describe('page_find_related execution', () => {
  it('returns ranked candidates carrying marker selectors and no snapshot index', async () => {
    const page = [
      { tag: 'button', text: '查看本周雷阵雨预警', selector: markerSelector(1) },
      { tag: 'button', text: '登录账号', selector: markerSelector(2) },
      { tag: 'a', text: '首页', selector: markerSelector(3) },
    ]
    // Query·passage dot products: 登录账号 0.9, 天气 0.4, 首页 0.1 (dim 2).
    embedInWorker.mockResolvedValueOnce({
      query: new Float32Array([1, 0]),
      passages: new Float32Array([0.4, 0.9165, 0.9, 0.4359, 0.1, 0.995]),
      dim: 2,
    })
    const tool = bootTool(async () => page)
    const value = await tool.execute({ tab_id: 7, task: '登录我的账号' }, undefined)

    expect(value.error).toBeUndefined()
    expect(value.candidates.map(candidate => candidate.text)).toEqual(['登录账号', '查看本周雷阵雨预警', '首页'])
    expect(value.candidates[0]?.selector).toBe(markerSelector(2))
    expect(Object.keys(value.candidates[0] ?? {})).not.toContain('index')
    expect(embedInWorker).toHaveBeenCalledWith('登录我的账号', ['查看本周雷阵雨预警', '登录账号', '首页'])
  })

  it('caps top_k and honors a smaller requested count', async () => {
    const page = Array.from({ length: 5 }, (_, index) => ({ tag: 'button', text: `项${String(index)}`, selector: markerSelector(index + 1) }))
    const dim = 1
    embedInWorker.mockResolvedValueOnce({
      query: new Float32Array([1]),
      passages: new Float32Array([0.9, 0.8, 0.7, 0.6, 0.5]),
      dim,
    })
    const tool = bootTool(async () => page)
    const two = await tool.execute({ tab_id: 7, task: 't', top_k: 2 }, undefined)
    expect(two.candidates.map(candidate => candidate.text)).toEqual(['项0', '项1'])
    embedInWorker.mockResolvedValueOnce({ query: new Float32Array([1]), passages: new Float32Array([0.9, 0.8, 0.7, 0.6, 0.5]), dim })
    const capped = await tool.execute({ tab_id: 7, task: 't', top_k: 99 }, undefined)
    expect(capped.candidates).toHaveLength(5)
  })

  it('reports an empty page honestly without touching the embedding model', async () => {
    const tool = bootTool(async () => [])
    const value = await tool.execute({ tab_id: 7, task: 't' }, undefined)
    expect(value.candidates).toEqual([])
    expect(value.error).toContain('没有可交互元素')
    expect(embedInWorker).not.toHaveBeenCalled()
  })

  it('turns an unready embedding model into an actionable error', async () => {
    embedInWorker.mockRejectedValueOnce(new Error('AI_LOCAL_MODEL_UNAVAILABLE: embed-e5-small'))
    const tool = bootTool(async () => [{ tag: 'button', text: '登录账号', selector: markerSelector(1) }])
    const value = await tool.execute({ tab_id: 7, task: '登录' }, undefined)
    expect(value.candidates).toEqual([])
    expect(value.error).toContain('本地嵌入模型未就绪')
    expect(value.error).toContain('multilingual-e5-small')
    expect(value.error).toContain('page_snapshot')
  })
})

describe('find render', () => {
  it('lists candidates by rank with their selectors and never advertises an index', () => {
    const text = formatFindOutput({
      tabId: 7,
      task: '登录我的账号',
      candidates: [
        { tag: 'button', role: 'button', text: '登录账号', selector: markerSelector(6), score: 0.919 },
        { tag: 'a', role: 'link', text: '首页', selector: markerSelector(1), score: 0.212 },
      ],
    })
    expect(text).toContain('[本地AI·嵌入]')
    expect(text).toContain('「登录账号」(相关度 0.919，selector: [data-dsh-find="6"])')
    expect(text).toContain('「首页」(相关度 0.212')
    expect(text).not.toContain('index')
    expect(text).toContain('页面跳转或下一次 page_find_related 后失效')
  })

  it('renders the error lane and the empty lane', () => {
    expect(formatFindOutput({ tabId: 7, task: 't', candidates: [], error: '本地嵌入模型未就绪' })).toBe('语义定位失败：本地嵌入模型未就绪')
    expect(formatFindOutput({ tabId: 7, task: 't', candidates: [] })).toBe('没有匹配的页面元素。')
  })
})
