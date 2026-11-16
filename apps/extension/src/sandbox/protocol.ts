/**
 * Shared host↔sandbox protocol utilities for the sandbox page's modules
 * (`main.ts` plugin lifecycle, `program-runner.ts` PTC execution). The tags,
 * the snapshot helper, and the error renderer are one definition each so the
 * two message consumers stay byte-identical on the wire.
 * @module sandbox/protocol
 */

/** Host→sandbox message-source tag (must match the host bridge). */
export const HOST_TO_SANDBOX = 'obh-sandbox'
/** Sandbox→host message-source tag (must match the host bridge). */
export const SANDBOX_TO_HOST = 'obh-sandbox-host'

/** The embedding extension origin when discoverable, else unrestricted. */
export function parentTarget(): string {
  // Sandboxed origins are opaque, so the exact ancestor origin cannot be
  // derived locally; Chromium exposes it via ancestorOrigins. An empty list
  // falls back to '*'.
  const origins = window.location.ancestorOrigins
  const first = origins.length > 0 ? origins[0] : undefined
  return first ?? '*'
}

/** Post one message to the embedding host with the shared source tag. */
export function postToHost(message: Record<string, unknown>): void {
  window.parent.postMessage({ source: SANDBOX_TO_HOST, ...message }, parentTarget())
}

/** Functions/symbols/bigints cannot cross structured clone; render them inert. */
export function snapshotArg(value: unknown, depth: number, seen: Set<object>): unknown {
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  if (depth > 6) return '[depth-limit]'
  const nextSeen = new Set(seen)
  nextSeen.add(value)
  if (Array.isArray(value)) return value.map(item => snapshotArg(item, depth, nextSeen))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = snapshotArg(item, depth, nextSeen)
  return out
}

/** Render one thrown value as the protocol's flat error string. */
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
