/**
 * sense-companion: the Route-B localhost companion — wraps the Sense Now
 * video engine (`sense-now/video-index`, FFmpeg/ASR-grade) as an MCP
 * Streamable HTTP server the extension's MCP panel can mount. Zero runtime
 * dependencies beyond what the user installs for the engine itself:
 *
 *   node sense-companion.mjs [--port 8767] [--root ~/.dsh-companion]
 *
 * Tools:
 *   sense_status       — companion facts (node/ffmpeg/sense-now availability)
 *   sense_video_index  — the full-power video_index passthrough; requires
 *                        `npm i sense-now` next to this script (first-run
 *                        calls return the honest install hint otherwise).
 *
 * Protocol surface (MCP Streamable HTTP): POST /mcp JSON-RPC
 * (initialize / notifications/initialized / tools/list / tools/call / ping),
 * GET /mcp → 405 (no server→client stream), DELETE /mcp → 204. Binds
 * 127.0.0.1 only — this server exists to serve THIS machine's extension.
 * @module sense-companion
 */

import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const PORT = Number(flag('port') ?? 8767)
const ROOT = resolve(flag('root') ?? join(homedir(), '.dsh-companion'))
/**
 * The sense-now package location: an npm install next to this script by
 * default, or an explicit checkout via --sense-now (the repo/package root
 * holding src/video-index-tool.js).
 */
const SENSE_NOW_PATH = flag('sense-now') === undefined ? undefined : resolve(flag('sense-now'))

const SERVER_INFO = { name: 'sense-companion', version: '0.1.0' }

/** The MCP tool definitions the companion advertises. */
const TOOLS = [
  {
    name: 'sense_status',
    description: '伴生服务状态：node/ffmpeg/sense-now 可用性与其数据根目录。调用 sense_video_index 前先用它确认环境。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sense_video_index',
    description: '满血版长视频索引（伴生进程）：FFmpeg 抽帧/内嵌字幕/ASR/说话人分离全开。参数与 video_index 同形（action=index/query/status/list/remove…，source=url|file）。需要本机 `npm i sense-now` 且 FFmpeg 在 PATH。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'index/query/status/list/remove' },
        url: { type: 'string', description: 'B 站视频页 URL' },
        path: { type: 'string', description: '本地视频文件路径（index, source=file）' },
        videoKey: { type: 'string', description: '索引键（query/status/remove）' },
        question: { type: 'string', description: '问题（query）' },
      },
      additionalProperties: false,
    },
  },
]

/**
 * Probe the local environment: ffmpeg on PATH, sense-now importability.
 * @returns the status facts.
 */
async function collectStatus() {
  let ffmpeg = { available: false, version: '' }
  try {
    const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000 })
    const first = (probe.stdout ?? '').split('\n')[0] ?? ''
    ffmpeg = probe.status === 0 ? { available: true, version: first.slice(0, 80) } : { available: false, version: '' }
  } catch {
    // ffmpeg absent stays reported as unavailable.
  }
  let senseNow = { installed: false, detail: '' }
  try {
    const mod = await importSenseNow()
    senseNow = { installed: true, detail: `exports: ${Object.keys(mod).join(', ').slice(0, 200)}` }
  } catch (err) {
    senseNow = { installed: false, detail: err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160) }
  }
  return {
    node: process.version,
    root: ROOT,
    ffmpeg,
    senseNow,
    installHint: 'cd 到本脚本目录后执行 npm i sense-now（引擎自举），FFmpeg 装入 PATH',
  }
}

/**
 * Import the sense-now tool layer: the --sense-now checkout when given,
 * else the npm package next to this script.
 * @returns the module namespace.
 */
async function importSenseNow() {
  const specifier = SENSE_NOW_PATH === undefined
    ? 'sense-now/video-index-tool'
    : `file://${join(SENSE_NOW_PATH, 'src', 'video-index-tool.js')}`
  return import(specifier)
}

/**
 * Dispatch the full-power video_index through the sense-now tool layer
 * (createVideoIndexTool().route — the complete Sense Now action surface:
 * indexAdaptive with FFmpeg/ASR/OCR adapters, query, status, list, remove).
 * @param args - the tool arguments ({action, url, path, videoKey, question, ...}).
 * @returns the engine's result serialized as text.
 */
async function runVideoIndex(args) {
  let mod
  try {
    mod = await importSenseNow()
  } catch (err) {
    const hint = SENSE_NOW_PATH === undefined
      ? '在本脚本目录执行 npm i sense-now，或用 --sense-now 指向 sense-now 仓库根后重启'
      : `检查 --sense-now 路径下是否存在 src/video-index-tool.js：${SENSE_NOW_PATH}`
    return {
      isError: true,
      text: `sense-now 工具层未加载——${hint}（原因：${err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160)}）`,
    }
  }
  if (typeof mod.createVideoIndexTool !== 'function') {
    return { isError: true, text: `sense-now/video-index-tool 未暴露 createVideoIndexTool（实际导出：${Object.keys(mod).join(', ').slice(0, 200)}）` }
  }
  const tool = mod.createVideoIndexTool({ rootDir: join(ROOT, 'video-index') })
  const result = await tool.route(args ?? {}, {})
  return { text: JSON.stringify(result) }
}

/**
 * Dispatch one tools/call by name.
 * @param name - the tool name.
 * @param toolArgs - the parsed tool arguments.
 * @returns the MCP tool result.
 */
async function callTool(name, toolArgs) {
  if (name === 'sense_status') {
    const status = await collectStatus()
    return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] }
  }
  if (name === 'sense_video_index') {
    const outcome = await runVideoIndex(toolArgs ?? {})
    return { content: [{ type: 'text', text: outcome.text }], ...(outcome.isError === true ? { isError: true } : {}) }
  }
  return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true }
}

/**
 * Handle one JSON-RPC request body.
 * @param body - the parsed JSON-RPC message.
 * @param sessionId - the issued session id (echoed on responses).
 * @returns { status, body, session } — body undefined for notifications.
 */
async function handleRpc(body, sessionId) {
  const session = sessionId
  const method = body?.method
  if (method === 'initialize') {
    return {
      status: 200,
      session,
      body: {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: body.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      },
    }
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return { status: 202, session, body: undefined }
  }
  if (method === 'tools/list') {
    return { status: 200, session, body: { jsonrpc: '2.0', id: body.id, result: { tools: TOOLS } } }
  }
  if (method === 'tools/call') {
    const result = await callTool(body.params?.name, body.params?.arguments)
    return { status: 200, session, body: { jsonrpc: '2.0', id: body.id, result } }
  }
  if (method === 'ping') {
    return { status: 200, session, body: { jsonrpc: '2.0', id: body.id, result: {} } }
  }
  return {
    status: 200,
    session,
    body: { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32601, message: `Method not found: ${String(method)}` } },
  }
}

/** Random-enough session token. */
function newSessionId() {
  return `sense-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Handle one POST /mcp request (one JSON-RPC message or a batch).
 * @param req - the request.
 * @param res - the response.
 * @param base - the CORS/PNA headers every response carries.
 */
async function handlePost(req, res, base) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
    return
  }
  const session = req.headers['mcp-session-id'] !== undefined ? String(req.headers['mcp-session-id']) : newSessionId()
  if (Array.isArray(body)) {
    const results = []
    for (const message of body) {
      const outcome = await handleRpc(message, session)
      if (outcome.body !== undefined) results.push(outcome.body)
    }
    res.writeHead(200, { ...base, 'content-type': 'application/json', 'mcp-session-id': session })
    res.end(JSON.stringify(results))
    return
  }
  const outcome = await handleRpc(body, session)
  res.writeHead(outcome.status, {
    ...base,
    'content-type': outcome.body === undefined ? 'text/plain' : 'application/json',
    ...(outcome.body === undefined ? {} : { 'mcp-session-id': outcome.session }),
  })
  res.end(outcome.body === undefined ? '' : JSON.stringify(outcome.body))
}

/**
 * The CORS + Private-Network headers every response carries: the extension
 * page (chrome-extension:// origin) fetching 127.0.0.1 is a private-network
 * request — Chrome preflights it and requires the target to opt in.
 * @returns the header record.
 */
function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version, authorization, last-event-id',
    'access-control-expose-headers': 'mcp-session-id',
    'access-control-allow-private-network': 'true',
  }
}

const server = http.createServer((req, res) => {
  const base = corsHeaders()
  if (req.method === 'OPTIONS' && (req.url === '/mcp' || req.url.startsWith('/mcp?'))) {
    res.writeHead(204, { ...base, 'access-control-max-age': '86400' })
    res.end()
    return
  }
  if (req.method === 'POST' && (req.url === '/mcp' || req.url.startsWith('/mcp?'))) {
    void handlePost(req, res, base)
    return
  }
  if (req.url === '/mcp' || req.url.startsWith('/mcp?')) {
    // No server→client stream: the spec's 405 for GET; DELETE closes a session.
    res.writeHead(req.method === 'DELETE' ? 204 : 405, { ...base, allow: 'POST, DELETE, OPTIONS' })
    res.end()
    return
  }
  res.writeHead(404, { ...base, 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found — the MCP endpoint is POST /mcp' }))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[sense-companion] MCP Streamable HTTP 已就绪：http://127.0.0.1:${String(PORT)}/mcp（数据根 ${ROOT}）`)
  console.log('[sense-companion] 扩展 MCP 面板添加：transport=streamable-http, url 如上；sense-now 引擎未安装时 sense_video_index 会给出安装指引')
})
