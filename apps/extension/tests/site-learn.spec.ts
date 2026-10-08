// @vitest-environment jsdom
/**
 * chrome-site-learn spec: the `/learn-site` pipeline's pure halves and the
 * crawl orchestration.
 *
 * The in-page extraction is covered through the SAME exported function
 * objects production serializes (`buildSelector` / `collectPageKnowledge`):
 * jsdom fixtures exercise them directly, and `pageExtractExpression` output
 * is pinned by substring identity to those sources — the shipping expression
 * cannot drift from what these tests cover. (End-to-end execution of the
 * serialized expression is proven by the real-device learn probe: an
 * outer-scope reference in either function would throw ReferenceError inside
 * the learned page.)
 *
 * The crawl drives a fake {@link LearnTabAccess} whose `evaluate` returns
 * canned per-URL knowledge — the orchestration contract under test is tab
 * lifecycle (dedicated learning tab, user tab restored), same-origin BFS,
 * caps, and skip accounting, not extraction fidelity.
 */

import { describe, expect, it } from 'vitest'
import {
  buildSelector,
  buildSiteDigest,
  collectPageKnowledge,
  hostMatches,
  learnSite,
  normalizeLearnUrl,
  pageExtractExpression,
  renderSiteKnowledgeText,
  resolveConfig,
  sameOrigin,
  type LearnTabAccess,
  type PageKnowledge,
} from '../src/offscreen/site-learn.ts'
import type { SiteKnowledge } from '../src/chrome/user-plugins.ts'

// ───────────────────────── config ─────────────────────────

describe('resolveConfig', () => {
  it('缺省字段落到默认预算', () => {
    expect(resolveConfig({})).toEqual({
      maxPages: 12,
      maxDigestBytes: 12_000,
      navSettleMs: 1_200,
      requestDelayMs: 350,
      tabPollMs: 1_500,
    })
  })

  it('合法覆盖生效，越界值加载即报错', () => {
    expect(resolveConfig({ maxPages: 3, maxDigestBytes: 2000, navSettleMs: 0, requestDelayMs: 0, tabPollMs: 250 }))
      .toMatchObject({ maxPages: 3, maxDigestBytes: 2000, navSettleMs: 0, requestDelayMs: 0, tabPollMs: 250 })
    expect(() => resolveConfig({ maxPages: 0 })).toThrow('maxPages')
    expect(() => resolveConfig({ maxPages: 1.5 })).toThrow('maxPages')
    expect(() => resolveConfig({ maxDigestBytes: 300 })).toThrow('maxDigestBytes')
    expect(() => resolveConfig({ tabPollMs: 100 })).toThrow('tabPollMs')
  })
})

// ───────────────────────── selector building ─────────────────────────

function mount(html: string): Document {
  const doc = document.implementation.createHTMLDocument('测试页')
  doc.body.innerHTML = html
  return doc
}

describe('buildSelector', () => {
  it('锚点优先级：id → data-testid → aria-label → name → 唯一类名 → 路径', () => {
    const doc = mount(`
      <form id="login"><input id="user" /></form>
      <input data-testid="search-box" />
      <button aria-label="提交搜索"></button>
      <input name="email" />
      <div class="card unique-card">x</div>
      <span class="plain">y</span><span class="plain">z</span>
    `)
    expect(buildSelector(doc.querySelector('#user')!, doc)).toBe('#user')
    expect(buildSelector(doc.querySelector('[data-testid]')!, doc)).toBe('[data-testid="search-box"]')
    expect(buildSelector(doc.querySelector('[aria-label]')!, doc)).toBe('[aria-label="提交搜索"]')
    expect(buildSelector(doc.querySelector('[name=email]')!, doc)).toBe('[name="email"]')
    expect(buildSelector(doc.querySelector('.unique-card')!, doc)).toBe('div.card.unique-card')
    // 多实例裸类名退化到 nth-of-type 路径而非歧义选择器。
    expect(buildSelector(doc.querySelector('.plain')!, doc)).toContain('body>span')
  })

  it('不安全 id 与含引号的属性值不会被拼进选择器', () => {
    const doc = mount('<input id="1bad" aria-label=\'a&quot;b\' />')
    const el = doc.querySelector('input')!
    expect(buildSelector(el, doc)).toBe('body>input')
  })
})

// ───────────────────────── page extraction ─────────────────────────

function pageFixtureUrl(path: string): string {
  return `https://docs.example.com${path}`
}

describe('collectPageKnowledge', () => {
  const doc = mount(`
    <h1>项目概览</h1>
    <nav><a href="/deploy">部署</a><a href="https://other.example.org/x">外站</a></nav>
    <form id="login" method="POST" action="/api/login">
      <label for="acct">账号</label>
      <input id="acct" name="account" required />
      <input type="password" name="secret" />
      <input type="hidden" name="csrf" />
    </form>
    <input id="global-search" placeholder="全站搜索" />
    <button id="save">保存</button>
    <button aria-hidden="true">隐藏按钮</button>
    <a href="javascript:void(0)">假链接</a>
    <a href="/docs?a=1">带参文档</a>
    <a href="/docs?a=1">带参文档</a>
  `)
  doc.title = '控制台'

  it('表单/独立输入/按钮/链接按契约提取，隐藏与外元素被滤除', () => {
    const page = collectPageKnowledge(doc, { href: pageFixtureUrl('/console') }, buildSelector)
    expect(page.title).toBe('控制台')
    expect(page.h1).toBe('项目概览')
    expect(page.forms).toHaveLength(1)
    expect(page.forms[0]).toMatchObject({ sel: '#login', method: 'post', action: '/api/login' })
    expect(page.forms[0]!.fields.map(f => f.sel)).toEqual(['#acct', '[name="secret"]'])
    expect(page.forms[0]!.fields[0]!.name).toBe('账号')
    expect(page.inputs).toEqual([{ sel: '#global-search', name: '全站搜索' }])
    expect(page.buttons).toEqual([{ sel: '#save', name: '保存' }])
    const hrefs = page.links.map(l => l.href)
    expect(hrefs).toContain(pageFixtureUrl('/deploy'))
    expect(hrefs).toContain(pageFixtureUrl('/docs?a=1'))
    expect(hrefs).not.toContain('javascript:void(0)')
    expect(page.links.filter(l => l.href === pageFixtureUrl('/deploy'))[0]!.inNav).toBe(true)
    expect(page.links.filter(l => l.href === pageFixtureUrl('/docs?a=1'))[0]!.inNav).toBe(false)
    // 重复 href+name 的链接去重。
    expect(page.links.filter(l => l.href === pageFixtureUrl('/docs?a=1'))).toHaveLength(1)
  })

  it('序列化表达式逐字携带两个导出函数的源码（同源注入契约）', () => {
    const expression = pageExtractExpression(0)
    // Substring identity pins the shipping expression to THESE exported
    // function objects — the jsdom direct-call coverage above therefore
    // covers exactly what runs in the learned page. End-to-end execution of
    // the serialized expression is proven by the real-device learn probe.
    expect(expression).toContain(buildSelector.toString())
    expect(expression).toContain(collectPageKnowledge.toString())
    expect(expression).toContain("document.readyState !== 'complete'")
    expect(expression.startsWith('(async () => {')).toBe(true)
  })
})

// ───────────────────────── URL queue logic ─────────────────────────

describe('normalizeLearnUrl', () => {
  it('规范化：去 hash、收尾斜杠、去默认端口；非文档与非法协议拒收', () => {
    expect(normalizeLearnUrl('https://Example.com/docs/#section')).toBe('https://example.com/docs')
    expect(normalizeLearnUrl('https://example.com/')).toBe('https://example.com/')
    expect(normalizeLearnUrl('http://example.com:80/a?b=1')).toBe('http://example.com/a?b=1')
    expect(normalizeLearnUrl('https://example.com/a/')).toBe('https://example.com/a')
    expect(normalizeLearnUrl('https://example.com/manual.pdf')).toBeUndefined()
    expect(normalizeLearnUrl('chrome://extensions')).toBeUndefined()
    expect(normalizeLearnUrl('https://user:pass@example.com/')).toBeUndefined()
    expect(normalizeLearnUrl('not a url')).toBeUndefined()
  })
})

describe('sameOrigin', () => {
  it('按 origin 精确比较', () => {
    expect(sameOrigin('https://a.com/x', 'https://a.com')).toBe(true)
    expect(sameOrigin('https://www.a.com/x', 'https://a.com')).toBe(false)
  })
})

// ───────────────────────── digest building ─────────────────────────

function fakePage(path: string, links: string[] = []): PageKnowledge {
  return {
    url: `https://example.com${path}`,
    path,
    title: `T${path}`,
    h1: '',
    forms: [],
    inputs: [],
    buttons: [{ sel: '#go', name: '出发' }],
    links: links.map(href => ({ href, name: '链', inNav: false })),
  }
}

describe('buildSiteDigest', () => {
  it('入口页在前、逐页成块、含用法头', () => {
    const digest = buildSiteDigest('example.com', [fakePage('/home', ['https://example.com/x']), fakePage('/x')], 0, 12_000)
    expect(digest).toContain('【站点速查 example.com】2 页')
    expect(digest).toContain('page_navigate')
    expect(digest.indexOf('· /home')).toBeLessThan(digest.indexOf('· /x'))
    expect(digest).toContain('按钮 #go「出发」')
  })

  it('超预算从尾部截断并标注', () => {
    const pages = ['/a', '/b', '/c'].map(p => fakePage(p))
    const digest = buildSiteDigest('example.com', pages, 0, 150)
    expect(digest).toContain('已截断至')
    expect(digest).not.toContain('· /c')
  })
})

// ───────────────────────── crawl orchestration ─────────────────────────

/** Fake browser seam: canned per-URL page knowledge, tab-lifecycle journal. */
function fakeBrowser(site: ReadonlyMap<string, PageKnowledge | Error>): {
  browser: LearnTabAccess
  journal: string[]
} {
  const journal: string[] = []
  const browser: LearnTabAccess = {
    tabs: async () => [],
    openTab: async (url, opts) => {
      journal.push(`open:${url}:${opts?.active === false ? 'bg' : 'fg'}`)
      return { tabId: 77, title: '', url, active: false, windowId: 1, index: 0 }
    },
    closeTab: async (tabId) => { journal.push(`close:${String(tabId)}`) },
    switchTab: async (tabId) => { journal.push(`switch:${String(tabId)}`) },
    navigate: async (_tabId, url) => { journal.push(`nav:${url}`) },
    evaluate: async <T>(_tabId: number, expression: string): Promise<T> => {
      expect(expression).toContain('collect')
      // The canned map keys on the URL the crawl most recently navigated to;
      // the entry page rides the openTab navigation.
      const current = journal.filter(entry => entry.startsWith('open:') || entry.startsWith('nav:')).at(-1)!
      const url = current.slice(current.indexOf(':') + 1).replace(/:(fg|bg)$/, '')
      const value = site.get(url)
      if (value instanceof Error) throw value
      return (value ?? null) as T
    },
  }
  return { browser, journal }
}

const BUDGETS = { maxPages: 5, maxDigestBytes: 12_000, navSettleMs: 0, requestDelayMs: 0 } as const

describe('learnSite', () => {
  const page = (path: string, links: string[] = []): PageKnowledge => fakePage(path, links)
  const site = (entries: Record<string, PageKnowledge | Error>): ReadonlyMap<string, PageKnowledge | Error> =>
    new Map(Object.entries(entries))

  it('同源 BFS：专用后台学习页、只导航非入口页、去重、关学习页并切回原标签页', async () => {
    const { browser, journal } = fakeBrowser(site({
      'https://example.com/': page('/', ['https://example.com/b', 'https://example.com/a', 'https://example.com/', 'https://elsewhere.net/z']),
      'https://example.com/b': page('/b', ['https://example.com/a']),
      'https://example.com/a': page('/a'),
    }))
    const outcome = await learnSite(browser, 'https://example.com/#top', 42, BUDGETS)

    // 入口去 hash 后开专用后台标签页；入口页不再二次导航。
    expect(journal[0]).toBe('open:https://example.com/:bg')
    expect(journal).not.toContain('nav:https://example.com/')
    // BFS 序：b 在 a 前（发现序），外站与重复不入队。
    expect(journal[1]).toBe('nav:https://example.com/b')
    expect(journal[2]).toBe('nav:https://example.com/a')
    expect(journal.filter(entry => entry.startsWith('nav:'))).toHaveLength(2)
    expect(outcome).toMatchObject({ host: 'example.com', pageCount: 3, skipped: 0 })
    expect(outcome.digest).toContain('【站点速查 example.com】3 页')
    // 收尾：先关学习页，再切回用户标签页。
    expect(journal.at(-2)).toBe('close:77')
    expect(journal.at(-1)).toBe('switch:42')
  })

  it('页数上限与跳过计数：单页失败不断爬', async () => {
    const { browser } = fakeBrowser(site({
      'https://example.com/': page('/', ['https://example.com/1', 'https://example.com/2']),
      'https://example.com/1': new Error('navigate blew up'),
      'https://example.com/2': page('/2', ['https://example.com/3']),
    }))
    // maxPages=2：/2 入账后 /3 不再爬。
    const outcome = await learnSite(browser, 'https://example.com/', -1, { ...BUDGETS, maxPages: 2 })
    expect(outcome).toMatchObject({ pageCount: 2, skipped: 1 })
  })

  it('不可学习入口（chrome://）拒绝且不触碰浏览器', async () => {
    const { browser, journal } = fakeBrowser(new Map())
    await expect(learnSite(browser, 'chrome://extensions', -1, BUDGETS)).rejects.toThrow('不是可学习的 http(s)')
    expect(journal).toEqual([])
  })

  it('学习页关闭抛错不影响学习结果（尽力收尾）', async () => {
    const journal: string[] = []
    const browser: LearnTabAccess = {
      tabs: async () => [],
      openTab: async url => ({ tabId: 9, title: '', url, active: false, windowId: 1, index: 0 }),
      closeTab: async () => { throw new Error('close race') },
      switchTab: async (tabId) => { journal.push(`switch:${String(tabId)}`) },
      navigate: async () => {},
      evaluate: async () => fakePage('/only') as unknown as never,
    }
    const outcome = await learnSite(browser, 'https://example.com/only', 5, BUDGETS)
    expect(outcome.pageCount).toBe(1)
    expect(journal).toEqual(['switch:5'])
  })
})

// ───────────────────────── prompt rendering ─────────────────────────

function knowledge(host: string, digest: string, learnedAt: number): SiteKnowledge {
  return { origin: `https://${host}`, host, learnedAt, pageCount: 1, digest }
}

describe('renderSiteKnowledgeText + hostMatches', () => {
  it('主机匹配含两侧子域', () => {
    expect(hostMatches('www.example.com', 'example.com')).toBe(true)
    expect(hostMatches('example.com', 'www.example.com')).toBe(true)
    expect(hostMatches('notexample.com', 'example.com')).toBe(false)
  })

  it('无命中返回空串；命中注入摘要，新学习在前，超预算截断', () => {
    const cache = {
      hosts: ['www.example.com', 'shop.other.net'],
      entries: [
        knowledge('example.com', '【站点速查 example.com】1 页\n· /a', 100),
        knowledge('shop.other.net', '【站点速查 shop.other.net】1 页\n· /b', 200),
        knowledge('quiet.io', '不该出现', 300),
      ],
    }
    const text = renderSiteKnowledgeText(cache, 12_000)
    expect(text).toContain('example.com')
    expect(text).toContain('shop.other.net')
    expect(text.indexOf('shop.other.net')).toBeLessThan(text.indexOf('example.com'))
    expect(text).not.toContain('不该出现')
    expect(renderSiteKnowledgeText({ hosts: ['elsewhere.org'], entries: cache.entries }, 12_000)).toBe('')
    // 预算只容得下第一个站点时第二个截断标注。
    const tight = renderSiteKnowledgeText(cache, 40)
    expect(tight).toContain('已截断')
  })
})
