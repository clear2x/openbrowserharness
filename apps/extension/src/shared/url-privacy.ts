/**
 * 链接净化 (the 链接净化 built-in capability): tracking query parameters
 * stripped from navigation URLs before the agent drives the page — pure
 * privacy, no functional loss, and the model sees the clean URL it will
 * actually land on.
 */

/** Query-parameter names treated as tracking (case-insensitive, utm_* family included by prefix). */
const TRACKING_PARAM_RE = /^(utm_|fbclid|gclid|yclid|msclkid|dclid|spm|scid|_hsenc|_hsmi|mc_[ei]id|igshid|ref_src$|ref_url$|vr_source)/i

/**
 * Strip tracking query parameters from one absolute URL. Unparseable input
 * returns verbatim; a URL left with no query drops the dangling `?`.
 * Exported pure for the capability spec.
 */
export function stripTrackingParams(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  const drop: string[] = []
  parsed.searchParams.forEach((_value, name) => {
    if (TRACKING_PARAM_RE.test(name)) drop.push(name)
  })
  if (drop.length === 0) return url
  for (const name of drop) parsed.searchParams.delete(name)
  let out = parsed.toString()
  if (out.endsWith('?')) out = out.slice(0, -1)
  return out
}
