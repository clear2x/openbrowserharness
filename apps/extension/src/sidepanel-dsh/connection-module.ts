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
 * `ConnectionHandle` fields the sidepanel consumes, with the fork's shared
 * `api` face added (the port-backed ApiProxy client).
 */
export interface ConnectionHandle {
  /** Shared api client (port-backed; fixture pages refuse). */
  readonly api: IApiClient
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** Generation-scoped Host facts, including native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Start the connect/pump/reconnect loop with the consumer's sinks.
   * One consumer owns the loop (the gateway object layer); a second call
   * throws.
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

  let started = false
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

  // The 0.1.5 generation source: one Port generation = open, ready ack, hold
  // until the Port drops or the loop aborts the signal. The loop's retry
  // then starts a fresh generation — a fresh Port, transparently.
  const source: ConnectionGenerationSource = (signal, ready) => {
    if (fixture) {
      ready({ home: '' })
      return new Promise((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }) })
    }
    return portClient.runGeneration(signal, ready)
  }

  const handle: ConnectionHandle = {
    get api(): IApiClient {
      if (fixture) {
        throw new Error('connection: fixture pages expose no ApiProxy client (rpc only)')
      }
      return portClient
    },
    isLoopback,
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    rpc,
    start(sinks: ConnectionSinks, config?: ConnectionRecoveryConfig) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new ConnectionController(source, {
        onConnected: (next) => {
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state: ConnectionState) => {
          if (state === 'disconnected') publishDescription(undefined)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller.start()
      return { stop: () => controller.stop() }
    },
  }
  ctx.provide('connection', handle as unknown as ConnectionHandle)
}
