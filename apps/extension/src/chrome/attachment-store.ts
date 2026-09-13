/**
 * `chrome-attachment-store`: the durable image-attachment service (`ctx.attachments`)
 * for the extension host — the browser twin of `@deepseek-ai/dsh-attachment-local`,
 * with the same seam (`AttachmentStore`), the same content-addressed reference
 * vocabulary (`sha256:<hex>` `ImageAttachmentRef`), and the same admission
 * policy shape, but OPFS bytes instead of a filesystem tree and `createImageBitmap`
 * full decode instead of sharp:
 *
 * - ADOPTION: the SidePanel composer submits temporary base64 bytes through
 *   `session.prompt`; the api-bridge batch-validates them against
 *   {@link DEFAULT_IMAGE_LIMITS} and promotes each one through
 *   {@link ContentAddressedImageStore.saveImage} BEFORE the user message is
 *   appended, so the durable log carries only references (apiproxy parity —
 *   packages/host/apiproxy/src/api-proxy.ts `durablePromptContent`).
 * - RESOLUTION: the model-facing adapters resolve references back to bytes at
 *   request time through {@link attachmentResolverOf} (the pi-ai adapter's
 *   `resolveAttachments` twin), and the bridge's `session.attachment` serves
 *   authorized history reads back to the panel.
 * - STORAGE: bytes live under the extension origin's OPFS as flat objects
 *   named by their sha256 digest (`attachments/v1/objects/<sha256>` — OPFS
 *   handle lookup needs no hex-prefix fan-out), so the offscreen
 *   engine and the SidePanel share one durable object set across reloads.
 *
 * The Service class is the plugin face (default export, loader-adopted like
 * `dsh-jobs-local`); the OPFS sink and bitmap probe are acquired lazily so a
 * Node-hosted composition test can mount a memory-backed
 * {@link ContentAddressedImageStore} on the same seam instead.
 */

import { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'

/** Default maximum encoded bytes for one image (attachment-local parity). */
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Default maximum images in one prompt (attachment-local parity). */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
/** Default maximum aggregate encoded image bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 100 * 1024 * 1024
/** Default maximum intrinsic pixels for one image. */
export const DEFAULT_MAX_IMAGE_PIXELS = 40_000_000

/** The resolved image-intake policy behind one store instance. */
export const DEFAULT_IMAGE_LIMITS: ImageAttachmentLimits = Object.freeze({
  maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
  maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE,
  maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
  maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
  maxImageDimension: 8192,
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
})

/** OPFS directory the Service class roots its object tree under. */
const OPFS_ROOT = 'attachments/v1/objects'

// ───────────────────────── media-type sniffing ─────────────────────────

/**
 * Raster media-type sniffing from magic bytes. Admission trusts these bytes —
 * never the submitter's declared type — so a mislabeled payload is refused
 * (`IMAGE_TYPE_MISMATCH`) instead of being stored under a wire type the
 * provider adapter would faithfully repeat.
 * @param data - complete encoded image bytes.
 * @returns the sniffed media type, or undefined when no signature matches.
 */
export function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return 'image/png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  if (data.length >= 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    return 'image/webp'
  }
  if (data.length >= 6
    && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38
    && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61) {
    return 'image/gif'
  }
  return undefined
}

// ───────────────────────── backend seams ─────────────────────────

/**
 * Immutable-byte object sink behind the content-addressed store. Keys are the
 * bare sha256 hex digests; implementations own placement and durability.
 */
export interface ImageObjectSink {
  /** Commit one object; an existing object with the key must stay untouched. */
  put(key: string, data: Uint8Array): Promise<void>
  /** Read one object's bytes, or undefined when the key is absent. */
  get(key: string): Promise<Uint8Array | undefined>
}

/**
 * Full-decode raster probe behind admission. The browser implementation
 * decodes through `createImageBitmap`, so a truncated or corrupt payload
 * fails admission instead of publishing a reference (the sharp
 * `detectImage` role in the local backend).
 */
export type ImageRasterProbe = (data: Uint8Array, mediaType: ImageMediaType) => Promise<{ width: number; height: number }>

/**
 * The browser admission probe: a full `createImageBitmap` decode proves the
 * encoded bytes are complete and yields the intrinsic dimensions.
 * @returns a probe over the decoded raster; rejects for undecodable bytes.
 */
export function bitmapImageProbe(): ImageRasterProbe {
  return async (data, mediaType) => {
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: mediaType }))
    } catch (error: unknown) {
      throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
    }
    try {
      return { width: bitmap.width, height: bitmap.height }
    } finally {
      bitmap.close()
    }
  }
}

/**
 * OPFS byte sink rooted at the extension origin's `attachments/v1/objects`
 * directory. Acquired lazily on first use because the Service constructor
 * cannot await; the same-origin SidePanel reads the same object set.
 * @returns a sink over the created directory tree.
 */
export async function opfsImageSink(): Promise<ImageObjectSink> {
  let root = await navigator.storage.getDirectory()
  for (const segment of OPFS_ROOT.split('/')) {
    root = await root.getDirectoryHandle(segment, { create: true })
  }
  return {
    async put(key, data) {
      // createWritable is exclusive per file name; identical content dedupes
      // to the same key, so a concurrent first write lands byte-identical.
      const handle = await root.getFileHandle(key, { create: true })
      const writable = await handle.createWritable()
      await writable.write(new Uint8Array(data))
      await writable.close()
    },
    async get(key) {
      try {
        const handle = await root.getFileHandle(key)
        const file = await handle.getFile()
        return new Uint8Array(await file.arrayBuffer())
      } catch (error: unknown) {
        // NotFoundError is the expected miss; every other failure is real.
        if (error instanceof DOMException && error.name === 'NotFoundError') return undefined
        throw error
      }
    },
  }
}

// ───────────────────────── base64 wire helpers ─────────────────────────

/**
 * Encode bytes as base64. `btoa` takes its binary string argument in chunks
 * because a 5 MB image would blow the call stack in one spread.
 * @param data - raw bytes.
 * @returns the base64 text.
 */
export function bytesToBase64(data: Uint8Array): string {
  let text = ''
  const chunk = 0x8000
  for (let i = 0; i < data.length; i += chunk) {
    text += String.fromCharCode(...data.subarray(i, i + chunk))
  }
  return btoa(text)
}

/**
 * Decode the browser-submitted base64 image payload while rejecting
 * non-canonical forms (whitespace, padding drift, foreign alphabets) — the
 * apiproxy `decodeBase64` contract, re-expressed over atob.
 * @param data - the submitted base64 text.
 * @returns the decoded bytes.
 * @throws AttachmentError `INVALID_IMAGE_BASE64` for any non-canonical form.
 */
export function decodeCanonicalBase64(data: string): Uint8Array {
  if (data.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
    throw new AttachmentError('Image upload is not canonical base64.', 'INVALID_IMAGE_BASE64')
  }
  let binary: string
  try {
    binary = atob(data)
  } catch {
    throw new AttachmentError('Image upload is not canonical base64.', 'INVALID_IMAGE_BASE64')
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  if (bytesToBase64(bytes) !== data) {
    throw new AttachmentError('Image upload is not canonical base64.', 'INVALID_IMAGE_BASE64')
  }
  return bytes
}

// ───────────────────────── content-addressed store ─────────────────────────

const SHA256_HEX = /^[a-f0-9]{64}$/

/** Strip a display name to its path-free leaf (attachment-local parity). */
function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // Strip both separator styles by hand: path.basename would keep a Windows
  // client's full local path on a POSIX host and leak it into the durable
  // reference and session log.
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return clean === '' ? undefined : clean
}

/** SHA-256 over the WebCrypto stable API (secure contexts: extension pages, Node 20+). */
async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The content-addressed image store proper: admission policy, digest
 * addressing, and read-back verification over an injected byte sink and
 * raster probe. Both the extension plugin face and the Node composition
 * tests mount this class — the tests inject a memory sink, production
 * injects OPFS plus the bitmap probe.
 */
export class ContentAddressedImageStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits
  // TS-private (compile-time) rather than #private: cordis publishes service
  // methods through shadow proxies that rebind `this`, and a #field brand
  // check would throw on every proxied call.
  private readonly sink: () => Promise<ImageObjectSink>
  private readonly probe: ImageRasterProbe

  /**
   * @param ctx - owning cordis context; this store provides `ctx.attachments`.
   * @param sink - lazy byte-sink accessor (OPFS acquisition may await).
   * @param probe - full-decode admission probe.
   * @param limits - admission policy; omitted fields fall back to the shared defaults.
   */
  constructor(
    ctx: Context,
    sink: () => Promise<ImageObjectSink>,
    probe: ImageRasterProbe,
    limits?: Partial<ImageAttachmentLimits>,
  ) {
    super(ctx)
    this.sink = sink
    this.probe = probe
    this.imageLimits = Object.freeze({
      maxImageBytes: limits?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: limits?.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: limits?.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: limits?.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      maxImageDimension: limits?.maxImageDimension ?? 8192,
      mediaTypes: DEFAULT_IMAGE_LIMITS.mediaTypes,
    })
  }

  /** Decode one reference into its bare digest, refusing foreign shapes. */
  private digestOf(ref: ImageAttachmentRef): string {
    const prefix = 'sha256:'
    const id = String(ref.attachmentId)
    if (!id.startsWith(prefix) || !SHA256_HEX.test(id.slice(prefix.length))) {
      throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
    }
    return id.slice(prefix.length)
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await this.inspect(input, this.imageLimits.maxImagePixels)
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    if (input.data.byteLength > this.imageLimits.maxImageBytes) {
      throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
    }
    const metadata = await this.inspect(input, this.imageLimits.maxImagePixels)
    const digest = await sha256(input.data)
    await (await this.sink()).put(digest, input.data)
    const name = displayName(input.name)
    return {
      attachmentId: AttachmentId(`sha256:${digest}`),
      ...metadata,
      ...(name !== undefined ? { name } : {}),
    }
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const digest = this.digestOf(ref)
    const data = await (await this.sink()).get(digest)
    signal?.throwIfAborted()
    if (data === undefined) {
      throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    }
    // The digest proves these are the exact bytes admission decoded, so the
    // read path re-derives only the header facts (no second raster decode).
    if (await sha256(data) !== digest) {
      throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
    }
    const sniffed = sniffImageMediaType(data)
    if (sniffed !== ref.mediaType || data.byteLength !== ref.bytes) {
      throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
    }
    return { ref, data }
  }

  /** Full admission inspection: size floor, sniffed type, complete decode, pixel cap. */
  private async inspect(
    input: SaveImageAttachment,
    maxPixels: number,
  ): Promise<Omit<ImageAttachmentRef, 'attachmentId' | 'name'>> {
    if (input.data.byteLength === 0) {
      throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
    }
    const sniffed = sniffImageMediaType(input.data)
    if (sniffed === undefined) {
      throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
    }
    if (sniffed !== input.mediaType) {
      throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH')
    }
    const dimensions = await this.probe(input.data, sniffed)
    if (dimensions.width * dimensions.height > maxPixels) {
      throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
    }
    return { mediaType: sniffed, bytes: input.data.byteLength, ...dimensions }
  }
}

// ───────────────────────── plugin face ─────────────────────────

/** Configuration for the extension attachment backend. */
export interface Config {
  /** Maximum encoded bytes accepted for one image. */
  maxImageBytes?: number
  /** Maximum image count accepted in one submitted message. */
  maxImagesPerMessage?: number
  /** Maximum aggregate encoded image bytes accepted in one submitted message. */
  maxMessageImageBytes?: number
  /** Maximum intrinsic width multiplied by height accepted for one image. */
  maxImagePixels?: number
}

/**
 * The composed plugin face: `ctx.attachments` over OPFS bytes and the
 * createImageBitmap admission probe. The sink acquisition stays lazy — the
 * loader applies this plugin synchronously and the offscreen document may
 * boot before the origin's storage is reachable.
 */
export default class ChromeAttachmentStore extends ContentAddressedImageStore {
  static Config: z<Config> = z.object({
    maxImageBytes: z.number().step(1).min(1),
    maxImagesPerMessage: z.number().step(1).min(1),
    maxMessageImageBytes: z.number().step(1).min(1),
    maxImagePixels: z.number().step(1).min(1),
  })

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, opfsImageSink, bitmapImageProbe(), config)
  }
}

/**
 * Build the adapter-facing byte resolver over one context: the closure
 * re-reads the service at request time through the reflect accessor, so
 * adapters registered before the store composes (chrome-llm precedes the
 * row) still resolve once it lands, and a deployment without the service
 * fails loud at first use (pi-ai's `resolveAttachments` contract).
 * @param ctx - the engine context whose `attachments` service resolves bytes.
 * @returns an async byte resolver for one durable reference.
 */
export function attachmentResolverOf(
  ctx: Context,
): (ref: ImageAttachmentRef) => Promise<StoredImageAttachment> {
  return async (ref) => {
    // The plain property read throws for an unprovided service; the reflect
    // accessor answers undefined instead (the store is optional by design).
    const store = ctx.reflect.get('attachments', false) as AttachmentStore | undefined
    if (store === undefined) {
      throw new AttachmentError('The extension host has no attachment service.', 'ATTACHMENT_PROJECTION_UNSUPPORTED')
    }
    return store.readImage(ref)
  }
}
