/**
 * In-page input value readback + native writeback (批22 + 切片2): after
 * per-character CDP keystrokes, the typed text can still be missing —
 * structured `<input type=date|time|…>` segmented UIs never receive the
 * keystrokes at all, and plain text fields can lose the value to a
 * controlled re-render or a blur reset. This module owns the in-page
 * verification for every text-entry element (inputs, textareas,
 * contenteditable). It is kept as a closure-free function plus its
 * serializer so the SAME code runs twice: directly against a DOM (unit
 * tests) and as evaluateInPage source (the extension's real execution
 * path). No closure references: the function must stay serializable, so
 * the deep pierce resolver travels as an argument.
 */

/** The deep resolver's call shape (injected as a function argument, see below). */
export type DeepQueryFn = (root: Document | ShadowRoot | Element, selector: string, invalidSentinel: string) => Element | string | null

/**
 * The in-page readback body. Reads the element's current text back and
 * compares it against the typed text; on a mismatch, assigns through the
 * native value setter (React/Vue controlled components only re-render
 * through it) and dispatches input/change, then re-reads.
 *
 * Masked fields (phone/card formatters) re-insert separators into the
 * value, so a separator-insensitive comparison already counts as landed —
 * writing the raw string back would only fight the mask. Structured
 * date/time inputs keep their raw-equality contract: the browser
 * canonicalizes the value, and an empty sanitized value means the format
 * was rejected.
 *
 * Returns one of:
 * - `not-found` — the element does not exist;
 * - `skip` — not a text-entry element (checkbox/button/…, non-editable node);
 * - `ok` — the value holds the typed text (after an optional writeback);
 * - `rejected-empty` — structured input: the browser rejected the format
 *   and sanitized the value to empty;
 * - `mismatch:<expectedLen>:<actualLen>` — still differs after the
 *   writeback; lengths are code-point counts (the host turns them into the
 *   user-facing error — the typed text itself is never echoed back).
 */
export function applyInputValueInPage(
  selector: string,
  text: string,
  deepQuery: DeepQueryFn,
  invalidSentinel: string,
): string {
  const STRUCTURED_TYPES = ['date', 'time', 'datetime-local', 'month', 'week']
  const NON_TEXT_TYPES = ['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden']

  function stripSeparators(v: string): string {
    return v.replace(/[\s.()\-/]/g, '')
  }

  function normalizeWhitespace(v: string): string {
    return v.replace(/\s+/g, ' ').trim()
  }

  /**
   * Real browsers answer through isContentEditable (true for every member
   * of an editing host); the contenteditable attribute is the fallback for
   * DOM stubs that do not implement the property (jsdom).
   */
  function isEditableNode(node: Element): boolean {
    if ((node as HTMLElement).isContentEditable) return true
    const attr = node.getAttribute('contenteditable')
    return attr !== null && attr !== 'false'
  }

  function focusQuietly(node: Element): void {
    const focus = (node as HTMLElement).focus.bind(node)
    if (typeof focus === 'function') {
      try {
        focus.call(node)
      } catch {
        // Detached/documentless nodes can refuse focus; the assignment below still works.
      }
    }
  }

  function dispatchInputEvents(node: Element): void {
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const el = deepQuery(document, selector, invalidSentinel)
  if (!el || typeof el === 'string') return 'not-found'

  let isStructured = false
  let read: () => string
  let write: (v: string) => void
  if (el instanceof HTMLInputElement) {
    const type = (el.getAttribute('type') || 'text').toLowerCase()
    if (NON_TEXT_TYPES.indexOf(type) >= 0) return 'skip'
    isStructured = STRUCTURED_TYPES.indexOf(type) >= 0
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    read = () => el.value
    write = (v: string) => {
      if (desc && desc.set) desc.set.call(el, v)
      else el.value = v
    }
  } else if (el instanceof HTMLTextAreaElement) {
    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
    read = () => el.value
    write = (v: string) => {
      if (desc && desc.set) desc.set.call(el, v)
      else el.value = v
    }
  } else if (isEditableNode(el)) {
    // Browsers materialize rich content (nbsp, wrapped lines): compare on
    // whitespace-normalized textContent, write back plain text.
    read = () => normalizeWhitespace(el.textContent || '')
    write = (v: string) => {
      el.textContent = v
    }
  } else {
    return 'skip'
  }

  const expected = isEditableNode(el) ? normalizeWhitespace(text) : text
  const matches = (current: string): boolean =>
    current === expected || stripSeparators(current) === stripSeparators(expected)

  if (isStructured) {
    // `read` is the input's raw value here (the branch that set isStructured).
    if (read() === text) return 'ok'
    focusQuietly(el)
    write(text)
    dispatchInputEvents(el)
    return read() === '' ? 'rejected-empty' : 'ok'
  }

  const current = read()
  if (matches(current)) return 'ok'
  focusQuietly(el)
  write(text)
  dispatchInputEvents(el)
  return matches(read()) ? 'ok' : `mismatch:${Array.from(text).length}:${Array.from(read()).length}`
}

/**
 * Serialize {@link applyInputValueInPage} into an evaluateInPage script:
 * the function's own compiled source, immediately invoked with the
 * JSON-encoded arguments (no values travel inside the source text) plus the
 * injected deep pierce resolver and its sentinel — pierce selectors reach
 * shadow-DOM / iframe inputs the same way page_click's probe does.
 */
export function inputValueFallbackScript(selector: string, text: string, deepQuery: DeepQueryFn, invalidSentinel: string): string {
  return `(${applyInputValueInPage.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(text)}, ${deepQuery.toString()}, ${JSON.stringify(invalidSentinel)})`
}
