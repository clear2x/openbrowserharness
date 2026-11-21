/**
 * Wire constants shared by the MCP server half (offscreen
 * `mcp-server.ts`) and its local bridge (`scripts/mcp-bridge.mjs`).
 *
 * MV3 extensions cannot listen on sockets, so the extension DIALS OUT to a
 * bridge the user runs on this machine: the bridge accepts the WebSocket,
 * speaks MCP (stdio) to external harnesses/agents on one side, and forwards
 * JSON-RPC to the extension on the other. Every forwarded request is one
 * message `{ id, kind: 'mcp-request', method, params }`; the extension
 * answers `{ id, kind: 'mcp-response', result }` where `result` is the MCP
 * result body (`{ content, isError }`) or `{ error }` for protocol-level
 * failures.
 *
 * @module mcp-server-protocol
 */

/** Loopback port the bridge's WebSocket server listens on. */
export const MCP_BRIDGE_WS_PORT = 8766

/** WebSocket subprotocol both sides speak (a cheap mismatch guard). */
export const MCP_BRIDGE_WS_PROTOCOL = 'dsh-mcp-bridge-v1'

/** Bridge hello frame the extension sends right after the socket opens. */
export interface McpBridgeHello {
  kind: 'hello'
  role: 'extension'
}

/** MCP request forwarded by the bridge (MCP server → extension). */
export interface McpBridgeRequest {
  kind: 'mcp-request'
  id: number
  /** MCP method: `tools/list`, `tools/call`, `ping`. */
  method: string
  params: Record<string, unknown>
}

/** Extension's answer to one forwarded MCP request. */
export interface McpBridgeResponse {
  kind: 'mcp-response'
  id: number
  /** The MCP result body on success, or `undefined` with `error` set. */
  result?: unknown
  /** JSON-RPC error object when the method failed at the protocol level. */
  error?: { code: number; message: string }
}

/** One frame on the bridge WebSocket (either direction). */
export type McpBridgeFrame = McpBridgeHello | McpBridgeRequest | McpBridgeResponse

/**
 * chrome.storage.local key the offscreen MCP server publishes its live
 * state under; the services panel card reads it (onChanged-driven) to
 * render 未启动 / 等待桥 / 已连接.
 */
export const MCP_SERVER_STATUS_KEY = 'dsh-mcp-server-status'

/** The published server state shape (`MCP_SERVER_STATUS_KEY`'s value). */
export interface McpServerStatusValue {
  /** `off` = the toggle is off (the last published terminal state). */
  state: 'off' | 'waiting' | 'connected'
  /** Epoch ms of the last state transition. */
  since: number
}
