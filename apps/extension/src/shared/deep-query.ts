/**
 * The in-page deep resolver for pierce selectors, shared by every context
 * that injects probe scripts (the SW snapshot/click paths and the Offscreen
 * danger-click gate). Lives outside the Service-Worker-only modules so the
 * Offscreen document can serialize it without importing `background/*`.
 *
 * A ` >>> `-separated selector descends one boundary per segment: a shadow
 * host continues into its shadowRoot, an iframe continues into its
 * contentDocument (same-origin), any other element scopes the next segment to
 * its subtree. A plain selector (no ` >>> `) resolves against the given root
 * exactly like `querySelector`. Closure-free so the compiled source can be
 * injected via `toString()`; the invalid-selector sentinel travels as an
 * argument.
 */

/** Segment separator of a pierce selector. */
export const PIERCE_SEPARATOR = ' >>> '

/** Returned verbatim when a selector segment is invalid CSS. */
export const INVALID_SELECTOR = '__dsh_invalid_selector__'

/**
 * Resolve a plain or pierce selector from `root`.
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
