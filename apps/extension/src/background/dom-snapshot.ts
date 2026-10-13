/**
 * DOM awareness layer: injects serialized IIFEs through Runtime.evaluate
 * (no content script) to extract page snapshots / element geometry / hit
 * validation / conditional waits / snapshot pre-steps.
 *
 * The injected code runs in the page context, so it is written as plain
 * string code assembled from closure-free exported functions (injected by
 * function-source serialization — the same objects the unit tests call, so
 * shipped and tested semantics cannot drift); all randomness and async logic
 * stay on the extension side.
 *
 * Snapshot piercing (the extension's addition over the reference
 * implementation): the walk recurses into open shadow roots and same-origin
 * iframe documents (depth ≤ 4). Elements collected below the top document
 * carry no top-addressable selector (selector = prefixed pierce chain) and
 * their rects are translated into the TOP viewport by the accumulated iframe
 * offsets, so `center` feeds Input.dispatchMouseEvent directly. Cross-origin
 * iframes contribute only the iframe element itself.
 *
 * Index addressing: every captured snapshot is cached per tab (`tabId` — the
 * CdpRequest wire carries no agent/session identity) and `resolve_index`
 * re-resolves one cached element on-page (deepQuery + fresh geometry) with
 * tag/text drift validation, instead of re-running the whole snapshot
 * pipeline for a single click.
 */

import type { PageElementInfo, PageSnapshot } from '../shared/protocol'
import { INVALID_SELECTOR, PIERCE_SEPARATOR, deepQuery } from '../shared/deep-query'
import { cdpController } from './cdp'
import {
  animFreezeEnabled,
  bannerCleanEnabled,
  lazyLoadEnabled,
  privacyMaskEnabled,
  snapLeanEnabled,
} from './capability-gate'

export { INVALID_SELECTOR, PIERCE_SEPARATOR, deepQuery }

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

// ───────────────────── click hit validation (silent null-click guard) ─────────────────────

/**
 * Minimal element the hit predicate reads. A real DOM Element, a jsdom
 * Element, and a test double all satisfy it.
 */
export interface HitCheckElement {
  contains(other: HitCheckElement | null): boolean
}

/**
 * Whether a click at the probed point would actually land on the target.
 * The three silent null-clicks are caught by one probe: an occluding overlay,
 * an off-viewport point (elementFromPoint misses), and a pointer-events:none
 * target (elementFromPoint skips it and reports what is beneath). Hitting a
 * DESCENDANT passes — click events bubble to the target, and a subtree that
 * re-enables pointer-events is genuinely clickable.
 *
 * Trade-off: a single elementFromPoint covers occlusion and
 * pointer-events:none at once (the latter returns the element beneath), so
 * the computed-style pointer-events value is not read separately.
 * @param target - the element the click is meant to land on.
 * @param hit - the element `document.elementFromPoint` returned for the target point.
 * @returns whether the click would land on the target (or its descendant).
 */
export function clickHitOk(target: HitCheckElement, hit: HitCheckElement | null): boolean {
  if (hit === target) return true
  return hit !== null && target.contains(hit)
}

// ───────────────────── shared in-page geometry helpers (serialized) ─────────────────────

/** A page window viewed structurally (the serialized probes read only these members). */
export interface SnapshotView {
  getComputedStyle(el: unknown): { visibility?: string; display?: string }
  readonly frameElement?: { getBoundingClientRect(): { x: number; y: number } } | null
  readonly parent?: { readonly document?: SnapshotDocument | null } | null
}

/** Structural document the collector and the probes read. */
export interface SnapshotDocument {
  readonly nodeType: number
  querySelectorAll(selectors: string): ArrayLike<SnapshotElementNode>
  readonly defaultView?: SnapshotView | null
}

/** Minimal shadow root the collector reads. */
export interface SnapshotShadowRoot {
  querySelectorAll(selectors: string): ArrayLike<SnapshotElementNode>
}

/**
 * Structural element subset the snapshot collector reads (real DOM elements
 * and jsdom elements both satisfy it; jsdom lacks `innerText`, which the
 * text derivation treats as absent).
 */
export interface SnapshotElementNode {
  readonly tagName: string
  readonly nodeType: number
  readonly id: string
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  getBoundingClientRect(): { x: number; y: number; width: number; height: number }
  querySelectorAll(selectors: string): ArrayLike<SnapshotElementNode>
  readonly parentNode: SnapshotElementNode | SnapshotDocument | null
  readonly firstElementChild: SnapshotElementNode | null
  readonly nextElementSibling: SnapshotElementNode | null
  readonly textContent: string | null
  /** Page-reality fields: absent in jsdom, present in a real page. */
  readonly innerText?: string
  readonly value?: unknown
  readonly href?: string
  readonly shadowRoot?: SnapshotShadowRoot | null
  readonly contentDocument?: SnapshotDocument | null
  readonly ownerDocument?: SnapshotDocument | null
}

/** Attribute-value counts backing unique-selector decisions (one scan per document). */
export interface SelectorCounts {
  readonly id: Map<string, number>
  readonly ariaLabel: Map<string, number>
  /** Keyed by `TAG|value` — the name selector is tag-scoped. */
  readonly name: Map<string, number>
  readonly placeholder: Map<string, number>
}

/**
 * Count candidate selector attributes over one document in a SINGLE pass.
 * Replaces the per-element unique() probes that ran up to four whole-document
 * querySelectorAll scans for every collected element.
 * @param doc - the document whose attribute counts back the unique-selector decisions.
 * @returns the four attribute-value count maps (empty maps when the scan fails).
 */
export function selectorCountsOf(doc: SnapshotDocument): SelectorCounts {
  const counts = {
    id: new Map<string, number>(),
    ariaLabel: new Map<string, number>(),
    name: new Map<string, number>(),
    placeholder: new Map<string, number>(),
  }
  let nodes: ArrayLike<SnapshotElementNode>
  try {
    nodes = doc.querySelectorAll('[id], [aria-label], [name], [placeholder]')
  } catch {
    return counts
  }
  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i] as SnapshotElementNode
    const id = el.getAttribute('id')
    if (id !== null && id !== '') bump(counts.id, id)
    const aria = el.getAttribute('aria-label')
    if (aria !== null && aria !== '') bump(counts.ariaLabel, aria)
    const name = el.getAttribute('name')
    if (name !== null && name !== '') bump(counts.name, `${el.tagName}|${name}`)
    const ph = el.getAttribute('placeholder')
    if (ph !== null && ph !== '') bump(counts.placeholder, ph)
  }
  return counts
}

/**
 * Best-effort unique CSS selector for one element: #id → [aria-label] →
 * tag[name] → [placeholder] (each only when unique in the collected
 * document), falling back to a ≤3-level tag:nth-of-type chain.
 * @param el - the element to address.
 * @param counts - the attribute counts from {@link selectorCountsOf} for the element's document.
 * @returns a selector unique within the document, or a structural chain fallback.
 */
export function makeSelector(el: SnapshotElementNode, counts: SelectorCounts): string {
  function q(v: string): string {
    return JSON.stringify(v)
  }
  function cssEsc(v: string): string {
    const css = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS
    return css?.escape !== undefined ? css.escape(v) : v
  }
  if (el.id !== '') {
    if ((counts.id.get(el.id) ?? 0) === 1) return '#' + cssEsc(el.id)
  }
  const aria = el.getAttribute('aria-label')
  if (aria !== null && aria !== '') {
    if ((counts.ariaLabel.get(aria) ?? 0) === 1) return '[aria-label=' + q(aria) + ']'
  }
  const name = el.getAttribute('name')
  if (name !== null && name !== '') {
    if ((counts.name.get(`${el.tagName}|${name}`) ?? 0) === 1) {
      return el.tagName.toLowerCase() + '[name=' + q(name) + ']'
    }
  }
  const ph = el.getAttribute('placeholder')
  if (ph !== null && ph !== '') {
    if ((counts.placeholder.get(ph) ?? 0) === 1) return '[placeholder=' + q(ph) + ']'
  }
  const parts: string[] = []
  let node: SnapshotElementNode = el
  let depth = 0
  while (node.nodeType === 1 && depth < 3) {
    const tag = node.tagName.toLowerCase()
    const parent = node.parentNode
    if (parent !== null && parent.nodeType === 1) {
      const p = parent as SnapshotElementNode
      let n = 0
      let idx = 0
      for (let c = p.firstElementChild; c !== null; c = c.nextElementSibling) {
        if (c.tagName === node.tagName) {
          n += 1
          if (c === node) idx = n
        }
      }
      parts.unshift(n > 1 ? `${tag}:nth-of-type(${String(idx)})` : tag)
    } else {
      parts.unshift(tag)
    }
    if (node.tagName === 'BODY') break
    const next = node.parentNode
    if (next === null || next.nodeType !== 1) break
    node = next as SnapshotElementNode
    depth += 1
  }
  return parts.join(' > ')
}

/** Structural subset the visibility check reads. */
export interface VisibleElement {
  getBoundingClientRect(): { width: number; height: number }
  readonly ownerDocument?: SnapshotDocument | null
}

/**
 * Rendered and not display:none/visibility:hidden (zero-area boxes excluded —
 * the same rule the snapshot and the element probes have always applied).
 * @param el - the element to check.
 * @returns whether the element occupies area in its viewport.
 */
export function elementVisible(el: VisibleElement): boolean {
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return false
  const doc = el.ownerDocument
  const view = (doc !== null && doc !== undefined && doc.defaultView !== null && doc.defaultView !== undefined
    ? doc.defaultView
    : globalThis) as unknown as { getComputedStyle(el: unknown): { visibility?: string; display?: string } }
  const st = view.getComputedStyle(el)
  return st.visibility !== 'hidden' && st.display !== 'none'
}

/** Structural subset the frame-offset walk reads. */
export interface FrameWalkElement {
  readonly ownerDocument?: SnapshotDocument | null
}

/**
 * Accumulated iframe offsets from an element's own document up to the TOP
 * viewport. Elements inside a same-origin iframe report their rect relative
 * to the IFRAME viewport; shadow roots share the host coordinate system and
 * add nothing.
 * @param el - the element whose document chain to walk.
 * @returns the {x, y} offsets to translate the element's local rect into the top viewport.
 */
export function topViewportOffset(el: FrameWalkElement): { x: number; y: number } {
  let offX = 0
  let offY = 0
  let doc = el.ownerDocument
  while (doc !== null && doc !== undefined && doc.defaultView !== null && doc.defaultView !== undefined) {
    const frame = doc.defaultView.frameElement
    if (frame === null || frame === undefined) break
    const fr = frame.getBoundingClientRect()
    offX += fr.x
    offY += fr.y
    const parent = doc.defaultView.parent
    doc = parent !== null && parent !== undefined ? (parent.document ?? null) : null
  }
  return { x: offX, y: offY }
}

/**
 * Derive one element's snapshot record. Shared by the full snapshot walk
 * (via addElement) and the resolve_index probe, so a resolved element is
 * byte-identical to its snapshot entry: same selector, same rounding, same
 * flags. Returns null for invisible elements (zero-area, display:none,
 * visibility:hidden) and hidden inputs.
 * @param el - the element to record.
 * @param counts - attribute counts for `doc` (see {@link selectorCountsOf}).
 * @param offsetX - accumulated iframe offset on x for `el`'s document.
 * @param offsetY - accumulated iframe offset on y for `el`'s document.
 * @param inShadow - whether `el` was reached through a shadow boundary.
 * @param inIframe - whether `el` was reached through an iframe boundary.
 * @param piercePrefix - the ` >>> `-joined selector chain above `el` ('' at the top document).
 * @returns the snapshot record, or null when the element is not visible.
 */
export function elementInfoOf(
  el: SnapshotElementNode,
  counts: SelectorCounts,
  offsetX: number,
  offsetY: number,
  inShadow: boolean,
  inIframe: boolean,
  piercePrefix: string,
): PageElementInfo | null {
  const INTERACTIVE_TAGS: Record<string, number> = { A: 1, BUTTON: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, SUMMARY: 1 }
  const INTERACTIVE_ROLES: Record<string, number> = {
    button: 1, link: 1, textbox: 1, checkbox: 1, radio: 1, combobox: 1, listbox: 1,
    menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, option: 1, tab: 1, switch: 1,
    searchbox: 1, slider: 1, spinbutton: 1,
  }
  const IMPLICIT_ROLES: Record<string, string> = { a: 'link', button: 'button', textarea: 'textbox', select: 'combobox', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', img: 'img', label: 'label', option: 'option' }
  function roleOf(node: SnapshotElementNode): string {
    const explicit = node.getAttribute('role')
    if (explicit) return explicit
    const tag = node.tagName.toLowerCase()
    if (tag === 'input') {
      const t = (node.getAttribute('type') || 'text').toLowerCase()
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button'
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      return 'textbox'
    }
    return IMPLICIT_ROLES[tag] || ''
  }
  function isInteractive(node: SnapshotElementNode): boolean {
    if (INTERACTIVE_TAGS[node.tagName]) return true
    if (node.hasAttribute('onclick')) return true
    if (node.hasAttribute('contenteditable')) {
      const ce = (node.getAttribute('contenteditable') || '').toLowerCase()
      if (ce === '' || ce === 'true') return true
    }
    const role = (node.getAttribute('role') || '').toLowerCase()
    if (INTERACTIVE_ROLES[role]) return true
    const ti = node.getAttribute('tabindex')
    if (ti !== null && parseInt(ti, 10) >= 0) return true
    return false
  }
  if (el.tagName === 'INPUT' && (el.getAttribute('type') || 'text').toLowerCase() === 'hidden') return null
  if (!elementVisible(el)) return null
  const r = el.getBoundingClientRect()
  const x = r.x + offsetX
  const y = r.y + offsetY
  let text = (el.innerText || (('value' in el) ? String((el as { value?: { toString(): string } }).value ?? '') : '') || el.textContent || '')
    .replace(/\s+/g, ' ').trim().slice(0, 80)
  if (el.tagName === 'IFRAME') {
    const t2 = el.getAttribute('title') || el.getAttribute('aria-label') || ''
    if (t2 !== '') text = t2.replace(/\s+/g, ' ').trim().slice(0, 80)
  }
  const own = makeSelector(el, counts)
  const rd = (n: number): number => Math.round(n * 10) / 10
  const role = roleOf(el)
  const ariaLabel = el.getAttribute('aria-label')
  const placeholder = el.getAttribute('placeholder')
  const href = el.tagName === 'A' ? el.href : undefined
  return {
    index: 0,
    tag: el.tagName.toLowerCase(),
    selector: piercePrefix !== '' ? piercePrefix + ' >>> ' + own : own,
    text,
    ...(role !== '' ? { role } : {}),
    ...(ariaLabel !== null && ariaLabel !== '' ? { ariaLabel } : {}),
    ...(placeholder !== null && placeholder !== '' ? { placeholder } : {}),
    ...(href !== undefined && href !== '' ? { href } : {}),
    rect: { x: rd(x), y: rd(y), width: rd(r.width), height: rd(r.height) },
    center: { x: rd(x + r.width / 2), y: rd(y + r.height / 2) },
    interactive: isInteractive(el),
    ...(inShadow ? { inShadowDom: true } : {}),
    ...(inIframe ? { inIframe: true } : {}),
  }
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
 * value; the extension's own probe IIFEs return plain values, and the
 * in-page waits (pollUntilExpression) resolve their promise inside the page,
 * so one evaluate replaces a multi-round CDP polling loop on the SW side.
 * Page exceptions become Chinese errors with stack context.
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

/**
 * Build one in-page awaitPromise poll: `checkSource` (an expression yielding
 * a function) is called every `intervalMs` until it returns a non-null value
 * (resolved) or `timeoutMs` elapses (resolves null). One Runtime.evaluate
 * replaces the SW-side sleep + CDP re-poll loops.
 * @param checkSource - an expression evaluating to a `() => value | null` closure (value = done).
 * @param intervalMs - the in-page poll cadence.
 * @param timeoutMs - the in-page budget; expiry resolves null.
 * @returns an expression whose evaluation resolves the check outcome (or null).
 */
export function pollUntilExpression(checkSource: string, intervalMs: number, timeoutMs: number): string {
  return `(function (check, intervalMs, timeoutMs) {
  return new Promise(function (resolve) {
    var t0 = Date.now();
    var iv = setInterval(function () {
      var outcome = check();
      if (outcome !== null && outcome !== undefined) { clearInterval(iv); resolve(outcome); return; }
      if (Date.now() - t0 >= timeoutMs) { clearInterval(iv); resolve(null); return; }
    }, intervalMs);
  });
})(${checkSource}, ${intervalMs}, ${timeoutMs})`
}

// ───────────────────────── snapshot injection script ─────────────────────────

/**
 * Collect visible interactive elements and return a PageSnapshot-shaped
 * object. See the module comment for the piercing rules. Collected facts:
 * - element set: a/button/input/textarea/select/[role]/[onclick]/
 *   [contenteditable]/h1-h6/label/img[alt]/[tabindex]/iframe, plus text
 *   leaves (childless non-interactive elements with visible text — status
 *   feedback the model would otherwise only see via page_evaluate)
 * - visibility: elementVisible (area + computed style)
 * - selector priority: #id (unique) → [aria-label] (unique) →
 *   tag[name] (unique) → [placeholder] (unique) → tag:nth-of-type(n) chain
 *   (≤3 levels up); uniqueness comes from ONE attribute-count pass per
 *   document (selectorCountsOf), not per-element whole-document scans
 * - cap 40 elements (the model-facing page_snapshot render cap — the SW no
 *   longer collects 60 to show 40), interactive first, DOM order preserved
 *   per bucket, indexes reassigned after the merge
 */
export const SNAPSHOT_EXPRESSION = `(() => {
  var MAX_ELEMENTS = 40;
  var HARD_CAP = 240;
  var MAX_DEPTH = 4;
  var LEAF_SKIP = ${JSON.stringify(TEXT_LEAF_SKIP_TAGS)};
  var LEAF_LISTED = ${JSON.stringify(TEXT_LEAF_LISTED_TAGS)};
  var textLeafOk = ${textLeafOk.toString()};
  var elementVisible = ${elementVisible.toString()};
  var selectorCountsOf = ${selectorCountsOf.toString()};
  var makeSelector = ${makeSelector.toString()};
  var elementInfoOf = ${elementInfoOf.toString()};
  var countsCache = new Map();
  function countsOf(doc) {
    var c = countsCache.get(doc);
    if (!c) { c = selectorCountsOf(doc); countsCache.set(doc, c); }
    return c;
  }
  var interactive = [], passive = [];
  function total() { return interactive.length + passive.length; }
  function addElement(el, doc, offsetX, offsetY, inShadow, inIframe, piercePrefix) {
    if (total() >= HARD_CAP) return;
    var info = elementInfoOf(el, countsOf(doc), offsetX, offsetY, inShadow, inIframe, piercePrefix);
    if (info === null) return;
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
          collect(cd, cd, offsetX + ir.x, offsetY + ir.y, depth + 1, inShadow, true, piercePrefix ? piercePrefix + ' >>> ' + makeSelector(el, countsOf(doc)) : makeSelector(el, countsOf(doc)));
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
          collect(h.shadowRoot, doc, offsetX, offsetY, depth + 1, true, inIframe, piercePrefix ? piercePrefix + ' >>> ' + makeSelector(h, countsOf(doc)) : makeSelector(h, countsOf(doc)));
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

// ───────────────────── per-tab snapshot cache (index addressing) ─────────────────────

/**
 * The last captured snapshot per tab. Keyed by `tabId` only — the
 * SW-boundary CdpRequest wire (channel/op/tabId/params) carries no agent or
 * session identity, so there is nothing else to key on; if a session
 * dimension ever becomes explicitly reachable it can be added to the key.
 */
interface SnapshotCacheEntry {
  /** Origin of the captured URL (diagnostic context for the entry). */
  origin: string
  /** In-page generation token prep wrote to `data-dsh-prep` (prep skip check). */
  docToken: string
  /** Snapshot elements by their model-facing index. */
  byIndex: Map<number, PageElementInfo>
}

const snapshotCache = new Map<number, SnapshotCacheEntry>()

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function newDocToken(): string {
  return `dsh-prep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function storeSnapshotCache(snapshot: PageSnapshot): void {
  const prev = snapshotCache.get(snapshot.tabId)
  const byIndex = new Map<number, PageElementInfo>()
  for (const element of snapshot.elements) byIndex.set(element.index, element)
  snapshotCache.set(snapshot.tabId, {
    origin: originOf(snapshot.url),
    docToken: prev?.docToken ?? '',
    byIndex,
  })
}

/**
 * 放行规则 for index drift validation: whitespace-normalized equality, or
 * one side containing the other (the 80-char text cap and PII placeholders
 * both shorten what the model saw relative to the live text).
 * @param cached - the (masked) text the snapshot rendered to the model.
 * @param live - the freshly derived text from the page.
 * @returns whether the live text still plausibly is the cached element's text.
 */
export function snapshotTextMatches(cached: string, live: string): boolean {
  const a = cached.replace(/\s+/g, ' ').trim()
  const b = live.replace(/\s+/g, ' ').trim()
  if (a === '') return true
  return a === b || a.includes(b) || b.includes(a)
}

/**
 * Resolve one cached snapshot element on-page for an index-addressed click:
 * deepQuery re-finds the element by its (pierce) selector, elementInfoOf
 * re-derives the same record the snapshot produced, and tag/text drift is
 * validated before the caller clicks. Throws 快照已过期 when the tab has no
 * cached index or the live element is gone/invisible/drifted — the model is
 * told to re-snapshot instead of silently clicking a neighboring element.
 * @param tabId - the tab whose cached snapshot addresses the element.
 * @param index - the model-facing index the last snapshot rendered.
 * @returns the freshly derived element record under the cached index.
 */
export async function resolveSnapshotElement(tabId: number, index: number): Promise<PageElementInfo> {
  const cached = snapshotCache.get(tabId)?.byIndex.get(index)
  if (cached === undefined) {
    throw new Error(`快照已过期，请重新 page_snapshot：标签页 ${tabId} 的快照缓存中没有 index ${index}`)
  }
  const raw = await evaluateInPage<unknown>(tabId, buildResolveExpression(cached))
  const live = normalizeElements([raw])[0]
  if (live === undefined) {
    throw new Error(`快照已过期，请重新 page_snapshot：index ${index} 的元素（<${cached.tag}>）已不可见或已移除`)
  }
  const masked = (await privacyMaskEnabled()) ? maskElementTextFields(live) : live
  if (masked.tag !== cached.tag || !snapshotTextMatches(cached.text, masked.text)) {
    throw new Error(
      `快照已过期，请重新 page_snapshot：index ${index} 的元素已变化（快照 <${cached.tag}> "${cached.text}"，页面 <${masked.tag}> "${masked.text}"）`,
    )
  }
  return { ...masked, index: cached.index }
}

/**
 * Re-resolve one cached element on-page: deepQuery by the (pierce) selector,
 * then the SAME elementInfoOf derivation the snapshot walk used, so the
 * resolved record is byte-identical to the snapshot entry (selector prefix,
 * flags, offsets, rounding). Exported for the pierce/parity spec.
 * @param cached - the snapshot record being re-resolved.
 * @returns an expression whose evaluation yields the fresh record (or null).
 */
export function buildResolveExpression(cached: PageElementInfo): string {
  const cut = cached.selector.lastIndexOf(PIERCE_SEPARATOR)
  const piercePrefix = cut === -1 ? '' : cached.selector.slice(0, cut)
  return `(() => {
  var deepQuery = ${deepQuery.toString()};
  var elementVisible = ${elementVisible.toString()};
  var topViewportOffset = ${topViewportOffset.toString()};
  var selectorCountsOf = ${selectorCountsOf.toString()};
  var makeSelector = ${makeSelector.toString()};
  var elementInfoOf = ${elementInfoOf.toString()};
  var el = deepQuery(document, ${JSON.stringify(cached.selector)}, ${JSON.stringify(INVALID_SELECTOR)});
  if (el === ${JSON.stringify(INVALID_SELECTOR)} || el === null || el === undefined) return null;
  if (!elementVisible(el)) return null;
  var off = topViewportOffset(el);
  var doc = el.ownerDocument || document;
  var info = elementInfoOf(el, selectorCountsOf(doc), off.x, off.y, ${cached.inShadowDom === true}, ${cached.inIframe === true}, ${JSON.stringify(piercePrefix)});
  if (info === null) return null;
  info.index = ${cached.index};
  return info;
})()`
}

/**
 * Capture the page snapshot: url/title/viewport/timestamp + visible
 * interactive elements (≤40 — the model-facing render cap), shadow DOM and
 * same-origin iframe piercing applied, gated pre-steps run first (their
 * actions surface as `prepActions`). Coordinates are viewport CSS pixels,
 * directly usable by Input.dispatchMouseEvent.
 */
export async function captureSnapshot(tabId: number): Promise<PageSnapshot> {
  const prepActions = await prepareSnapshot(tabId)
  const raw = await evaluateInPage<unknown>(tabId, SNAPSHOT_EXPRESSION)
  if (raw === null || typeof raw !== 'object') {
    throw new Error('快照提取失败：页面返回了非对象数据')
  }
  const o = raw as Record<string, unknown>
  const vp = (o['viewport'] ?? {}) as Record<string, unknown>
  const snapshot: PageSnapshot = {
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
  const processed = await postProcess(snapshot)
  const final = prepActions.length > 0 ? { ...processed, prepActions } : processed
  storeSnapshotCache(final)
  return final
}

// ───────────────────── 快照预处理（内置能力：横幅清理/懒加载/动画冻结） ─────────────────────

/** Attribute the prep step marks the document generation token with. */
const PREP_TOKEN_ATTR = 'data-dsh-prep'

export interface SnapshotPrepFlags {
  freeze: boolean
  banner: boolean
  lazy: boolean
  /** Token to compare the in-page marker against (null = always run). */
  checkToken: string | null
  /** Token to write after the steps run. */
  setToken: string
}

/**
 * The combined snapshot pre-step script. One evaluate replaces the previous
 * three (freeze / banner sweep / lazy sweep), and the document-generation
 * token makes a repeated snapshot on an unchanged document skip the whole
 * sweep (the previous code re-ran everything on every snapshot). Each gated
 * step is individually try-caught — a prep nicety must never fail the
 * snapshot. The lazy sweep restores the PRE-sweep scroll position instead of
 * forcing the page back to the top.
 * @param flags - the gated steps to run plus the token check/set pair.
 * @returns an expression whose evaluation yields { cached, actions }.
 */
export function buildPrepExpression(flags: SnapshotPrepFlags): string {
  return `(function (flags) {
  var root = document.documentElement;
  if (flags.checkToken !== null && root.getAttribute('${PREP_TOKEN_ATTR}') === flags.checkToken) {
    return { cached: true, actions: [] };
  }
  var actions = [];
  ${flags.freeze ? `(function () {
    try {
      var s = document.getElementById('__dsh_freeze');
      if (!s) {
        s = document.createElement('style');
        s.id = '__dsh_freeze';
        s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
        document.documentElement.appendChild(s);
      }
    } catch (e) {}
  })()` : ''}
  ${flags.banner ? `(function () {
    try {
      var matchesBannerText = ${matchesBannerText.toString()};
      var nodes = document.querySelectorAll('button, [role=button], a');
      for (var i = 0; i < nodes.length && actions.length < 3; i++) {
        var t = ((nodes[i].textContent || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 24);
        if (!t) continue;
        var r = nodes[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && matchesBannerText(t) !== null) {
          nodes[i].click();
          actions.push(t);
        }
      }
    } catch (e2) {}
  })()` : ''}
  var sweep = ${flags.lazy ? `new Promise(function (resolve) {
    var startY = window.scrollY || window.pageYOffset || 0;
    var step = Math.max(300, window.innerHeight * 0.9), y = startY, hops = 0;
    var t = setInterval(function () {
      y += step; hops += 1;
      window.scrollTo(0, y);
      if (y >= document.body.scrollHeight || hops >= 20) {
        window.scrollTo(0, startY); clearInterval(t); resolve('swept');
      }
    }, 120);
  })` : 'null'};
  root.setAttribute('${PREP_TOKEN_ATTR}', flags.setToken);
  if (sweep === null) return { cached: false, actions: actions };
  return sweep.then(function () { return { cached: false, actions: actions }; });
})(${JSON.stringify(flags)})`
}

/**
 * Run the gated snapshot pre-steps in a fixed order (冻结动画, 清理横幅,
 * 触发懒加载) inside ONE evaluate, skipping the whole sweep when the page's
 * prep marker still carries this tab's token (same document, already
 * prepped). Returns the banner texts the sweep actually clicked so they can
 * be recorded — the previous sweep clicked without recording.
 */
async function prepareSnapshot(tabId: number): Promise<string[]> {
  const [freeze, banner, lazy] = await Promise.all([animFreezeEnabled(), bannerCleanEnabled(), lazyLoadEnabled()])
  if (!freeze && !banner && !lazy) return []
  const prev = snapshotCache.get(tabId)
  const setToken = newDocToken()
  let result: unknown
  try {
    result = await evaluateInPage<unknown>(tabId, buildPrepExpression({
      freeze,
      banner,
      lazy,
      checkToken: prev?.docToken || null,
      setToken,
    }))
  } catch {
    // Page mid-navigation: proceed with the snapshot as-is.
    return []
  }
  if (result === null || typeof result !== 'object') return []
  const o = result as Record<string, unknown>
  const actions = Array.isArray(o['actions'])
    ? (o['actions'] as unknown[]).filter((item): item is string => typeof item === 'string')
    : []
  const cached = o['cached'] === true
  // cached 分支的页内提前返回发生在 setAttribute 之前——页面标记仍是 checkToken
  // （= prev.docToken），此时必须保留旧 token；无条件采纳 setToken 会让下一次
  // checkToken 与页面标记必然失配，清扫降级为隔次全量重跑。
  snapshotCache.set(tabId, {
    origin: prev?.origin ?? '',
    docToken: cached ? (prev?.docToken ?? setToken) : setToken,
    byIndex: prev?.byIndex ?? new Map<number, PageElementInfo>(),
  })
  return cached ? [] : actions
}

/**
 * Drop one tab's snapshot index cache: the document is being replaced by an
 * explicit navigation, so cached index→selector entries would re-find unknown
 * elements on the new page. Called by the navigate/back/forward ops.
 */
export function invalidateSnapshotCache(tabId: number): void {
  snapshotCache.delete(tabId)
}

// ───────────────────── 横幅清扫词表（锚定匹配） ─────────────────────

/**
 * Whether one button's text matches a consent/overlay banner word under
 * anchored matching: the occurrence must start at a word boundary (position 0
 * or after a non-word character — so 「不同意」 does not anchor 「同意」),
 * must not sit behind a negation (中文否定字 or English not/*n't), and may run
 * into a continuation (「同意并继续」 still matches). Longest-first word order
 * makes the match deterministic.
 *
 * Fully self-contained (word table and helpers inlined): the function source
 * is serialized into the prep script, so it must not close over module scope.
 * @param raw - the button's visible text.
 * @returns the matched word, or null when nothing anchors.
 */
export function matchesBannerText(raw: string): string | null {
  const WORDS = [
    '接受全部', '全部接受', '我知道了', '知道了', '同意', '接受', '关闭',
    'accept all', 'i agree', 'got it', 'accept', 'close',
  ]
  function isWordChar(ch: string): boolean {
    return /[a-z0-9\u4e00-\u9fff]/.test(ch)
  }
  function negated(text: string, at: number): boolean {
    // 中文否定字紧邻（不/未/勿/别/莫/非，允许空白），或英文 not / *n't 紧邻。
    const head = text.slice(0, at)
    if (/[不未勿别莫非]\s*$/.test(head)) return true
    if (/(^|[^a-z0-9])not\s*$/.test(head)) return true
    if (/n't\s*$/.test(head)) return true
    return false
  }
  const text = raw.replace(/\s+/g, ' ').trim().toLowerCase()
  if (text === '') return null
  for (const word of WORDS) {
    let at = text.indexOf(word)
    while (at >= 0) {
      const startAnchored = at === 0 || !isWordChar(text.charAt(at - 1))
      if (startAnchored && !negated(text, at)) return word
      at = text.indexOf(word, at + 1)
    }
  }
  return null
}

// ───────────────────── 快照精简（内置能力 snap-lean，默认关） ─────────────────────

/** Passive-text cap under 快照精简: longer prose drops, short labels stay. */
const LEAN_TEXT_CAP = 40

/**
 * Drop long passive text elements from the snapshot (the 快照精简 token saver):
 * interactive controls, headings, and short labels stay — the agent keeps its
 * action surface and orients by headings, while content-heavy prose stops
 * burning context. Exported pure for the capability spec.
 */
export function leanElements(elements: readonly PageElementInfo[]): PageElementInfo[] {
  return elements.filter(element =>
    element.interactive
    || /^h[1-6]$/i.test(element.tag)
    || (element.text ?? '').length <= LEAN_TEXT_CAP)
}

/** Apply the snap-lean capability after masking (mask first — masked text is what gets length-judged). */
async function postProcess(snapshot: PageSnapshot): Promise<PageSnapshot> {
  const masked = await maskSensitiveSnapshot(snapshot)
  if (!(await snapLeanEnabled())) return masked
  return { ...masked, elements: leanElements(masked.elements) }
}

// ───────────────────── 快照脱敏（内置能力 privacy-mask，默认开） ─────────────────────

/**
 * PII runs masked in snapshot TEXT fields before the page reaches the model,
 * longest first so an 18-digit 身份证 is not eaten by the card or phone rule.
 * Indices and selectors stay untouched — clicking and addressing keep
 * working; only readable values turn into placeholders. Screenshots are not
 * covered (that capability is separate and opt-in).
 */
const MASK_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // 身份证 first, pinned to its date structure + digit boundaries so a long
  // card number is not chewed by it; the card rule then takes 16–19 runs.
  [/(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])\d{3}[\dXx](?!\d)/g, '[身份证号]'],
  [/(?<!\d)\d{16,19}(?!\d)/g, '[卡号]'],
  [/1[3-9]\d{9}/g, '[手机号]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[邮箱]'],
]

/**
 * Replace PII runs in one text value with bracketed placeholders. Exported
 * for the masking spec; the capture path goes through
 * {@link maskSensitiveSnapshot}.
 */
export function maskSensitiveText(text: string): string {
  let out = text
  for (const [pattern, replacement] of MASK_RULES) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/**
 * Mask the PII carriers of one element record (text, aria label, placeholder);
 * hrefs and selectors stay verbatim (URLs rarely carry the masked classes,
 * and addressing must not drift). Shared by the capture path and the
 * resolve_index path so both hand the model the same masked text.
 */
function maskElementTextFields(element: PageElementInfo): PageElementInfo {
  return {
    ...element,
    ...(element.text === '' ? {} : { text: maskSensitiveText(element.text) }),
    ...(element.ariaLabel === undefined ? {} : { ariaLabel: maskSensitiveText(element.ariaLabel) }),
    ...(element.placeholder === undefined ? {} : { placeholder: maskSensitiveText(element.placeholder) }),
  }
}

/**
 * Apply the privacy-mask capability to one snapshot.
 * A gated-off read leaves the snapshot verbatim.
 */
async function maskSensitiveSnapshot(snapshot: PageSnapshot): Promise<PageSnapshot> {
  if (!(await privacyMaskEnabled())) return snapshot
  return {
    ...snapshot,
    elements: snapshot.elements.map(maskElementTextFields),
  }
}

// ───────────────────────── element geometry / visibility ─────────────────────────

export interface ElementProbe {
  rect: { x: number; y: number; width: number; height: number }
  center: { x: number; y: number }
  /** Whether a click at `center` would land on the target (clickHitOk). */
  hitOk: boolean
  /** Chinese reason when `hitOk` is false (视口外 / 被遮挡 / 没有命中元素). */
  hitReason: string
}

/**
 * Element probe IIFE: resolves the (pierce) selector, checks visibility, and
 * validates the click hit at the element center. Returns null (absent or
 * invisible), `{ invalid: true }` (bad selector syntax), or the probe record.
 * Exported for the click-hit spec (the serialization wiring assertions).
 * @param selector - the CSS or pierce selector addressing the target.
 * @returns an expression whose evaluation yields the probe record.
 */
export function clickProbeExpression(selector: string): string {
  const selJson = JSON.stringify(selector)
  return `(() => {
  var deepQuery = ${deepQuery.toString()};
  var elementVisible = ${elementVisible.toString()};
  var topViewportOffset = ${topViewportOffset.toString()};
  var clickHitOk = ${clickHitOk.toString()};
  var el = deepQuery(document, ${selJson}, ${JSON.stringify(INVALID_SELECTOR)});
  if (el === ${JSON.stringify(INVALID_SELECTOR)}) return { invalid: true };
  if (el === null || el === undefined || !elementVisible(el)) return null;
  var r = el.getBoundingClientRect();
  var off = topViewportOffset(el);
  var cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  var own = el.ownerDocument || document;
  var hit = own.elementFromPoint ? own.elementFromPoint(cx, cy) : null;
  var tx = cx + off.x, ty = cy + off.y;
  var view = own.defaultView || window;
  var inView = cx >= 0 && cy >= 0 && cx <= view.innerWidth && cy <= view.innerHeight && tx >= 0 && ty >= 0;
  var ok = clickHitOk(el, hit || null);
  function rd(n) { return Math.round(n * 10) / 10; }
  return {
    rect: { x: rd(r.x + off.x), y: rd(r.y + off.y), width: rd(r.width), height: rd(r.height) },
    center: { x: rd(tx), y: rd(ty) },
    hitOk: ok,
    hitReason: ok ? '' : (inView ? (hit ? '目标点被其他元素遮挡（或目标不接受指针事件）' : '目标点没有命中元素') : '目标点在视口外')
  };
})()`
}

/**
 * Element viewport rect and center, plus the click-hit validation. Returns
 * null when absent or invisible; an invalid selector syntax throws a Chinese
 * error.
 */
export async function getElementRect(
  tabId: number,
  selector: string,
): Promise<ElementProbe | null> {
  const raw = await evaluateInPage<unknown>(
    tabId,
    clickProbeExpression(selector),
  )
  if (raw !== null && typeof raw === 'object' && (raw as Record<string, unknown>)['invalid'] === true) {
    throw new Error(`选择器语法无效：${selector}`)
  }
  if (raw === null || typeof raw !== 'object') return null
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
    hitOk: o['hitOk'] === true,
    hitReason: asString(o['hitReason'], ''),
  }
}

/**
 * Wait for an element to appear and become visible: one in-page awaitPromise
 * poll (deepQuery + elementVisible inside the page) until the deadline —
 * no SW-side CDP re-polling.
 */
export async function waitFor(
  tabId: number,
  selector: string,
  timeoutMs = 5000,
): Promise<void> {
  const budget = Math.max(0, timeoutMs)
  const status = await evaluateInPage<unknown>(
    tabId,
    pollUntilExpression(`(function () {
  var deepQuery = ${deepQuery.toString()};
  var elementVisible = ${elementVisible.toString()};
  return function () {
    var el = deepQuery(document, ${JSON.stringify(selector)}, ${JSON.stringify(INVALID_SELECTOR)});
    if (el === ${JSON.stringify(INVALID_SELECTOR)}) return 'invalid';
    if (el !== null && el !== undefined && elementVisible(el)) return 'found';
    return null;
  };
})()`, 200, budget),
  )
  if (status === 'invalid') {
    throw new Error(`选择器语法无效：${selector}`)
  }
  if (status !== 'found') {
    throw new Error(`等待元素超时（${timeoutMs}ms）：${selector}`)
  }
}
