/**
 * DOM awareness layer: injects a serialized IIFE through Runtime.evaluate
 * (no content script) to extract page snapshots / element geometry /
 * visibility probes / conditional waits.
 *
 * The injected code runs in the page context, so it is written as plain ES5
 * string code that conflicts with nothing in the page environment; all
 * randomness and async logic stay on the extension side.
 *
 * Snapshot piercing (the extension's addition over the reference
 * implementation): the walk recurses into open shadow roots and same-origin
 * iframe documents (depth ≤ 4). Elements collected below the top document
 * carry no top-addressable selector (selector = '' plus the inShadowDom /
 * inIframe flags) and their rects are translated into the TOP viewport by the
 * accumulated iframe offsets, so `center` feeds Input.dispatchMouseEvent
 * directly. Cross-origin iframes contribute only the iframe element itself.
 */

import type { PageElementInfo, PageSnapshot } from '../shared/protocol'
import { cdpController, sleep } from './cdp'

// ───────────────────── text-leaf scan (status text into the snapshot) ─────────────────────

/**
 * Structural element subset the leaf predicate reads (real DOM elements and
 * jsdom/test doubles both satisfy it).
 */
export interface TextLeafElement {
  tagName: string
  hasAttribute(name: string): boolean
  children: { length: number }
  textContent: string | null
}

/**
 * Tags the text-leaf scan never enters: not rendered (metadata) or their text
 * is code/data rather than page status.
 */
export const TEXT_LEAF_SKIP_TAGS: Record<string, number> = {
  SCRIPT: 1,
  STYLE: 1,
  NOSCRIPT: 1,
  TEMPLATE: 1,
  SVG: 1,
  HEAD: 1,
  TITLE: 1,
  META: 1,
  LINK: 1,
}

/**
 * Tags the curated snapshot selector list already collects — the leaf scan
 * must skip them or their text would enter `passive` twice (an h3 leaf is
 * both an h1-h6 hit and a text leaf).
 */
export const TEXT_LEAF_LISTED_TAGS: Record<string, number> = {
  A: 1,
  BUTTON: 1,
  INPUT: 1,
  TEXTAREA: 1,
  SELECT: 1,
  IFRAME: 1,
  LABEL: 1,
  IMG: 1,
  H1: 1,
  H2: 1,
  H3: 1,
  H4: 1,
  H5: 1,
  H6: 1,
  OPTION: 1,
  SUMMARY: 1,
}

/**
 * Leaf-candidate predicate: a non-interactive, childless element carrying
 * visible text. Injected into SNAPSHOT_EXPRESSION via function-source
 * serialization and imported by tests — one implementation, so the shipped
 * and tested semantics cannot drift. Motivation (真机批36): operation
 * feedback spans ("点击成功 05:33:20") never entered the snapshot, forcing
 * the model into page_evaluate for every status read.
 */
export function textLeafOk(
  el: TextLeafElement,
  listed: Record<string, number>,
  skip: Record<string, number>,
): boolean {
  const tag = el.tagName.toUpperCase()
  if (skip[tag] || listed[tag]) return false
  if (el.hasAttribute('role')) return false
  if (el.hasAttribute('onclick')) return false
  if (el.hasAttribute('contenteditable')) return false
  if (el.hasAttribute('tabindex')) return false
  if (el.hasAttribute('aria-hidden')) return false
  if (el.children.length > 0) return false
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
  return text.length > 0
}

// ───────────────────────── CDP Runtime.evaluate result (minimal types) ─────────────────────────

interface CdpRemoteObject {
  type: string
  subtype?: string
  value?: unknown
  description?: string
}

interface CdpExceptionDetails {
  text: string
  exception?: { type?: string; value?: unknown; description?: string }
  lineNumber?: number
  columnNumber?: number
}

interface CdpEvaluateResult {
  result: CdpRemoteObject
  exceptionDetails?: CdpExceptionDetails
}

/**
 * Evaluate an expression in the page and take its value (returnByValue).
 * `awaitPromise: true` lets model-facing `page_evaluate` run async snippets
 * (fetch with credentials, async page globals) and receive the resolved
 * value; the extension's own probes are sync IIFEs, so this changes nothing
 * for them. Page exceptions become Chinese errors with stack context.
 */
export async function evaluateInPage<T>(
  tabId: number,
  expression: string,
): Promise<T> {
  const res = await cdpController.send<CdpEvaluateResult>(
    tabId,
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      userGesture: true,
      awaitPromise: true,
    },
  )
  if (res && res.exceptionDetails) {
    const d = res.exceptionDetails
    const detail =
      d.exception && d.exception.description
        ? d.exception.description.split('\n')[0]
        : d.exception && d.exception.value !== undefined
          ? JSON.stringify(d.exception.value)
          : ''
    throw new Error(
      `页面脚本执行失败：${d.text}${detail ? `（${detail}）` : ''}${
        typeof d.lineNumber === 'number' ? ` [行 ${d.lineNumber + 1}]` : ''
      }`,
    )
  }
  return (res.result.value ?? null) as T
}

// ───────────────────────── snapshot injection script ─────────────────────────

/**
 * Collect visible interactive elements and return a PageSnapshot-shaped
 * object. See the module comment for the piercing rules. Collected facts:
 * - element set: a/button/input/textarea/select/[role]/[onclick]/
 *   [contenteditable]/h1-h6/label/img[alt]/[tabindex]/iframe, plus text
 *   leaves (childless non-interactive elements with visible text — status
 *   feedback the model would otherwise only see via page_evaluate)
 * - visibility: getBoundingClientRect width/height > 0 and sane computed style
 * - selector priority: #id (unique) → [aria-label] (unique) →
 *   name/placeholder (unique) → tag:nth-of-type(n) chain (≤3 levels up)
 * - cap 60 elements, interactive first, DOM order preserved per bucket,
 *   indexes reassigned after the merge
 */
export const SNAPSHOT_EXPRESSION = `(() => {
  var MAX_ELEMENTS = 60;
  var HARD_CAP = 240;
  var MAX_DEPTH = 4;
  var INTERACTIVE_TAGS = { A: 1, BUTTON: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, SUMMARY: 1 };
  var INTERACTIVE_ROLES = { button: 1, link: 1, textbox: 1, checkbox: 1, radio: 1, combobox: 1, listbox: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, option: 1, tab: 1, switch: 1, searchbox: 1, slider: 1, spinbutton: 1 };
  var IMPLICIT_ROLES = { a: 'link', button: 'button', textarea: 'textbox', select: 'combobox', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', img: 'img', label: 'label', option: 'option' };
  function q(v) { return JSON.stringify(String(v)); }
  function cssEsc(v) { return (window.CSS && CSS.escape) ? CSS.escape(v) : String(v); }
  function unique(doc, sel) { try { return doc.querySelectorAll(sel).length === 1; } catch (e) { return false; } }
  function makeSelector(el, doc) {
    if (el.id) {
      var idSel = '#' + cssEsc(el.id);
      if (unique(doc, idSel)) return idSel;
    }
    var aria = el.getAttribute('aria-label');
    if (aria) {
      var s1 = '[aria-label=' + q(aria) + ']';
      if (unique(doc, s1)) return s1;
    }
    var name = el.getAttribute('name');
    if (name) {
      var s2 = el.tagName.toLowerCase() + '[name=' + q(name) + ']';
      if (unique(doc, s2)) return s2;
    }
    var ph = el.getAttribute('placeholder');
    if (ph) {
      var s3 = '[placeholder=' + q(ph) + ']';
      if (unique(doc, s3)) return s3;
    }
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 3) {
      var tag = node.tagName.toLowerCase();
      var parent = node.parentNode;
      if (parent) {
        var n = 0, idx = 0;
        for (var c = parent.firstElementChild; c; c = c.nextElementSibling) {
          if (c.tagName === node.tagName) { n++; if (c === node) idx = n; }
        }
        parts.unshift(n > 1 ? tag + ':nth-of-type(' + idx + ')' : tag);
      } else {
        parts.unshift(tag);
      }
      if (node.tagName === 'BODY') break;
      node = node.parentNode;
      depth++;
    }
    return parts.join(' > ');
  }
  function isVisible(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') return false;
    return true;
  }
  function roleOf(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    return IMPLICIT_ROLES[tag] || '';
  }
  function isInteractive(el) {
    if (INTERACTIVE_TAGS[el.tagName]) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.hasAttribute('contenteditable')) {
      var ce = (el.getAttribute('contenteditable') || '').toLowerCase();
      if (ce === '' || ce === 'true') return true;
    }
    var role = (el.getAttribute('role') || '').toLowerCase();
    if (INTERACTIVE_ROLES[role]) return true;
    var ti = el.getAttribute('tabindex');
    if (ti !== null && parseInt(ti, 10) >= 0) return true;
    return false;
  }
  function rd(n) { return Math.round(n * 10) / 10; }
  var LEAF_SKIP = ${JSON.stringify(TEXT_LEAF_SKIP_TAGS)};
  var LEAF_LISTED = ${JSON.stringify(TEXT_LEAF_LISTED_TAGS)};
  var textLeafOk = ${textLeafOk.toString()};
  var interactive = [], passive = [];
  function total() { return interactive.length + passive.length; }
  function addElement(el, doc, offsetX, offsetY, inShadow, inIframe, piercePrefix) {
    if (total() >= HARD_CAP) return;
    if (el.tagName === 'INPUT' && (el.getAttribute('type') || 'text').toLowerCase() === 'hidden') return;
    if (!isVisible(el)) return;
    var r = el.getBoundingClientRect();
    var x = r.x + offsetX, y = r.y + offsetY;
    var text = (el.innerText || ('value' in el ? String(el.value || '') : '') || el.textContent || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 80);
    if (el.tagName === 'IFRAME') {
      var t2 = el.getAttribute('title') || el.getAttribute('aria-label') || '';
      if (t2) text = String(t2).replace(/\\s+/g, ' ').trim().slice(0, 80);
    }
    var own = makeSelector(el, doc);
    var info = {
      index: 0,
      tag: el.tagName.toLowerCase(),
      selector: piercePrefix ? piercePrefix + ' >>> ' + own : own,
      text: text,
      role: roleOf(el) || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      href: el.tagName === 'A' ? (el.href || undefined) : undefined,
      rect: { x: rd(x), y: rd(y), width: rd(r.width), height: rd(r.height) },
      center: { x: rd(x + r.width / 2), y: rd(y + r.height / 2) },
      interactive: isInteractive(el),
      inShadowDom: inShadow || undefined,
      inIframe: inIframe || undefined
    };
    if (info.interactive) {
      if (interactive.length < MAX_ELEMENTS) interactive.push(info);
    } else if (passive.length < MAX_ELEMENTS) {
      passive.push(info);
    }
  }
  function collect(root, doc, offsetX, offsetY, depth, inShadow, inIframe, piercePrefix) {
    if (depth > MAX_DEPTH) return;
    var nodes;
    try {
      nodes = root.querySelectorAll('a, button, input, textarea, select, iframe, [role], [onclick], [contenteditable], h1, h2, h3, h4, h5, h6, label, img[alt], [tabindex]');
    } catch (e) { return; }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || el.nodeType !== 1) continue;
      addElement(el, doc, offsetX, offsetY, inShadow, inIframe, piercePrefix);
      if (total() >= HARD_CAP) return;
      if (el.tagName === 'IFRAME') {
        var cd = null;
        try { cd = el.contentDocument; } catch (e) { cd = null; }
        if (cd) {
          var ir = el.getBoundingClientRect();
          collect(cd, cd, offsetX + ir.x, offsetY + ir.y, depth + 1, inShadow, true, piercePrefix ? piercePrefix + ' >>> ' + makeSelector(el, doc) : makeSelector(el, doc));
        }
        // 跨域 iframe：contentDocument 为 null/抛错 → 只保留 iframe 元素本身。
      }
    }
    // shadow 宿主不一定命中上面的选择器清单（普通 div、扩展注入的自定义元素
    // 都会带 shadowRoot），所以对全量元素补一遍宿主扫描；同一遍顺带收集
    // 状态文本叶子（textLeafOk）；HARD_CAP 兜底规模。
    var allNodes;
    try {
      allNodes = root.querySelectorAll('*');
    } catch (e2) { allNodes = []; }
    for (var j = 0; j < allNodes.length; j++) {
      var h = allNodes[j];
      if (h && h.nodeType === 1) {
        if (h.shadowRoot) {
          collect(h.shadowRoot, doc, offsetX, offsetY, depth + 1, true, inIframe, piercePrefix ? piercePrefix + ' >>> ' + makeSelector(h, doc) : makeSelector(h, doc));
        }
        // 状态文本叶子（真机批36）：非交互、无子元素、有文本的元素也进快照，
        // 操作反馈不必再靠 page_evaluate 深读。addElement 自带可见性过滤、
        // HARD_CAP 与 passive 桶上限，规模由既有兜底控制。
        if (textLeafOk(h, LEAF_LISTED, LEAF_SKIP)) {
          addElement(h, doc, offsetX, offsetY, inShadow, inIframe, piercePrefix);
        }
      }
      if (total() >= HARD_CAP) return;
    }
  }
  collect(document, document, 0, 0, 0, false, false, '');
  var merged = interactive.concat(passive).slice(0, MAX_ELEMENTS);
  for (var k = 0; k < merged.length; k++) { merged[k].index = k; }
  return {
    url: location.href,
    title: document.title,
    timestamp: Date.now(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX || window.pageXOffset || 0,
      scrollY: window.scrollY || window.pageYOffset || 0
    },
    elements: merged
  };
})()`

// ───────────────────────── snapshot validation & normalization ─────────────────────────

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

/**
 * Normalize raw injected-script output into PageElementInfo[], reassigning
 * indexes and carrying the piercing flags through.
 */
function normalizeElements(raw: unknown): PageElementInfo[] {
  if (!Array.isArray(raw)) return []
  const out: PageElementInfo[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    const rect = (e['rect'] ?? {}) as Record<string, unknown>
    const center = (e['center'] ?? {}) as Record<string, unknown>
    if (typeof e['tag'] !== 'string' || typeof e['selector'] !== 'string') continue
    const x = asNumber(rect['x'], 0)
    const y = asNumber(rect['y'], 0)
    out.push({
      index: out.length,
      tag: e['tag'],
      selector: e['selector'],
      text: asString(e['text'], ''),
      ...(typeof e['role'] === 'string' ? { role: e['role'] } : {}),
      ...(typeof e['ariaLabel'] === 'string' ? { ariaLabel: e['ariaLabel'] } : {}),
      ...(typeof e['placeholder'] === 'string' ? { placeholder: e['placeholder'] } : {}),
      ...(typeof e['href'] === 'string' ? { href: e['href'] } : {}),
      rect: {
        x,
        y,
        width: asNumber(rect['width'], 0),
        height: asNumber(rect['height'], 0),
      },
      center: {
        x: asNumber(center['x'], x),
        y: asNumber(center['y'], y),
      },
      interactive: e['interactive'] === true,
      ...(e['inShadowDom'] === true ? { inShadowDom: true } : {}),
      ...(e['inIframe'] === true ? { inIframe: true } : {}),
    })
  }
  return out
}

/**
 * Capture the page snapshot: url/title/viewport/timestamp + visible
 * interactive elements (≤60, shadow DOM and same-origin iframe piercing
 * applied). Coordinates are viewport CSS pixels, directly usable by
 * Input.dispatchMouseEvent.
 */
export async function captureSnapshot(tabId: number): Promise<PageSnapshot> {
  const raw = await evaluateInPage<unknown>(tabId, SNAPSHOT_EXPRESSION)
  if (raw === null || typeof raw !== 'object') {
    throw new Error('快照提取失败：页面返回了非对象数据')
  }
  const o = raw as Record<string, unknown>
  const vp = (o['viewport'] ?? {}) as Record<string, unknown>
  return {
    tabId,
    url: asString(o['url'], ''),
    title: asString(o['title'], ''),
    timestamp: asNumber(o['timestamp'], Date.now()),
    viewport: {
      width: asNumber(vp['width'], 0),
      height: asNumber(vp['height'], 0),
      scrollX: asNumber(vp['scrollX'], 0),
      scrollY: asNumber(vp['scrollY'], 0),
    },
    elements: normalizeElements(o['elements']),
  }
}

// ───────────────────────── element geometry / visibility ─────────────────────────

export interface ElementProbe {
  rect: { x: number; y: number; width: number; height: number }
  center: { x: number; y: number }
}

export const INVALID_SELECTOR = '__dsh_invalid_selector__'

/** Element probe IIFE: null (absent/invisible) or {rect, center}. */
/**
 * In-page deep resolver for pierce selectors. A ` >>> `-separated selector
 * descends one boundary per segment: a shadow host continues into its
 * shadowRoot, an iframe continues into its contentDocument (same-origin),
 * any other element scopes the next segment to its subtree. A plain selector
 * (no ` >>> `) resolves against the top document exactly as before. Closure-
 * free so the compiled source can be injected via toString; the invalid-
 * selector sentinel travels as an argument.
 * @param root - search root (top document, shadow root, element, or iframe document).
 * @param selector - plain CSS selector or `seg >>> seg >>> …` pierce selector.
 * @param invalidSentinel - returned verbatim when a segment is invalid CSS.
 * @returns the resolved element, the sentinel (invalid syntax), or null (absent).
 */
export function deepQuery(
  root: Document | ShadowRoot | Element,
  selector: string,
  invalidSentinel: string,
): Element | string | null {
  function descend(r: Document | ShadowRoot | Element, seg: string): Element | string | null {
    try {
      return r.querySelector(seg)
    } catch {
      return invalidSentinel
    }
  }
  const PIERCE = ' >>> '
  if (selector.indexOf(PIERCE) === -1) return descend(root, selector)
  const segs = selector.split(PIERCE)
  let node: Document | ShadowRoot | Element = root
  let el: Element | string | null = null
  for (let i = 0; i < segs.length; i++) {
    el = descend(node, segs[i] as string)
    if (el === invalidSentinel) return el
    if (el === null || el === undefined) return null
    if (i < segs.length - 1) {
      const e = el as Element
      if (e.shadowRoot) {
        node = e.shadowRoot
        continue
      }
      if (e.tagName === 'IFRAME') {
        let cd: Document | null = null
        try {
          cd = (e as HTMLIFrameElement).contentDocument
        } catch {
          cd = null
        }
        if (!cd) return null
        node = cd
        continue
      }
      node = e
    }
  }
  return el
}

function buildProbeExpression(selector: string): string {
  const selJson = JSON.stringify(selector)
  return `(() => {
  var el = (${deepQuery.toString()})(document, ${selJson}, ${JSON.stringify(INVALID_SELECTOR)});
  if (!el) return null;
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  // An element inside a same-origin iframe reports its rect relative to the
  // IFRAME viewport; walk up the frame chain and accumulate each host's
  // offset so callers get one top-viewport coordinate (click/typed焦点都按
  // 主视口寻址). Shadow roots share the host coordinate system — no correction.
  var offX = 0, offY = 0;
  var d = el.ownerDocument;
  while (d && d.defaultView && d.defaultView.frameElement) {
    var fr = d.defaultView.frameElement.getBoundingClientRect();
    offX += fr.x; offY += fr.y;
    d = d.defaultView.parent.document;
  }
  var st = el.ownerDocument.defaultView ? el.ownerDocument.defaultView.getComputedStyle(el) : window.getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden') return null;
  function rd(n) { return Math.round(n * 10) / 10; }
  return {
    rect: { x: rd(r.x + offX), y: rd(r.y + offY), width: rd(r.width), height: rd(r.height) },
    center: { x: rd(r.x + offX + r.width / 2), y: rd(r.y + offY + r.height / 2) }
  };
})()`
}

/**
 * Element viewport rect and center. Returns null when absent or invisible;
 * an invalid selector syntax throws a Chinese error.
 */
export async function getElementRect(
  tabId: number,
  selector: string,
): Promise<ElementProbe | null> {
  const raw = await evaluateInPage<unknown>(
    tabId,
    buildProbeExpression(selector),
  )
  if (raw === INVALID_SELECTOR) {
    throw new Error(`选择器语法无效：${selector}`)
  }
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const rect = (o['rect'] ?? {}) as Record<string, unknown>
  const center = (o['center'] ?? {}) as Record<string, unknown>
  return {
    rect: {
      x: asNumber(rect['x'], 0),
      y: asNumber(rect['y'], 0),
      width: asNumber(rect['width'], 0),
      height: asNumber(rect['height'], 0),
    },
    center: {
      x: asNumber(center['x'], 0),
      y: asNumber(center['y'], 0),
    },
  }
}

/** Element exists and is visible (same visibility rule as getElementRect). */
async function elementExistsAndVisible(
  tabId: number,
  selector: string,
): Promise<boolean> {
  return (await getElementRect(tabId, selector)) !== null
}

/** Wait for an element to appear and become visible; 250ms polling. */
export async function waitFor(
  tabId: number,
  selector: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    if (await elementExistsAndVisible(tabId, selector)) return
    const remain = deadline - Date.now()
    if (remain <= 0) {
      throw new Error(`等待元素超时（${timeoutMs}ms）：${selector}`)
    }
    await sleep(Math.min(250, remain))
  }
}

/** Viewport size (for scroll gesture placement); sane default on failure. */
export async function getViewport(
  tabId: number,
): Promise<{ width: number; height: number }> {
  try {
    const v = await evaluateInPage<{ width?: unknown; height?: unknown }>(
      tabId,
      '(() => ({ width: window.innerWidth, height: window.innerHeight }))()',
    )
    if (
      v &&
      typeof v === 'object' &&
      typeof v.width === 'number' &&
      typeof v.height === 'number' &&
      v.width > 0
    ) {
      return { width: v.width, height: v.height }
    }
  } catch {
    // Page unavailable → default.
  }
  return { width: 1280, height: 800 }
}
