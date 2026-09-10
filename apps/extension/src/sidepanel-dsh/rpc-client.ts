/**
 * One unary RPC over a fresh `dsh-api` Port (the same wire `sendPrompt` and
 * PortApiClient ride): connect → bridge `ready` ack → `{k:'rpc'}` → resolve
 * on the matching `{k:'rpc.result'}` (the result body is nested under
 * `result` — see api-port-protocol.ts). One call per port, correlated by
 * rpcId = method; disconnects resolve as a structured refusal, and a silent
 * peer is cut off after 10 s. Extracted from extension-shell so the shell and
 * the composer bar share one transport definition.
 */

import { API_PORT_NAME } from '../shared/api-port-protocol.ts'

/** rpc outcome for all callers: the value on ok, the message on refusal. */
export interface RpcOutcome {
  ok: boolean
  value?: unknown
  error?: { message?: string } | undefined
}

export const rpc = (method: string, payload: Record<string, unknown>): Promise<RpcOutcome> => {
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: API_PORT_NAME })
    let settled = false
    const finish = (outcome: RpcOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
      try {
        port.disconnect()
      } catch {
        // Port already gone — nothing to tear down.
      }
    }
    port.onMessage.addListener((msg) => {
      const m = msg as { k?: string; rpcId?: string; result?: { ok?: boolean; value?: unknown; error?: { message?: string } } }
      if (m.k === 'ready') port.postMessage({ k: 'rpc', rpcId: method, method, payload })
      if (m.k === 'rpc.result' && m.rpcId === method) {
        finish({ ok: m.result?.ok === true, value: m.result?.value, error: m.result?.error })
      }
    })
    port.onDisconnect.addListener(() => finish({ ok: false, error: { message: 'dsh-api 桥已断开' } }))
    setTimeout(() => finish({ ok: false, error: { message: 'dsh-api RPC 超时' } }), 10000)
  })
}
