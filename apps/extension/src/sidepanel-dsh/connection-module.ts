/**
 * The SidePanel's replacement `@deepseek-ai/dsh-client-connection` client
 * half. The boot registers THIS module statically under the connection row's
 * id (`registerStatic`), so the module table's statics branch serves it
 * instead of fetching the package's own `lib/client.js` — the official
 * bundle's web transports (fetch + WebSocket) can never reach the Offscreen
 * engine from an extension page, while `PortApiClient` rides the `dsh-api`
 * chrome.runtime Port.
 *
 * The 0.1.5 connection seam is generation-based: `ConnectionController` owns
 * the connect/retry loop over a {@link ConnectionGenerationSource}; this
 * module supplies the source — open the `dsh-api` Port, await its ready ack,
 * hold until the Port drops — and API Gateway's own loop drives the rest.
 * The shared `api` (the port-backed `IApiClient`) and the generic `/api` RPC
 * channel ride the same Port. `?fixture` pages keep an in-memory RPC face
 * (`createFixtureConnectionRpc`) and no ApiProxy client: that lane is manual
 * render verification, not the product path.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ClientConnectionRpc,
  ConnectionGenerationSource,
  ConnectionHostInfo,
  ConnectionRecoveryConfig,
  ConnectionSinks,
  ConnectionState,
} from '@deepseek-ai/dsh-client-connection/client'
// The connection package keeps ConnectionController and the fixture world
// package-internal (not exported through `./client`), so the twin reaches the
// same source files directly, by extensionful relative specifier.
import { ConnectionController } from '../../../../packages/client/connection/src/client/connection.ts'
import { createFixtureConnectionRpc } from '../../../../packages/client/connection/src/client/fixture.ts'
import { isLoopbackHostname } from '../../../../packages/client/connection/src/loopback-hostname.ts'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { API_PORT_NAME, type ApiPortLike } from '../shared/api-port-protocol.ts'
import { bindInteractionRespond, interactionStore } from './interaction-store.ts'
import { PortApiClient } from './port-api-client.ts'

/** Observable Host description published by each completed connection handshake (official shape). */
interface HostDescriptionSource {
  /** Latest connected-generation description; absent before connect and while reconnecting. */
  getSnapshot(): ConnectionHostInfo | undefined
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void
}

/** Required services (none — this is the wire root, like the official module). */
export const inject: string[] = []

/**
 * The ctx.connection service API this module provides — the official
 * 0.1.5 `ConnectionHandle` surface (generation registration + observables)
 * with the fork's shared `api` face and `hostDescription` source added.
 */
export interface ConnectionHandle {
  /** Shared api client (port-backed; fixture pages refuse). */
  readonly api: IApiClient
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** Current Remote event generation and the Host facts carried by its opening frame. */
  readonly generation: {
    getSnapshot(): { readonly id: number; readonly host: ConnectionHostInfo } | undefined
    subscribe(listener: () => void): () => void
  }
  /** Current recovery lifecycle for connection-specific consumers. */
  readonly state: {
    getSnapshot(): 'connected' | 'disconnected' | 'connecting' | undefined
    subscribe(listener: () => void): () => void
  }
  /** Generation-scoped Host facts, including native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /** Reset retry progression and replace the current attempt immediately. */
  reconnect(): void
  /**
   * Register the sole source defining Host generations (API Gateway's event
   * pump). A second registration throws.
   * @param source - the generation source.
   * @returns disposer withdrawing the source.
   */
  registerGenerationSource(source: (signal: AbortSignal, ready: (host: ConnectionHostInfo) => void) => Promise<void>): () => void
  /**
   * Start the connect/pump/reconnect loop over the registered source. One
   * consumer owns the loop (the gateway object layer); a second call throws.
   * @param sinks - generation/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionRecoveryConfig): { stop(): void }
}

/** Page default Port factory: the named `dsh-api` channel to the Offscreen engine. */
function connectApiPort(): ApiPortLike {
  if (typeof chrome === 'undefined' || chrome.runtime === undefined) {
    throw new Error('dsh-connection: chrome.runtime is unavailable (not an extension page?)')
  }
  return chrome.runtime.connect({ name: API_PORT_NAME })
}

/**
 * Port-branch generic RPC (`ClientConnectionRpc`): forward every `/api`
 * channel call to the Offscreen engine through the same PortApiClient that
 * carries the protocol legs — the endpoint string (`<ns>/<method>`) rides
 * the wire method slot and the api bridge dispatches by it, so the typert
 * remote namespaces (pluginInventory, commands, goals, messageFeedback, …)
 * reach the engine over the one `dsh-api` Port. Channels other than the
 * shared `/api` remain the structured refusal: the extension host serves no
 * other generic channel, and silently rerouting one onto the `/api`
 * dispatcher would misroute it instead of refusing.
 */
function createPortRpc(client: PortApiClient): ClientConnectionRpc {
  return {
    call: (channel, endpoint, payload, signal) => {
      if (channel !== '/api') {
        return Promise.resolve({
          ok: false,
          error: {
            code: 'internal',
            message: `connection: generic RPC channel ${JSON.stringify(channel)} is not served by the extension host`,
            details: {},
          },
        })
      }
      return client.genericRpc(endpoint, payload, signal)
    },
  }
}

/**
 * Client plugin body: pick the transport by page mode (fixture vs Port) and
 * provide ctx.connection — the official module's apply with the carrier
 * swapped for the extension Port.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')

  // One client instance serves both the protocol legs (api) and the generic
  // `/api` channel (rpc) so a single Port carries everything. Its mux
  // envelopes feed the interaction store (approval/ask_user capture) ahead
  // of the stream consumers.
  const portClient = new PortApiClient(connectApiPort)
  portClient.onMuxEnvelope = (envelope) => { interactionStore.handleMuxEnvelope(envelope) }
  // The interaction store answers engine asks (approval gate, ask_user_question)
  // through the same client: one respond carrier for the page lifetime.
  bindInteractionRespond(portClient)

  const rpc: ClientConnectionRpc = fixture
    ? createFixtureConnectionRpc()
    : createPortRpc(portClient)
  // The engine is this same extension's Offscreen document — the authority
  // fences the flag feeds (LAN trust) are trivially satisfied. Fixture pages
  // keep the official hostname semantics for fidelity with `dsh web`.
  const isLoopback = !fixture
    || pageLocation === undefined
    || isLoopbackHostname(pageLocation.hostname)

  let description: ConnectionHostInfo | undefined
  const descriptionListeners = new Set<() => void>()
  const publishDescription = (next: ConnectionHostInfo | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-connection] host-description listener threw:', error)
      }
    }
  }

  // The Port generation: open, ready ack, hold until the Port drops or the
  // loop aborts the signal. The loop's retry then starts a fresh generation —
  // a fresh Port, transparently.
  const portSource: ConnectionGenerationSource = (signal, ready) => {
    if (fixture) {
      ready({ home: '' })
      return new Promise((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }) })
    }
    return portClient.runGeneration(signal, ready)
  }

  // The 0.1.5 registration contract: API Gateway registers the sole generation
  // source (its remote-event pump) before it starts the loop.
  let registeredSource: ConnectionGenerationSource | undefined
  let owner: { readonly token: object; readonly source: ConnectionGenerationSource; readonly controller: ConnectionController } | undefined
  let generationId = 0
  let generation: { readonly id: number; readonly host: ConnectionHostInfo } | undefined
  let state: 'connected' | 'disconnected' | 'connecting' | undefined
  const generationListeners = new Set<() => void>()
  const stateListeners = new Set<() => void>()
  const publishGeneration = (next: typeof generation): void => {
    if (Object.is(generation, next)) return
    generation = next
    for (const listener of [...generationListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-connection] generation listener threw:', error)
      }
    }
  }
  const publishState = (next: typeof state): void => {
    if (state === next) return
    state = next
    for (const listener of [...stateListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-connection] state listener threw:', error)
      }
    }
  }
  const releaseOwner = (current: typeof owner): void => {
    if (owner !== current || current === undefined) return
    owner = undefined
    current.controller.stop()
    publishGeneration(undefined)
    publishState(undefined)
  }

  const handle: ConnectionHandle = {
    get api(): IApiClient {
      if (fixture) {
        throw new Error('connection: fixture pages expose no ApiProxy client (rpc only)')
      }
      return portClient
    },
    isLoopback,
    generation: {
      getSnapshot: () => generation,
      subscribe: (listener) => {
        generationListeners.add(listener)
        return () => { generationListeners.delete(listener) }
      },
    },
    state: {
      getSnapshot: () => state,
      subscribe: (listener) => {
        stateListeners.add(listener)
        return () => { stateListeners.delete(listener) }
      },
    },
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    rpc,
    reconnect() {
      owner?.controller.reconnect()
    },
    registerGenerationSource(source) {
      if (registeredSource !== undefined) {
        throw new Error('connection: a generation source is already registered')
      }
      registeredSource = source
      return () => {
        if (registeredSource !== source) return
        registeredSource = undefined
        const current = owner
        if (current?.source === source) releaseOwner(current)
      }
    },
    start(sinks: ConnectionSinks, config?: ConnectionRecoveryConfig) {
      if (owner !== undefined) throw new Error('connection: the stream loop is already owned by another consumer')
      const source = registeredSource
      if (source === undefined) throw new Error('connection: no generation source is registered')
      // One generation runs BOTH carriers: the Port (open/ready/hold) and the
      // registered gateway pump. The pump's own ready — carrying the Host
      // facts from its opening frame — wins over the Port's (reportReady is
      // first-wins), and ending the pump ends the Port so a retry starts a
      // fresh one.
      const combined: ConnectionGenerationSource = (signal, ready) => {
        const gatewayDone = new AbortController()
        const portSignal = AbortSignal.any([signal, gatewayDone.signal])
        const portHold = portSource(portSignal, ready)
        void portHold.catch(() => {})
        return source(signal, ready).finally(() => { gatewayDone.abort() })
      }
      const token = {}
      const ownsGeneration = (): boolean => owner?.token === token
      const controller = new ConnectionController(combined, {
        ...sinks,
        onConnected: (next) => {
          const nextGeneration = { id: ++generationId, host: next }
          publishGeneration(nextGeneration)
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!ownsGeneration() || !Object.is(generation, nextGeneration) || !Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state: ConnectionState) => {
          if (state !== 'connected') {
            publishGeneration(undefined)
            publishDescription(undefined)
          }
          if (!ownsGeneration()) return
          publishState(state)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      const current = { token, source, controller }
      owner = current
      controller.start()
      return {
        stop: () => { releaseOwner(current) },
      }
    },
  }
  ctx.provide('connection', handle as unknown as ConnectionHandle)
}
