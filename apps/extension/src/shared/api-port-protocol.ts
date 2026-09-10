/**
 * The `dsh-api` Port line protocol contract — the single shared description of
 * the wire between the SidePanel's real dsh Web UI (this app's
 * `sidepanel-dsh/` boot) and the ApiProxy bridge inside the Offscreen engine
 * (`src/chrome/api-bridge.ts`).
 *
 * Two sides, one contract: `api-bridge.ts` (the engine side, written first)
 * declares its own copy of these unions at the top of its file because the
 * extension package deliberately does not depend on the gateway package for
 * its Node graph. THIS file is the browser-side twin: the shapes below are
 * kept byte-compatible with the engine side (field-for-field; when the two
 * drift, fix them together). Frames cross the Port as opaque JSON — the
 * structural frame unions are re-declared loosely here (the client re-parse
 * them with the real apiproxy zod schemas at `port-api-client.ts`).
 *
 * Semantics summary (mirrors api-bridge.ts's header comment):
 * - Up {k:'rpc'} carries one unary ClientRequest as {rpcId, method, payload};
 *   the engine answers Down {k:'rpc.result'} with the same rpcId and an
 *   RpcResult body. Method names are the SINGULAR apiproxy wire names
 *   (`session.list`, `host.describe`, `workspace.list`, `settings.update`,
 *   `credentials.set`, `llm.models`, …).
 * - Up {k:'respond'} answers a Down server-request by rpcId (the approval /
 *   question channel); the receipt rides a `rpc.result` message.
 * - Up {k:'stream.open'} subscribes one downlink stream ('mux' | 'host') on
 *   this port; frames fan out as Down {k:'frame'}. A mux open payload may
 *   carry `since: {sessionId: lastSeq}` watermarks for durable delta replay
 *   (v1 SidePanel boots without them). Up {k:'stream.close'} (and Port
 *   disconnect, and plugin disposal) tears the subscription down.
 * - Down {k:'ready'} is the bridge's connect ack (informational — message
 *   ordering already guarantees Up messages sent before it are served).
 */

// ───────────────────────── wire vocabulary ─────────────────────────

/**
 * Named Port the SidePanel connects on. A dedicated name keeps the api bridge
 * passive toward every other Port (`dsh-ui`, …) in the extension.
 */
export const API_PORT_NAME = 'dsh-api'

/**
 * Structured RPC error body (wire shape of apiproxy RpcError; `details` stays
 * loose because the closed apiproxy code→details map is not importable here).
 */
interface ApiRpcError {
  code: string
  message: string
  details?: Record<string, unknown>
}

/** Business result carried by rpc.result / respond messages. */
export type ApiRpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: ApiRpcError }

/** One frame on the mux stream (loose mirror of the apiproxy MuxFrame union). */
interface ApiMuxFrame {
  type: string
  [field: string]: unknown
}

/** One frame on the host stream (loose mirror of the apiproxy HostFrame union). */
interface ApiHostFrame {
  type: string
  [field: string]: unknown
}

/**
 * `stream.open` mux payload — the subscription/resume hook of the events.mux
 * contract (`since` is a per-session lastSeq watermark; the delta above it is
 * replayed from persistence before live forwarding starts).
 */
export interface MuxOpenPayload {
  since?: Record<string, number>
}

/** SidePanel → Offscreen messages (discriminated by `k`). */
export type ApiPortUpMessage =
  | { k: 'rpc'; rpcId: string; method: string; payload?: unknown }
  | { k: 'respond'; rpcId: string; result: ApiRpcResult }
  | { k: 'stream.open'; stream: 'mux' | 'host'; rpcId: string; payload?: MuxOpenPayload }
  | { k: 'stream.close'; stream: 'mux' | 'host' }

/** Offscreen → SidePanel messages (discriminated by `k`). */
export type ApiPortDownMessage =
  | { k: 'ready' }
  | { k: 'rpc.result'; rpcId: string; result: ApiRpcResult }
  | { k: 'frame'; stream: 'mux' | 'host'; frame: ApiMuxFrame | ApiHostFrame }

// ───────────────────────── type guards ─────────────────────────

/** Whether `value` is an `ApiRpcResult` (the one body shape tests need to mint). */
export function isApiRpcResult(value: unknown): value is ApiRpcResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  if (result.ok === true) return true
  if (result.ok !== false) return false
  const error = result.error
  if (typeof error !== 'object' || error === null) return false
  const err = error as Record<string, unknown>
  return typeof err.code === 'string' && typeof err.message === 'string'
}

/** Narrow an unknown Port message to the Down union (unknown shapes are ignored). */
export function isApiPortDownMessage(value: unknown): value is ApiPortDownMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  switch (message.k) {
    case 'ready':
      return true
    case 'rpc.result':
      return typeof message.rpcId === 'string' && isApiRpcResult(message.result)
    case 'frame':
      return (message.stream === 'mux' || message.stream === 'host')
        && typeof message.frame === 'object' && message.frame !== null
    default:
      return false
  }
}

/** The subset of chrome.runtime.Port the client consumes (structural: tests fake it). */
export interface ApiPortLike {
  /** Port name (diagnostics only). */
  readonly name: string
  /** Send one message to the peer; throws when the port is already gone. */
  postMessage(message: unknown): void
  onMessage: {
    addListener(listener: (message: unknown) => void): void
    removeListener(listener: (message: unknown) => void): void
  }
  onDisconnect: {
    addListener(listener: () => void): void
    removeListener(listener: () => void): void
  }
}
