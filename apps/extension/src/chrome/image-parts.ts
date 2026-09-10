/**
 * Durable-image resolution at the adapter wire boundary — the shared half of
 * the extension host's image serialization (pi-ai's `toPiContextWithImages`
 * role, split so the wire converters stay synchronous):
 *
 * 1. {@link collectImageRefs} walks derived history for image blocks (nested
 *    tool results included, the one recursive walk `contentHasImage` also
 *    owns);
 * 2. {@link resolveWireImages} reads each reference through the context's
 *    attachment service and returns the base64 byte table;
 * 3. each protocol converter looks its blocks up in the table and emits its
 *    native wire part (Anthropic base64 source, Responses `input_image`).
 *
 * A request whose images cannot resolve fails loud BEFORE any bytes reach
 * the wire: a missing attachment service or a reference it cannot serve is
 * `UNSUPPORTED_CONTENT`, never a silently flattened message.
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'

/** Resolved wire bytes for one image reference (base64, provider-neutral). */
export interface WireImageBytes {
  mediaType: ImageMediaType
  data: string
}

/**
 * Base64 byte table for one request, keyed by the opaque attachment id.
 * Converters treat a missing entry as an internal wiring failure and refuse.
 */
export type WireImageTable = ReadonlyMap<string, WireImageBytes>

/** Collect every image reference in one message's content, nested results included. */
function imageRefsIn(content: readonly ContentBlock[]): ImageAttachmentRef[] {
  const refs: ImageAttachmentRef[] = []
  for (const block of content) {
    if (block.type === 'image') {
      refs.push(block.attachment)
      continue
    }
    if (block.type === 'tool-result') {
      refs.push(...imageRefsIn(block.content))
    }
  }
  return refs
}

/**
 * Walk derived history for every image block's durable reference (nested
 * tool-result content included).
 * @param messages - the request history about to be serialized.
 * @returns the references in arrival order, deduplicated by attachment id.
 */
export function collectImageRefs(messages: readonly Message[]): ImageAttachmentRef[] {
  const seen = new Set<string>()
  const refs: ImageAttachmentRef[] = []
  for (const message of messages) {
    if (!contentHasImage(message.content)) continue
    for (const ref of imageRefsIn(message.content)) {
      const id = String(ref.attachmentId)
      if (seen.has(id)) continue
      seen.add(id)
      refs.push(ref)
    }
  }
  return refs
}

/**
 * Resolve one request's image references into the wire byte table.
 * @param refs - the references collected from the request history.
 * @param resolve - the context-owned durable byte resolver.
 * @returns the table keyed by attachment id; empty for an image-free request.
 * @throws LlmError `UNSUPPORTED_CONTENT` when the host has no resolver or a
 *   reference fails its integrity-verified read.
 */
export async function resolveWireImages(
  refs: readonly ImageAttachmentRef[],
  resolve: ((ref: ImageAttachmentRef) => Promise<StoredImageAttachment>) | undefined,
): Promise<WireImageTable> {
  if (refs.length === 0) return new Map()
  if (resolve === undefined) {
    throw new LlmError('image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
  }
  const table = new Map<string, WireImageBytes>()
  for (const ref of refs) {
    try {
      const stored = await resolve(ref)
      table.set(String(ref.attachmentId), { mediaType: stored.ref.mediaType, data: toBase64(stored.data) })
    } catch (error: unknown) {
      if (error instanceof AttachmentError) {
        throw new LlmError(`attachment read failed: ${error.message}`, 'UNSUPPORTED_CONTENT', { cause: error })
      }
      throw error
    }
  }
  return table
}

/** Chunked binary-string base64 (btoa spread limit). */
function toBase64(data: Uint8Array): string {
  let text = ''
  const chunk = 0x8000
  for (let i = 0; i < data.length; i += chunk) {
    text += String.fromCharCode(...data.subarray(i, i + chunk))
  }
  return btoa(text)
}

/**
 * The byte table entry for one image block, refusing a block the resolution
 * phase never populated (an internal wiring failure, not a user error).
 * @param table - the resolved request table.
 * @param ref - the block's durable reference.
 * @returns the resolved bytes.
 * @throws LlmError `UNSUPPORTED_CONTENT` when the entry is missing.
 */
export function wireImageOf(table: WireImageTable, ref: ImageAttachmentRef): WireImageBytes {
  const entry = table.get(String(ref.attachmentId))
  if (entry === undefined) {
    throw new LlmError('image block was not resolved before serialization', 'UNSUPPORTED_CONTENT')
  }
  return entry
}
