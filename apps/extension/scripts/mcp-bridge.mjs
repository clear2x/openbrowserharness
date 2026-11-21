#!/usr/bin/env node
/**
 * OpenBrowserHarness MCP bridge — the local process that turns the browser
 * extension into an MCP server.
 *
 *   node scripts/mcp-bridge.mjs
 *
 * Why a bridge: MV3 extensions cannot listen on sockets, so the extension
 * DIALS OUT. This process is the other end:
 *
 *   external harness / agent  ⇄ (MCP over stdio)  ⇄  this bridge
 *                                                        ⇅ (WebSocket, loopback only)
 *                                            extension offscreen document
 *                                                        ⇅ (chrome.runtime Port)
 *                                          the full dsh-api RPC surface
 *
 * stdio speaks newline-delimited JSON-RPC (the MCP stdio transport): point
 * any MCP client at `command: node, args: [<repo>/apps/extension/scripts/
 * mcp-bridge.mjs]`. The WebSocket server on 127.0.0.1:8766 expects exactly
 * one extension connection; until it arrives, tool calls fail fast with
 * "extension not connected" (flip the 服务 panel's MCP 服务器 toggle).
 *
 * Zero npm dependencies: the WebSocket server is hand-rolled RFC 6455
 * (handshake + text frames + ping/pong, one client).
 */
import http from 'node:http'
import crypto from 'node:crypto'

const WS_PORT = 8766
const WS_PROTOCOL = 'dsh-mcp-bridge-v1'
const RPC_TIMEOUT_MS = 130_000

// ── WebSocket client state (the extension side) ─────────────────────────
/** @type {{ sock: import('node:net').Socket, send: (obj: unknown) => void } | undefined} */
let ext = undefined
let nextRequestId = 1
/** RPC id → { resolve, timer } for calls forwarded to the extension. */
const pending = new Map()

function forwardToExtension(method, params) {
  if (ext === undefined) {
    return Promise.reject(new Error('extension not connected（在扩展「服务」面板打开 MCP 服务器开关）'))
  }
  const id = nextRequestId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('extension RPC 超时'))
    }, RPC_TIMEOUT_MS)
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (err) => { clearTimeout(timer); reject(err) },
    })
    ext.send({ kind: 'mcp-request', id, method, params })
  })
}

// ── Minimal RFC 6455 server (loopback, one client, text frames) ─────────
const wsServer = http.createServer((req, res) => {
  res.writeHead(404).end('MCP bridge WebSocket endpoint only\n')
})
wsServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(s => s.trim())
  if (key === undefined || (protocols.length > 0 && !protocols.includes(WS_PROTOCOL))) {
    socket.destroy()
    return
  }
  if (ext !== undefined) {
    // One extension at a time: the newcomer replaces a dead peer silently.
    try {
      ext.sock.destroy()
    } catch { /* already gone */ }
    ext = undefined
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Protocol: ${WS_PROTOCOL}\r\n` +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.setNoDelay(true)

  /** @type {Buffer[]} */ const fragments = []
  let buffer = Buffer.alloc(0)
  let helloed = false

  const sendFrame = (opcode, payload) => {
    const len = payload.length
    let header
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len])
    } else if (len < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    socket.write(Buffer.concat([header, payload]))
  }
  const client = {
    sock: socket,
    send: (obj) => sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')),
  }
  ext = client
  logErr('extension connected')

  const dispatchFrame = (opcode, data) => {
    if (opcode === 0x9) { sendFrame(0xA, data); return }        // ping → pong
    if (opcode === 0xA) return                                   // pong
    if (opcode === 0x8) {                                        // close: echo + drop
      try {
        sendFrame(0x8, data)
      } catch { /* socket already dying */ }
      socket.destroy()
      return
    }
    fragments.push(data)
    const payload = Buffer.concat(fragments)
    fragments.length = 0
    let frame
    try {
      frame = JSON.parse(payload.toString('utf8'))
    } catch {
      return
    }
    if (frame?.kind === 'hello' && frame?.role === 'extension') {
      helloed = true
      return
    }
    if (frame?.kind === 'mcp-response' && typeof frame.id === 'number') {
      const waiter = pending.get(frame.id)
      if (waiter === undefined) return
      pending.delete(frame.id)
      if (frame.error !== undefined) waiter.reject(new Error(String(frame.error.message ?? 'extension error')))
      else waiter.resolve(frame.result)
    }
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) break
      const fin = (buffer[0] & 0x80) !== 0
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let len = buffer[1] & 0x7f
      let offset = 2
      if (len === 126) {
        if (buffer.length < 4) break
        len = buffer.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buffer.length < 10) break
        len = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      const maskKey = masked ? buffer.subarray(offset, offset + 4) : undefined
      if (maskKey !== undefined) offset += 4
      if (buffer.length < offset + len) break
      let payload = buffer.subarray(offset, offset + len)
      if (maskKey !== undefined) {
        const unmasked = Buffer.alloc(len)
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i & 3]
        payload = unmasked
      }
      buffer = buffer.subarray(offset + len)
      if (opcode === 0x8) {
        dispatchFrame(opcode, payload)
        return
      }
      if (opcode === 0x1 || opcode === 0x0 || opcode === 0x9) {
        if (fin) dispatchFrame(opcode, payload)
        else fragments.push(payload)
      }
    }
  })
  const drop = () => {
    if (ext === client) {
      ext = undefined
      logErr('extension disconnected')
    }
    for (const waiter of pending.values()) waiter.reject(new Error('extension disconnected'))
    pending.clear()
  }
  socket.on('close', drop)
  socket.on('error', drop)
})

// ── MCP over stdio (newline-delimited JSON-RPC) ──────────────────────────
const SERVER_INFO = { name: 'openbrowserharness', version: '0.1.0' }

function mcpError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}
function mcpResult(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

async function onMcpRequest(msg) {
  if (msg.method === 'initialize') {
    mcpResult(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: 'Drive the OpenBrowserHarness browser extension: create/prompt sessions, poll session_history for the agent\'s replies and browser actions, or use dsh_rpc for the full RPC surface.',
    })
    return
  }
  if (msg.method === 'ping') {
    mcpResult(msg.id, {})
    return
  }
  if (msg.method === 'tools/list') {
    mcpResult(msg.id, { tools: (await forwardToExtension('tools/list', {})).tools })
    return
  }
  if (msg.method === 'tools/call') {
    const out = await forwardToExtension('tools/call', msg.params ?? {})
    mcpResult(msg.id, out)
    return
  }
  mcpError(msg.id, -32601, `unknown method ${String(msg.method)}`)
}

let stdinBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk
  let nl
  while ((nl = stdinBuffer.indexOf('\n')) >= 0) {
    const line = stdinBuffer.slice(0, nl).trim()
    stdinBuffer = stdinBuffer.slice(nl + 1)
    if (line === '') continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id === undefined) continue // notification (initialized) — no reply
    onMcpRequest(msg).catch(err => {
      mcpError(msg.id, -32603, String(err?.message ?? err))
    })
  }
})

function logErr(...parts) {
  process.stderr.write('[mcp-bridge] ' + parts.join(' ') + '\n')
}

wsServer.listen(WS_PORT, '127.0.0.1', () => {
  logErr(`websocket server on ws://127.0.0.1:${WS_PORT} — waiting for the extension (服务面板 → MCP 服务器 → 开)`)
  logErr('stdio MCP server ready — point your MCP client at this process')
})
wsServer.on('error', (err) => {
  logErr(`websocket server failed: ${String(err.message)} (is another bridge already running on ${WS_PORT}?)`)
  process.exit(1)
})
