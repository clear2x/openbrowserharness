/**
 * Browser stub for the MCP SDK's stdio transport: the offscreen document
 * cannot spawn child processes, so the transport factory's `stdio` branch is
 * compiled to this refusing stand-in. Configuring a stdio server fails at
 * connection time with the actionable remedy instead of failing the whole
 * offscreen bundle at build time (the real transport imports node:stream).
 */

import type { Transport } from '@modelcontextprotocol/client'

function refuse(): Promise<never> {
  return Promise.reject(new Error('MCP stdio transport is unavailable in the browser extension.'))
}

export class StdioClientTransport implements Transport {
  constructor() {
    throw new Error(
      'MCP stdio 传输在浏览器扩展中不可用（无法启动子进程）——请改用 streamable-http 传输（填 url）。',
    )
  }

  start(): Promise<void> {
    return refuse()
  }

  send(): Promise<void> {
    return refuse()
  }

  close(): Promise<void> {
    return refuse()
  }
}
