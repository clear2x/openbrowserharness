// @vitest-environment jsdom
/**
 * Composer attachment strip spec (SidePanel composer): the paperclip picker
 * stages raster images as thumbnail chips (name + preview + remove), refuses
 * unsupported types and oversized files through the notice, maps staged
 * attachments to `session.prompt` image parts in attachment order, and drops
 * everything on a session switch. URL.createObjectURL is stubbed — jsdom
 * has no object-URL store.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  AttachmentStrip,
  MAX_PENDING_IMAGE_BYTES,
  imagePromptParts,
  useComposerAttachments,
} from '../src/sidepanel-dsh/composer-attachments.tsx'

/** jsdom lacks the object-URL store; hand out stable fakes. */
const createdUrls: string[] = []
vi.stubGlobal('URL', {
  ...URL,
  createObjectURL: (blob: Blob) => {
    const url = `blob:fake-${String(createdUrls.length)}-${String(blob.size)}`
    createdUrls.push(url)
    return url
  },
  revokeObjectURL: (url: string) => {
    const index = createdUrls.indexOf(url)
    if (index >= 0) createdUrls.splice(index, 1)
  },
})

/** A tiny valid PNG payload (only the sniffed type matters to the strip). */
const PNG_FILE = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'shot.png', { type: 'image/png' })

/** Test harness: owns the hook so a render drives the real state machine. */
function Harness(props: { sessionId: string; notices: string[] }): JSX.Element {
  const handle = useComposerAttachments(props.sessionId, (message) => {
    props.notices.push(message)
  })
  handleRef.current = handle
  return <AttachmentStrip handle={handle} />
}

const handleRef: { current: ReturnType<typeof useComposerAttachments> | undefined } = { current: undefined }

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 50 && !predicate(); i++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
  }
  expect(predicate()).toBe(true)
}

describe('composer-attachments', () => {
  afterEach(() => {
    cleanup()
    handleRef.current?.clear()
    createdUrls.length = 0
  })

  it('stages picked images as thumbnail chips with remove buttons', async () => {
    const notices: string[] = []
    render(<Harness sessionId="session-main" notices={notices} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement

    await act(async () => {
      fireEvent.change(input, { target: { files: [PNG_FILE] } })
    })
    await waitFor(() => handleRef.current?.attachments.length === 1)

    const chip = screen.getByTitle(/shot\.png/)
    expect(chip.textContent).toContain('shot.png')
    const thumb = chip.querySelector('img')
    expect(thumb?.getAttribute('src')).toMatch(/^blob:fake-/)
    expect(handleRef.current?.attachments[0]?.mediaType).toBe('image/png')

    // Remove empties the strip and revokes the preview URL.
    act(() => {
      fireEvent.click(screen.getByLabelText('移除图片 shot.png'))
    })
    await waitFor(() => handleRef.current?.attachments.length === 0)
    expect(createdUrls).toHaveLength(0)
  })

  it('refuses unsupported types and oversized files through the notice', async () => {
    const notices: string[] = []
    render(<Harness sessionId="session-main" notices={notices} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement

    const svg = new File([new Uint8Array([1, 2, 3])], 'logo.svg', { type: 'image/svg+xml' })
    const huge = new File([new Uint8Array(MAX_PENDING_IMAGE_BYTES + 1)], 'big.png', { type: 'image/png' })
    await act(async () => {
      fireEvent.change(input, { target: { files: [svg, huge] } })
    })
    await waitFor(() => notices.length === 2)
    expect(handleRef.current?.attachments).toHaveLength(0)
    expect(notices[0]).toContain('不支持的图片类型')
    expect(notices[1]).toContain('超过 5 MB')
  })

  it('maps staged attachments to prompt image parts and drops them on session switch', async () => {
    const notices: string[] = []
    const { rerender } = render(<Harness sessionId="session-main" notices={notices} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [PNG_FILE] } })
    })
    await waitFor(() => handleRef.current?.attachments.length === 1)

    expect(imagePromptParts(handleRef.current?.attachments ?? [])).toEqual([
      { type: 'image', mediaType: 'image/png', data: handleRef.current?.attachments[0]?.dataBase64 },
    ])

    // A session switch clears the staging (attachments belong to the message
    // being written, not to the conversation) and revokes the previews.
    rerender(<Harness sessionId="session-other" notices={notices} />)
    await waitFor(() => handleRef.current?.attachments.length === 0)
    expect(createdUrls).toHaveLength(0)
  })
})
