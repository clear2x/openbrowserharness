/**
 * Browser shim for node:path — the symbols the mounted dsh closure imports
 * (audited: `isAbsolute` from core/session; `resolve`/`join`/`dirname` from
 * the subagent/homedir chain; `basename`/`extname` from tool-fs's read-image).
 * POSIX-only implementations; these never see URL-shaped strings (fs paths
 * only), so plain segment normalization is safe.
 */

export function isAbsolute(p: string): boolean {
  return p.startsWith('/')
}

/** Normalize dot segments; keep a leading slash. */
function normalizeSegments(p: string): string {
  const out: string[] = []
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!p.startsWith('/')) out.push('..')
      continue
    }
    out.push(segment)
  }
  return (p.startsWith('/') ? '/' : '') + out.join('/')
}

export function resolve(...parts: string[]): string {
  const joined = parts.length === 0 ? '.' : parts.join('/')
  const absolute = joined.startsWith('/') ? joined : `/${joined}`
  return normalizeSegments(absolute)
}

export function join(...parts: string[]): string {
  return normalizeSegments(parts.join('/'))
}

export function dirname(p: string): string {
  const normalized = normalizeSegments(p)
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return idx === 0 ? '/' : '.'
  return normalized.slice(0, idx)
}

export function basename(p: string): string {
  const normalized = normalizeSegments(p)
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}

/** Node `extname` semantics: the dot suffix of the basename, or '' for none/leading-dot. */
export function extname(p: string): string {
  const base = basename(p)
  const idx = base.lastIndexOf('.')
  if (idx <= 0) return ''
  return base.slice(idx)
}
