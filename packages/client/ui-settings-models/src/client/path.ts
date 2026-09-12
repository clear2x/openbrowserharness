/**
 * Minimal structural path accessors for settings namespace drafts: the only
 * pieces the panels need from the retired schema-form package, inlined so the
 * dependency-inverted panel keeps no package-level form dependency.
 * @module @deepseek-ai/dsh-client-ui-settings-models/path
 */

/**
 * Read the value at a key path.
 * @param value - root value (draft or fallback layer).
 * @param path - key path from the root; array indexes as strings.
 * @returns the value at the path, or `undefined` along a missing branch.
 */
export function getPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (Array.isArray(current)) {
      current = current[Number(key)]
      continue
    }
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
