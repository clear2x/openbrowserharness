/**
 * Node-shaped byte string shared by the buffer and crypto shims: a Uint8Array
 * body plus Buffer's string encodings, so mounted packages keep their
 * `Buffer.concat(...).toString('utf8')` / `randomBytes(n).toString('base64url')`
 * call sites unchanged.
 */

/** Base64url encode raw bytes (no padding, URL-safe alphabet). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** Lowercase hex encode raw bytes. */
export function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

export class ByteView extends Uint8Array {
  override toString(encoding?: string): string {
    if (encoding === undefined || encoding === 'utf8' || encoding === 'utf-8') return new TextDecoder().decode(this)
    if (encoding === 'hex') return toHex(this)
    if (encoding === 'base64url') return bytesToBase64Url(this)
    throw new Error(`byte toString('${encoding}') unsupported in shim; use 'base64url', 'hex' or 'utf8'`)
  }
}
