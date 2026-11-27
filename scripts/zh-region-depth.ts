/**
 * Depth-shift the non-corpus relative links of one generated region so it can
 * render unchanged on a Chinese-side page one directory deeper (`D/foo.md` →
 * `D/zh/foo.md`). Corpus-pair destinations already carry their `zh/` segment
 * and keep the depth the locale rewrite gave them; every other relative
 * destination climbs one extra level.
 */

import {
  isExternalOrAbsoluteMarkdownUrl,
  markdownDestination,
  parseMarkdown,
  splitMarkdownUrlTarget,
  visitMarkdown,
} from './markdown.ts'
import { isZhCorpusPath } from './translation-paths.ts'

interface Edit { start: number; end: number; value: string }

/** Repository-relative directory of one page, slash-separated. */
function pageDir(page: string): string {
  return page.includes('/') ? page.slice(0, page.lastIndexOf('/')) : '.'
}

/**
 * Prepend one `../` to every relative, non-corpus destination of `region`,
 * which was authored relative to the English page directory `enPage`.
 * @param region - Region text as rendered for the English page.
 * @param enPage - Repository-relative English page the region was authored for.
 * @returns The region text with non-corpus destinations shifted one level.
 */
export function depthShiftRegionForZhPage(region: string, enPage: string): string {
  const enDir = pageDir(enPage)
  const edits: Edit[] = []
  visitMarkdown(parseMarkdown(region), (node) => {
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return
    if (isExternalOrAbsoluteMarkdownUrl(node.url)) return
    const destination = markdownDestination(region, node)
    const { path } = splitMarkdownUrlTarget(destination.url)
    if (path === '' || path.startsWith('#')) return
    let decoded = path
    try {
      decoded = decodeURIComponent(path)
    } catch {
      // A malformed escape names no resolvable target; shift it like plain text.
    }
    const target = posixNormalize(join(enDir, decoded))
    if (isZhCorpusPath(target) || target.startsWith('.agents/notes/archived/')) return
    edits.push({ start: destination.start, end: destination.end, value: `../${destination.url}` })
  })
  let out = region
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    out = out.slice(0, edit.start) + edit.value + out.slice(edit.end)
  }
  return out
}

function join(dir: string, path: string): string {
  return dir === '.' ? path : `${dir}/${path}`
}
function posixNormalize(path: string): string {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' && segments.length > 0 && segments[segments.length - 1] !== '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const joined = segments.join('/')
  return joined === '' ? '.' : joined
}
