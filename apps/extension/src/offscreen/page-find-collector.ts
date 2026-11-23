/**
 * The in-page candidate collector of `page_find_related` — a pure,
 * self-contained function serialized into ONE fixed page expression (the
 * model never authors it). Kept in its own dependency-free module so the
 * minified-expression regression lock can bundle and inspect it, and so the
 * collector logic is unit-testable against a jsdom document directly.
 *
 * Every collected element is tagged with the marker attribute carrying its
 * collection ordinal, and the returned `selector` is that marker: unique by
 * construction and independent of the page's own id / aria-label / name
 * attributes (most real-page controls have none of those). Markers from an
 * earlier collection are cleared first, so a stale selector never silently
 * addresses an element the latest collection dropped.
 *
 * @module page-find-collector
 */

/** The marker attribute the collector tags collected elements with. */
export const FIND_MARKER_ATTRIBUTE = 'data-dsh-find'

/** Maximum elements one collection tags and returns. */
export const FIND_COLLECT_CAP = 120

/** One interactive element collected in-page (plain JSON over the CDP wire). */
export interface CollectedElement {
  tag: string
  role?: string
  text: string
  ariaLabel?: string
  placeholder?: string
  /** The unique marker selector; usable by every selector-addressed tool. */
  selector: string
}

/** The geometry and visibility probes the collector needs (the page supplies the DOM defaults). */
export interface FindCollectorEnvironment {
  /** The element's viewport box size. */
  rectOf(element: Element): { width: number; height: number }
  /** Whether the element is rendered (not `visibility:hidden` / `display:none`). */
  isVisible(element: Element): boolean
}

/** The page-world environment: viewport geometry and computed-style visibility. */
const PAGE_ENVIRONMENT_SOURCE = `({
  rectOf: function (element) { return element.getBoundingClientRect(); },
  isVisible: function (element) {
    var style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }
})`

/**
 * CSS selector addressing the n-th collected element of the latest
 * collection (stable until the next `page_find_related` call or a
 * navigation).
 * @param ordinal - the 1-based collection ordinal.
 * @returns the attribute selector.
 */
export function markerSelector(ordinal: number): string {
  return `[${FIND_MARKER_ATTRIBUTE}="${String(ordinal)}"]`
}

/**
 * Collect the page's interactive elements, tag each with its marker, and
 * return the records in DOM order. Self-contained on purpose: the function
 * body references only its parameters, its own inner declarations, and
 * callers-passed probes — never a module-scope name — because the
 * serialized source runs in the page world where no module scope exists.
 * @param doc - the document to walk.
 * @param env - the geometry/visibility probes.
 * @param markerAttribute - the marker attribute name.
 * @param cap - the maximum number of elements to return.
 * @returns the collected elements with their marker selectors.
 */
export function collectFindCandidates(
  doc: Document,
  env: FindCollectorEnvironment,
  markerAttribute: string,
  cap: number,
): CollectedElement[] {
  const ROLES: Record<string, string> = { a: 'link', button: 'button', input: 'textbox', textarea: 'textbox', select: 'combobox', summary: 'summary' }
  function textOf(element: Element): string {
    const tag = element.tagName
    const label = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' ? '' : element.textContent || ''
    return label.replace(/\s+/g, ' ').trim().slice(0, 120)
  }
  const out: CollectedElement[] = []
  for (const stale of doc.querySelectorAll(`[${markerAttribute}]`)) stale.removeAttribute(markerAttribute)
  const nodes = doc.querySelectorAll(
    'a, button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=searchbox], [contenteditable], [tabindex]',
  )
  for (const element of nodes) {
    if (out.length >= cap) break
    const rect = env.rectOf(element)
    if (rect.width <= 0 || rect.height <= 0) continue
    if (!env.isVisible(element)) continue
    const tag = element.tagName
    const text = textOf(element)
    const aria = element.getAttribute('aria-label') || ''
    const placeholder = element.getAttribute('placeholder') || ''
    if (!text && !aria && !placeholder) continue
    const ordinal = out.length + 1
    element.setAttribute(markerAttribute, String(ordinal))
    const record: CollectedElement = { tag: tag.toLowerCase(), text, selector: `[${markerAttribute}="${String(ordinal)}"]` }
    const role = element.getAttribute('role') || ROLES[tag.toLowerCase()] || ''
    if (role !== '') record.role = role
    if (aria !== '') record.ariaLabel = aria
    if (placeholder !== '') record.placeholder = placeholder
    out.push(record)
  }
  return out
}

/**
 * The fixed page expression: the serialized collector invoked immediately
 * with the page document and the page-world environment. No name binding
 * at all, so minification of the host bundle cannot break it.
 */
export const COLLECT_EXPRESSION = `(${collectFindCandidates.toString()})(document, ${PAGE_ENVIRONMENT_SOURCE}, ${JSON.stringify(FIND_MARKER_ATTRIBUTE)}, ${String(FIND_COLLECT_CAP)})`

/**
 * Validate the CDP wire result of {@link COLLECT_EXPRESSION}: the page
 * context is an untrusted boundary, so every record is checked field by
 * field and malformed records are dropped rather than trusted.
 * @param raw - the evaluated value.
 * @returns the well-formed collected elements.
 */
export function parseCollectedElements(raw: unknown): CollectedElement[] {
  if (!Array.isArray(raw)) return []
  const out: CollectedElement[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const tag = record['tag']
    const text = record['text']
    const selector = record['selector']
    if (typeof tag !== 'string' || typeof text !== 'string' || typeof selector !== 'string') continue
    const role = record['role']
    const ariaLabel = record['ariaLabel']
    const placeholder = record['placeholder']
    out.push({
      tag,
      text,
      selector,
      ...(typeof role === 'string' && role !== '' ? { role } : {}),
      ...(typeof ariaLabel === 'string' && ariaLabel !== '' ? { ariaLabel } : {}),
      ...(typeof placeholder === 'string' && placeholder !== '' ? { placeholder } : {}),
    })
  }
  return out
}

/**
 * The element's embedding text: the visible text with the accessible name
 * and placeholder folded in — the three signals a task actually matches.
 * @param element - the collected element record.
 * @returns the text to embed.
 */
export function elementEmbedText(element: CollectedElement): string {
  return [element.text, element.ariaLabel, element.placeholder].filter(part => part !== undefined && part.length > 0).join(' ')
}
