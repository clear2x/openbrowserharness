/**
 * The in-page probes of `page_batch_actions` — a pure, self-contained
 * function plus fixed expressions serialized into the page (the model never
 * authors them). Kept in its own module so the minified-expression
 * regression lock can bundle and inspect it, and so the logic is
 * unit-testable against a jsdom document directly.
 *
 * Three probes back the batch lane's actionability rules:
 * - target readiness: the element exists, has a rendered box, and is
 *   scrolled into view before a click / type acts on it;
 * - a navigation mark armed on `window` before each mutating step: a
 *   document that no longer carries the mark after the step is a NEW
 *   document (the step navigated), which is the only reliable signal —
 *   `document.readyState` still reports `complete` for the OLD document
 *   until the navigation commits;
 * - the document state read during the post-mutation settle.
 *
 * @module page-batch-page
 */
import { INVALID_SELECTOR, deepQuery } from '../shared/deep-query.ts'

/** The `window` property carrying the per-document navigation mark. */
export const BATCH_NAV_MARKER = '__dshBatchNavMark'

/** What the target-readiness probe found. */
export type TargetState = 'found' | 'missing' | 'invalid'

/** The resolver's call shape (the shared deep pierce resolver, injected as an argument). */
type DeepQueryFn = typeof deepQuery

/**
 * Resolve the target and require a rendered box; optionally bring it into
 * the viewport. Self-contained on purpose: the serialized source runs in the
 * page world, so it references only its parameters and page globals.
 * @param selector - the CSS or pierce (` >>> `) selector addressing the target.
 * @param invalidSentinel - the resolver's invalid-selector sentinel.
 * @param resolver - the deep pierce resolver.
 * @param scrollIntoView - whether a found target is scrolled to the viewport
 *   center (click / type targets: yes; a `wait` step only observes: no).
 * @returns `invalid` (bad selector syntax), `missing` (absent or without a
 *   rendered box), or `found`.
 */
export function prepareTargetInPage(
  selector: string,
  invalidSentinel: string,
  resolver: DeepQueryFn,
  scrollIntoView: boolean,
): TargetState {
  const el = resolver(document, selector, invalidSentinel)
  if (el === invalidSentinel) return 'invalid'
  if (el === null || el === undefined || typeof el === 'string') return 'missing'
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return 'missing'
  if (scrollIntoView) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    } catch {
      // Environments without scrollIntoView options still leave the element
      // addressable; the click's own hit test reports an off-viewport target.
    }
  }
  return 'found'
}

/**
 * The fixed expression running {@link prepareTargetInPage} against the page
 * document; the resolver travels as an immediately-passed argument, so no
 * name binding exists for the production minifier to break.
 * @param selector - the CSS or pierce selector addressing the target.
 * @param scrollIntoView - whether a found target is scrolled into view.
 * @returns the expression.
 */
export const targetProbeExpression = (selector: string, scrollIntoView: boolean): string =>
  `(${prepareTargetInPage.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(INVALID_SELECTOR)}, ${deepQuery.toString()}, ${scrollIntoView ? 'true' : 'false'})`

/**
 * Arm the navigation mark on the current document: bump the counter so the
 * settle can tell "same document" from "a navigation committed".
 * @param marker - the `window` property name.
 * @returns the fixed expression; its value is the armed count.
 */
export const armNavigationMarkExpression = (marker: string): string =>
  `(() => { var w = window; var k = ${JSON.stringify(marker)}; var n = (w[k] || 0) + 1; w[k] = n; return String(n); })()`

/**
 * Read the document state as one string: `<readyState>|same` while the
 * marked document is still current, `<readyState>|new` once a navigation
 * committed (the new document carries no mark).
 * @param marker - the `window` property name.
 * @returns the fixed expression.
 */
export const documentStateExpression = (marker: string): string =>
  `document.readyState + '|' + (window[${JSON.stringify(marker)}] === undefined ? 'new' : 'same')`

/** One parsed document-state read. */
export interface DocumentState {
  readyState: string
  /** `same` = the marked document is still current; `new` = a navigation committed. */
  document: 'same' | 'new'
}

/**
 * Parse one document-state read. A value outside the expected
 * `<readyState>|same|new` shape (a page that intercepted the read, an
 * unusual serialization) parses as `undefined`, so the settle falls back
 * to its quiet-window rule instead of trusting a malformed signal.
 * @param raw - the evaluated value.
 * @returns the parsed state, or undefined when malformed.
 */
export function parseDocumentState(raw: unknown): DocumentState | undefined {
  if (typeof raw !== 'string') return undefined
  const separator = raw.lastIndexOf('|')
  if (separator === -1) return undefined
  const document = raw.slice(separator + 1)
  if (document !== 'same' && document !== 'new') return undefined
  return { readyState: raw.slice(0, separator), document }
}
