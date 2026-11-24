/**
 * script-network spec: the lexical net under the website-task rule. A page
 * script that calls a site's interface names a request primitive and is
 * reported with that primitive's name; a script that only reads page state —
 * including one that merely mentions `fetch` in a comment, a string, a
 * template's text or a regular expression — is not.
 *
 * @module script-network-spec
 */

import { describe, expect, it } from 'vitest'
import { findScriptNetworkCall, scriptNetworkRefusal } from '../src/shared/script-network.ts'

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
    ['a URL string with a double slash followed by more code', "const u = 'https://api.example.com/x'\nreturn document.querySelector('a[href=\"' + u + '\"]') !== null"],
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
    expect(reason).toContain('页面脚本请求接口')
  })

  it('names the program as the refused surface for run_code', () => {
    const reason = scriptNetworkRefusal('XMLHttpRequest', 'run_code')
    expect(reason).toContain('run_code 程序禁止请求接口')
    expect(reason).toContain('检测到 XMLHttpRequest')
    expect(reason).toContain('不要在 run_code 里')
  })
})
