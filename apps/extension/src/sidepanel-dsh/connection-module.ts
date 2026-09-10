/**
 * The SidePanel's replacement `@deepseek-ai/dsh-client-connection` client
 * half. The boot registers THIS module statically under the connection row's
 * id (`registerStatic`), so the module table's statics branch serves it
 * instead of fetching the package's own `lib/client.js` — the official
 * bundle's `WebApiClient` (fetch + WebSocket) can never reach the Offscreen
 * engine from an extension page, while `PortApiClient` rides the `dsh-api`
 * chrome.runtime Port.
 *
 * Everything else is the official module's skeleton
 * (`packages/client/connection/src/client/index.ts`) kept interaction-faithful
 * so the shell around it cannot tell the difference:
 * - `ConnectionController` (the official class, imported from the connection
 *   package source) still owns the connect/pump/reconnect loop, the strict
 *   mux+host+describe readiness handshake, and the reconnect/resync cadence —
 *   only the carrier underneath changed.
 * - The observable `hostDescription` store and the single-consumer `start()`
 *   guard are copied verbatim.
 * - `?fixture` pages keep the OFFICIAL behavior untouched: FixtureApiClient
 *   (the in-memory fake server) and its rpc, exactly like `dsh web ?fixture`.
 *   That branch is the manual render-verification lane (see boot.ts).
 * - `isLoopback` on the port branch reports true: the "server" is the same
 *   extension's Offscreen document, so every authority distinction the flag
 *   encodes (LAN trust fences) resolves to fully trusted here.
 * - `rpc` (generic Connection RPC channels — the typert remote lane:
 *   pluginInventory, commands, goals, messageFeedback, …) forwards every
 *   `/api` call through the PortApiClient on the port branch; the endpoint
 *   string rides the wire method slot and the api bridge dispatches by it.
 *   `?fixture` pages keep the official FixtureApiClient rpc (in-memory
 *   commands/goals remotes), exactly like `dsh web`.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ClientConnectionRpc,
  ConnectionConfig,
  ConnectionSinks,
  HostDescription,
  IApiClient,
} from '@deepseek-ai/dsh-client-connection/client'
// The connection package keeps ConnectionController and FixtureApiClient
// package-internal (not exported through `./client`), so the twin reaches the
// same source files directly, by extensionful relative specifier: the
// extension pins the SOURCE file in every resolver (the package's source dir
// carries stale tsc `.js` twins that would win an extensionless lookup), and
// the tsconfig's rewriteRelativeImportExtensions:false keeps the paths
// writable across the project reference. These are the very files the vite
// alias binds the public subpath to, so one module instance exists per file.
import { ConnectionController } from '../../../../packages/client/connection/src/client/connection.ts'
import { FixtureApiClient } from '../../../../packages/client/connection/src/client/fixture.ts'
import { isLoopbackHostname } from '../../../../packages/client/connection/src/loopback-hostname.ts'
import { API_PORT_NAME, type ApiPortLike } from '../shared/api-port-protocol.ts'
import { bindInteractionRespond, interactionStore } from './interaction-store.ts'
import { PortApiClient } from './port-api-client.ts'

/** Observable Host description published by each completed connection handshake (official shape). */
interface HostDescriptionSource {
  /** Latest connected-generation description; absent before connect and while reconnecting. */
  getSnapshot(): HostDescription | undefined
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void
}

/** Required services (none — this is the wire root, like the official module). */
export const inject: string[] = []

/**
 * The ctx.connection service API this module provides — field-for-field the
 * official `ConnectionHandle`.
 */
export interface ConnectionHandle {
  /** Shared api client (port-backed, or the official fixture on `?fixture` pages). */
  readonly api: IApiClient
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** Generation-scoped Host facts, including native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
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
 * Client plugin body: pick the api by page mode (fixture vs Port) and provide
 * ctx.connection — the official module's apply with only the carrier swapped.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  // One client instance serves both the protocol legs (api) and the generic
  // `/api` channel (rpc) so a single Port carries everything.
  let api: IApiClient
  let rpc: ClientConnectionRpc
  if (fixtureClient !== undefined) {
    api = fixtureClient
    rpc = fixtureClient.rpc
  } else {
    const portClient = new PortApiClient(connectApiPort)
    api = portClient
    rpc = createPortRpc(portClient)
  }
  // The interaction store answers engine asks (approval gate, ask_user_question)
  // through the same client: one respond carrier for both carriers (port and
  // fixture), bound once for the page lifetime.
  bindInteractionRespond(api)
  // The engine is this same extension's Offscreen document — the authority
  // fences the flag feeds (LAN trust) are trivially satisfied. Fixture pages
  // keep the official hostname semantics for fidelity with `dsh web`.
  const isLoopback = fixtureClient === undefined
    || pageLocation === undefined
    || isLoopbackHostname(pageLocation.hostname)
  let started = false
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
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
  const handle: ConnectionHandle = {
    api,
    isLoopback,
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new ConnectionController(api, {
        ...sinks,
        onMuxEnvelope: (envelope) => {
          // Interaction tap ahead of the runtime dispatch: the store keeps its
          // own payload-identity dedupe (the client re-mints envelope ids per
          // delivery); the session stream's dispatch below is untouched.
          interactionStore.handleMuxEnvelope(envelope)
          sinks.onMuxEnvelope?.(envelope)
        },
        onConnected: (next) => {
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') publishDescription(undefined)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller.start()
      return {
        stop: () => {
          controller.stop()
          publishDescription(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
