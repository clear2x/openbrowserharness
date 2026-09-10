/**
 * Browser-side mirrors of the extension host's declared-provider profile rules
 * (`apps/extension/src/chrome/custom-providers.ts`). The client packages
 * reference only client packages, so the gates are mirrored here to name a
 * rejected field while the user is still looking at it instead of after a
 * refused round trip; keep each rule in step with its twin.
 * @module @deepseek-ai/dsh-client-ui-settings-models/profileValidation
 */

/**
 * A route id usable as a settings key AND as the stem of a credential name.
 * The leading letter is the second half of that: `deriveKeyRef` uppercases the
 * id and replaces every non-alphanumeric run with `_`, and a credential
 * reference is a POSIX shell identifier, which cannot start with a digit.
 */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * Header names a declared route may not set through `headersText`. The
 * credential is the credential seam's job (API Key → Bearer / x-api-key), and
 * content-type is fixed by both adapters' wire format, so an override here
 * would only quietly break authentication or serialization.
 */
const FORBIDDEN_HEADER_NAMES: ReadonlySet<string> = new Set(['authorization', 'content-type'])

/** Upper bound on usable headers one declared route may carry. */
export const MAX_CUSTOM_HEADERS = 20

/**
 * RFC 9110 field-name token characters minus whitespace — what a header name
 * may be built from.
 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^`|~0-9A-Za-z]+$/

/**
 * Why a drafted route id cannot be written yet, or `undefined` when it can.
 * @param route - the id as typed (or auto-derived from the display name).
 * @param taken - ids already declared, which must never be shadowed.
 * @returns the failure message, or undefined.
 */
export function routeIdFailure(route: string, taken: readonly string[]): string | undefined {
  if (!ROUTE_PATTERN.test(route)) {
    return '路由 ID 需以小写字母开头，之后可用小写字母、数字和短横线（如 acme-gateway）'
  }
  if (taken.includes(route)) return '已有提供方使用了这个路由 ID。'
  return undefined
}

/**
 * Derive a valid route id from a display name, so the create form can offer one
 * the user never has to think about unless they want to: ASCII letters and
 * digits survive lowercased, every other run (spaces, CJK, punctuation)
 * collapses to one dash, leading/trailing dashes go, and a first digit gains a
 * `p` prefix to keep {@link ROUTE_PATTERN} and the derived credential name
 * legal. A name with no usable character at all falls back to `gateway`.
 * @param name - the display name as typed.
 * @returns the candidate id, possibly still colliding with `taken` ids.
 */
export function slugOfName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug === '') return 'gateway'
  return /^[0-9]/.test(slug) ? `p${slug}` : slug
}

/**
 * Mirror of the host's per-line headersText parse (`parseHeadersText`): one
 * `Header-Name: value` per line, blank and `#` lines skipped, an empty entry
 * value skipped, a repeated name keeping its last value, whitespace trimmed
 * away, at most {@link MAX_CUSTOM_HEADERS} usable headers.
 * @param raw - the textarea's current text.
 * @returns the failure message without a field prefix, or undefined when usable.
 */
export function headersTextFailure(raw: string): string | undefined {
  const count = new Set<string>()
  const lines = raw.split(/\r?\n/)
  for (const [index, source] of lines.entries()) {
    const line = source.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator === -1) {
      return `第 ${index + 1} 行缺少冒号，每行应为 "Header-Name: value"`
    }
    const name = line.slice(0, separator).trim()
    if (/\s/.test(name)) return `第 ${index + 1} 行的名称不能包含空格："${name}"`
    if (!HEADER_NAME_PATTERN.test(name)) return `第 ${index + 1} 行的名称含有非法字符："${name}"`
    if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
      return `${name} 不允许在此配置：认证请填写 API Key，勿在此重复配置`
    }
    const value = line.slice(separator + 1).trim()
    if (value === '') continue
    count.add(name)
    if (count.size > MAX_CUSTOM_HEADERS) return `自定义请求头最多 ${MAX_CUSTOM_HEADERS} 条`
  }
  return undefined
}

/**
 * Reject a baseURL a declared route may not target — the browser mirror of
 * `publicHttpUrlFailure`: plain HTTP(S) public endpoints only; loopback,
 * link-local, private, and reserved ranges refused.
 * @param raw - the baseURL as typed.
 * @returns the failure message, or undefined when acceptable.
 */
export function publicHttpUrlFailure(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'Base URL 不是合法的绝对地址'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Base URL 仅支持 http/https'
  }
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') {
    return 'Base URL 不能指向本机（localhost/环回地址）'
  }
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its embedded v4 address.
  const v4 = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(v4)) {
    const [a, b] = v4.split('.').map(Number) as [number, number]
    if (a === 127 || a === 10 || a === 0 || a >= 224) return 'Base URL 不能指向环回/私有/保留地址'
    if (a === 172 && b >= 16 && b <= 31) return 'Base URL 不能指向私有地址'
    if (a === 192 && b === 168) return 'Base URL 不能指向私有地址'
    if (a === 169 && b === 254) return 'Base URL 不能指向链路本地地址'
  }
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return 'Base URL 不能指向私有/链路本地地址'
  }
  return undefined
}
