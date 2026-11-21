// @vitest-environment jsdom
/**
 * chrome-download-tool: the agent's browser-download lane. Pins the pure
 * pieces (filename sanitization, mime allowlist, data-URL building) and the
 * tool registration shape; the SW half (chrome.downloads) is exercised by the
 * automation probes on a real profile.
 * @module @deepseek-ai/dsh-extension/tests/chrome-download-tool
 */
import { describe, expect, it } from 'vitest'
import {
  apply,
  buildDownloadDataUrl,
  DOWNLOAD_MAX_CHARS,
  isAllowedMime,
  sanitizeDownloadFilename,
} from '../src/offscreen/chrome-download-tool.ts'
import { isDownloadRequest } from '../src/shared/protocol.ts'

describe('download filename sanitization', () => {
  it('strips path separators and control characters, keeps readable names', () => {
    expect(sanitizeDownloadFilename('site-example-com-apis.json')).toBe('site-example-com-apis.json')
    expect(sanitizeDownloadFilename('a/b\\c:d*e?f"g<h>i|.md')).toBe('a-b-c-d-e-f-g-h-i-.md')
    expect(sanitizeDownloadFilename('..hidden')).toBe('hidden')
    expect(sanitizeDownloadFilename('   ')).toBe('artifact.txt')
    expect(sanitizeDownloadFilename('x'.repeat(300))).toHaveLength(120)
  })
})

describe('download mime allowlist', () => {
  it('accepts text families and structured-text application types', () => {
    expect(isAllowedMime('text/plain;charset=utf-8')).toBe(true)
    expect(isAllowedMime('text/markdown')).toBe(true)
    expect(isAllowedMime('application/json')).toBe(true)
    expect(isAllowedMime('application/csv')).toBe(true)
  })
  it('refuses executable and unknown families', () => {
    expect(isAllowedMime('application/javascript')).toBe(false)
    expect(isAllowedMime('text/html')).toBe(true)
    expect(isAllowedMime('application/x-msdownload')).toBe(false)
    expect(isAllowedMime('')).toBe(false)
  })
})

describe('download data URL', () => {
  it('carries the content base64-encoded and round-trips UTF-8', () => {
    const url = buildDownloadDataUrl('application/json', '{"站点":"爬取"}')
    expect(url.startsWith('data:application/json;base64,')).toBe(true)
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), ch => ch.charCodeAt(0)),
    )
    expect(decoded).toBe('{"站点":"爬取"}')
  })
})

describe('download tool registration', () => {
  it('registers one download_file tool with the engine tool surface', () => {
    const registered: Array<{ name: string }> = []
    const ctx = {
      tools: {
        register: (tool: { name: string }): void => { registered.push(tool) },
      },
    }
    apply(ctx as never, {})
    expect(registered.map(tool => tool.name)).toEqual(['download_file'])
  })

  it('guards the content cap before any download fires', () => {
    expect(DOWNLOAD_MAX_CHARS).toBe(8_000_000)
  })
})

describe('download channel guard', () => {
  it('recognizes the SW request shape', () => {
    expect(isDownloadRequest({ channel: 'dsh-download', filename: 'a.json', url: 'data:text/plain;base64,QQ==' })).toBe(true)
    expect(isDownloadRequest({ channel: 'dsh-storage', op: 'get', keys: [] })).toBe(false)
  })
})
