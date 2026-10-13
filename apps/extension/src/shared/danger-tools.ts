/**
 * The gated tool classes of the extension engine's permission gate, shared so
 * the word list has exactly one home (capability panels and future gates
 * import from here instead of copying it).
 *
 * CHANGE tools add, modify, or delete content — typed text, keypresses,
 * scripts, navigation (typed URLs replace the page), tab open/close, and the
 * OPFS write/edit pair (the base fs suite is all this composition mounts).
 * BROWSE tools touch the page without changing its content — clicking and
 * scrolling — and additionally ask under `ask-always`. Read-only tools
 * (snapshot/extract/read/wait, tab listing and switching) never consult the
 * gate.
 */

/** Tools that change page, tab, or file content (asked under ask-change). */
export const CHANGE_TOOLS: ReadonlySet<string> = new Set([
  'write', 'edit',
  'page_type', 'page_press_key', 'page_navigate', 'page_evaluate',
  'tabs_open', 'tabs_close',
])

/** Tools that touch the page without changing its content (asked under ask-always). */
export const BROWSE_TOOLS: ReadonlySet<string> = new Set(['page_click', 'page_scroll'])

/** Every tool the permission-mode matrix gates. */
export const GATED_TOOLS: ReadonlySet<string> = new Set([...CHANGE_TOOLS, ...BROWSE_TOOLS])
