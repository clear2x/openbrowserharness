/**
 * 页面脚本请求接口 (the script-network built-in capability): pure detection
 * of the network primitives a page script can use to call a site's API. The
 * website-task rule is that a task on a site is completed through real page
 * operations (navigation, clicks, typing, scrolling), never by calling the
 * site's interfaces from a script — the tool gate refuses such a script
 * through this module, without a browser.
 *
 * Comments, string contents and regular-expression bodies are skipped before
 * matching: a script that only mentions `fetch` in a comment or a string is
 * not a request.
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

/**
 * The first request primitive one script uses, or undefined when the script
 * makes no request. Detection is lexical: it catches the spellings a model
 * writes, not deliberately obfuscated code — the prompt rule and the refusal
 * message are the primary deterrent, this is the net under them.
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
  return undefined
}

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
    '只有用户明确要求抓取站点接口并已在内置能力里开启“页面脚本请求接口”时才允许。',
  ].join('')
}
