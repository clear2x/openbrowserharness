/**
 * script-network spec: the detection under the website-task rule — a site's
 * API is never requested directly. A page script that calls a site's interface
 * names a request primitive and is reported with that primitive's name; a
 * script that only reads page state — including one that merely mentions
 * `fetch` in a comment, a string, a template's text or a regular expression —
 * is not. An address a tool would open or fetch is read as an API address or
 * a page's; each refusal names the one switch that lifts the rule, by the
 * label the capability panel shows.
 *
 * @module script-network-spec
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DIRECT_SITE_API_SWITCH, findScriptNetworkCall, isSiteApiUrl, scriptNetworkRefusal, siteApiHostTarget,
  siteApiUrlRefusal, videoIndexApiRefusal,
} from '../src/shared/script-network.ts'

describe('findScriptNetworkCall', () => {
  it.each([
    ['bare fetch', "fetch('/api/now').then(r => r.json())", 'fetch'],
    ['awaited fetch with credentials', '(async () => { const r = await fetch("https://api.bilibili.com/x/web-interface/view?bvid=1", { credentials: "include" }); return await r.json() })()', 'fetch'],
    ['optional-call fetch', "return window.fetch?.('/x')?.ok", 'fetch'],
    ['XMLHttpRequest', "const xhr = new XMLHttpRequest(); xhr.open('GET', '/api/x'); xhr.send()", 'XMLHttpRequest'],
    ['namespaced XMLHttpRequest', 'return typeof window.XMLHttpRequest', 'XMLHttpRequest'],
    ['an open(verb, …) call on any object', 'stream.open("POST", "/api/x")', 'XMLHttpRequest.open'],
    ['sendBeacon', "navigator.sendBeacon('/track', {})", 'sendBeacon'],
    ['WebSocket', "new WebSocket('wss://example.com/socket')", 'WebSocket'],
    ['EventSource', "new EventSource('/stream')", 'EventSource'],
    ['dynamic import', "const mod = await import('/chunk.js')", 'import()'],
    ['jQuery ajax', "$.ajax({ url: '/api/x', method: 'GET' })", 'ajax'],
    ['axios', "return (await axios.get('/api/x')).data", 'axios'],
    ['script-tag injection', "const s = document.createElement('script'); s.src = 'https://example.com/jsonp'", '<script>'],
    ['fetch inside a template interpolation', 'return `${fetch("/x").ok} done`', 'fetch'],
    ['fetch after a string holding a double slash', "const u = 'https://example.com/a//b'; const r = await fetch(u); return r.status", 'fetch'],
    ['fetch after a block comment', "/* reads only\n   the page */ const r = await fetch('/x'); return r.ok", 'fetch'],
    ['an aliased fetch', "const f = window.fetch; return f('/api/x').then(r => r.text())", 'fetch'],
    ['a bound fetch', "const get = fetch.bind(window); return get('/api/x')", 'fetch'],
    ['a bracketed fetch read', "return window['fetch']('/api/x')", 'fetch'],
    ['a feature check on fetch', "return typeof fetch === 'function'", 'fetch'],
    ['jQuery get', "return $.get('/api/x')", 'jQuery'],
    ['jQuery getJSON', "$.getJSON('/api/list', data => data)", 'jQuery'],
    ['AngularJS $http', "return $http.get('/api/x')", '$http'],
    ['a tab navigation to an API address', "location.href = 'https://api.bilibili.com/x/web-interface/view?bvid=1'", '接口地址'],
    ['a window opened on an API address', 'return window.open("https://api.github.com/users/octocat") ? 1 : 0', '接口地址'],
    ['an iframe src set to an API address', "const f = document.createElement('iframe'); f.src = 'https://www.bilibili.com/x/web-interface/nav'; return f.src", '接口地址'],
    ['a protocol-relative API address', "location.assign('//api.bilibili.com/x/web-interface/view')", '接口地址'],
    ['an API address in a template', 'return `https://api.bilibili.com/x/space/wbi/arc?mid=${mid}`', '接口地址'],
  ])('reports %s', (_label, script, primitive) => {
    expect(findScriptNetworkCall(script)).toBe(primitive)
  })

  it.each([
    ['an empty script', ''],
    ['a DOM read', 'document.title'],
    ['a page-state read', '(() => { const v = window.__INITIAL_STATE__?.videoData ?? {}; return { title: v.title, up: v.owner?.name } })()'],
    ['a DOM scrape', "Array.from(document.querySelectorAll('.card')).slice(0, 10).map(card => card.textContent.trim())"],
    ['a fetch mention in a comment', "// 不要 fetch('/api')：操作网站走真实点击\nreturn document.title"],
    ['a fetch mention in a string', "return document.body.innerText.includes('fetch(')"],
    ['a fetch mention in template text', 'return `called fetch(/x) at ${document.title}`'],
    ['a fetch mention in a regular expression', 'return /fetch\\(/.test(document.body.innerHTML)'],
    ['a fetch word in a selector string', "document.querySelector('[data-action=\"fetch\"]')?.textContent"],
    ['a resource-timing read naming fetch as a string', "performance.getEntriesByType('resource').filter(e => e.initiatorType === 'fetch').length"],
    ['a jQuery call in template text', 'return `$.get(1) done`'],
    ['a double-dollar DOM helper', "return $$('.item').length"],
    ['a get method on a local object', 'const bag = new Map(); return bag.get(1)'],
    ['a style injection', [
      '(() => {',
      "  document.getElementById('obh-remix')?.remove()",
      "  const style = document.createElement('style')",
      "  style.id = 'obh-remix'",
      "  style.textContent = ['.a { display: none !important; }', '.b { max-width: 720px }'].join('\\n')",
      '  document.documentElement.append(style)',
      "  return 'applied'",
      '})()',
    ].join('\n')],
    ['a page-address string with a double slash followed by more code', "const u = 'https://www.example.com/x'\nreturn document.querySelector('a[href=\"' + u + '\"]') !== null"],
    ['a page address literal', "return location.href.startsWith('https://www.bilibili.com/video/')"],
    ['a page opened in a new window', "return window.open('https://www.bilibili.com/video/BV1GJ411x7h7') ? 1 : 0"],
    ['a relative API path with no host behind it', 'return document.querySelector(\'a[href="/api/help"]\') !== null'],
    ['a documentation address on an api host', "return location.href === 'https://api.flutter.dev/flutter/' ? 'docs' : 'other'"],
    ['a regular expression holding quotes', "const re = /['\"]/; return re.test(document.title) ? 'yes' : 'no'"],
    ['division', 'return (a + b) / 2 / 3'],
    ['an object literal inside an interpolation', 'return `${ { a: 1 }.a }`'],
    ['a nested template', 'return `a${ `b${1 + 1}` }c`'],
    ['storage and cookie reads', 'return { cookie: document.cookie, local: Object.keys(localStorage) }'],
  ])('lets %s through', (_label, script) => {
    expect(findScriptNetworkCall(script)).toBeUndefined()
  })

  it('names the first primitive in pattern order when several appear', () => {
    expect(findScriptNetworkCall("const a = document.createElement('script'); return fetch('/x')")).toBe('fetch')
  })
})

describe('scriptNetworkRefusal', () => {
  it('tells the model the rule, the page tools to use, and the switch that lifts it', () => {
    const reason = scriptNetworkRefusal('fetch', 'page_evaluate')
    expect(reason).toContain('page_evaluate 脚本禁止请求接口')
    expect(reason).toContain('检测到 fetch')
    expect(reason).toContain('真实页面操作')
    expect(reason).toContain('page_click')
    expect(reason).toContain('page_scroll')
    expect(reason).toContain(DIRECT_SITE_API_SWITCH)
    expect(reason).toContain('封号')
  })

  it('names the program as the refused surface for run_code', () => {
    const reason = scriptNetworkRefusal('XMLHttpRequest', 'run_code')
    expect(reason).toContain('run_code 程序禁止请求接口')
    expect(reason).toContain('检测到 XMLHttpRequest')
    expect(reason).toContain('不要在 run_code 里')
  })
})

describe('isSiteApiUrl', () => {
  it.each([
    ['an api host', 'https://api.bilibili.com/x/web-interface/view?bvid=1'],
    ['the API root a site keeps under its page host', 'https://www.bilibili.com/x/web-interface/archive/stat?bvid=1'],
    ['the API root under another host of the same site', 'https://app.bilibili.com/x/v2/view?aid=1'],
    ['an api host on a subdomain', 'https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=1'],
    ['an api token before digits in the label', 'https://h5api.m.taobao.com/h5/mtop.taobao.detail.getdetail/1.0/'],
    ['an api token after a hyphen in the label', 'https://open-api.example.com/v1/things'],
    ['an api token before a digit in the label', 'https://api2.example.com/users'],
    ['an uppercase host', 'https://API.Zhihu.com/market/paid_column'],
    ['a /api/ path root', 'https://www.xiaohongshu.com/api/sns/web/v1/feed'],
    ['an /ajax/ path root', 'https://weibo.com/ajax/statuses/mymblog?uid=1'],
    ['a /graphql/ path root', 'https://example.com/graphql?query=%7Bx%7D'],
    ['a plain http address', 'http://api.example.com/x'],
  ])('reads %s as an API address', (_label, url) => {
    expect(isSiteApiUrl(url)).toBe(true)
  })

  it.each([
    ['a video page', 'https://www.bilibili.com/video/BV1GJ411x7h7?p=2'],
    ['a search results page', 'https://search.bilibili.com/all?keyword=%E6%99%BA%E8%B0%B1'],
    ['a space page', 'https://space.bilibili.com/2/dynamic'],
    ['a login page on a host that also serves an API', 'https://passport.bilibili.com/login'],
    ['a live room page', 'https://live.bilibili.com/123'],
    ['a documentation site served from an api host', 'https://api.flutter.dev/flutter/material/Colors-class.html'],
    ['another documentation site served from an api host', 'https://api.jquery.com/category/ajax/'],
    ['a product site whose name starts with api', 'https://apidog.com/'],
    ['a host with api inside a word', 'https://www.rapid7.com/'],
    ['another host with api inside a word', 'https://www.capitalone.com/'],
    ['a path whose first segment only starts with api', 'https://example.com/api-gateway/docs'],
    ['an api path that is not the first segment', 'https://developers.example.com/miniprogram/dev/api/'],
    ['a docs path ending in api', 'https://example.com/docs/api'],
    ['a bare host', 'https://example.com/'],
    ['the API root of another site on an unrelated host', 'https://example.com/x/thing'],
    ['an extension page', 'chrome-extension://abcdefghijklmnop/sidepanel.html'],
    ['a file', 'file:///tmp/a.json'],
    ['about:blank', 'about:blank'],
    ['an empty string', ''],
    ['text that is not a URL', 'not a url'],
  ])('reads %s as a page address', (_label, url) => {
    expect(isSiteApiUrl(url)).toBe(false)
  })
})

describe('siteApiHostTarget', () => {
  it.each([
    ['tabs_open', { url: 'https://api.bilibili.com/x/web-interface/view?bvid=1' }, 'api.bilibili.com'],
    ['page_navigate', { tab_id: 3, url: 'https://API.Zhihu.com/market/paid_column' }, 'api.zhihu.com'],
    ['web_fetch', { url: 'https://example.com/graphql?query=x' }, 'example.com'],
  ])('names the API host a %s call targets', (tool, args, host) => {
    expect(siteApiHostTarget(tool, args)).toBe(host)
  })

  it('reads the navigate steps of a batch plan and reports the API one', () => {
    const plan = {
      tab_id: 3,
      actions: [
        { op: 'click', selector: '#more' },
        { op: 'navigate', url: 'https://www.bilibili.com/' },
        { op: 'navigate', url: 'https://www.bilibili.com/x/web-interface/nav?wts=1' },
      ],
    }
    expect(siteApiHostTarget('page_batch_actions', plan)).toBe('www.bilibili.com')
  })

  it.each([
    ['a page address', 'tabs_open', { url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }],
    ['a batch plan of page steps', 'page_batch_actions', { actions: [{ op: 'navigate', url: 'https://example.com/a' }, { op: 'scroll', direction: 'down' }] }],
    ['a batch plan that is not an array', 'page_batch_actions', { actions: 'nope' }],
    ['a batch step without a URL', 'page_batch_actions', { actions: [{ op: 'click' }, 'junk'] }],
    ['arguments that are not a record', 'tabs_open', 'https://api.bilibili.com/x'],
    ['a tool that takes no address', 'page_click', { selector: '#a', url: 'https://api.bilibili.com/x' }],
    ['a script (the lexical detector reads those)', 'page_evaluate', { expression: "fetch('https://api.bilibili.com/x')" }],
  ])('reports no API host for %s', (_label, tool, args) => {
    expect(siteApiHostTarget(tool, args)).toBeUndefined()
  })
})

describe('the address and video_index refusals', () => {
  it('names the tool, the host, the page tools to use, the risk, and the switch', () => {
    const reason = siteApiUrlRefusal('tabs_open', 'api.bilibili.com')
    expect(reason).toContain('tabs_open 禁止直接请求站点接口')
    expect(reason).toContain('api.bilibili.com')
    expect(reason).toContain('page_extract_text')
    expect(reason).toContain('封号')
    expect(reason).toContain(DIRECT_SITE_API_SWITCH)
  })

  it('points video_index at the page-operation alternative and the switch', () => {
    const reason = videoIndexApiRefusal()
    expect(reason).toContain('video_index 的 index 动作禁止执行')
    expect(reason).toContain('带登录态')
    expect(reason).toContain('zoom')
    expect(reason).toContain('封号')
    expect(reason).toContain(DIRECT_SITE_API_SWITCH)
  })
})

describe('the switch every refusal names', () => {
  it('is the label the capability panel shows', () => {
    // The panel's dictionary belongs to the client compiler face; read it as text.
    const panels = readFileSync(resolve(__dirname, '../src/sidepanel-dsh/locales/panels.ts'), 'utf8')
    const zhLabel = panels.match(/'capability\.scriptNetwork': '([^']*)'/)?.[1]
    expect(zhLabel).toBe(DIRECT_SITE_API_SWITCH)
  })
})
