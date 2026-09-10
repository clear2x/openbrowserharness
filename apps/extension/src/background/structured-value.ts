/**
 * Structured date/time input fallback for page_type (批22): per-character CDP
 * keystrokes never land in `<input type=date|time|…>` segmented UIs, so the
 * DOM value stays empty after typing. This module owns the in-page fallback —
 * kept as a closure-free function plus its serializer so the SAME code runs
 * twice: directly against a DOM (unit tests) and as evaluateInPage source
 * (the extension's real execution path). No imports: the function must stay
 * closure-free to serialize.
 */

/**
 * The in-page fallback body. For an `<input>` of a structured date/time type
 * whose value did not take the typed text, assign through the native value
 * setter (React/Vue controlled components only re-render through it) and
 * dispatch input/change. Returns one of: `not-found` | `skip` (not such an
 * input, or value already correct) | `ok:<value>` — an empty `<value>` means
 * the browser rejected the text (invalid format for the type).
 */
export function applyStructuredValueInPage(selector: string, text: string): string {
  const el = document.querySelector(selector)
  if (!el) return 'not-found'
  if (!(el instanceof HTMLInputElement)) return 'skip'
  const type = (el.getAttribute('type') || '').toLowerCase()
  const structured = ['date', 'time', 'datetime-local', 'month', 'week']
  if (structured.indexOf(type) < 0) return 'skip'
  if (el.value === text) return 'ok:' + el.value
  if (typeof el.focus === 'function') {
    try {
      el.focus()
    } catch {
      // Detached/documentless nodes can refuse focus; the assignment below still works.
    }
  }
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  if (desc && desc.set) {
    desc.set.call(el, text)
  } else {
    el.value = text
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok:' + el.value
}

/**
 * Serialize {@link applyStructuredValueInPage} into an evaluateInPage script:
 * the function's own compiled source, immediately invoked with the
 * JSON-encoded arguments (no values travel inside the source text).
 */
export function structuredValueFallbackScript(selector: string, text: string): string {
  return `(${applyStructuredValueInPage.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(text)})`
}
