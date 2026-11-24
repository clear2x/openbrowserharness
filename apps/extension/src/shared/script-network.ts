/**
 * The 直接请求站点接口 built-in capability (key `dsh-capability-script-network`,
 * named when it covered page scripts only): pure detection of every exit by
 * which the agent can make a site's API be requested directly. A task on a
 * site is completed through real page operations (navigation, clicks, typing,
 * scrolling), never by requesting the site's interfaces — a request the site
 * did not make itself trips its risk control and can cost the user the
 * account. The tool gate refuses such a call through this module, without a
 * browser: a script that names a network primitive, a tool pointed at an API
 * address, and the `video_index` action that calls Bilibili's API itself.
 *
 * Comments, string contents and regular-expression bodies are skipped before
 * a script is matched: a script that only mentions `fetch` in a comment or a
 * string is not a request.
 *
 * @module script-network
 */

/** Characters after which a `/` opens a regular-expression literal instead of division. */
const REGEX_PRECEDERS: ReadonlySet<string> = new Set([
  '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>',
])

/** Keywords after which a `/` opens a regular-expression literal. */
const REGEX_KEYWORDS: ReadonlySet<string> = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'instanceof',
])

const IDENTIFIER = /[A-Za-z0-9_$]/
const REGEX_FLAG = /[a-z]/i

/** One script, twice: `code` blanks comments, strings and regex bodies; `withStrings` keeps string contents. */
interface Scanned {
  readonly code: string
  readonly withStrings: string
}

/**
 * The index just past a `'` or `"` string that starts at `start` (an
 * unterminated or newline-broken string ends at the newline or the source end).
 */
function stringEnd(source: string, start: number, quote: string): number {
  let i = start + 1
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    if (ch === '\n') return i
    i += 1
  }
  return source.length
}

/**
 * The index of the closing `/` of a regular-expression literal whose opening
 * `/` sits at `start`. An unescaped `/` inside a character class does not
 * close the literal.
 */
function regexEnd(source: string, start: number): number {
  let inClass = false
  let i = start + 1
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '\n') return i
    if (inClass) {
      if (ch === ']') inClass = false
    } else if (ch === '[') {
      inClass = true
    } else if (ch === '/') {
      return i
    }
    i += 1
  }
  return source.length
}

/**
 * Blank out what cannot contain a request: comments, the contents of string
 * and template literals (interpolation expressions stay code) and regex
 * bodies. `withStrings` keeps string contents for the patterns that read a
 * verb out of a string argument.
 * @param source - the page script.
 * @returns the script with both blanking policies applied.
 */
function scan(source: string): Scanned {
  let code = ''
  let withStrings = ''
  /** `${` interpolations currently open, innermost last; each entry counts the braces nested inside it. */
  const interpolations: number[] = []
  /** Whether the scan sits in the text part of a template literal. */
  let inTemplate = false
  /** The last non-blank character and the identifier ending at it, for regex-versus-division. */
  let lastChar = ''
  let lastWord = ''

  /** Write source text as code to both copies and advance the regex-versus-division context. */
  const writeCode = (text: string): void => {
    code += text
    withStrings += text
    for (const ch of text) {
      if (IDENTIFIER.test(ch)) {
        lastWord = IDENTIFIER.test(lastChar) ? lastWord + ch : ch
        lastChar = ch
      } else if (ch !== ' ' && ch !== '\n') {
        lastChar = ch
        lastWord = ''
      }
    }
  }
  /** Copy source text verbatim to `withStrings` and blank it in `code`; the call site sets what follows it. */
  const writeBlanked = (raw: string): void => {
    withStrings += raw
    code += raw.replace(/[^\n]/g, ' ')
  }

  let i = 0
  while (i < source.length) {
    const ch = source[i] ?? ''
    const next = source[i + 1]
    if (inTemplate) {
      if (ch === '\\' && next !== undefined) {
        writeBlanked(source.slice(i, i + 2))
        i += 2
        continue
      }
      if (ch === '`') {
        writeCode('`')
        inTemplate = false
        i += 1
        continue
      }
      if (ch === '$' && next === '{') {
        withStrings += '${'
        code += '${'
        interpolations.push(0)
        inTemplate = false
        lastChar = '{'
        lastWord = ''
        i += 2
        continue
      }
      withStrings += ch
      code += ch === '\n' ? '\n' : ' '
      i += 1
      continue
    }
    if (ch === '/' && (next === '/' || next === '*')) {
      // A comment reads as whitespace: the context before it still decides the next `/`.
      const end = next === '/'
        ? (source.indexOf('\n', i) < 0 ? source.length : source.indexOf('\n', i))
        : (source.indexOf('*/', i + 2) < 0 ? source.length : source.indexOf('*/', i + 2) + 2)
      writeBlanked(source.slice(i, end))
      i = end
      continue
    }
    if (ch === "'" || ch === '"') {
      const end = stringEnd(source, i, ch)
      const raw = source.slice(i, end)
      const closed = raw.length >= 2 && raw.endsWith(ch)
      writeBlanked(raw)
      lastChar = closed ? ch : ''
      lastWord = ''
      i = end
      continue
    }
    if (ch === '`') {
      writeCode('`')
      inTemplate = true
      i += 1
      continue
    }
    if (ch === '}' && interpolations.length > 0 && interpolations.at(-1) === 0) {
      // The interpolation's own closing brace: back to the template text.
      interpolations.pop()
      writeCode('}')
      inTemplate = true
      i += 1
      continue
    }
    if (ch === '{' && interpolations.length > 0) {
      interpolations[interpolations.length - 1] = (interpolations.at(-1) ?? 0) + 1
      writeCode('{')
      i += 1
      continue
    }
    if (ch === '}' && interpolations.length > 0) {
      interpolations[interpolations.length - 1] = (interpolations.at(-1) ?? 0) - 1
      writeCode('}')
      i += 1
      continue
    }
    if (ch === '/' && (lastChar === '' || REGEX_PRECEDERS.has(lastChar) || REGEX_KEYWORDS.has(lastWord))) {
      const close = regexEnd(source, i)
      let end = close < source.length ? close + 1 : close
      while (end < source.length && REGEX_FLAG.test(source[end] ?? '')) end += 1
      writeBlanked(source.slice(i, end))
      lastChar = '/'
      lastWord = ''
      i = end
      continue
    }
    writeCode(ch)
    i += 1
  }
  return { code, withStrings }
}

/**
 * Request primitives named in code; matched with string contents blanked.
 * `fetch` is flagged however it is read — called, aliased (`const f = window.fetch`,
 * `fetch.bind(null)`) or bracketed — because a page script has no other use for it.
 */
const CODE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['fetch', /(?<![\w$])fetch(?![\w$])/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['sendBeacon', /\bsendBeacon\s*\(/],
  ['WebSocket', /\bWebSocket(?:Stream)?\s*\(/],
  ['EventSource', /\bEventSource\s*\(/],
  ['importScripts', /\bimportScripts\s*\(/],
  ['import()', /(?<![\w$])import\s*\(/],
  ['ajax', /\.ajax\s*\(/],
  ['axios', /\baxios\b/],
  ['jQuery', /(?<![\w$])\$\s*\.\s*(?:ajax|get|post|getJSON|getScript)\s*\(/],
  ['$http', /(?<![\w$])\$http(?![\w$])/],
]

/** Request primitives spelled out in a string argument; matched with string contents kept. */
const STRING_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['XMLHttpRequest.open', /\.open\s*\(\s*["'`](?:GET|POST|PUT|DELETE|PATCH|HEAD)\b/i],
  ['<script>', /createElement\s*\(\s*["']script["']\s*\)/i],
  ['fetch', /\[\s*["']fetch["']\s*\]/],
]

/** A tool that runs agent-authored code. */
export type ScriptTool = 'page_evaluate' | 'run_code'

/** The argument of such a tool that carries the code. */
type ScriptToolArgument = 'expression' | 'code'

/**
 * The tools that run agent-authored code, by the argument that carries it: a
 * `page_evaluate` expression and a PTC `run_code` program.
 */
export const SCRIPT_TOOL_ARGUMENTS: Readonly<Record<ScriptTool, ScriptToolArgument>> = {
  page_evaluate: 'expression',
  run_code: 'code',
}

/**
 * Whether a tool is one that runs agent-authored code.
 * @param name - a tool name.
 * @returns true when {@link SCRIPT_TOOL_ARGUMENTS} names the argument carrying the code.
 */
export function isScriptTool(name: string): name is ScriptTool {
  return Object.hasOwn(SCRIPT_TOOL_ARGUMENTS, name)
}

/** An absolute address spelled out in a script: with a scheme, or protocol-relative. */
const URL_LITERAL = /(?:https?:)?\/\/[\w.-]+(?::\d+)?(?:[/?#][^\s'"`<>)\\]*)?/g

/** What a script that spells out an API address is reported as. */
export const API_ADDRESS = '接口地址'

/**
 * Every absolute address one script spells out in a string or in a template's
 * text, made absolute for the address classifier.
 * @param withStrings - the scanned script with string contents kept.
 * @returns the addresses, each with a scheme.
 */
function spelledAddresses(withStrings: string): string[] {
  return [...withStrings.matchAll(URL_LITERAL)].map((match) => {
    const raw = match[0] ?? ''
    return raw.startsWith('//') ? `https:${raw}` : raw
  })
}

/**
 * The first request primitive one script uses, or undefined when the script
 * makes no request. Detection is lexical: it catches the spellings a model
 * writes, not deliberately obfuscated code — the prompt rule and the refusal
 * message carry the rule, and this check answers the model that breaks it.
 * An API address spelled out in the script counts: assigning it to
 * `location.href`, opening it, or setting it as an element's `src` requests
 * the site's API as surely as navigating a tab there does.
 * @param script - a `page_evaluate` expression or a `run_code` program.
 * @returns the primitive's name for the refusal reason.
 */
export function findScriptNetworkCall(script: string): string | undefined {
  const { code, withStrings } = scan(script)
  for (const [name, pattern] of CODE_PATTERNS) {
    if (pattern.test(code)) return name
  }
  for (const [name, pattern] of STRING_PATTERNS) {
    if (pattern.test(withStrings)) return name
  }
  for (const address of spelledAddresses(withStrings)) {
    if (isSiteApiUrl(address)) return API_ADDRESS
  }
  return undefined
}

/** How the user-facing panel names the switch that lifts this rule; every refusal names it too. */
export const DIRECT_SITE_API_SWITCH = '直接请求站点接口'

/** The sentence every refusal carries: why the rule exists. */
const RISK_SENTENCE = '直接请求站点接口会触发网站风控、有封号风险。'

/**
 * The model-facing refusal for agent-authored code that calls a site's interface.
 * @param primitive - what {@link findScriptNetworkCall} detected.
 * @param tool - the tool the code was submitted to.
 * @returns the deny reason the tool result carries.
 */
export function scriptNetworkRefusal(primitive: string, tool: ScriptTool): string {
  const where = tool === 'run_code' ? 'run_code 程序' : 'page_evaluate 脚本'
  return [
    `${where}禁止请求接口（检测到 ${primitive}）：在网站上完成任务必须通过真实页面操作——`,
    'page_navigate / tabs_open 打开页面、page_snapshot 或 page_find_related 定位元素、',
    'page_click / page_type / page_press_key / page_scroll 执行点击、输入、按键、滚动、',
    'page_extract_text 读取页面内容；需要更多内容就向下滚动。',
    `不要在 ${tool} 里用 fetch/XHR 调用站点接口，也不要改用 web_fetch 抓接口或用标签页直接打开接口地址。`,
    RISK_SENTENCE,
    `只有用户明确要求直接请求站点接口并已在内置能力里开启“${DIRECT_SITE_API_SWITCH}”时才允许。`,
  ].join('')
}

/** Host labels that name `api`/`apis` yet serve a documentation site, page by page. */
const DOCUMENTATION_API_HOSTS: ReadonlySet<string> = new Set([
  'api.flutter.dev', 'api.dart.dev', 'api.jquery.com', 'api.rubyonrails.org', 'api.wordpress.org', 'api.kde.org',
])

/** First path segments that are an API root on any site. */
const API_PATH_ROOTS: ReadonlySet<string> = new Set(['api', 'apis', 'ajax', 'graphql'])

/** First path segments that are an API root on one site family, by host suffix. */
const SITE_API_PATH_ROOTS: ReadonlyArray<readonly [string, string]> = [
  ['bilibili.com', 'x'],
]

/**
 * Whether one host label carries `api` or `apis` as a whole token: `api`,
 * `open-api`, `h5api` and `api2` do; `apidog`, `rapid7` and `capital` do not.
 */
function isApiHostLabel(label: string): boolean {
  if (label === 'api' || label === 'apis') return true
  return label
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(/[-_. ]+/)
    .some(token => token === 'api' || token === 'apis')
}

/**
 * Whether one URL addresses a site's API rather than a page the site shows
 * people. Three readings, any one of which makes the URL an API address: the
 * first host label names an API host (`api.bilibili.com`, `h5api.m.taobao.com`)
 * unless that subdomain is a documentation site; the first path segment is an
 * API root (`/api/`, `/graphql/`); or the first path segment is the API root
 * the site family keeps under its page hosts (`www.bilibili.com/x/…`).
 * @param url - the address a tool would request.
 * @returns true when requesting the URL is a direct call on a site's API. A URL that
 *   does not parse is not one: the tool's own validation reports it.
 */
export function isSiteApiUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  const [firstLabel] = host.split('.')
  if (firstLabel !== undefined && isApiHostLabel(firstLabel) && !DOCUMENTATION_API_HOSTS.has(host)) return true
  const root = parsed.pathname.split('/').filter(segment => segment !== '')[0]?.toLowerCase()
  if (root === undefined) return false
  if (API_PATH_ROOTS.has(root)) return true
  return SITE_API_PATH_ROOTS.some(([site, apiRoot]) => root === apiRoot && (host === site || host.endsWith(`.${site}`)))
}

/** Tools whose one argument is the address the browser or the extension then requests. */
const URL_TOOL_ARGUMENTS: Readonly<Record<string, string>> = {
  tabs_open: 'url',
  page_navigate: 'url',
  web_fetch: 'url',
}

/** Whether a value is a plain record: an argument object or one step of a plan. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The API host one tool call would request directly, or undefined when the
 * call requests none: the URL argument of the navigation and fetch tools
 * (`tabs_open`, `page_navigate`, `web_fetch`) or a `navigate` step of a
 * `page_batch_actions` plan.
 * @param tool - the tool name.
 * @param args - the call's arguments.
 * @returns the API host the call targets.
 */
export function siteApiHostTarget(tool: string, args: unknown): string | undefined {
  const urls: string[] = []
  if (tool === 'page_batch_actions') {
    const plan = isRecord(args) ? args['actions'] : undefined
    if (!Array.isArray(plan)) return undefined
    for (const step of plan) {
      if (isRecord(step) && step['op'] === 'navigate' && typeof step['url'] === 'string') urls.push(step['url'])
    }
  } else {
    const argument = URL_TOOL_ARGUMENTS[tool]
    const url = argument === undefined || !isRecord(args) ? undefined : args[argument]
    if (typeof url === 'string') urls.push(url)
  }
  for (const url of urls) {
    if (isSiteApiUrl(url)) return new URL(url).hostname
  }
  return undefined
}

/**
 * The model-facing refusal for a tool call that would open or fetch a site's
 * API address.
 * @param tool - the tool (`tabs_open`, `page_navigate`, `page_batch_actions`, `web_fetch`).
 * @param host - the API host the call targets.
 * @returns the deny reason the tool result carries.
 */
export function siteApiUrlRefusal(tool: string, host: string): string {
  return [
    `${tool} 禁止直接请求站点接口（${host} 是接口地址，不是给人看的网页）：`,
    '在网站上完成任务必须通过真实页面操作——打开对应的网页，',
    'page_snapshot 或 page_find_related 定位元素，page_click / page_type / page_scroll 操作，',
    'page_extract_text 读取页面呈现的内容。',
    RISK_SENTENCE,
    `只有用户明确要求直接请求站点接口并已在内置能力里开启“${DIRECT_SITE_API_SWITCH}”时才允许。`,
  ].join('')
}

/**
 * The model-facing refusal for the `video_index` action that builds its index
 * through Bilibili's API with the user's login state.
 * @returns the deny reason the tool result carries.
 */
export function videoIndexApiRefusal(): string {
  return [
    'video_index 的 index 动作禁止执行：建索引要直接请求 B 站接口（视频信息、字幕、音频，带登录态）。',
    RISK_SENTENCE,
    '改用页面操作：打开视频页，用播放器自己的进度条、字幕开关和画面截帧读取页面上已呈现的内容',
    '（video_index 的 zoom 动作可以直接传视频页 URL 截取某一时刻的画面并识别画面里的字幕；sense_now 陪看当前画面）。',
    `只有用户明确要求并已在内置能力里开启“${DIRECT_SITE_API_SWITCH}”时才能用 index。`,
  ].join('')
}
