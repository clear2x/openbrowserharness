/**
 * ComposerAttachments — the SidePanel composer's image-attachment strip:
 *
 *   [📎] [thumb 名称 ×] [thumb 名称 ×]
 *
 * A paperclip button opens the raster image picker (png/jpeg/webp/gif); each
 * attached file becomes one thumbnail chip with a remove button. The strip is
 * pure intake UI: files are validated client-side against the host's
 * image-intake limits (media type + per-image bytes), held as base64 plus an
 * object-URL thumbnail in module state, and handed to the shell's send
 * pipeline as `session.prompt` content parts
 * (`{ type: 'image', mediaType, data }` — temporary bytes the bridge promotes
 * to durable references at admission, apiproxy wire parity). The send
 * pipeline (`dispatchSendLine`) stays untouched: the shell reads the pending
 * parts when its `prompt` action fires.
 *
 * Everything lives in this new module so `composer-bar.tsx` carries no
 * attachment concerns; the shell concatenates {@link ATTACHMENT_CSS} beside
 * the other stylesheet exports.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { PaperclipIcon, CloseIcon } from './icons.tsx'

/** Raster media types the version-one attachment path accepts (host parity). */
export type AttachmentMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

const MEDIA_TYPES: readonly AttachmentMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Client-side per-image byte cap — mirrors the host's default admission limit. */
export const MAX_PENDING_IMAGE_BYTES = 5 * 1024 * 1024

/** One pending (unsent) composer attachment. */
export interface PendingAttachment {
  /** Stable local id for chip addressing. */
  readonly id: string
  /** Browser-provided file name, already path-free at the source. */
  readonly name: string
  readonly mediaType: AttachmentMediaType
  /** Full file bytes, base64 — the wire `data` field verbatim. */
  readonly dataBase64: string
  /** Object URL for the chip thumbnail; revoked on remove/clear/unmount. */
  readonly previewUrl: string
  readonly bytes: number
}

/** The wire content parts the shell's send pipeline attaches for one message. */
export interface PendingImagePart {
  type: 'image'
  mediaType: AttachmentMediaType
  /** Base64 bytes (the bridge decodes canonically and stores durably). */
  data: string
}

/** Chunked binary-string base64 — a 5 MB image would blow btoa's spread in one call. */
function base64Of(data: Uint8Array): string {
  let text = ''
  const chunk = 0x8000
  for (let i = 0; i < data.length; i += chunk) {
    text += String.fromCharCode(...data.subarray(i, i + chunk))
  }
  return btoa(text)
}

/** State and actions the strip and the shell's send pipeline share. */
export interface ComposerAttachmentsHandle {
  readonly attachments: readonly PendingAttachment[]
  /** Validate and stage image files; refusals surface through the strip's notice. */
  addFiles: (files: readonly File[]) => void
  remove: (id: string) => void
  clear(): void
}

/**
 * Composer attachment state: staged files for the current session, dropped on
 * session switch (attachments belong to the message being written, not to the
 * conversation), with object URLs revoked on every removal path.
 * @param sessionId - the session the composer is writing into.
 * @param onNotice - refusal feedback (wrong type, oversized file); the shell
 *   shows it beside the composer like its other transient notices.
 * @returns the shared handle.
 */
export function useComposerAttachments(sessionId: string, onNotice: (message: string) => void): ComposerAttachmentsHandle {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const counterRef = useRef(0)
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice
  // Preview URLs by attachment id, so every removal path revokes directly
  // (side effects never ride inside state updaters).
  const urlsRef = useRef(new Map<string, string>())

  const revokeAll = useCallback((): void => {
    for (const url of urlsRef.current.values()) URL.revokeObjectURL(url)
    urlsRef.current.clear()
  }, [])

  const remove = useCallback((id: string): void => {
    const url = urlsRef.current.get(id)
    if (url !== undefined) {
      URL.revokeObjectURL(url)
      urlsRef.current.delete(id)
    }
    setAttachments(current => current.filter(entry => entry.id !== id))
  }, [])

  const clear = useCallback((): void => {
    revokeAll()
    setAttachments([])
  }, [revokeAll])

  const addFiles = useCallback((files: readonly File[]): void => {
    void (async () => {
      for (const file of files) {
        if (!MEDIA_TYPES.includes(file.type as AttachmentMediaType)) {
          noticeRef.current(`不支持的图片类型「${file.name}」：仅接受 PNG / JPEG / WebP / GIF`)
          continue
        }
        if (file.size > MAX_PENDING_IMAGE_BYTES) {
          noticeRef.current(`图片「${file.name}」超过 5 MB 上限，未附上`)
          continue
        }
        try {
          const data = new Uint8Array(await file.arrayBuffer())
          counterRef.current += 1
          const id = `att-${String(counterRef.current)}-${Math.random().toString(36).slice(2, 8)}`
          const previewUrl = URL.createObjectURL(file)
          urlsRef.current.set(id, previewUrl)
          setAttachments(current => [...current, {
            id,
            name: file.name,
            mediaType: file.type as AttachmentMediaType,
            dataBase64: base64Of(data),
            previewUrl,
            bytes: file.size,
          }])
        } catch {
          noticeRef.current(`读取图片「${file.name}」失败`)
        }
      }
    })()
  }, [])

  // Session switch and unmount drop everything (and revoke the thumbnails).
  useEffect(() => {
    setAttachments([])
    return () => {
      revokeAll()
      setAttachments([])
    }
  }, [sessionId, revokeAll])

  return { attachments, addFiles, remove, clear }
}

/**
 * The wire content parts for one send: the staged images in attachment order.
 * @param attachments - the staged attachments.
 * @returns `session.prompt` image parts carrying the temporary base64 bytes.
 */
export function imagePromptParts(attachments: readonly PendingAttachment[]): PendingImagePart[] {
  return attachments.map(entry => ({
    type: 'image',
    mediaType: entry.mediaType,
    data: entry.dataBase64,
  }))
}

/** Props for {@link AttachmentStrip}. */
export interface AttachmentStripProps {
  /** The shared pending-attachment handle (`useComposerAttachments`). */
  handle: ComposerAttachmentsHandle
}

/**
 * The attachment strip rendered inside the composer's input wrap, under the
 * textarea: a paperclip button (opening a native multi-select image picker)
 * and one thumbnail chip per staged image (preview, name, remove button).
 * Renders nothing while no attachments are staged AND never has — the button
 * row stays visible so the affordance is discoverable.
 */
export function AttachmentStrip({ handle }: AttachmentStripProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const { attachments, addFiles, remove } = handle

  return (
    <div className="dshx-attbar" data-testid="composer-attachments">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          if (files.length > 0) addFiles(files)
          // Reset so picking the same file again re-fires change.
          event.target.value = ''
        }}
      />
      <button
        type="button"
        className="dshx-chip dshx-attbtn"
        aria-label="添加图片"
        title="添加图片（PNG / JPEG / WebP / GIF，≤5 MB）"
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon size={12} />
      </button>
      {attachments.map(entry => (
        <span key={entry.id} className="dshx-attchip" title={`${entry.name} · ${entry.mediaType}`}>
          <img className="dshx-attthumb" src={entry.previewUrl} alt="" />
          <span className="dshx-attname">{entry.name}</span>
          <button
            type="button"
            className="dshx-attremove"
            aria-label={`移除图片 ${entry.name}`}
            onClick={() => { remove(entry.id) }}
          >
            <CloseIcon size={10} />
          </button>
        </span>
      ))}
    </div>
  )
}

/**
 * Attachment strip styles (injected beside the shell's other stylesheet
 * exports): a slim row under the textarea — 22 px paperclip chip, thumbnail
 * chips with 18 px previews and hairline borders matching the composer card.
 */
export const ATTACHMENT_CSS = `
.dshx-attbar{display:flex;align-items:center;flex-wrap:wrap;gap:4px;padding:2px 0 6px}
.dshx-attbtn{height:22px;padding:0 6px}
.dshx-attchip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 3px 0 2px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));max-width:150px}
.dshx-attthumb{width:18px;height:18px;border-radius:5px;object-fit:cover;flex:none}
.dshx-attname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary,#888);min-width:0}
.dshx-attremove{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#aaa);cursor:pointer}
.dshx-attremove:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.1));color:var(--dsw-alias-label-primary,#333)}
`
