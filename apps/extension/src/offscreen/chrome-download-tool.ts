/**
 * `chrome-download-tool`: the agent's browser-download lane. Engine-side file
 * writes land in the OPFS workspace (invisible unless the user links a local
 * folder), so produced artifacts — 爬取清单、认证导出、报告 — never reached
 * the user's Downloads directory on their own. This tool hands content to the
 * service worker (`dsh-download` channel, shared/protocol.ts) which routes a
 * data: URL through chrome.downloads: a real browser download, no network,
 * no host. The visible-page export path (downloadSessionMarkdown) keeps its
 * own anchor flow.
 *
 * @module chrome-download-tool
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DOWNLOAD_CHANNEL } from '../shared/protocol.ts'
import type { DownloadResponse } from '../shared/protocol.ts'

/** Tools carry no config today. */
export interface Config {}

/** Accessing ctx.tools requires the dependency to be declared (cordis gate). */
export const inject = ['tools']

/** One artifact download's hard cap (data URLs ride memory). */
export const DOWNLOAD_MAX_CHARS = 8_000_000

/** MIME families a produced artifact may carry (text-shaped deliverables). */
const MIME_RE = /^(text\/[a-z0-9.+-]+|application\/(json|csv|x-yaml|xml|octet-stream))(;|$)/

/** Sanitize one download filename: path separators and control-ish picks out. */
export function sanitizeDownloadFilename(raw: string): string {
  const cleaned = raw
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim()
  return cleaned === '' ? 'artifact.txt' : cleaned.slice(0, 120)
}

/** Whether one mime is an allowed artifact family. */
export function isAllowedMime(mime: string): boolean {
  return MIME_RE.test(mime)
}

/** UTF-8-safe base64 (btoa alone corrupts non-ASCII). */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Build the data: URL one download rides (content stays local to the browser). */
export function buildDownloadDataUrl(mime: string, content: string): string {
  return `data:${mime};base64,${toBase64(content)}`
}

/** Send one download request to the service worker and await the outcome. */
function requestDownload(filename: string, url: string): Promise<DownloadResponse> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { channel: DOWNLOAD_CHANNEL, filename, url },
        (response: unknown) => {
          if (chrome.runtime.lastError !== undefined) {
            resolve({ ok: false, error: chrome.runtime.lastError.message ?? '下载通道不可用' })
            return
          }
          resolve((response ?? { ok: false, error: '下载通道无响应' }) as DownloadResponse)
        },
      )
    } catch (err: unknown) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

/**
 * Register the `download_file` tool on ctx.tools: one artifact per call, the
 * browser's own download flow, the user's Downloads directory.
 */
export function apply(ctx: Context, _config: Config): void {
  void _config

  ctx.tools.register(defineTool({
    name: 'download_file',
    description: '把产物作为文件下载到用户浏览器的「下载」目录（数据 URL 直落本地，不经网络）。适合交付清单、报告、JSON/CSV/文本等文字型产物；单次上限约 800 万字符。大文件或二进制请改用 write 工具写工作区。',
    parameters: {
      filename: { type: 'string', required: true, description: '下载文件名（如 site-example-com-apis.json）' },
      content: { type: 'string', required: true, description: '文件的完整文本内容' },
      mime: { type: 'string', description: 'MIME 类型，默认 text/plain；支持 text/* 与 application/json、csv、xml、x-yaml、octet-stream' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          downloaded: { type: 'boolean', required: true },
          filename: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.downloaded === true
          ? `已通过浏览器下载：${value.filename}（见下载目录）`
          : `下载失败：${value.error ?? '未知原因'}`,
      }],
    },
    async execute(args) {
      const filename = sanitizeDownloadFilename(String(args.filename ?? ''))
      const content = String(args.content ?? '')
      const requestedMime = String(args.mime ?? 'text/plain').toLowerCase()
      if (filename === '') {
        return { downloaded: false, filename: '', error: '文件名无效' }
      }
      if (content.length > DOWNLOAD_MAX_CHARS) {
        return { downloaded: false, filename, error: `内容超出单次下载上限（${DOWNLOAD_MAX_CHARS} 字符）——请分段或写工作区` }
      }
      const mime = requestedMime === '' || requestedMime === 'text/plain' ? 'text/plain;charset=utf-8' : requestedMime
      if (!isAllowedMime(mime)) {
        return { downloaded: false, filename, error: `不支持的 MIME 类型：${mime}` }
      }
      const response = await requestDownload(filename, buildDownloadDataUrl(mime, content))
      if (!response.ok) {
        return { downloaded: false, filename, error: response.error ?? '下载失败' }
      }
      return { downloaded: true, filename }
    },
    presentCall: () => ({ card: 'generic', title: '下载文件', kind: 'other' }),
  }))
}
