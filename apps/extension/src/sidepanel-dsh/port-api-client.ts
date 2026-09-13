/**
 * `PortApiClient`: the dsh wire client for the SidePanel's real Web UI — the
 * Port-carrier twin of `WebApiClient` (HTTP + WebSocket). The extension page
 * cannot reach the Offscreen engine over HTTP/SSE/WS, so every protocol leg
 * rides one `chrome.runtime` Port (`dsh-api`) served by
 * `src/chrome/api-bridge.ts`; the wire contract both sides share is
 * `src/shared/api-port-protocol.ts`.
 *
 * Carrier posture (mirrors `packages/client/connection/src/client/index.ts`
 * choosing between FixtureApiClient and WebApiClient, and FixtureApiClient's
 * precedent of overriding the protocol-level virtuals): a transport object
 * below owns the Port lifecycle (connect → `ready` ack → rpc/respond/stream
 * demultiplexing → disconnect teardown → transparent reconnect on next use),
 * while this class keeps every AbstractApiClient invariant it can reuse —
 * rpcId minting, the four-quadrant full-form envelope tap, the 30 s unary
 * deadline (merged with the caller's signal, `host.pickDirectory`'s
 * caller-signal-only exemption honored), and the two-level S→C frame parse
 * against the REAL apiproxy zod schemas.
 *
 * One deliberate deviation, documented: `callUnary` is overridden (like the
 * fixture's) instead of routing through `doFetch`, because the base class
 * re-parses every response with `serverResponseSchema` whose RpcError union
 * is CLOSED over the Node gateway's codes — the extension bridge
 * intentionally answers extra codes (`not-available-in-extension`, …) that
 * the strict parse would turn into thrown ZodErrors. Overriding keeps such
 * structured refusals as first-class `RpcResult` error branches (business
 * code default-handles unknown codes); the cost, identical to the fixture's,
 * is skipping the ok-value schema re-parse — the bridge is the same
 * extension's code, not an untrusted network peer.
 */

import type {
  ClientRequest,
  ClientResponse,
  HostFrame,
  MuxFrame,
  RequestPayload,
  ResponseValue,
  RpcMethodMap,
  RpcReceipt,
  RpcRequest,
  RpcResponse,
  RpcResult,
  ServerRequest,
  ServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId as rpcIdOf } from '@deepseek-ai/dsh-host-apiproxy/api'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { rpcReceiptSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import {
  API_PORT_NAME,
  isApiPortDownMessage,
  type ApiPortLike,
  type ApiPortUpMessage,
  type ApiRpcResult,
  type MuxOpenPayload,
} from '../shared/api-port-protocol.ts'

/** Milliseconds a call waits for the bridge `ready` ack (distinct from the AbstractApiClient rpc deadline). */
const READY_TIMEOUT_MS = 10_000

/** One queued downstream item of an open stream ('end' resolves the generator). */
type StreamItem = { kind: 'frame'; frame: unknown } | { kind: 'end' }

/** Per-stream pull queue between the Port listener and one generator. */
interface StreamQueue {
  readonly stream: 'mux' | 'host'
  readonly items: StreamItem[]
  wake: (() => void) | undefined
}

/** Pending unary/respond waiter registered by rpcId. */
interface PendingCall {
  settle(result: ApiRpcResult): void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Mirror fetch's abort rejection: the signal's reason when Error-shaped, else a plain Error. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  if (typeof reason === 'string') return new Error(reason)
  return new Error('This operation was aborted')
}

/** Mint a wire id (rpc correlation / per-frame push identity). */
function mintId(): string {
  return globalThis.crypto.randomUUID?.() ?? `rpc-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * The `dsh-api` Port transport. One Port carries every leg (unary, respond,
 * both streams — the bridge keys stream state per port, not per stream). The
 * Port is created lazily on first use, gated on the bridge's `{k:'ready'}`
 * ack, torn down on disconnect (pending calls answered with a transport
 * error, stream queues ended), and recreated transparently on the next use —
 * exactly the reconnect granularity the shell's ConnectionController drives:
 * a lost generation aborts its stream signals, the generators end, the next
 * generation's openers find no Port and connect fresh, and their
 * `stream.open` handshakes re-arm the subscriptions on the new Port.
 */
export class ApiPortTransport {
  private readonly connectPort: () => ApiPortLike
  private port: ApiPortLike | undefined
  private readyPromise: Promise<void> | undefined
  private readyResolve: (() => void) | undefined
  private readyReject: ((error: Error) => void) | undefined
  private readonly pending = new Map<string, PendingCall>()
  private readonly streamQueues = new Set<StreamQueue>()
  /** Resolved when the live Port drops — the connection generation's end signal. */
  private readonly portLostWaiters = new Set<() => void>()

  /**
   * Optional tap for mux envelopes ahead of stream-queue fan-out (the
   * interaction store's approval/question capture). The connection module
   * binds it once per page.
   */
  onMuxEnvelope: ((envelope: RpcRequest<MuxFrame>) => void) | undefined

  /** @param connectPort - Port factory (the page default binds `chrome.runtime.connect`; tests inject fakes). */
  constructor(connectPort: () => ApiPortLike) {
    this.connectPort = connectPort
  }

  // ───────────────────────── Port lifecycle ─────────────────────────

  /** Messages received on the live Port. */
  private readonly handleMessage = (message: unknown): void => {
    if (!isApiPortDownMessage(message)) return
    if (message.k === 'ready') {
      this.readyResolve?.()
      this.readyResolve = undefined
      this.readyReject = undefined
      return
    }
    if (message.k === 'rpc.result') {
      const waiter = this.pending.get(message.rpcId)
      if (waiter === undefined) return // late answer to an aborted/timed-out call
      this.pending.delete(message.rpcId)
      waiter.settle(message.result)
      return
    }
    if (message.k === 'frame' && message.stream === 'mux') {
      this.onMuxEnvelope?.(message.frame as unknown as RpcRequest<MuxFrame>)
    }
    for (const queue of [...this.streamQueues]) {
      if (queue.stream !== message.stream) continue
      queue.items.push({ kind: 'frame', frame: message.frame })
      queue.wake?.()
      queue.wake = undefined
    }
  }

  /** Port loss: answer callers with a transport error, end streams, drop the Port so the next use reconnects. */
  private readonly handleDisconnect = (): void => {
    const error = new Error(`dsh-api port disconnected (name=${JSON.stringify(API_PORT_NAME)})`)
    for (const waiter of [...this.pending.values()]) {
      waiter.settle({ ok: false, error: { code: 'internal', message: error.message } })
    }
    this.pending.clear()
    for (const queue of [...this.streamQueues]) {
      queue.items.push({ kind: 'end' })
      queue.wake?.()
      queue.wake = undefined
    }
    this.streamQueues.clear()
    this.readyReject?.(error)
    this.readyResolve = undefined
    this.readyReject = undefined
    this.port = undefined
    this.readyPromise = undefined
    for (const waiter of [...this.portLostWaiters]) waiter()
    this.portLostWaiters.clear()
  }

  /**
   * Run one connection generation: open the Port, await its ready ack, report
   * the Host facts, and hold until the Port drops or `signal` aborts. The
   * connection loop's reconnect then starts a fresh generation (a fresh Port).
   * @param signal - cancellation owned by the connection loop.
   * @param ready - one-shot report that incremental delivery is attached.
   */
  async runGeneration(
    signal: AbortSignal,
    ready: (host: { readonly home: string }) => void,
  ): Promise<void> {
    let lostResolve!: () => void
    const lost = new Promise<void>((resolve) => { lostResolve = resolve })
    this.portLostWaiters.add(lostResolve)
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    try {
      void this.ensure()
      await this.readyPromise
      ready({ home: '' })
      await Promise.race([lost, aborted])
    } finally {
      if (lostResolve !== undefined) this.portLostWaiters.delete(lostResolve)
    }
  }

  /** Ensure a live Port and hand back its ready-ack promise (connects when needed). */
  private ensure(): Promise<void> {
    if (this.port !== undefined && this.readyPromise !== undefined) return this.readyPromise
    const port = this.connectPort()
    this.port = port
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.readyPromise = ready
    port.onMessage.addListener(this.handleMessage)
    port.onDisconnect.addListener(this.handleDisconnect)
    // Bound the ack wait so a silent peer cannot wedge callers until their own
    // rpc deadline; the timer dies with the promise (ack or disconnect).
    const timer = setTimeout(() => {
      if (this.port === port) {
        this.readyReject?.(new Error(`dsh-api port: no ready ack within ${String(READY_TIMEOUT_MS)}ms`))
      }
    }, READY_TIMEOUT_MS)
    void ready.finally(() => { clearTimeout(timer) })
    return ready
  }

  /** Send one up message on the live Port; a dead Port surfaces as a thrown transport error. */
  private post(message: ApiPortUpMessage): void {
    const port = this.port
    if (port === undefined) throw new Error('dsh-api port: not connected')
    try {
      port.postMessage(message)
    } catch (error) {
      this.handleDisconnect()
      throw new Error(`dsh-api port: postMessage failed: ${errorText(error)}`)
    }
  }

  // ───────────────────────── call legs ─────────────────────────

  /**
   * One unary/respond round trip, abort-aware across the whole span (ready-ack
   * wait included). The caller supplies the correlation rpcId (the envelope
   * id the business layer minted). Rejections carry transport failures that
   * cannot be attributed to a call (abort, deadline, dead Port); a mid-flight
   * Port loss RESOLVES with the structured transport error instead (the
   * call's RpcResult error branch) — the disconnect is a wire fact, not an
   * exception, and business callers already switch on `ok`.
   */
  private roundTrip(
    rpcId: string,
    buildMessage: () => ApiPortUpMessage,
    signal: AbortSignal | undefined,
  ): Promise<ApiRpcResult> {
    return new Promise<ApiRpcResult>((resolve, reject) => {
      let settled = false
      const onAbort = (): void => {
        if (settled) return
        settled = true
        this.pending.delete(rpcId)
        signal?.removeEventListener('abort', onAbort)
        reject(signal === undefined ? new Error('aborted') : abortError(signal))
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.ensure().then(() => {
        if (settled) return
        this.pending.set(rpcId, {
          settle: (result) => {
            if (settled) return
            settled = true
            signal?.removeEventListener('abort', onAbort)
            resolve(result)
          },
        })
        try {
          this.post(buildMessage())
        } catch (error) {
          this.pending.delete(rpcId)
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          reject(error instanceof Error ? error : new Error(errorText(error)))
        }
      }, (error: unknown) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(errorText(error)))
      })
    })
  }

  /** One `session.list`-style unary call, correlated by the envelope rpcId. */
  rpc(method: string, payload: unknown, rpcId: string, signal?: AbortSignal): Promise<ApiRpcResult> {
    return this.roundTrip(
      rpcId,
      () => ({ k: 'rpc', rpcId, method, ...(payload === undefined ? {} : { payload }) }),
      signal,
    )
  }

  /**
   * One approval/question answer delivery (the receipt rides the rpc.result
   * value). Correlation id = the answered server-request's rpcId — the up
   * message and the awaited result share it.
   */
  respond(result: ApiRpcResult, rpcId: string, signal?: AbortSignal): Promise<ApiRpcResult> {
    return this.roundTrip(rpcId, () => ({ k: 'respond', rpcId, result }), signal)
  }

  // ───────────────────────── stream legs ─────────────────────────

  /**
   * One downlink stream: handshake (ready ack → `stream.open`), then raw
   * frames until abort or Port loss (both end the generator normally — the
   * ConnectionController treats generator end as generation loss and
   * reconnects). `onOpen` fires after the open message is posted and before
   * the first frame is handed back, preserving the base class's
   * stream-established semantics for the readiness handshake.
   */
  async *stream(
    name: 'mux' | 'host',
    payload: MuxOpenPayload | undefined,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator {
    const queue: StreamQueue = { stream: name, items: [], wake: undefined }
    let opened = false
    const onAbort = (): void => {
      queue.items.push({ kind: 'end' })
      queue.wake?.()
      queue.wake = undefined
    }
    signal.addEventListener('abort', onAbort, { once: true })
    this.streamQueues.add(queue)
    try {
      await this.ensure()
      if (signal.aborted) return
      this.post({
        k: 'stream.open',
        stream: name,
        rpcId: mintId(),
        ...(payload === undefined ? {} : { payload }),
      })
      opened = true
      onOpen?.()
      while (true) {
        // 'retry' = the queue moved while we parked (an abort enqueued 'end',
        // a push enqueued a frame); re-enter the shift instead of trusting a
        // possibly-stale item snapshot.
        const item = await new Promise<StreamItem | 'retry'>((resolve) => {
          const next = queue.items.shift()
          if (next !== undefined) {
            resolve(next)
            return
          }
          queue.wake = () => { resolve('retry') }
        })
        if (item === 'retry') continue
        if (item.kind === 'end') return
        yield item.frame
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.streamQueues.delete(queue)
      if (opened) {
        // Best-effort subscription teardown on a possibly-dead Port; the
        // bridge also tears its side down on Port disconnect.
        try {
          this.post({ k: 'stream.close', stream: name })
        } catch {
          // Port already gone — nothing left to close.
        }
      }
    }
  }
}

/** The error branch of a wire RpcResult (what a structured refusal looks like on the wire). */
type RpcErrorBody = Extract<RpcResult<unknown>, { ok: false }>['error']

/** Normalize a port-side result into the wire RpcResult (error `details` slot always present). */
function toRpcResult(result: ApiRpcResult): RpcResult<unknown> {
  if (result.ok) return result
  const error = result.error
  // The bridge's extension-specific codes sit outside the closed RpcError
  // union by design; runtime consumers switch over known codes and
  // default-handle the rest, so this passthrough is the honest wire shape.
  return {
    ok: false,
    error: { code: error.code, message: error.message, details: error.details ?? {} } as RpcErrorBody,
  }
}

/**
 * The SidePanel's API client: the AbstractApiClient protocol surface over the
 * `dsh-api` Port. Constructed by the replacement connection module
 * (`connection-module.ts`); every shell consumer (runtime object layer,
 * settings, workspace) drives it through the unchanged IApiClient face.
 */
export class PortApiClient extends AbstractApiClient {
  private readonly transport: ApiPortTransport

  /**
   * Mux envelope tap bound by the connection module (the interaction store's
   * approval/ask_user capture, ahead of stream-queue fan-out).
   */
  onMuxEnvelope: ((envelope: RpcRequest<MuxFrame>) => void) | undefined

  /**
   * @param connectPort - Port factory; defaults to `chrome.runtime.connect`
   * on {@link API_PORT_NAME}. Tests inject a fake.
   * @param timeoutMs - unary deadline (AbstractApiClient default: 30 s).
   */
  constructor(connectPort: () => ApiPortLike = defaultConnectPort, timeoutMs?: number) {
    super(timeoutMs)
    this.transport = new ApiPortTransport(connectPort)
    this.transport.onMuxEnvelope = (envelope) => { this.onMuxEnvelope?.(envelope) }
  }

  /**
   * Run one connection generation over the transport Port: open, ready ack,
   * report Host facts, hold until the Port drops or the loop aborts.
   * @param signal - cancellation owned by the connection loop.
   * @param ready - one-shot report that incremental delivery is attached.
   */
  runGeneration(
    signal: AbortSignal,
    ready: (host: { readonly home: string }) => void,
  ): Promise<void> {
    return this.transport.runGeneration(signal, ready)
  }

  /** All protocol paths are overridden (fixture precedent); fetch is unreachable. */
  protected doFetch(): Promise<Response> {
    return Promise.reject(new Error('PortApiClient overrides all protocol paths; doFetch must be unreachable'))
  }

  protected override async callUnary<K extends keyof RpcMethodMap>(
    method: K,
    payload: RequestPayload<K>,
    signal?: AbortSignal,
    timeoutPolicy: 'default' | 'caller-signal-only' = 'default',
  ): Promise<RpcResponse<ResponseValue<K>>> {
    const rpcId = this.mintRpcId()
    const request: ClientRequest = { type: 'client-request', rpcId, method, payload }
    this.onEnvelope(request)
    const deadline = timeoutPolicy === 'default'
      ? (signal === undefined
        ? AbortSignal.timeout(this.timeoutMs)
        : AbortSignal.any([AbortSignal.timeout(this.timeoutMs), signal]))
      : signal
    const result = await this.transport.rpc(method, payload, rpcId, deadline)
    const full: ServerResponse = { type: 'server-response', rpcId, result: toRpcResult(result) }
    this.onEnvelope(full)
    return { rpcId, result: full.result as RpcResult<ResponseValue<K>> }
  }

  /**
   * Generic typert-remote RPC: one unary call on the logical `/api` channel.
   * The endpoint string (`<ns>/<method>`, e.g. `pluginInventory/list`) rides
   * the wire method slot — port parity with the web caller's envelope
   * (`method: endpoint` under `POST /api/<endpoint>`); the api bridge
   * dispatches by exactly that string. Endpoints sit outside the closed
   * RpcMethodMap keys (the same deviation class as the extension-specific
   * error codes this class already passes through), hence the cast;
   * everything else is stock callUnary — rpcId minting, the 30 s deadline
   * merged with the caller's signal, the envelope tap, Port round trip.
   * Rejections are transport failures (abort, deadline, dead Port); business
   * refusals resolve as the error branch, and the caller (the gateway client)
   * folds throws the way it does for the web carrier.
   */
  genericRpc(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>> {
    return this.callUnary(endpoint as never, payload as never, signal)
      .then(response => response.result)
  }

  override async respond(message: ClientResponse, signal?: AbortSignal): Promise<RpcReceipt> {
    this.onEnvelope(message)
    const result = await this.transport.respond(message.result, message.rpcId, signal)
    if (!result.ok) {
      throw new Error(`dsh-api port: respond transport failure: ${result.error.message}`)
    }
    return rpcReceiptSchema.parse(result.value)
  }

  protected override openMux(
    payload: { since?: Record<string, number> },
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.tapStream(muxFrameSchema, this.transport.stream('mux', payload, signal, onOpen))
  }

  protected override openHost(
    _payload: Record<never, never>,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.tapStream(hostFrameSchema, this.transport.stream('host', {}, signal, onOpen))
  }

  /**
   * Port frames → contract envelopes (web-api-client parity): parse against
   * the real frame schema (a corrupt frame is dropped loudly, never kills the
   * stream), mint the per-push rpcId, tap the server-request full form, and
   * yield the narrow `RpcRequest<frame>`.
   */
  private async *tapStream<F extends MuxFrame | HostFrame>(
    frameSchema: { parse(value: unknown): F },
    frames: AsyncGenerator,
  ): AsyncGenerator<RpcRequest<F>> {
    for await (const raw of frames) {
      let frame: F
      try {
        frame = frameSchema.parse(raw)
      } catch (error) {
        console.error('[dsh-port-api] dropping malformed stream frame:', error)
        continue
      }
      const rpcId = rpcIdOf(mintId())
      const full: ServerRequest = { type: 'server-request', rpcId, method: frame.type, payload: frame }
      this.onEnvelope(full)
      yield { rpcId, payload: frame }
    }
  }
}

/** Page default: the named `dsh-api` Port to the Offscreen engine. */
function defaultConnectPort(): ApiPortLike {
  if (typeof chrome === 'undefined' || chrome.runtime === undefined) {
    throw new Error('dsh-api port: chrome.runtime is unavailable (not an extension page?)')
  }
  return chrome.runtime.connect({ name: API_PORT_NAME })
}
