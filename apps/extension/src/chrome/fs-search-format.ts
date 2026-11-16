/**
 * Pure formatting and presentation helpers for the OPFS `glob`/`grep` suite.
 * Split from `fs-search.ts` so the tool registrations stay small: this module
 * holds no I/O and no cordis state — every function maps already-collected
 * results to the model-facing text and card views, mirroring the desktop
 * `@deepseek-ai/dsh-tool-fs-search` output format.
 * @module chrome-fs-search-format
 */

import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { SpillRef } from '@deepseek-ai/dsh-spill'

/** One flat content match, mirroring the desktop `grep` output rows. */
export interface GrepMatch {
  path: string
  lineNumber: number
  line: string
}

/** Truncate one matched line to the preview cap on a UTF-8 boundary, with an ellipsis marker. */
export function previewLine(line: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(line)
  if (encoded.length <= maxBytes) return line
  let cut = maxBytes
  while (cut > 0) {
    const byte = encoded[cut - 1]
    if (byte === undefined || (byte & 0xc0) !== 0x80) break
    cut -= 1
  }
  return `${new TextDecoder().decode(encoded.slice(0, cut))}…`
}

/** Group matches by file the way the desktop renderer does: `path`, then `Line N: text` rows. */
export function formatGrepMatches(matches: readonly GrepMatch[]): string {
  const byFile = new Map<string, GrepMatch[]>()
  for (const match of matches) {
    const group = byFile.get(match.path)
    if (group === undefined) byFile.set(match.path, [match])
    else group.push(match)
  }
  const sections: string[] = []
  for (const [path, group] of byFile) {
    sections.push(`${path}\n${group.map(m => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`)
  }
  return sections.join('\n\n')
}

/** Format one bounded `glob` page plus the recovery path for the complete sorted result. */
function formatGlobPage(items: readonly string[], seen: number, spillRef: SpillRef | undefined, basis: string): string {
  const body = items.join('\n')
  const recovery = spillRef !== undefined
    ? `Full sorted result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}`
    : 'The complete result could not be saved; narrow pattern or path to see more.'
  return `${body}\n\n(Showing ${items.length} of ${seen} paths${basis} ${recovery})`
}

/** Render one canonical `glob` path list relative to its search root. */
export function renderGlobPaths(paths: readonly string[], maxResults: number): string {
  if (paths.length === 0) return 'No files found'
  if (paths.length <= maxResults) return paths.join('\n')
  return formatGlobPage(paths.slice(0, maxResults), paths.length, undefined, '.')
}

/** Render a capped `grep` result with its found-count header (the desktop format). */
export function renderGrepMatches(matches: readonly GrepMatch[], maxMatches: number, maxLineBytes: number): string {
  if (matches.length === 0) return 'No matches found'
  const retained = matches.slice(0, maxMatches).map(match => ({ ...match, line: previewLine(match.line, maxLineBytes) }))
  const truncated = matches.length > maxMatches
  const header = truncated ? `Found ${retained.length} of ${matches.length} matches` : `Found ${matches.length} matches`
  const body = formatGrepMatches(retained)
  if (!truncated) return `${header}\n\n${body}`
  return `${header}\n\n${body}\n\n(The complete result could not be saved; narrow pattern, path, or include to see more.)`
}

/** Pending-call card for `glob`: a search view titled by the pattern and root (the desktop wording). */
export function presentGlobCall(args: { pattern: string; path?: string }): GenericCallView {
  const where = args.path !== undefined ? ` in ${args.path}` : ''
  return { card: 'generic', title: `Glob ${args.pattern}${where}`, kind: 'search', rawInput: args.pattern }
}

/** Pending-call card for `grep`: a search view titled by the pattern, target, and include filter. */
export function presentGrepCall(args: { pattern: string; path?: string; include?: string }): GenericCallView {
  const where = args.path !== undefined ? ` in ${args.path}` : ''
  const filter = args.include !== undefined && args.include !== '' ? ` (${args.include})` : ''
  return { card: 'generic', title: `Grep ${args.pattern}${where}${filter}`, kind: 'search', rawInput: args.pattern }
}
