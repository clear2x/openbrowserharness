/**
 * The model-facing `page_screenshot` tool: captures the target tab as a PNG
 * (viewport or whole laid-out page), durably commits the bytes through the
 * attachment service (the same lifecycle as a user-uploaded image), and
 * returns an image block so the captured evidence enters model context from
 * the next request onward.
 *
 * Registration is attachment-conditional — the composing plugin calls
 * {@link applyScreenshotTool} inside `ctx.inject(['attachments'])` so the
 * tool exists only while a durable store is mounted. Execution re-checks the
 * store and the calling route's declared image input, the same gates
 * `read_image` runs; the provider layer owns the user opt-in toggle (an
 * unenabled capture refuses with the panel hint).
 * @module @deepseek-ai/dsh-tool-browser/src/screenshot
 */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-browser'
import { rememberScreenshotBytes } from './attach.ts'
import { parseTabId } from './args.ts'

/** The canonical outcome declared by the `page_screenshot` output schema. */
export interface PageScreenshotValue {
  tabId: number
  url: string
  captured: 'viewport' | 'full-page'
  image: {
    attachmentId: string
    /** Screenshots are always PNG captures. */
    mediaType: 'image/png'
    bytes: number
    width: number
    height: number
    name?: string
  }
}

/**
 * Enforce the image-capability gate for the calling route. Resolves the
 * session's latest routed provider/model (request header config, then agent
 * options) and requires the resolved route to declare `image` input — a tool
 * result enters durable session history, so emitting an image on a route that
 * cannot carry it would break that route's continuation.
 * @param ctx - the plugin context used to resolve the optional `llm` service.
 * @param exec - the tool-execution context supplying the calling agent.
 */
async function assertImageCapableRoute(ctx: Context, exec: ToolExecution): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('page_screenshot: the current model route could not be resolved')
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`page_screenshot: model "${model}" does not declare image input; switch to an image-capable model to capture screenshots`)
  }
}

/**
 * Re-brand the canonical image outcome into the durable attachment reference
 * an `ImageBlock` carries.
 * @param image - the canonical image metadata from the output schema.
 * @returns the branded attachment reference.
 */
function imageRefFromValue(image: PageScreenshotValue['image']): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

/**
 * Project one canonical screenshot into its model-facing envelope and image.
 * @param value - the canonical screenshot outcome.
 * @returns the content blocks used by native and nested dispatches.
 */
function screenshotContent(value: PageScreenshotValue): ContentBlock[] {
  const envelope = `<tab>${value.tabId}</tab>
<url>${value.url}</url>
<type>image</type>
<content>
${value.image.mediaType} screenshot (${value.captured}), ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes — the image rides the adjacent image block; describe what it shows when citing it as evidence
</content>`
  return [
    { type: 'text', text: envelope },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ]
}

/** One-shot screenshot counter for attachment display names. */
let screenshotSeq = 0

/**
 * Register the `page_screenshot` tool. Call from `ctx.inject(['attachments'])`
 * so a deployment without a durable store never sees the tool.
 * @param ctx - the registration scope; execution uses `browser` plus the
 *   optional `llm` service and the attachment store this scope was entered for.
 */
export function applyScreenshotTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'page_screenshot',
    description: '截取指定标签页的页面截图（默认视口，可选整页），图片会返回给你作为证据使用。需要当前模型支持图片输入。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      full_page: { type: 'boolean', description: '是否截取整个可滚动页面（默认 false，仅当前视口）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          url: { type: 'string', required: true },
          captured: { type: 'string', enum: ['viewport', 'full-page'], required: true },
          image: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', enum: ['image/png'], required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => screenshotContent(value),
    },
    // Content-addressed attachment writes are idempotent, and a capture never
    // changes page state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const tabId = parseTabId(args.tab_id)
      const fullPage = args.full_page === true
      // Every gate runs before any capture I/O so a refusal never leaks
      // partial attachment writes.
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error('page_screenshot: no attachment service is mounted')
      }
      if (!attachments.imageLimits.mediaTypes.includes('image/png')) {
        throw new Error('page_screenshot: PNG captures are not accepted by this deployment')
      }
      await assertImageCapableRoute(ctx, exec)

      const captured = await ctx.browser.provider.screenshot(tabId, { fullPage })
      // The tool result is one message carrying one image, so the per-message
      // aggregate bound applies beside the per-image bound.
      const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      if (captured.data.byteLength > byteCap) {
        throw new Error(`page_screenshot: the capture is ${captured.data.byteLength} bytes, above this deployment's ${byteCap}-byte image cap; capture a viewport instead of the full page`)
      }
      screenshotSeq += 1
      // Persist before returning: the image block must reference a durably
      // committed object by the time the tool/result event is appended.
      const ref = await attachments.saveImage({
        data: captured.data,
        mediaType: captured.mediaType,
        name: `screenshot-${Date.now()}-${screenshotSeq}.png`,
      })
      // Cache the bytes for a later page_attach_screenshot: the durable store
      // holds them for session history, but the attach path needs direct
      // extension → page transfer without a model round-trip.
      rememberScreenshotBytes(ref.attachmentId, {
        data: captured.data,
        mediaType: captured.mediaType,
        width: ref.width,
        height: ref.height,
        ...ref.name === undefined ? {} : { name: ref.name },
      })
      const tab = (await ctx.browser.provider.tabs()).find(entry => entry.tabId === tabId)
      const value: PageScreenshotValue = {
        tabId,
        url: tab?.url ?? '',
        captured: fullPage ? 'full-page' : 'viewport',
        image: {
          attachmentId: ref.attachmentId,
          // The save input above is exactly 'image/png'; the store round-trips
          // the declared type, so the union-typed ref fact narrows here.
          mediaType: ref.mediaType as 'image/png',
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
        },
      }
      if (exec.parent !== undefined) {
        exec.deferContext(createUserMessage({
          content: screenshotContent(value),
          source: { kind: 'plugin', plugin: 'tool-browser' },
        }))
      }
      return value
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: `截图标签页 ${args.tab_id}${args.full_page === true ? '（整页）' : ''}`,
      kind: 'read',
    }),
  }))
}
