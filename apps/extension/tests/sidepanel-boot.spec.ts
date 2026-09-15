// @vitest-environment jsdom
/**
 * SidePanel dsh-boot unit lane (no chrome, no network): the boot graph against
 * the official parser plus the roster's on-disk provenance, the
 * `?fixture`-aware boot seams' static-registration ordering, and the
 * PortApiClient wire semantics over a scripted fake Port (ready gating, rpc
 * round trips, structured-refusal passthrough, deadlines/abort, disconnect
 * teardown + reconnect, respond receipts, stream handshake/frame mapping/
 * close-on-abort). jsdom because the imported web-shell graph touches browser
 * globals at module scope. Real render verification is the manual `?fixture`
 * lane documented in src/sidepanel-dsh/boot.ts.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseBootManifest, type DshWindow } from '@deepseek-ai/dsh-client-modules/client'
import { RpcId, type ServerResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  API_PORT_NAME,
  isApiPortDownMessage,
  isApiRpcResult,
  type ApiPortLike,
  type ApiPortUpMessage,
  type ApiRpcResult,
} from '../src/shared/api-port-protocol.ts'
import type { ClientModuleCreateOptions, ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import { createBootSeams, installModuleLoaderQueueFacade } from '../src/sidepanel-dsh/boot.ts'
import * as PortConnectionModule from '../src/sidepanel-dsh/connection-module.ts'
import {
  CONNECTION_MODULE_ID,
  EXTENSION_BOOT_REV,
  EXTENSION_PLUGIN_IDS,
  EXTENSION_SHELL_MODULE_ID,
  buildExtensionBootGraph,
} from '../src/sidepanel-dsh/manifest.ts'
import { PortApiClient } from '../src/sidepanel-dsh/port-api-client.ts'

// ───────────────────────── fake Port ─────────────────────────

/** Scriptable ApiPortLike: records up messages, emits down messages, disconnects. */
class FakePort {
  readonly name = API_PORT_NAME
  readonly sent: ApiPortUpMessage[] = []
  private readonly messageListeners = new Set<(message: unknown) => void>()
  private readonly disconnectListeners = new Set<() => void>()
  private dead = false

  constructor(private readonly autoReady = false) {}

  postMessage(message: ApiPortUpMessage): void {
    if (this.dead) throw new Error('Attempting to use a disconnected port object')
    this.sent.push(message)
  }

  /** Deliver one engine→sidepanel message to the registered listener. */
  emit(message: unknown): void {
    for (const listener of [...this.messageListeners]) listener(message)
  }

  /** Kill the Port: the transport sees exactly what chrome delivers — onDisconnect. */
  disconnect(): void {
    if (this.dead) return
    this.dead = true
    for (const listener of [...this.disconnectListeners]) listener()
  }

  onMessage = {
    addListener: (listener: (message: unknown) => void): void => {
      this.messageListeners.add(listener)
      // The real bridge acks each connection; the auto-ready fake acks the
      // moment its first (the transport's) listener attaches.
      if (this.autoReady && this.messageListeners.size === 1) listener({ k: 'ready' })
    },
    removeListener: (listener: (message: unknown) => void): void => { this.messageListeners.delete(listener) },
  }

  onDisconnect = {
    addListener: (listener: () => void): void => { this.disconnectListeners.add(listener) },
    removeListener: (listener: () => void): void => { this.disconnectListeners.delete(listener) },
  }
}

/**
 * A client over fresh FakePorts; every reconnect draws the next port from
 * `ports`. `autoReady` makes each Port behave like the real bridge, which
 * acks `{k:'ready'}` the moment a listener attaches (tests that assert
 * pre-ack gating construct manual ports instead).
 */
function makeClient(timeoutMs = 30_000, autoReady = false): { client: PortApiClient; ports: FakePort[] } {
  const ports: FakePort[] = []
  const client = new PortApiClient(() => {
    const port = new FakePort(autoReady)
    ports.push(port)
    return port satisfies ApiPortLike
  }, timeoutMs)
  return { client, ports }
}

/** Answer the most recent up rpc/respond message with a down rpc.result (the fake engine). */
function reply(port: FakePort, result: ApiRpcResult): void {
  const last = port.sent.at(-1)
  if (last === undefined || (last.k !== 'rpc' && last.k !== 'respond')) {
    throw new Error('fake engine: no rpc to answer')
  }
  port.emit({ k: 'rpc.result', rpcId: last.rpcId, result })
}

const HOST_DESCRIBE_VALUE = {
  version: '0.2.0',
  cwd: '/',
  provider: 'deepseek',
  model: 'deepseek-chat',
  attachedSessions: 0,
  canOpenPath: false,
}

/** A mux `since` watermark keyed by branded session id (the client's resume hook). */
const sinceWatermark: Record<SessionId, number> = {}
sinceWatermark[SessionId('session-a')] = 5

afterEach(() => {
  delete (globalThis as DshWindow).__ModuleLoader__
  vi.restoreAllMocks()
})

// ───────────────────────── protocol guards ─────────────────────────

describe('api-port-protocol guards', () => {
  it('narrows down messages', () => {
    expect(isApiPortDownMessage({ k: 'ready' })).toBe(true)
    expect(isApiPortDownMessage({ k: 'rpc.result', rpcId: 'r', result: { ok: true, value: 1 } })).toBe(true)
    expect(isApiPortDownMessage({ k: 'frame', stream: 'mux', frame: { type: 'session/subscribed' } })).toBe(true)
    expect(isApiPortDownMessage({ k: 'frame', stream: 'other', frame: {} })).toBe(false)
    expect(isApiPortDownMessage({ k: 'rpc.result', rpcId: 'r', result: { ok: 'yes' } })).toBe(false)
    expect(isApiPortDownMessage(null)).toBe(false)
    expect(isApiRpcResult({ ok: false, error: { code: 'internal', message: 'x' } })).toBe(true)
  })
})

// ───────────────────────── boot graph ─────────────────────────

describe('extension boot graph', () => {
  it('shapes every row the way the official parser demands', () => {
    const graph = buildExtensionBootGraph()
    expect(graph.rev).toBe(EXTENSION_BOOT_REV)
    // 45 yml rows − 6 excluded chrome + 6 scan-covered extras + 2 static modules (connection, shell).
    expect(graph.entries).toHaveLength(EXTENSION_PLUGIN_IDS.length + 2)
    const parsed = parseBootManifest(graph)
    const expected = [...EXTENSION_PLUGIN_IDS, CONNECTION_MODULE_ID, EXTENSION_SHELL_MODULE_ID].sort()
    expect([...parsed.plugins.map(row => row.id)].sort()).toEqual(expected)
    for (const entry of graph.entries) {
      expect(entry.url).toBe(`/plugins/${entry.id}/client.js?rev=${EXTENSION_BOOT_REV}`)
      expect(entry.rev).toBe(EXTENSION_BOOT_REV)
    }
    expect(new Set(EXTENSION_PLUGIN_IDS).size).toBe(EXTENSION_PLUGIN_IDS.length)
  })

  it('keeps the connection row lazy (replaced by the static module) and the package-declared immediately tier otherwise', () => {
    const parsed = parseBootManifest(buildExtensionBootGraph())
    const byId = new Map(parsed.plugins.map(row => [row.id, row] as const))
    expect(byId.get(CONNECTION_MODULE_ID)?.immediately).toBe(false)
    expect(parsed.plugins.filter(row => row.immediately).map(row => row.id).sort()).toEqual([
      '@deepseek-ai/dsh-api-gateway',
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-file-upload',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-modules',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-theme',
      '@deepseek-ai/dsh-typert-registry',
      EXTENSION_SHELL_MODULE_ID,
    ].sort())
  })
})

// ───────────────── roster provenance (on-disk drift guard) ─────────────────

/** npm name → package.json, one scan over packages/<group>/<pkg> (vite pipeline parity). */
function packagesByName(): Map<string, Record<string, unknown>> {
  const root = join(process.cwd(), 'packages')
  const byName = new Map<string, Record<string, unknown>>()
  for (const group of readdirSync(root)) {
    if (!statSync(join(root, group)).isDirectory()) continue
    for (const pkg of readdirSync(join(root, group))) {
      const manifest = join(root, group, pkg, 'package.json')
      if (!existsSync(manifest)) continue
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
      if (typeof parsed.name === 'string') byName.set(parsed.name, parsed)
    }
  }
  return byName
}

describe('roster provenance', () => {
  it('matches the web-app yml browser roster (45 rows) minus the excluded chrome, plus the six scan-covered extras', () => {
    const yml = readFileSync(join(process.cwd(), 'packages/bundle/web-app/cordis.patch.yml'), 'utf8')
    const block = yml.slice(yml.indexOf('    - id: modules'), yml.indexOf('# ── the agent plane'))
    const ymlNames = [...block.matchAll(/name: '(@deepseek-ai\/[^']+)'/gu)].map(match => match[1] as string)
    expect(ymlNames).toHaveLength(45)
    const ids = new Set(EXTENSION_PLUGIN_IDS)
    const REPLACED = [
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-sidebar',
      '@deepseek-ai/dsh-client-ui-workspace',
      // Desktop-only chrome the SidePanel never hosts: the chat page (the
      // shell mounts the trajectory view) and the official brand row.
      '@deepseek-ai/dsh-client-ui-chat',
      '@deepseek-ai/dsh-client-ui-brand-official',
      CONNECTION_MODULE_ID,
    ]
    for (const name of ymlNames) {
      if (REPLACED.includes(name)) continue
      expect(ids.has(name)).toBe(true)
    }
    const extras = EXTENSION_PLUGIN_IDS.filter(id => !ymlNames.includes(id))
    expect(extras).toEqual([
      '@deepseek-ai/dsh-typert-registry',
      '@deepseek-ai/dsh-api-gateway',
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-api-workspace-controller',
      '@deepseek-ai/dsh-api-workspace-files',
      '@deepseek-ai/dsh-session-log-export',
    ])
    // The reload chain has no rebuild watcher in a packaged extension.
    expect(ids.has('@deepseek-ai/dsh-client-hmr')).toBe(false)
    // The extension shell row is STATIC (registerStatic wins; no bundle).
    expect(EXTENSION_PLUGIN_IDS.includes(EXTENSION_SHELL_MODULE_ID)).toBe(false)
  })

  const REPLACED_INJECT = [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-client-ui-chat',
  ]

  it('copies every inject/immediately flag with documented deviations (replaced workspace-chrome references stripped)', () => {
    const byName = packagesByName()
    const manifest = parseBootManifest(buildExtensionBootGraph())
    const byId = new Map(manifest.plugins.map(row => [row.id, row] as const))
    for (const id of EXTENSION_PLUGIN_IDS) {
      const pkg = byName.get(id)
      expect(pkg, `package.json for ${id}`).toBeDefined()
      const dsh = (pkg as { dsh?: { client?: { platform?: unknown; inject?: unknown; immediately?: unknown } } }).dsh?.client
      expect(dsh?.platform, `${id} dsh.client.platform`).toBe('web')
      const row = byId.get(id)
      expect(row, `manifest row for ${id}`).toBeDefined()
      expect(row?.inject).toEqual(((dsh?.inject as string[] | undefined) ?? []).filter(id => !REPLACED_INJECT.includes(id)))
      const declaredImmediate = dsh?.immediately === true
      if (id === CONNECTION_MODULE_ID) {
        // The one deliberate deviation: the extension registers its own
        // replacement module statically, so prefetching the official bundle
        // would load a factory the statics branch never consults.
        expect(declaredImmediate).toBe(true)
        expect(row?.immediately).toBe(false)
      } else {
        expect(row?.immediately, `${id} immediately`).toBe(declaredImmediate)
      }
      const exports = (pkg as { exports?: Record<string, unknown> }).exports
      expect(exports?.['./client'], `${id} exports['./client']`).toBeDefined()
    }
  })
})

// ───────────────────────── boot seams ─────────────────────────

describe('createBootSeams', () => {
  /** A live-mode facade double recording every registration (post-create state). */
  function liveFacade(): { target: ClientModuleLoaderTarget; events: string[] } {
    const events: string[] = []
    const target: ClientModuleLoaderTarget = {
      mode: 'live',
      pendingQueue: [],
      load(registration): void {
        events.push(`register:${registration.id}`)
        const module = registration.factory(() => undefined) as { apply?: unknown }
        expect(typeof module.apply, `factory of ${registration.id}`).toBe('function')
      },
      create(): never { throw new Error('create must not run in these tests') },
    }
    return { target, events }
  }

  it('registers the replacement connection module through the live facade before the first bundle load, exactly once', async () => {
    const { target, events } = liveFacade()
    ;(globalThis as DshWindow).__ModuleLoader__ = target
    const seams = createBootSeams(false, async (url) => { events.push(`load:${url}`) })
    await seams.loadBundle('/plugins/@deepseek-ai/dsh-client-locale/client.js?rev=ext')
    await seams.loadBundle('/plugins/@deepseek-ai/dsh-client-locale/client.js?rev=ext')
    expect(events.filter(event => event.startsWith('register:'))).toEqual([
      `register:${EXTENSION_SHELL_MODULE_ID}`,
      `register:${CONNECTION_MODULE_ID}`,
    ])
    expect(events).toContain('load:/plugins/@deepseek-ai/dsh-client-locale/client.js?rev=ext')
  })

  it('registers the official connection module on fixture pages (the manual render lane)', async () => {
    const registered: Array<[string, unknown]> = []
    ;(globalThis as DshWindow).__ModuleLoader__ = {
      mode: 'live',
      pendingQueue: [],
      load(registration): void { registered.push([registration.id, registration.factory(() => undefined)]) },
      create(): never { throw new Error('create must not run in these tests') },
    }
    const seams = createBootSeams(true, async () => {})
    await seams.loadBundle('/plugins/x/client.js')
    expect(registered).toHaveLength(2)
    const byId = new Map(registered as Array<[string, { apply?: unknown }]>)
    expect(byId.size).toBe(2)
    expect(byId.has(CONNECTION_MODULE_ID)).toBe(true)
    expect(byId.has(EXTENSION_SHELL_MODULE_ID)).toBe(true)
    for (const [mid, mod] of byId) {
      expect(typeof mod.apply, `module ${mid}`).toBe('function')
    }
  })

  it('fails loudly when the loader facade is missing (sequencing tripwire)', async () => {
    const seams = createBootSeams(false, async () => {})
    await expect(seams.loadBundle('/plugins/x/client.js')).rejects.toThrow('__ModuleLoader__')
  })

  it('installs the queue facade and consumes the preloaded modules bundle at create', async () => {
    installModuleLoaderQueueFacade()
    const facade = (globalThis as DshWindow).__ModuleLoader__
    expect(facade?.mode).toBe('queue')
    // The preloaded modules bundle registers into the queue exactly like the
    // served index's parser-preloaded script.
    facade?.load({ id: '@deepseek-ai/dsh-client-modules', factory: () => ({
      createClientModuleSystem: (
        target: ClientModuleLoaderTarget,
        bootstrapModule: { id: string },
        options: ClientModuleCreateOptions,
      ) => {
        expect(bootstrapModule.id).toBe('@deepseek-ai/dsh-client-modules')
        expect(target.mode).toBe('queue')
        expect(options).toBe(createOptions)
        return 'system' as never
      },
      apply: () => {},
    }) })
    const createOptions = { boot: { rev: 'probe', entries: [], batches: [] }, staticModules: {} }
    const system = facade?.create(createOptions)
    expect(system).toBe('system')
    expect(facade?.mode).toBe('queue') // the fake system never flips the mode; create consumed the queue instead
    expect(facade?.pendingQueue).toHaveLength(0)
  })
})

describe('connection module shape', () => {
  it('is a cordis plugin twin of the official client half', () => {
    expect(PortConnectionModule.inject).toEqual([])
    expect(typeof PortConnectionModule.apply).toBe('function')
  })
})

// ───────────────────────── PortApiClient ─────────────────────────

describe('PortApiClient unary', () => {
  it('gates the first rpc on the bridge ready ack, then round-trips the envelope', async () => {
    const { client, ports } = makeClient()
    const tap: ServerResponse[] = []
    client.subscribeEnvelopes((batch) => {
      for (const message of batch) tap.push(message as ServerResponse)
    })
    const call = client.host.describe({})
    // Not even connected traffic before the ack.
    expect(ports).toHaveLength(1)
    expect(ports[0]?.sent).toEqual([])
    ports[0]?.emit({ k: 'ready' })
    await vi.waitFor(() => { expect(ports[0]?.sent.at(-1)?.k).toBe('rpc') })
    expect(ports[0]?.sent.at(-1)).toMatchObject({ k: 'rpc', method: 'host.describe', payload: {} })
    reply(ports[0] as FakePort, { ok: true, value: HOST_DESCRIBE_VALUE })
    const response = await call
    expect(response.result).toEqual({ ok: true, value: HOST_DESCRIBE_VALUE })
    expect(response.rpcId).toBe((ports[0]?.sent.at(-1) as { rpcId: string }).rpcId)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(tap.map(message => message.type)).toEqual(['client-request', 'server-response'])
  })

  it('passes structured refusals through as first-class RpcResult errors (extension-only codes included)', async () => {
    const { client, ports } = makeClient(30_000, true)
    const call = client.workspace.create({ path: '/x' })
    await vi.waitFor(() => { expect(ports[0]?.sent.at(-1)?.k).toBe('rpc') })
    reply(ports[0] as FakePort, {
      ok: false,
      error: { code: 'not-available-in-extension', message: '此方法在扩展宿主中不可用', details: { method: 'workspace.create' } },
    })
    const response = await call
    expect(response.result).toEqual({
      ok: false,
      error: { code: 'not-available-in-extension', message: '此方法在扩展宿主中不可用', details: { method: 'workspace.create' } },
    })
  })

  it('enforces the unary deadline when the engine never answers', async () => {
    const { client, ports } = makeClient(15, true)
    const call = client.host.describe({})
    // Attach the rejection assertion before the 15 ms deadline can fire
    // (otherwise the promise sits rejected-but-unobserved across waitFor's
    // async gap and vitest reports an unhandled rejection).
    const rejected = expect(call).rejects.toThrow()
    await vi.waitFor(() => { expect(ports[0]?.sent.at(-1)?.k).toBe('rpc') })
    await rejected
    // A late answer must neither resolve nor leak: nothing throws unhandled.
    reply(ports[0] as FakePort, { ok: true, value: HOST_DESCRIBE_VALUE })
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  })

  it('honors a caller abort across the whole span (ack wait included)', async () => {
    const { client, ports } = makeClient()
    const caller = new AbortController()
    const call = client.host.describe({}, caller.signal)
    const rejected = expect(call).rejects.toThrow()
    caller.abort()
    await rejected
    expect(ports[0]?.sent.filter(message => message.k === 'rpc')).toHaveLength(0)
  })

  it('rejects pending calls on Port loss and reconnects transparently on the next use', async () => {
    const { client, ports } = makeClient(30_000, true)
    const lost = client.host.describe({})
    await vi.waitFor(() => { expect(ports[0]?.sent.at(-1)?.k).toBe('rpc' ) })
    ;(ports[0] as FakePort).disconnect()
    await expect(lost).resolves.toMatchObject({
      result: { ok: false, error: { code: 'internal', message: expect.stringContaining('disconnected') as never } },
    })
    const next = client.host.describe({})
    await vi.waitFor(() => { expect(ports).toHaveLength(2) })
    await vi.waitFor(() => { expect(ports[1]?.sent.at(-1)?.k).toBe('rpc') })
    reply(ports[1] as FakePort, { ok: true, value: HOST_DESCRIBE_VALUE })
    await expect(next).resolves.toMatchObject({ result: { ok: true } })
  })

  it('surfaces a connect failure to the caller (no chrome runtime → no silent hang)', async () => {
    const client = new PortApiClient(() => { throw new Error('connect refused') })
    await expect(client.host.describe({})).rejects.toThrow('connect refused')
  })
})

describe('PortApiClient respond', () => {
  it('delivers client responses and parses the receipt riding the rpc.result value', async () => {
    const { client, ports } = makeClient(30_000, true)
    const call = client.respond({ type: 'client-response', rpcId: RpcId('approval-1'), result: { ok: true, value: { outcome: 'allow' } } })
    await vi.waitFor(() => { expect(ports[0]?.sent.at(-1)?.k).toBe('respond') })
    expect(ports[0]?.sent.at(-1)).toMatchObject({ k: 'respond', rpcId: 'approval-1', result: { ok: true } })
    reply(ports[0] as FakePort, { ok: true, value: { accepted: true } })
    await expect(call).resolves.toEqual({ accepted: true })
  })

  it('parses not-pending receipts and throws on transport-level failures', async () => {
    const { client, ports } = makeClient(30_000, true)
    const late = client.respond({ type: 'client-response', rpcId: RpcId('late-1'), result: { ok: true, value: {} } })
    await vi.waitFor(() => { expect(ports[0]?.sent.at(-1)?.k).toBe('respond') })
    reply(ports[0] as FakePort, { ok: true, value: { accepted: false, reason: 'not-pending' } })
    await expect(late).resolves.toEqual({ accepted: false, reason: 'not-pending' })

    const failed = client.respond({ type: 'client-response', rpcId: RpcId('late-2'), result: { ok: true, value: {} } })
    await vi.waitFor(() => { expect(ports[0]?.sent.filter(message => message.k === 'respond').length).toBe(2) })
    reply(ports[0] as FakePort, { ok: false, error: { code: 'internal', message: 'boom' } })
    await expect(failed).rejects.toThrow('boom')
  })
})

describe('PortApiClient streams', () => {
  it('handshakes mux (open after ready, onOpen before frames), maps frames to envelopes, forwards the since payload', async () => {
    const { client, ports } = makeClient(30_000, true)
    const caller = new AbortController()
    const opened = vi.fn()
    const iter = client.events.mux({ since: sinceWatermark }, caller.signal, opened)[Symbol.asyncIterator]()
    const first = iter.next()
    // The Port is created by the first pull; bind after it exists.
    await vi.waitFor(() => { expect(ports[0]?.sent.some(message => message.k === 'stream.open')).toBe(true) })
    const port = ports[0] as FakePort
    expect(opened).toHaveBeenCalledTimes(1)
    expect(port.sent.find(message => message.k === 'stream.open')).toMatchObject({
      k: 'stream.open',
      stream: 'mux',
      payload: { since: { 'session-a': 5 } },
    })
    port.emit({ k: 'frame', stream: 'mux', frame: { type: 'session/subscribed', sessionId: 'session-a', lastSeq: 5 } })
    const { value } = await first as { value?: { payload: unknown; rpcId: string } }
    expect(value?.payload).toEqual({ type: 'session/subscribed', sessionId: 'session-a', lastSeq: 5 })
    expect(typeof value?.rpcId).toBe('string')
    caller.abort()
    await expect(iter.next()).resolves.toEqual({ done: true, value: undefined })
    expect(port.sent.at(-1)).toEqual({ k: 'stream.close', stream: 'mux' })
  })

  it('drops malformed frames loudly and keeps the stream alive', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client, ports } = makeClient(30_000, true)
    const caller = new AbortController()
    const iter = client.events.host({}, caller.signal)[Symbol.asyncIterator]()
    const first = iter.next()
    await vi.waitFor(() => { expect(ports[0]?.sent.some(message => message.k === 'stream.open')).toBe(true) })
    const port = ports[0] as FakePort
    port.emit({ k: 'frame', stream: 'host', frame: { type: 'not-a-host-frame' } })
    port.emit({ k: 'frame', stream: 'host', frame: { type: 'host/session-removed', sessionId: 'session-a' } })
    const { value } = await first as { value?: { payload: unknown } }
    expect(value?.payload).toEqual({ type: 'host/session-removed', sessionId: 'session-a' })
    expect(console.error).toHaveBeenCalled()
    caller.abort()
    await expect(iter.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('yields stream/error frames untouched (generation loss is the controller\'s business)', async () => {
    const { client, ports } = makeClient(30_000, true)
    const caller = new AbortController()
    const iter = client.events.mux({}, caller.signal)[Symbol.asyncIterator]()
    const first = iter.next()
    await vi.waitFor(() => { expect(ports[0]?.sent.some(message => message.k === 'stream.open')).toBe(true) })
    const port = ports[0] as FakePort
    port.emit({ k: 'frame', stream: 'mux', frame: { type: 'stream/error', error: { code: 'internal', message: 'x', details: {} } } })
    const { value } = await first as { value?: { payload: { type: string } } }
    expect(value?.payload.type).toBe('stream/error')
    caller.abort()
    await expect(iter.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('hands the mux tap the contract envelope (parsed payload + fresh rpcId), not the raw wire frame', async () => {    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client, ports } = makeClient(30_000, true)
    const tapped: Array<{ rpcId: string; payload: { type: string } }> = []
    client.onMuxEnvelope = envelope => tapped.push(envelope)
    // A Port only exists after the first use: open a throwaway mux stream.
    const caller = new AbortController()
    const iter = client.events.mux({}, caller.signal)[Symbol.asyncIterator]()
    void iter.next()
    await vi.waitFor(() => { expect(ports[0]?.sent.some(message => message.k === 'stream.open')).toBe(true) })
    const port = ports[0] as FakePort
    // A raw approval frame exactly as the engine broadcasts it.
    port.emit({
      k: 'frame',
      stream: 'mux',
      frame: { type: 'approval/requested', sessionId: 'session-a', approvalId: 'ap-1', toolName: 'tabs_open' },
    })
    await vi.waitFor(() => { expect(tapped).toHaveLength(1) })
    expect(tapped[0]?.payload).toEqual({
      type: 'approval/requested',
      sessionId: 'session-a',
      approvalId: 'ap-1',
      toolName: 'tabs_open',
    })
    expect(typeof tapped[0]?.rpcId).toBe('string')

    // A frame outside the contract is dropped loudly; the tap sees nothing.
    port.emit({ k: 'frame', stream: 'mux', frame: { type: 'not-a-mux-frame' } })
    expect(console.error).toHaveBeenCalled()
    expect(tapped).toHaveLength(1)
    caller.abort()
    await expect(iter.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('ends streams on Port loss (the reconnect path reopens on a fresh Port)', async () => {
    const { client, ports } = makeClient(30_000, true)
    const caller = new AbortController()
    const iter = client.events.mux({}, caller.signal)[Symbol.asyncIterator]()
    const first = iter.next()
    await vi.waitFor(() => { expect(ports[0]?.sent.some(message => message.k === 'stream.open')).toBe(true) })
    const port = ports[0] as FakePort
    port.disconnect()
    await expect(first).resolves.toEqual({ done: true, value: undefined })
    caller.abort()
  })

  it('routes frames only to the stream that opened them', async () => {
    const { client, ports } = makeClient(30_000, true)
    const caller = new AbortController()
    const mux = client.events.mux({}, caller.signal)[Symbol.asyncIterator]()
    const host = client.events.host({}, caller.signal)[Symbol.asyncIterator]()
    const muxFirst = mux.next()
    const hostFirst = host.next()
    await vi.waitFor(() => {
      expect(ports[0]?.sent.filter(message => message.k === 'stream.open').length).toBe(2)
    })
    const port = ports[0] as FakePort
    port.emit({ k: 'frame', stream: 'host', frame: { type: 'host/session-removed', sessionId: 'session-a' } })
    const { value } = await hostFirst as { value?: { payload: { type: string } } }
    expect(value?.payload.type).toBe('host/session-removed')
    // The mux pull stays pending: its queue never saw the host frame.
    const raced = await Promise.race([muxFirst.then(() => 'resolved'), new Promise<'pending'>((resolve) => { setTimeout(() => { resolve('pending') }, 20) })])
    expect(raced).toBe('pending')
    caller.abort()
    await expect(mux.next()).resolves.toEqual({ done: true, value: undefined })
  })
})

describe('connection-module port rpc streams', () => {
  it('translates $events: ready frame first, host remote-events as emits, other host frames skipped', async () => {
    const { client, ports } = makeClient(30_000, true)
    const rpc = PortConnectionModule.createPortRpc(client)
    const caller = new AbortController()
    const open = rpc.open
    if (open === undefined) throw new Error('unreachable: createPortRpc always supplies open')
    const iter = open('/api', '$events', {}, caller.signal)[Symbol.asyncIterator]()
    const first = iter.next()
    // The ready frame is synthesized before any port traffic.
    const ready = await first as { value?: { type: string; clientId: string; host: { home: string } } }
    expect(ready.value?.type).toBe('ready')
    expect(typeof ready.value?.clientId).toBe('string')
    expect(ready.value?.host).toEqual({ home: '' })
    // Consuming past ready opens the port's host stream.
    const second = iter.next()
    await vi.waitFor(() => {
      expect(ports[0]?.sent.some(message => message.k === 'stream.open')).toBe(true)
    })
    const port = ports[0] as FakePort
    // A non-event host frame is skipped; the remote-event frame becomes an emit.
    port.emit({ k: 'frame', stream: 'host', frame: { type: 'host/session-added', sessionId: 'session-a', blank: true } })
    port.emit({
      k: 'frame',
      stream: 'host',
      frame: { type: 'host/remote-event', event: 'credentials/reference-updated', args: [{ key: 'k' }] },
    })
    const emitted = await second as { value?: { type: string; event: string; args: unknown[] } }
    expect(emitted.value).toEqual({
      type: 'emit',
      event: 'credentials/reference-updated',
      args: [{ key: 'k' }],
    })
    caller.abort()
    await expect(iter.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('parks unknown Remote endpoints with one warning and ends cleanly on abort', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = makeClient(30_000, true)
    const rpc = PortConnectionModule.createPortRpc(client)
    const caller = new AbortController()
    const open = rpc.open
    if (open === undefined) throw new Error('unreachable: createPortRpc always supplies open')
    const iter = open('/api', 'session/follow', {}, caller.signal)[Symbol.asyncIterator]()
    const first = iter.next()
    await expect(Promise.race([
      first.then(() => 'yielded'),
      new Promise<'pending'>((resolve) => { setTimeout(() => { resolve('pending') }, 30) }),
    ])).resolves.toBe('pending')
    expect(console.warn).toHaveBeenCalledTimes(1)
    // A second opener of the same endpoint stays silent.
    const second = open('/api', 'session/follow', {}, new AbortController().signal)[Symbol.asyncIterator]()
    void second.next()
    expect(console.warn).toHaveBeenCalledTimes(1)
    caller.abort()
    await expect(iter.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('refuses non-/api stream channels like the call leg does', () => {
    const { client } = makeClient(30_000, true)
    const rpc = PortConnectionModule.createPortRpc(client)
    const open = rpc.open
    if (open === undefined) throw new Error('unreachable: createPortRpc always supplies open')
    expect(() => open('/other', '$events', {}, new AbortController().signal)).toThrow('/other')
  })
})
