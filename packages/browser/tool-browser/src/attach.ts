/**
 * The model-facing `page_attach_screenshot` tool: writes a previously captured
 * `page_screenshot` image into a page file input (`<input type="file">`) and
 * dispatches `input`/`change`, so the agent can hand screenshot evidence to
 * web forms (upload fields, paste targets built on file inputs).
 *
 * The image bytes never round-trip through the model: `page_screenshot` caches
 * them here at capture time keyed by attachment id, and execution injects a
 * base64-bearing script through the browser seam. A cache miss (engine
 * restarted since the capture) refuses with recovery guidance instead of
 * silently re-capturing the wrong page.
 * @module @deepseek-ai/dsh-tool-browser/src/attach
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-browser'
import { parseSelector, parseTabId } from './args.ts'

/** Cached screenshots kept for `page_attach_screenshot`; oldest entry evicted. */
const CACHE_LIMIT = 4

/** Cached capture bytes plus the facts the injected File and result echo need. */
interface CachedScreenshot {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly width: number
  readonly height: number
  readonly name?: string
}

/**
 * Insertion-ordered cache of recent capture bytes. Engine-lifetime state: a
 * restart empties it and the attach tool fails loudly until a fresh capture.
 */
const recentScreenshots = new Map<string, CachedScreenshot>()

/**
 * Remember one capture's bytes for a later `page_attach_screenshot` call.
 * @param attachmentId - the durable id `page_screenshot` already returned.
 * @param cached - capture bytes and raster facts.
 */
export function rememberScreenshotBytes(attachmentId: string, cached: CachedScreenshot): void {
  recentScreenshots.delete(attachmentId)
  recentScreenshots.set(attachmentId, cached)
  while (recentScreenshots.size > CACHE_LIMIT) {
    const oldest = recentScreenshots.keys().next()
    if (oldest.done === true) break
    recentScreenshots.delete(oldest.value)
  }
}

/**
 * Read one cached capture.
 * @param attachmentId - the id the model cites from its `page_screenshot` result.
 * @returns the cached bytes, or undefined when the id is unknown or evicted.
 */
export function readScreenshotBytes(attachmentId: string): CachedScreenshot | undefined {
  const cached = recentScreenshots.get(attachmentId)
  if (cached === undefined) return undefined
  return cached
}

/**
 * Read the most recently captured bytes (insertion order — reads never
 * reorder, so the last entry is always the newest capture).
 * @returns the newest cached capture, or undefined when the cache is empty.
 */
export function readNewestScreenshot(): { attachmentId: string; cached: CachedScreenshot } | undefined {
  let newest: { attachmentId: string; cached: CachedScreenshot } | undefined
  for (const [id, cached] of recentScreenshots) newest = { attachmentId: id, cached }
  return newest
}

/** Clear the cache; test isolation only. */
export function clearScreenshotBytes(): void {
  recentScreenshots.clear()
}

/** Encode bytes as base64 in ~32 KiB chunks to stay under argument-count limits. */
function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < data.length; start += 0x8000) {
    binary += String.fromCharCode(...data.subarray(start, start + 0x8000))
  }
  return btoa(binary)
}

/** Strip path separators from a display/file name; fall back to a fixed name. */
function safeFileName(raw: string | undefined): string {
  const cleaned = (raw ?? '').replace(/[\\/]/g, '_').trim()
  return cleaned.length > 0 ? cleaned : 'screenshot.png'
}

/** Canonical `page_attach_screenshot` outcome declared by the output schema. */
export interface PageAttachScreenshotValue {
  tabId: number
  selector: string
  attachmentId: string
  file: {
    name: string
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
  }
}

/**
 * Register the `page_attach_screenshot` tool. Call beside
 * {@link applyScreenshotTool} inside `ctx.inject(['attachments'])` — without a
 * mounted store no capture exists to attach, so the tool never registers.
 * @param ctx - registration scope; execution uses `browser` only.
 */
export function applyScreenshotAttachTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'page_attach_screenshot',
    description: '把之前 page_screenshot 截取的图片写入页面上的文件输入框（<input type="file">），并派发 input/change 事件。用于把截图证据上传/粘贴进网页表单。省略 attachment_id 时默认使用最近一次 page_screenshot 的截图；也可以传 page_screenshot 结果里的 attachmentId 指定某一次截图。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id（文件输入框所在的页面）。' },
      attachment_id: { type: 'string', description: '要贴入的截图：省略则用最近一次 page_screenshot 的截图；指定时传 page_screenshot 结果返回的 attachmentId。' },
      selector: { type: 'string', required: true, description: '目标文件输入框的 CSS selector。' },
      filename: { type: 'string', description: '写入的文件名（省略则沿用截图名或 screenshot.png）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          selector: { type: 'string', required: true },
          attachmentId: { type: 'string', required: true },
          file: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              name: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已把截图 ${value.file.name}（${value.file.width}x${value.file.height} px，${value.file.bytes} 字节）写入标签页 ${value.tabId} 的文件输入框 ${value.selector}，并派发了 input/change 事件。页面若展示缩略图或文件名，回读确认即可。`,
      }],
    },
    // Writing page state: never parallelize with other page mutations.
    async execute(args, _exec) {
      const tabId = parseTabId(args.tab_id)
      const selector = parseSelector(args.selector)
      const citedId = typeof args.attachment_id === 'string' && args.attachment_id.trim().length > 0
        ? args.attachment_id.trim()
        : undefined
      let attachmentId: string
      let cached: CachedScreenshot | undefined
      if (citedId === undefined) {
        const newest = readNewestScreenshot()
        if (newest === undefined) {
          throw new Error('page_attach_screenshot：截图缓存为空——请先在本会话调用 page_screenshot，再重试')
        }
        attachmentId = newest.attachmentId
        cached = newest.cached
      } else {
        attachmentId = citedId
        cached = readScreenshotBytes(citedId)
      }
      if (cached === undefined) {
        // Only reachable when a cited id missed the cache; the no-citation
        // path above already threw on an empty cache.
        throw new Error(`page_attach_screenshot：attachment_id ${JSON.stringify(citedId)} 没有可用的截图字节（缓存为空或已被清理）；请先在本会话重新调用 page_screenshot，再用其返回的 attachmentId 重试`)
      }
      const fileName = safeFileName(args.filename === undefined ? cached.name : args.filename)
      // The base64 payload is embedded in the script source by the tool itself,
      // so the bytes travel extension → page directly and never via the model.
      const expression = `(() => {
  const binary = atob(${JSON.stringify(bytesToBase64(cached.data))});
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(cached.mediaType)} });
  const list = new DataTransfer();
  list.items.add(file);
  const input = document.querySelector(${JSON.stringify(selector)});
  if (input === null) return { ok: false, error: 'selector 未匹配到元素' };
  if (!(input instanceof HTMLInputElement) || input.type !== 'file') return { ok: false, error: '目标元素不是 <input type="file">' };
  input.files = list.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, name: file.name, size: file.size };
})()`
      const outcome = await ctx.browser.provider.evaluate<{ ok: boolean; error?: string; name?: string; size?: number }>(tabId, expression)
      if (!outcome.ok) {
        throw new Error(`page_attach_screenshot：${outcome.error ?? '页面写入失败'}`)
      }
      return {
        tabId,
        selector,
        attachmentId,
        file: {
          name: fileName,
          mediaType: cached.mediaType,
          bytes: cached.data.byteLength,
          width: cached.width,
          height: cached.height,
        },
      }
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: `粘贴截图到 ${args.selector}`,
      kind: 'execute',
      rawInput: args.selector,
    }),
  }))
}
