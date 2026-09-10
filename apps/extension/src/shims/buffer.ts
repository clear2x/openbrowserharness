/**
 * Browser shim for node:buffer — only `Buffer.byteLength` is in the mounted
 * closure's reach (message-feedback's note budget; the global-mounted
 * tool-output truncation paths); UTF-8 byte length via TextEncoder.
 * Anything else throws loudly at the call site. `shims/globals.ts` mounts
 * this object as the ambient `Buffer` global for packages that reference it
 * without a `node:buffer` import.
 */

const encoder = new TextEncoder()

export const Buffer = {
  byteLength(value: string | Uint8Array, _encoding?: string): number {
    void _encoding
    return typeof value === 'string' ? encoder.encode(value).length : value.byteLength
  },
} as const

export function isBuffer(value: unknown): boolean {
  return value instanceof Uint8Array
}
