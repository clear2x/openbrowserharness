/**
 * Browser shim for node:util — exactly the symbols the mounted dsh closure
 * imports at source level (audited):
 * - `isDeepStrictEqual` — packages/compaction/compaction-basic (plain-JSON
 *   structural comparison);
 * - `inspect` — vendored logging paths (property-style usage survives
 *   minification in the bundle).
 *
 * Adding a symbol here is deliberate: extend only when a bundler error names
 * a new node:util import, never speculatively.
 */

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

export function inspect(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
