/**
 * The MCP SERVER half living in the engine (offscreen) document. When the
 * MCP 服务器 capability is on, this module dials the local bridge
 * (`scripts/mcp-bridge.mjs`, ws://127.0.0.1:8766) and serves MCP over it:
 * external harnesses and agents talk MCP to the bridge's stdio, the bridge
 * forwards JSON-RPC here, and every tools/call lands on the SAME dsh-api
 * RPC surface the SidePanel rides (one fresh `dsh-api` Port per call — the
 * api-bridge accepts runtime Ports from any extension context, including
 * this one).
 *
 * The tool catalog is a thin MCP projection of that RPC surface: curated
 * session tools plus the `dsh_rpc` passthrough for full control.
 *
 * @module mcp-server
 */
import {
  MCP_BRIDGE_WS_PORT,
  MCP_BRIDGE_WS_PROTOCOL,
  MCP_SERVER_STATUS_KEY,
  type McpBridgeFrame,
  type McpServerStatusValue,
} from '../shared/mcp-server-protocol.ts'
import { dispatchApiRpc } from '../chrome/api-bridge.ts'
import { storageSet } from '../chrome/storage-client.ts'

/** The MCP tool catalog served on `tools/list`. */
const MCP_TOOLS: ReadonlyArray<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
}> = [
  {
    name: 'session_create',
    description: '创建一个新会话（可选 agentPreset 组合预设），返回会话 id。',
    inputSchema: {
      type: 'object',
      properties: { agentPreset: { type: 'string', description: '预设 id（如 standard/ptc/minimal/cordis 或自定义 id）' } },
    },
  },
  {
    name: 'session_list',
    description: '列出全部会话（id、标题、运行态、当前预设）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'session_prompt',
    description: '向会话发送一条用户消息（Agent 将驱动浏览器执行）；返回投递结果。轮询 session_history 读进展。',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'content'],
      properties: {
        sessionId: { type: 'string' },
        content: { type: 'string', description: '消息正文（Markdown）' },
      },
    },
  },
  {
    name: 'session_history',
    description: '读取会话事件日志（消息气泡/工具调用，分页）。用于轮询 Agent 的回复与动作。',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string' },
        maxMessages: { type: 'number', description: '每页事件数（默认 200）' },
      },
    },
  },
  {
    name: 'session_interrupt',
    description: '中断会话正在运行的回合。',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: { sessionId: { type: 'string' } },
    },
  },
  {
    name: 'dsh_rpc',
    description: '完整控制通道：直接调用扩展宿主的任意 dsh-api RPC（method + payload 与面板同面）。',
    inputSchema: {
      type: 'object',
      required: ['method'],
      properties: {
        method: { type: 'string', description: 'RPC 方法名，如 session.rename / agentPreset.list / capability.set' },
        payload: { type: 'object', description: '方法参数对象' },
      },
    },
  },
]

/** Map a curated tool call to (method, payload) on the dsh-api surface. */
function toolToRpc(name: string, args: Record<string, unknown>): { method: string; payload: Record<string, unknown> } | undefined {
  switch (name) {
    case 'session_create':
      return {
        method: 'session.create',
        payload: args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset },
      }
    case 'session_list':
      return { method: 'session.list', payload: {} }
    case 'session_prompt':
      return {
        method: 'session.prompt',
        payload: { sessionId: args.sessionId, content: [{ type: 'text', text: String(args.content ?? '') }] },
      }
    case 'session_history':
      return {
        method: 'session.history',
        payload: {
          sessionId: args.sessionId,
          ...(args.maxMessages === undefined ? {} : { maxMessages: args.maxMessages }),
        },
      }
    case 'session_interrupt':
      return { method: 'session.interrupt', payload: { sessionId: args.sessionId } }
    default:
      return undefined
  }
}

/**
 * One unary RPC against the method table IN THIS DOCUMENT: a chrome.runtime
 * Port opened here is never delivered to this document's own onConnect
 * listener (senders are excluded from their own connects), so the MCP server
 * rides the in-process seam instead of the panel wire.
 */
type RpcOutcome = { ok: boolean; value?: unknown; error?: { message?: string } }

function callRpc(method: string, payload: Record<string, unknown>, timeoutMs: number): Promise<RpcOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: { ok: boolean; value?: unknown; error?: { message?: string } }): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    setTimeout(() => { finish({ ok: false, error: { message: 'dsh-api RPC 超时' } }) }, timeoutMs)
    void dispatchApiRpc(method, payload).then((outcome) => {
      if (outcome.error === undefined) {
        finish({ ok: outcome.ok, value: outcome.value })
        return
      }
      finish({ ok: outcome.ok, error: { message: outcome.error.message } })
    })
  })
}

/** Render one tools/call outcome as an MCP result body. */
function mcpResultFromRpc(outcome: { ok: boolean; value?: unknown; error?: { message?: string } }): unknown {
  if (!outcome.ok) {
    return {
      content: [{ type: 'text', text: `RPC 拒绝：${outcome.error?.message ?? '未知原因'}` }],
      isError: true,
    }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome.value ?? null, null, 2) }],
    isError: false,
  }
}

/** Handle one forwarded MCP request frame (pure over injected callRpc). */
export function handleMcpRequest(
  method: string,
  params: Record<string, unknown>,
  call: (m: string, p: Record<string, unknown>) => Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }>,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  if (method === 'ping') return Promise.resolve({ result: {} })
  if (method === 'tools/list') {
    return Promise.resolve({ result: { tools: MCP_TOOLS.map(tool => ({ ...tool })) } })
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : ''
    const args = (params.arguments ?? {}) as Record<string, unknown>
    if (name === 'dsh_rpc') {
      const m = typeof args.method === 'string' && args.method !== '' ? args.method : undefined
      if (m === undefined) {
        return Promise.resolve({ result: { content: [{ type: 'text', text: 'dsh_rpc 缺 method 参数' }], isError: true } })
      }
      return call(m, (args.payload ?? {}) as Record<string, unknown>).then(mcpResultFromRpc).then(result => ({ result }))
    }
    const mapped = toolToRpc(name, args)
    if (mapped === undefined) {
      return Promise.resolve({
        error: { code: -32602, message: `未知工具 "${name}"（tools/list 查看可用工具）` },
      })
    }
    return call(mapped.method, mapped.payload).then(mcpResultFromRpc).then(result => ({ result }))
  }
  return Promise.resolve({ error: { code: -32601, message: `MCP 服务器不支持方法 "${method}"` } })
}

let socket: WebSocket | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let wanted = false
const log = (...parts: unknown[]): void => { console.log('[mcp-server]', ...parts) }

async function publishStatus(state: McpServerStatusValue['state']): Promise<void> {
  try {
    // storage-client, NOT chrome.storage: offscreen documents do not receive
    // the chrome.storage bindings (the client routes through the SW).
    await storageSet({ [MCP_SERVER_STATUS_KEY]: { state, since: Date.now() } })
  } catch (err) {
    log('状态发布失败：', String(err))
  }
}

function dial(): void {
  if (!wanted) return
  publishStatus('waiting').catch(() => {})
  let ws: WebSocket
  try {
    ws = new WebSocket(`ws://127.0.0.1:${MCP_BRIDGE_WS_PORT}/`, [MCP_BRIDGE_WS_PROTOCOL])
  } catch (err) {
    log('WebSocket 创建失败（', String(err), '），2.5s 后重试')
    scheduleRedial()
    return
  }
  socket = ws
  ws.onopen = () => {
    socket = ws
    ws.send(JSON.stringify({ kind: 'hello', role: 'extension' }))
    publishStatus('connected').catch(() => {})
    log('已连接本地 MCP 桥（127.0.0.1:' + MCP_BRIDGE_WS_PORT + '）')
  }
  ws.onmessage = (event) => {
    let frame: McpBridgeFrame
    try {
      frame = JSON.parse(String(event.data)) as McpBridgeFrame
    } catch {
      return
    }
    if (frame.kind !== 'mcp-request') return
    void handleMcpRequest(frame.method, frame.params ?? {}, (m, p) => callRpc(m, p, 120_000))
      .then((outcome) => {
        const response = { kind: 'mcp-response', id: frame.id, ...outcome }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response))
      })
      .catch((err) => {
        const response = { kind: 'mcp-response', id: frame.id, error: { code: -32603, message: String(err) } }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response))
      })
  }
  ws.onclose = () => {
    if (socket === ws) socket = undefined
    if (wanted) {
      publishStatus('waiting').catch(() => {})
      scheduleRedial()
    }
  }
  ws.onerror = () => {
    try {
      ws.close()
    } catch {
      // Already closing.
    }
  }
}

function scheduleRedial(): void {
  if (reconnectTimer !== undefined || !wanted) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    dial()
  }, 2500)
}

/** Start serving (idempotent): dial the bridge and keep reconnecting. */
export function startMcpServer(): void {
  if (wanted) return
  wanted = true
  log('MCP 服务器已启用：正在连接 ws://127.0.0.1:' + MCP_BRIDGE_WS_PORT)
  dial()
}

/** Stop serving: close the socket, cancel the reconnect loop, publish `off`. */
export function stopMcpServer(): void {
  wanted = false
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }
  if (socket !== undefined) {
    try {
      socket.close()
    } catch {
      // Already closed.
    }
    socket = undefined
  }
  void publishStatus('off')
  log('MCP 服务器已停用')
}

/** Whether the server loop currently wants to run (test seam). */
export function isMcpServerWanted(): boolean {
  return wanted
}
