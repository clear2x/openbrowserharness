/**
 * Minimal structural path and schema-node accessors for the settings
 * namespace drafts: the pieces the panels need from the retired schema-form
 * package, inlined so the dependency-inverted panel keeps no package-level
 * form dependency.
 * @module @deepseek-ai/dsh-client-ui-settings-models/path
 */

import Schema from '@deepseek-ai/schemastery'

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

/**
 * Whether a draft explicitly carries the path (its presence marks a user
 * override).
 * @param value - the draft to inspect.
 * @param path - the field path, one segment per step.
 * @returns true when the path resolves to an explicit value.
 */
export function hasPath(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return value !== undefined
  const parent = getPath(value, path.slice(0, -1))
  const key = path[path.length - 1] as string
  if (Array.isArray(parent)) return Number(key) < parent.length
  if (typeof parent !== 'object' || parent === null) return false
  return key in parent
}

/** Live schemastery node; the panels read only its structural relations. */
export type SchemaNode = Schema

/**
 * Rehydrate a serialized schema envelope into a live validator/node tree.
 * @param serialized - `schema.toJSON()` output received over the wire.
 * @returns the root schema node.
 */
export function rehydrateSchema(serialized: unknown): SchemaNode {
  return new Schema(serialized as Schema)
}

/**
 * Resolve the schema node at a settings path (the configurable-provider
 * directory's `settingsPath` vocabulary): object properties by name, dict
 * entries through `inner`. An unresolvable segment returns `undefined` so
 * the caller falls back instead of rendering a wrong subtree.
 * @param root - rehydrated section root node.
 * @param path - key path from the section root.
 * @returns the node describing that position, or `undefined`.
 */
export function nodeAtPath(root: SchemaNode, path: readonly string[]): SchemaNode | undefined {
  let node: SchemaNode | undefined = root
  for (const key of path) {
    if (node === undefined) return undefined
    if (node.type === 'object') node = (node.dict as Record<string, SchemaNode> | undefined)?.[key]
    else if (node.type === 'dict' || node.type === 'array') node = node.inner as SchemaNode | undefined
    else return undefined
  }
  return node
}
