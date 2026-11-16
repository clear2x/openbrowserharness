/**
 * Browser shim for node:buffer — `Buffer.byteLength` (message-feedback's note
 * budget; the global-mounted tool-output truncation paths), `Buffer.from`
 * (the account Host's OAuth state comparison) and `Buffer.concat` (its
 * response-body reader). Concatenations come back as {@link ByteView} so the
 * `toString('utf8')` read after the concat keeps its Node encoding. Anything
 * else throws loudly at the call site. `shims/globals.ts` mounts this object
 * as the ambient `Buffer` global for packages that reference it without a
 * `node:buffer` import.
 */

import { ByteView } from './bytes'

const encoder = new TextEncoder()

export const Buffer = {
  byteLength(value: string | Uint8Array, _encoding?: string): number {
    void _encoding
    return typeof value === 'string' ? encoder.encode(value).length : value.byteLength
  },
  from(value: string | Uint8Array): Uint8Array {
    if (typeof value === 'string') return new ByteView(encoder.encode(value))
    return value
  },
  concat(list: readonly Uint8Array[]): Uint8Array {
    const total = list.reduce((sum, chunk) => sum + chunk.length, 0)
    const merged = new ByteView(total)
    let offset = 0
    for (const chunk of list) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    return merged
  },
} as const

export function isBuffer(value: unknown): boolean {
  return value instanceof Uint8Array
}
