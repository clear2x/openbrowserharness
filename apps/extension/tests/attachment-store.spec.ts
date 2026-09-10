/**
 * Attachment store spec: the content-addressed image store behind
 * `ctx.attachments` (memory-backed, the Node-composable seam). Covers the
 * round-trip contract the extension projection shares with the desktop's
 * attachment-local backend — admission policy (type sniffing, declared-type
 * match, byte and pixel limits, canonical base64), content-addressed
 * references (sha256 ids, dedup), verified reads (corruption, missing
 * object), and the durable wire helpers (canonical base64 decode, chunked
 * encode).
 */

import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import {
  ContentAddressedImageStore,
  bytesToBase64,
  decodeCanonicalBase64,
  sniffImageMediaType,
} from '../src/chrome/attachment-store.ts'
import type { ImageObjectSink } from '../src/chrome/attachment-store.ts'

/** A 1×1 PNG's exact bytes (a real, fully decodable raster). */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

/** Memory sink: placement keyed by bare digest, readable for corruption tests. */
function memorySink(): ImageObjectSink & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>()
  return {
    objects,
    async put(key, data) {
      objects.set(key, new Uint8Array(data))
    },
    async get(key) {
      const data = objects.get(key)
      return data === undefined ? undefined : new Uint8Array(data)
    },
  }
}

/** Fixed 2×2 probe standing in for createImageBitmap's full decode. */
const probe = async (): Promise<{ width: number; height: number }> => ({ width: 2, height: 2 })

function mount(limits?: Parameters<typeof buildStore>[2]): ReturnType<typeof buildStore> {
  return buildStore(memorySink(), probe, limits)
}

function buildStore(
  sink: ImageObjectSink,
  probeImpl: (data: Uint8Array, mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif') => Promise<{ width: number; height: number }>,
  limits?: { maxImageBytes?: number; maxImagePixels?: number },
): {
  store: ContentAddressedImageStore
  ctx: Context
} {
  const ctx = new CordisContext()
  const store = new ContentAddressedImageStore(ctx, async () => sink, probeImpl, limits)
  return { store, ctx }
}

describe('sniffImageMediaType', () => {
  it('recognizes the four version-one signatures and nothing else', () => {
    expect(sniffImageMediaType(PNG_BYTES)).toBe('image/png')
    expect(sniffImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('image/jpeg')
    expect(sniffImageMediaType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
    expect(sniffImageMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    expect(sniffImageMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x38, 0x61]))).toBeUndefined()
    expect(sniffImageMediaType(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })
})

describe('decodeCanonicalBase64 / bytesToBase64', () => {
  it('round-trips canonical base64 and rejects non-canonical forms', () => {
    const encoded = bytesToBase64(PNG_BYTES)
    expect(new Uint8Array(decodeCanonicalBase64(encoded))).toEqual(PNG_BYTES)
    expect(() => decodeCanonicalBase64('')).toThrowError(/canonical/)
    expect(() => decodeCanonicalBase64('A')).toThrowError(/canonical/)
    expect(() => decodeCanonicalBase64(`${encoded.slice(0, 96)}ab?d`)).toThrowError(/canonical/)
    expect(() => decodeCanonicalBase64('ab cd')).toThrowError(/canonical/)
  })
})

describe('ContentAddressedImageStore', () => {
  it('admits, publishes a sha256 reference, and round-trips verified bytes', async () => {
    const { store } = mount()
    const ref = await store.saveImage({ data: PNG_BYTES, mediaType: 'image/png', name: '/tmp/截图.png' })
    expect(String(ref.attachmentId)).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(ref.mediaType).toBe('image/png')
    expect(ref.bytes).toBe(PNG_BYTES.byteLength)
    expect(ref.width).toBe(2)
    expect(ref.height).toBe(2)
    expect(ref.name).toBe('截图.png')

    const stored = await store.readImage(ref)
    expect(new Uint8Array(stored.data)).toEqual(PNG_BYTES)
    expect(stored.ref).toEqual(ref)
  })

  it('dedupes identical bytes to one object while keeping names distinct', async () => {
    const { store } = mount()
    const first = await store.saveImage({ data: PNG_BYTES, mediaType: 'image/png', name: 'a.png' })
    const second = await store.saveImage({ data: PNG_BYTES, mediaType: 'image/png', name: 'b.png' })
    expect(second.attachmentId).toBe(first.attachmentId)
    expect(second.name).toBe('b.png')
  })

  it('refuses declared types that do not match the sniffed bytes', async () => {
    const { store } = mount()
    await expect(store.validateImage({ data: PNG_BYTES, mediaType: 'image/jpeg' }))
      .rejects.toMatchObject({ code: 'IMAGE_TYPE_MISMATCH' })
  })

  it('refuses empty and unrecognized payloads', async () => {
    const { store } = mount()
    await expect(store.validateImage({ data: new Uint8Array(0), mediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    await expect(store.validateImage({ data: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })

  it('enforces the byte and pixel limits', async () => {
    const { store } = mount({ maxImageBytes: 8 })
    await expect(store.saveImage({ data: PNG_BYTES, mediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })

    const tiny = buildStore(memorySink(), probe, { maxImagePixels: 1 }).store
    await expect(tiny.saveImage({ data: PNG_BYTES, mediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS' })
  })

  it('reports the image policy the batch admission reads', () => {
    const { store } = mount()
    expect(store.imageLimits.maxImagesPerMessage).toBeGreaterThan(0)
    expect(store.imageLimits.maxMessageImageBytes).toBeGreaterThan(0)
    expect(store.imageLimits.mediaTypes).toHaveLength(4)
  })

  it('fails a read whose stored bytes no longer match the digest', async () => {
    const sink = memorySink()
    const { store } = buildStore(sink, probe)
    const ref = await store.saveImage({ data: PNG_BYTES, mediaType: 'image/png' })
    const digest = String(ref.attachmentId).slice('sha256:'.length)
    sink.objects.set(digest, new Uint8Array([1, 2, 3]))
    await expect(store.readImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })

  it('fails a read for a missing object and a malformed reference', async () => {
    const { store } = mount()
    const missing = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    } as const
    await expect(store.readImage(missing)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    await expect(store.readImage({ ...missing, attachmentId: 'not-a-digest' as never }))
      .rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })
  })

  it('provides the service under ctx.attachments (the seam the adapters resolve)', async () => {
    const { store, ctx } = mount()
    // cordis publishes a contextual proxy; assert the seam behaviorally.
    expect(ctx.attachments).toBeDefined()
    const ref = await ctx.attachments.saveImage({ data: PNG_BYTES, mediaType: 'image/png' })
    const stored = await ctx.attachments.readImage(ref)
    expect(new Uint8Array(stored.data)).toEqual(PNG_BYTES)
    expect(store).toBeInstanceOf(ContentAddressedImageStore)
  })
})
