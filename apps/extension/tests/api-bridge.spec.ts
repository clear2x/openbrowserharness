/**
 * api-bridge spec: boots the SAME composition src/offscreen/main.ts mounts
 * (the composition.spec.ts skeleton plus the `chrome-api-bridge` row) under
 * Node, with chrome.runtime mocked as an in-memory Port double and
 * chrome.storage as an in-memory map — then drives the ApiProxy surface
 * exactly the way the SidePanel's carrier will: rpc round-trips,
 * structured-unavailable refusals, mux stream baselines, session/event
 * forwarding, multi-port fan-out, and stream.close teardown.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Timer from '@deepseek-ai/cordis-plugin-timer'
import type { FiberState } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as llmRetry from '@deepseek-ai/dsh-llm-retry'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as BrowserSeam from '@deepseek-ai/dsh-browser'
import SessionStore from '@deepseek-ai/dsh-session'
import IndexedDbPersistence from '@deepseek-ai/dsh-session-persistence-indexeddb'
import { createMemoryDatabase } from './memory-idb.ts'
import * as checkpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import * as TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as compactionBasic from '@deepseek-ai/dsh-compaction-basic'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import * as AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as toolTodo from '@deepseek-ai/dsh-tool-todo'
import * as toolBrowser from '@deepseek-ai/dsh-tool-browser'
import * as userPluginTools from '../src/offscreen/user-plugin-tools.ts'
import { setUserPluginHost } from '../src/chrome/user-plugins.ts'
import * as StorageHub from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as chromeStorageKv from '../src/chrome/storage-kv.ts'
import * as chromeSkillStorage from '../src/chrome/skill-storage.ts'
import * as Commands from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import * as messageFeedback from '@deepseek-ai/dsh-message-feedback'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import ChromeCredentialProvider from '../src/chrome/credentials.ts'
import { syncCustomProviders } from '../src/chrome/custom-providers.ts'
import { ContentAddressedImageStore, bytesToBase64 } from '../src/chrome/attachment-store.ts'
import * as chromeBrowserProvider from '../src/chrome/browser-provider.ts'
import * as uiBridgePlugin from '../src/chrome/ui-bridge.ts'
import * as apiBridgePlugin from '../src/chrome/api-bridge.ts'
import * as planModePlugin from '@deepseek-ai/dsh-plan-mode'
import * as permissionModePlugin from '../src/offscreen/permission-mode.ts'
import { AGENT_PRESET_STORE_KEY, API_PORT_NAME, UNAVAILABLE_CODE } from '../src/chrome/api-bridge.ts'
import type { ApiPortDownMessage, ApiPortUpMessage, ApiRpcResult } from '../src/chrome/api-bridge.ts'

const PROVIDER = 'deepseek'
const MODEL = 'deepseek-v4-flash'
const HOST_VERSION = '0.1.0-rc.5'
const REPLY = 'api-bridge 烟测回复。'

/** Mirrors the offscreen entry: FiberState is a const enum erased from the built cordis lib. */
const FIBER_ACTIVE = 2

// ───────────────────────── in-memory chrome double ─────────────────────────

const connectListeners = new Set<(port: unknown) => void>()
const storageData = new Map<string, unknown>()
const storageChangedListeners = new Set<(changes: Record<string, unknown>, area: string) => void>()

/**
 * Installs the chrome double BEFORE the composition boots so settings-store,
 * ui-bridge, and api-bridge all observe it. Message delivery rides a
 * microtask (real Port messages are async too).
 */
function installChromeDouble(): void {
  const chromeMock = {
    runtime: {
      onConnect: {
        addListener: (listener: (port: unknown) => void): void => {
          connectListeners.add(listener)
        },
        removeListener: (listener: (port: unknown) => void): void => {
          connectListeners.delete(listener)
        },
      },
      onMessage: {
        addListener: (): void => undefined,
        removeListener: (): void => undefined,
      },
      sendMessage: (_message: unknown, callback?: (response?: unknown) => void): void => {
        callback?.({ ok: true })
      },
    },
    storage: {
      local: {
        get: async (keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> => {
          const names = typeof keys === 'string'
            ? [keys]
            : Array.isArray(keys)
              ? keys
              : keys === null || keys === undefined
                ? [...storageData.keys()]
                : Object.keys(keys)
          const out: Record<string, unknown> = {}
          for (const name of names) {
            const value = storageData.get(name)
            if (value !== undefined) out[name] = value
          }
          return out
        },
        set: async (items: Record<string, unknown>): Promise<void> => {
          for (const [key, value] of Object.entries(items)) storageData.set(key, value)
          // Real chrome fires onChanged after every set/remove; skills-provider
          // catalog invalidation rides it, so the double must too.
          const changes = Object.fromEntries(
            Object.keys(items).map(key => [key, { newValue: storageData.get(key) }]),
          )
          for (const listener of storageChangedListeners) listener(changes, 'local')
        },
        remove: async (keys: string | string[] | object): Promise<void> => {
          const names = typeof keys === 'string'
            ? [keys]
            : Array.isArray(keys)
              ? keys
              : Object.keys(keys)
          const changes = Object.fromEntries(names.map(key => [key, {}]))
          for (const name of names) storageData.delete(name)
          for (const listener of storageChangedListeners) listener(changes, 'local')
        },
      },
      onChanged: {
        addListener: (listener: (changes: Record<string, unknown>, area: string) => void): void => {
          storageChangedListeners.add(listener)
        },
        removeListener: (listener: (changes: Record<string, unknown>, area: string) => void): void => {
          storageChangedListeners.delete(listener)
        },
      },
    },
  }
  ;(globalThis as unknown as { chrome: unknown }).chrome = chromeMock
}

/** One end of an in-memory Port pair (microtask delivery, like a real Port). */
class FakePortEnd {
  readonly messageListeners = new Set<(message: unknown) => void>()
  readonly disconnectListeners = new Set<() => void>()
  peer: FakePortEnd | undefined

  constructor(readonly name: string) {}

  postMessage(message: unknown): void {
    const peer = this.peer
    if (peer === undefined) return
    queueMicrotask(() => {
      for (const listener of [...peer.messageListeners]) listener(message)
    })
  }

  disconnect(): void {
    for (const listener of [...this.disconnectListeners, ...this.peer?.disconnectListeners ?? []]) {
      listener()
    }
  }

  readonly onMessage = {
    addListener: (listener: (message: unknown) => void): void => {
      this.messageListeners.add(listener)
    },
    removeListener: (listener: (message: unknown) => void): void => {
      this.messageListeners.delete(listener)
    },
  }

  readonly onDisconnect = {
    addListener: (listener: () => void): void => {
      this.disconnectListeners.add(listener)
    },
    removeListener: (listener: () => void): void => {
      this.disconnectListeners.delete(listener)
    },
  }
}

/** The SidePanel-side test driver over one connected Port. */
class TestClient {
  readonly inbox: ApiPortDownMessage[] = []
  private readonly waiters: Array<{
    predicate: (message: ApiPortDownMessage) => boolean
    resolve: (message: ApiPortDownMessage) => void
  }> = []
  private rpcCounter = 0

  bind(end: FakePortEnd): void {
    end.onMessage.addListener((message) => {
      const down = message as ApiPortDownMessage
      this.inbox.push(down)
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const waiter = this.waiters[i] as (typeof this.waiters)[number]
        if (!waiter.predicate(down)) continue
        this.waiters.splice(i, 1)
        waiter.resolve(down)
      }
    })
  }

  send(up: ApiPortUpMessage): void {
    this.end.postMessage(up)
  }

  constructor(private readonly end: FakePortEnd) {
    this.bind(end)
  }

  /** Resolve with the FIRST message (already seen or future) matching the predicate. */
  async expect(
    predicate: (message: ApiPortDownMessage) => boolean,
    timeoutMs = 8_000,
  ): Promise<ApiPortDownMessage> {
    const seen = this.inbox.find(predicate)
    if (seen !== undefined) return seen
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`等待端口消息超时（inbox：${JSON.stringify(this.inbox)}）`))
      }, timeoutMs)
      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
      })
    })
  }

  /** One unary rpc round-trip; resolves with the business result. */
  async rpc(method: string, payload?: unknown, timeoutMs = 8_000): Promise<ApiRpcResult> {
    this.rpcCounter += 1
    const rpcId = `test-rpc-${String(this.rpcCounter)}`
    this.send({ k: 'rpc', rpcId, method, payload })
    const answer = await this.expect(
      message => message.k === 'rpc.result' && message.rpcId === rpcId,
      timeoutMs,
    )
    if (answer.k !== 'rpc.result') throw new Error('unreachable: predicate guarantees rpc.result')
    return answer.result
  }
}

/** Connect one SidePanel test client; the engine sees the server-side end. */
function connectSidePanel(): TestClient {
  const server = new FakePortEnd(API_PORT_NAME)
  const clientEnd = new FakePortEnd(API_PORT_NAME)
  server.peer = clientEnd
  clientEnd.peer = server
  for (const listener of [...connectListeners]) {
    listener(server as unknown as chrome.runtime.Port)
  }
  return new TestClient(clientEnd)
}

// ───────────────────────── composition ─────────────────────────

class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly route = PROVIDER) {
    super()
  }

  override async *stream(_options: GenerateOptions): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: REPLY }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 6 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      { provider: this.route, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
      { provider: this.route, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ])
  }

  // DeepSeek-family facts (the preset route's adapter would report): a 1M
  // window, text-only input (except the vision fixture model, which declares
  // image input for the attachment admission gate), and selectable
  // off/high/max reasoning efforts.
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1_000_000 },
      inputModalities: model === 'deepseek-vision' ? ['text', 'image'] : ['text'],
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('off'), name: 'Off' },
          { id: ReasoningEffortId('high'), name: 'High' },
          { id: ReasoningEffortId('max'), name: 'Max' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    })
  }
}

async function bootComposition(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Loader)
  // The tool lane's host singleton: stubbed so chrome-user-plugin-tools can
  // bind its definitions without chrome.storage/sandbox (execute paths are
  // not exercised here — registration is what this composition proves).
  setUserPluginHost({
    list: async () => [],
    write: async () => ({ name: 'x', registeredEvents: [] }),
    remove: async () => undefined,
    toggle: async () => ({ name: 'x', enabled: true }),
    start: async () => undefined,
    dispose: () => undefined,
  } as never)
  const MODULES: Record<string, object> = {
    '@deepseek-ai/cordis-plugin-timer': Timer,
    '@deepseek-ai/dsh-llm': LlmRuntime,
    '@deepseek-ai/dsh-llm-retry': llmRetry,
    '@deepseek-ai/dsh-browser': BrowserSeam,
    '@deepseek-ai/dsh-session': SessionStore,
    '@deepseek-ai/dsh-session-checkpoint-policy': checkpointPolicy,
    '@deepseek-ai/dsh-token-meter': TokenMeter,
    '@deepseek-ai/dsh-compaction-basic': compactionBasic,
    '@deepseek-ai/dsh-tools': ToolRuntime,
    '@deepseek-ai/dsh-system-prompt': SystemPrompt,
    '@deepseek-ai/dsh-agent': AgentRegistry,
    '@deepseek-ai/dsh-agent-default-model': AgentDefaultModel,
    '@deepseek-ai/dsh-agent-loop': AgentLoop,
    '@deepseek-ai/dsh-tool-todo': toolTodo,
    '@deepseek-ai/dsh-tool-browser': toolBrowser,
    '@deepseek-ai/dsh-commands': Commands,
    '@deepseek-ai/dsh-goal': GoalService,
    '@deepseek-ai/dsh-message-feedback': messageFeedback,
    'chrome-credentials': ChromeCredentialProvider,
    'chrome-browser-provider': chromeBrowserProvider,
    'ui-bridge': uiBridgePlugin,
    '@deepseek-ai/dsh-session-projection': SessionProjection,
    '@deepseek-ai/dsh-subagent': Subagents,
    '@deepseek-ai/dsh-subagent-spawn-in-process': SubagentSpawn,
    '@deepseek-ai/dsh-skill': SkillRegistry,
    '@deepseek-ai/dsh-storage': StorageHub,
    'chrome-storage-kv': chromeStorageKv,
    'chrome-skill-storage': chromeSkillStorage,
    '@deepseek-ai/dsh-storage-domain': storageDomain,
    'chrome-api-bridge': apiBridgePlugin,
    'chrome-user-plugin-tools': userPluginTools,
    '@deepseek-ai/dsh-plan-mode': planModePlugin,
    'permission-mode': permissionModePlugin,
  }
  ctx.loader.internal = {
    import: async (name: string) => {
      const mod = MODULES[name]
      if (mod === undefined) throw new Error(`引擎宿主未捆绑插件模块：${name}`)
      return mod
    },
  } as never

  // Node substitution: the IndexedDB backend over the in-memory double.
  const memory = createMemoryDatabase()
  class MemoryBackedPersistence extends IndexedDbPersistence {
    constructor(pctx: Context, config: Record<string, unknown>) {
      super(pctx, config as never, { openDatabase: memory.open })
    }
  }
  ctx.plugin(MemoryBackedPersistence, { dbName: 'api-bridge-spec' })

  const rows: Array<{ name: string; config?: Record<string, unknown> }> = [
    { name: '@deepseek-ai/cordis-plugin-timer' },
    { name: '@deepseek-ai/dsh-llm' },
    { name: '@deepseek-ai/dsh-llm-retry' },
    { name: '@deepseek-ai/dsh-browser' },
    { name: '@deepseek-ai/dsh-session' },
    { name: '@deepseek-ai/dsh-session-checkpoint-policy' },
    { name: '@deepseek-ai/dsh-token-meter' },
    {
      name: '@deepseek-ai/dsh-compaction-basic',
      config: { thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192, compactionRetries: 1 },
    },
    { name: '@deepseek-ai/dsh-tools' },
    { name: '@deepseek-ai/dsh-system-prompt', config: { persona: '' } },
    { name: '@deepseek-ai/dsh-agent' },
    { name: '@deepseek-ai/dsh-agent-default-model', config: { provider: PROVIDER, model: MODEL } },
    { name: '@deepseek-ai/dsh-skill' },
    {
      name: '@deepseek-ai/dsh-agent-loop',
      config: { agents: [{ id: 'main', sessionId: 'session-main', provider: PROVIDER, model: MODEL }] },
    },
    { name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { name: '@deepseek-ai/dsh-tool-browser' },
    // The bridge's inject array names commands/goals/messageFeedback since the
    // typert dispatchers landed; the composition must provide all three or the
    // bridge fiber stays PENDING forever.
    { name: '@deepseek-ai/dsh-commands' },
    { name: '@deepseek-ai/dsh-goal' },
    // message-feedback rides the chrome.storage KV trio, same as offscreen.
    { name: '@deepseek-ai/dsh-storage' },
    { name: 'chrome-storage-kv' },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'chrome' } },
    { name: '@deepseek-ai/dsh-message-feedback', config: { maxNoteBytes: 8192 } },
    // The bridge's inject array names subagents since the RPC face landed;
    // the subagent catalog folds through the projection registry, so both
    // rows must compose or the bridge fiber stays PENDING forever.
    { name: '@deepseek-ai/dsh-session-projection' },
    { name: '@deepseek-ai/dsh-subagent' },
    { name: '@deepseek-ai/dsh-subagent-spawn-in-process', config: { providerName: 'spawn' } },
    { name: 'chrome-credentials' },
    { name: 'chrome-browser-provider' },
    { name: 'ui-bridge' },
    // The bridge's inject array names permissionMode (session.permission.*):
    // the knob service rides the plan-mode service for its plan sync, so both
    // rows must precede chrome-api-bridge or the bridge fiber stays PENDING.
    { name: '@deepseek-ai/dsh-plan-mode', config: { section: '计划模式下只做研究，不执行变更。' } },
    { name: 'permission-mode' },
    { name: 'chrome-skill-storage' },
    { name: 'chrome-api-bridge' },
    { name: 'chrome-user-plugin-tools' },
  ]
  for (const row of rows) {
    await ctx.loader.create({
      name: row.name,
      ...(row.config === undefined ? {} : { config: row.config }),
    })
  }

  // Node substitution: the scripted adapter owns the provider route
  // (chrome-llm's storage-backed key resolution has no Node answer).
  ctx.llm.registerAdapter([PROVIDER], new ScriptedAdapter())

  await ctx.loader.await()
  const notActive = Array.from(ctx.loader.entries())
    .filter(entry => entry.fiber === undefined || entry.fiber.state !== (FIBER_ACTIVE as FiberState))
    .map(entry => `${entry.options.name}(${entry.fiber?.state ?? 'fiberless'})`)
  expect(notActive).toEqual([])

  // The configured agent's restore-or-create startup runs past its fiber's
  // apply — poll like the boot entry's restore does.
  const deadline = Date.now() + 10_000
  while (ctx.agents.roots().length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const [agent] = ctx.agents.roots()
  expect(agent).toBeDefined()
  await agent!.whenIdle()
  return ctx
}

/** Drive one scripted turn on a session and wait for quiescence + flush. */
async function driveTurn(ctx: Context, sessionId: string, text: string): Promise<void> {
  const agent = ctx.agents.get(sessionId as never)
  expect(agent).toBeDefined()
  agent!.followup(
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  )
  await agent!.whenIdle()
  await ctx.sessions.flush(agent!.session)
}

// ───────────────────────── tests ─────────────────────────

describe('chrome-api-bridge', () => {
  it(
    'serves the ApiProxy surface over the dsh-api Port',
    { timeout: 120_000 },
    async () => {
      installChromeDouble()
      const ctx = await bootComposition()

      const panelA = connectSidePanel()
      const panelB = connectSidePanel()

      // Both connections get the ready handshake.
      await panelA.expect(message => message.k === 'ready')
      await panelB.expect(message => message.k === 'ready')

      // ── rpc round-trip: host.describe ──
      const describe = await panelA.rpc('host.describe')
      expect(describe.ok).toBe(true)
      if (!describe.ok) throw new Error('unreachable')
      expect(describe.value).toEqual({
        version: HOST_VERSION,
        cwd: '/',
        provider: PROVIDER,
        model: MODEL,
        attachedSessions: expect.any(Number),
        canOpenPath: false,
      })
      expect((describe.value as { attachedSessions: number }).attachedSessions).toBeGreaterThanOrEqual(1)

      // ── rpc round-trip: session.list (the startup main session) ──
      const list1 = await panelA.rpc('session.list', {})
      expect(list1.ok).toBe(true)
      if (!list1.ok) throw new Error('unreachable')
      const items1 = (list1.value as { items: Array<{ sessionId: string; blank: boolean }> }).items
      const main1 = items1.find(item => item.sessionId === 'session-main')
      expect(main1).toBeDefined()
      expect(main1!.blank).toBe(true) // no turn has run yet

      // ── structured-unavailable refusals (never thrown) ──
      // (goal.create left this list when the typert dispatcher gained a real
      // goals/create implementation — it now answers bad-request, not a
      // structured refusal.)
      for (const method of ['host.pickDirectory', 'host.listDirectory', 'workspace.rename']) {
        const refused = await panelB.rpc(method, {})
        expect(refused.ok).toBe(false)
        if (refused.ok) throw new Error(`unreachable: ${method}`)
        expect(refused.error.code).toBe(UNAVAILABLE_CODE)
        expect(refused.error.message).toContain(method)
      }
      const unknown = await panelA.rpc('bogus.method', {})
      expect(unknown.ok).toBe(false)
      if (unknown.ok) throw new Error('unreachable')
      expect(unknown.error.code).toBe(UNAVAILABLE_CODE)

      // ── mux stream: subscribed baseline, live forwarding ──
      panelA.send({ k: 'stream.open', stream: 'mux', rpcId: 'mux-open-a' })
      const subscribed = await panelA.expect(
        message => message.k === 'frame' && message.stream === 'mux'
          && message.frame.type === 'session/subscribed' && message.frame.sessionId === 'session-main',
      )
      if (subscribed.k !== 'frame') throw new Error('unreachable')
      expect((subscribed.frame as { lastSeq: number }).lastSeq).toBeGreaterThanOrEqual(-1)

      // panelB has NOT opened its mux stream: a turn must reach A only.
      // (The inbox-splice event precedes turn/start, so match the turn's
      // opening frame explicitly rather than asserting on the first frame.)
      await driveTurn(ctx, 'session-main', '打个招呼')
      const turnStart = await panelA.expect(
        message => message.k === 'frame' && message.stream === 'mux'
          && message.frame.type === 'session/event' && message.frame.sessionId === 'session-main'
          && (message.frame as { event: { type?: string } }).event.type === 'turn/start',
      )
      if (turnStart.k !== 'frame') throw new Error('unreachable')
      expect(panelB.inbox.some(message => message.k === 'frame')).toBe(false)

      // ── multi-port broadcast: B opens its mux, the next turn reaches both ──
      panelB.send({ k: 'stream.open', stream: 'mux', rpcId: 'mux-open-b' })
      await panelB.expect(
        message => message.k === 'frame' && message.stream === 'mux'
          && message.frame.type === 'session/subscribed' && message.frame.sessionId === 'session-main',
      )
      await driveTurn(ctx, 'session-main', '再打一个招呼')
      await panelA.expect(
        message => message.k === 'frame' && message.stream === 'mux'
          && message.frame.type === 'session/event'
          && (message.frame as { event: { data: { content?: Array<{ text?: string }> } } }).event.data.content?.[0]?.text === '再打一个招呼',
      )
      await panelB.expect(
        message => message.k === 'frame' && message.stream === 'mux'
          && message.frame.type === 'session/event',
      )

      // ── host stream: workspace baseline frame + session-status ──
      panelA.send({ k: 'stream.open', stream: 'host', rpcId: 'host-open-a' })
      const workspaceFrame = await panelA.expect(
        message => message.k === 'frame' && message.stream === 'host'
          && message.frame.type === 'host/workspace-changed',
      )
      if (workspaceFrame.k !== 'frame') throw new Error('unreachable')
      const workspace = (workspaceFrame.frame as {
        workspace: { workspaceId: string; sessionIds: string[] }
      }).workspace
      expect(workspace.workspaceId).toBe('extension-main')
      expect(workspace.sessionIds).toContain('session-main')

      // ── stream.close stops the forwarding ──
      // Settle in-flight frame deliveries from the previous turn (Port
      // delivery rides microtasks), then close and let the close land before
      // the accounting snapshot — otherwise late tail frames pollute the count.
      await new Promise(resolve => setTimeout(resolve, 100))
      panelA.send({ k: 'stream.close', stream: 'mux' })
      await new Promise(resolve => setTimeout(resolve, 100))
      const framesBefore = panelA.inbox
        .filter(message => message.k === 'frame' && message.stream === 'mux').length
      await driveTurn(ctx, 'session-main', '第三次招呼')
      await panelB.expect(
        message => message.k === 'frame' && message.stream === 'mux'
          && message.frame.type === 'session/event'
          && (message.frame as { event: { data: { content?: Array<{ text?: string }> } } }).event.data.content?.[0]?.text === '第三次招呼',
      )
      // Give the (closed) A stream a beat to misbehave, then assert silence.
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(panelA.inbox.filter(message => message.k === 'frame' && message.stream === 'mux').length)
        .toBe(framesBefore)

      // ── post-turn facts: list shows the started session with a title ──
      const list2 = await panelA.rpc('session.list', {})
      expect(list2.ok).toBe(true)
      if (!list2.ok) throw new Error('unreachable')
      const items2 = (list2.value as {
        items: Array<{ sessionId: string; blank: boolean; projections?: { values: { title?: string } } }>
      }).items
      const main2 = items2.find(item => item.sessionId === 'session-main')
      expect(main2).toBeDefined()
      expect(main2!.blank).toBe(false)
      expect(main2!.projections?.values.title).toBeDefined()

      // ── history round-trip over the port ──
      const history = await panelA.rpc('session.history', { sessionId: 'session-main' })
      expect(history.ok).toBe(true)
      if (!history.ok) throw new Error('unreachable')
      const historyValue = history.value as { events: Array<{ event: { type: string; seq: number } }>; hasMore: boolean }
      expect(historyValue.events.length).toBeGreaterThan(0)
      expect(historyValue.hasMore).toBe(false)
      // The whole log fits one page: page starts at seq 0 (whose event is the
      // followup enqueue splice; turn/start is seq 1 — see composition.spec).
      expect(historyValue.events[0]!.event.seq).toBe(0)
      expect(historyValue.events.some(entry => entry.event.type === 'turn/start')).toBe(true)

      // ── session prompt through the port API (the SidePanel's real path) ──
      const prompt = await panelB.rpc('session.prompt', {
        sessionId: 'session-main',
        mode: 'queue',
        content: [{ type: 'text', text: '通过端口发送' }],
      })
      expect(prompt.ok).toBe(true)
      if (!prompt.ok) throw new Error('unreachable')
      expect((prompt.value as { accepted: boolean }).accepted).toBe(true)
      const agent = ctx.agents.get('session-main' as never)
      expect(agent).toBeDefined()
      await agent!.whenIdle()
      await ctx.sessions.flush(agent!.session)

      // ── workspace.list: fixed single-workspace view ──
      const workspaces = await panelA.rpc('workspace.list', {})
      expect(workspaces.ok).toBe(true)
      if (!workspaces.ok) throw new Error('unreachable')
      const wsItems = (workspaces.value as {
        items: Array<{ workspaceId: string; sessionIds: string[] }>
        archivedSessionIds: string[]
      })
      expect(wsItems.items).toHaveLength(1)
      expect(wsItems.items[0]!.workspaceId).toBe('extension-main')
      expect(wsItems.items[0]!.sessionIds).toContain('session-main')
      expect(wsItems.archivedSessionIds).toEqual([])

      // ── settings + credentials over chrome.storage ──
      const settingsDescribe = await panelA.rpc('settings.describe', {})
      expect(settingsDescribe.ok).toBe(true)
      if (!settingsDescribe.ok) throw new Error('unreachable')
      const describeValue = settingsDescribe.value as {
        writable: boolean
        namespaces: Array<{
          ns: string
          schema: { type: string; dict: Record<string, { type: string }> }
          value: { baseURL?: string; model?: string; provider?: string }
          secrets: Array<{ path: string[]; set: boolean }>
        }>
      }
      expect(describeValue.writable).toBe(true)
      expect(describeValue.namespaces[0]!.ns).toBe('llm-deepseek')
      // The engine section mirrors the llm-deepseek adapter family's Config
      // shape, so the dsh Models page renders the curated DeepSeek editor.
      expect(describeValue.namespaces[0]!.schema.type).toBe('object')
      expect(Object.keys(describeValue.namespaces[0]!.schema.dict)).toEqual(expect.arrayContaining([
        'apiKeyEnv', 'baseURL', 'models', 'maxTokens', 'defaultContextWindow',
      ]))
      expect(describeValue.namespaces[0]!.value.model).toBe(MODEL)
      expect(describeValue.namespaces[0]!.secrets.some((entry: { path: string[] }) => entry.path.join('.') === 'apiKeyEnv')).toBe(true)
      // The engine section exposes the ACTIVE provider, so the Models page can
      // mark it 默认 and switch it through a settings.mutate path op.
      expect(describeValue.namespaces[0]!.schema.dict).toHaveProperty('provider')
      expect(describeValue.namespaces[0]!.value.provider).toBe(PROVIDER)
      // The seeded plugin-card namespaces agree with the offscreen composition:
      // the web-search-deepseek provider is mounted, so its card seeds enabled.
      const genericViews = describeValue.namespaces as Array<{ ns: string; value: Record<string, unknown> }>
      const webSearchNs = genericViews.find(view => view.ns === 'web-search-deepseek')
      expect(webSearchNs).toBeDefined()
      expect(webSearchNs?.value.enabled).toBe(true)
      expect(webSearchNs?.value.apiKeyEnv).toBe('DEEPSEEK_API_KEY')

      const credSet = await panelA.rpc('credentials.set', { ref: 'DEEPSEEK_API_KEY', value: 'sk-test' })
      expect(credSet.ok).toBe(true)
      expect(storageData.get('DEEPSEEK_API_KEY')).toBe('sk-test')
      const credDescribe = await panelA.rpc('credentials.describe', { refs: ['DEEPSEEK_API_KEY'] })
      expect(credDescribe.ok).toBe(true)
      if (!credDescribe.ok) throw new Error('unreachable')
      const credView = (credDescribe.value as {
        credentials: Record<string, { configured: boolean; writable: boolean }>
      }).credentials['DEEPSEEK_API_KEY']
      expect(credView).toBeDefined()
      if (credView === undefined) throw new Error('unreachable')
      expect(credView.configured).toBe(true)
      expect(credView.writable).toBe(true)

      // ── llm catalog over the registered route ──
      const models = await panelA.rpc('llm.models', {})
      expect(models.ok).toBe(true)
      if (!models.ok) throw new Error('unreachable')
      const catalog = models.value as {
        groups: Array<{
          id: string
          contextWindow?: number
          models: Array<{
            id: string
            contextWindow?: number
            inputModalities?: string[]
            reasoning?: { efforts: Array<{ id: string }>; defaultEffort?: string }
          }>
        }>
        failures: unknown[]
      }
      expect(catalog.groups[0]!.id).toBe(PROVIDER)
      expect(catalog.groups[0]!.models.map(model => model.id)).toContain('deepseek-v4-flash')
      expect(catalog.groups.some((group: { id: string }) => group.id === PROVIDER)).toBe(true)
      for (const failure of catalog.failures) expect(typeof (failure as { message: string }).message).toBe('string')

      // ── catalog capability metadata rides the wire (deepseek preset facts) ──
      const deepseekGroup = catalog.groups.find(group => group.id === PROVIDER)
      expect(deepseekGroup).toBeDefined()
      if (deepseekGroup === undefined) throw new Error('unreachable')
      // Provider-level window comes from the preset registry (1M).
      expect(deepseekGroup.contextWindow).toBe(1_000_000)
      for (const row of deepseekGroup.models) {
        expect(row.contextWindow).toBe(1_000_000)
        expect(row.inputModalities).toEqual(['text'])
        expect(row.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'high', 'max'])
        expect(row.reasoning?.defaultEffort).toBe('high')
      }

      // ── hand-declared route models carry their profile metadata ──
      storageData.set('dsh-api-settings-namespaces', {
        'llm-pi-ai': {
          revision: 0,
          value: {
            providers: {
              'acme-gateway': {
                displayName: 'Acme',
                api: 'openai',
                baseURL: 'https://api.acme.example.com/v1',
                apiKeyEnv: '',
                models: [{
                  id: 'acme-large',
                  name: 'Acme Large',
                  contextWindow: 65536,
                  maxTokens: 32768,
                  input: ['text', 'image'],
                }],
              },
            },
          },
        },
      })
      // chrome-llm runs this sync at boot; the test composition mounts LlmRuntime
      // directly, so the sync runs here — after which the route is live.
      await syncCustomProviders(ctx)
      const withDeclared = await panelA.rpc('llm.models', {})
      expect(withDeclared.ok).toBe(true)
      if (!withDeclared.ok) throw new Error('unreachable')
      const declaredCatalog = withDeclared.value as {
        groups: Array<{
          id: string
          name: string
          contextWindow?: number
          models: Array<{
            id: string
            contextWindow?: number
            inputModalities?: string[]
            reasoning?: { efforts: Array<{ id: string }> }
          }>
        }>
      }
      const acme = declaredCatalog.groups.find(group => group.id === 'acme-gateway')
      expect(acme).toBeDefined()
      if (acme === undefined) throw new Error('unreachable')
      expect(acme.name).toBe('Acme')
      // No preset backs a declared route, so no provider-level window; the
      // model's own disclosed window is the real value.
      expect(acme.contextWindow).toBeUndefined()
      expect(acme.models[0]).toMatchObject({
        id: 'acme-large',
        name: 'Acme Large',
        contextWindow: 65536,
        // The profile declares image input, but the chat-completions family
        // adapter serializes text only in this host — the seam reports the
        // intersection, so the bridge refuses image prompts at admission.
        inputModalities: ['text'],
      })
      expect(acme.models[0]!.reasoning?.efforts.length).toBeGreaterThan(0)

      // ── llm.providers: the official directory is DeepSeek alone ──
      const providers = await panelA.rpc('llm.providers', {})
      expect(providers.ok).toBe(true)
      if (!providers.ok) throw new Error('unreachable')
      const providerRows = (providers.value as {
        providers: Array<{
          provider: string
          displayName: string
          settingsNs: string
          settingsPath: string[]
          active: boolean
          keyEnv?: string
          baseURL?: string
          api?: string
          defaultModel?: string
        }>
      }).providers
      const officialRows = providerRows.filter(row => row.settingsPath.length === 0)
      // Two presets ship by default (DeepSeek + 智谱); every other vendor
      // arrives through the Models page's 添加供应商 custom flow.
      expect(officialRows.map(row => row.provider)).toEqual(['deepseek', 'zhipu', 'zhipu-coding'])
      expect(officialRows[0]).toMatchObject({
        displayName: 'DeepSeek',
        settingsNs: 'llm-deepseek',
        active: true,
        keyEnv: 'DEEPSEEK_API_KEY',
        baseURL: 'https://api.deepseek.com',
        api: 'openai',
        defaultModel: MODEL,
      })

      // ── the catalog lists only configured providers, and only presets ──
      // With the DeepSeek key stored, the preset group is the sole official
      // entry; a stored key under a non-preset ref must not conjure a group
      // (adding a provider is a settings-page action, not a picker concern).
      expect(catalog.groups.map((group: { id: string }) => group.id)).toEqual([PROVIDER])
      expect(catalog.failures).toEqual([])
      const straySet = await panelA.rpc('credentials.set', { ref: 'OPENAI_API_KEY', value: 'sk-openai' })
      expect(straySet.ok).toBe(true)
      const modelsAfterStrayKey = await panelA.rpc('llm.models', {})
      expect(modelsAfterStrayKey.ok).toBe(true)
      if (!modelsAfterStrayKey.ok) throw new Error('unreachable')
      const afterGroups = (modelsAfterStrayKey.value as { groups: Array<{ id: string; models: Array<{ id: string }> }> }).groups
      expect(afterGroups.find(group => group.id === 'openai')).toBeUndefined()

      // ── session.models: current selection + routability ──
      const sessionModels = await panelA.rpc('session.models', { sessionId: 'session-main' })
      expect(sessionModels.ok).toBe(true)
      if (!sessionModels.ok) throw new Error('unreachable')
      const modelsValue = sessionModels.value as {
        current: { provider: string }
        routable: boolean
        groups: unknown[]
      }
      expect(modelsValue.current.provider).toBe(PROVIDER)
      expect(modelsValue.routable).toBe(true)

      // ── session.create / cancel round-trips ──
      const created = await panelA.rpc('session.create', {})
      expect(created.ok).toBe(true)
      if (!created.ok) throw new Error('unreachable')
      const createdId = (created.value as { sessionId: string }).sessionId
      expect(typeof createdId).toBe('string')
      const cancel = await panelA.rpc('session.cancel', { sessionId: 'session-main' })
      expect(cancel.ok).toBe(true)

      // ── session.search: keyword match over the durable event logs ──
      // (the 'main' session holds the prompted turns above; the blank session
      // created earlier carries no message text and must not surface)
      const search = await panelA.rpc('session.search', { query: '招呼' })
      expect(search.ok).toBe(true)
      if (!search.ok) throw new Error('unreachable')
      const searchValue = search.value as {
        items: Array<{ sessionId: string; snippet: string }>
        hasMore: boolean
      }
      expect(searchValue.hasMore).toBe(false)
      const mainHit = searchValue.items.find(item => item.sessionId === 'session-main')
      expect(mainHit).toBeDefined()
      expect(mainHit!.snippet).toContain('招呼')
      expect(searchValue.items.some(item => item.sessionId === createdId)).toBe(false)
      // Case-insensitive matching over assistant reply text.
      const replyHit = await panelA.rpc('session.search', { query: '烟测' })
      expect(replyHit.ok).toBe(true)
      if (!replyHit.ok) throw new Error('unreachable')
      expect((replyHit.value as { items: Array<{ sessionId: string }> }).items
        .map(item => item.sessionId)).toContain('session-main')
      // A query matching nothing answers the empty page.
      const miss = await panelA.rpc('session.search', { query: '不存在的关键词' })
      expect(miss.ok).toBe(true)
      if (!miss.ok) throw new Error('unreachable')
      expect(miss.value).toEqual({ items: [], hasMore: false })
      // Wire parity: a blank query is a bad-request refusal, never an empty page.
      const blank = await panelA.rpc('session.search', { query: '   ' })
      expect(blank.ok).toBe(false)
      if (blank.ok) throw new Error('unreachable')
      expect(blank.error.code).toBe('bad-request')
      const skills = await panelA.rpc('skill.list', { sessionId: 'session-main' })
      expect(skills.ok).toBe(true)
      if (!skills.ok) throw new Error('unreachable')
      expect((skills.value as { skills: unknown[] }).skills).toEqual([])
      const presets = await panelA.rpc('agentPreset.list', {})
      expect(presets.ok).toBe(true)
      if (!presets.ok) throw new Error('unreachable')
      expect((presets.value as { presets: Array<{ id: string; trust: string; isDefault: boolean }> }).presets)
        .toEqual([{
          id: 'default',
          trust: 'system',
          isDefault: true,
          name: '默认',
          description: expect.stringContaining(`当前引擎：${PROVIDER}/`),
        }])
      // The extension roster is authorable by construction (chrome.storage is
      // the writable root); no native opener exists to hand a directory to.
      expect((presets.value as { authorable: boolean; hasDocument: boolean }).authorable).toBe(true)
      expect((presets.value as { hasDocument: boolean }).hasDocument).toBe(false)
      const subagents = await panelA.rpc('subagent.list', { parentSessionId: 'session-main' })
      expect(subagents.ok).toBe(true)
      if (!subagents.ok) throw new Error('unreachable')
      const subagentValue = subagents.value as { entries: unknown[]; parentAvailable: boolean }
      expect(subagentValue.entries).toEqual([])
      expect(subagentValue.parentAvailable).toBe(true)

      // ── agent presets: the implicit 'default' composition preset ──
      const createdDefault = await panelB.rpc('session.create', { agentPreset: 'default' })
      expect(createdDefault.ok).toBe(true)
      if (!createdDefault.ok) throw new Error('unreachable')
      expect((createdDefault.value as { agentPreset?: string }).agentPreset).toBe('default')
      // An unknown preset is a roster miss, not a structural refusal: the
      // error carries the ids the roster does supply.
      const refusedPreset = await panelB.rpc('session.create', { agentPreset: 'other' })
      expect(refusedPreset.ok).toBe(false)
      if (refusedPreset.ok) throw new Error('unreachable')
      expect(refusedPreset.error.code).toBe('agent-preset-not-found')
      expect((refusedPreset.error.details as { available?: string[] }).available).toContain('default')

      // ── plugin inventory: live loader-tree projection ──
      const inventory = await panelA.rpc('pluginInventory/list', {})
      expect(inventory.ok).toBe(true)
      if (!inventory.ok) throw new Error('unreachable')
      const inventoryRows = (inventory.value as {
        entries: Array<{ entryId: string; moduleName: string; enabled: boolean; fiberPhase: string | null }>
      }).entries
      expect(inventoryRows.some(row => row.moduleName === 'chrome-api-bridge')).toBe(true)
      expect(inventoryRows.filter(row => row.moduleName === 'chrome-api-bridge')
        .every(row => row.enabled === true && row.fiberPhase === 'active')).toBe(true)
      const unknownApi = await panelA.rpc('/api/nope/list', {})
      expect(unknownApi.ok).toBe(false)
      if (unknownApi.ok) throw new Error('unreachable')
      expect(unknownApi.error.code).toBe(UNAVAILABLE_CODE)

      // ── settings write fans a host/remote-event invalidation frame out ──
      const engineNs = (settingsDescribe.value as {
        namespaces: Array<{ ns: string; revision: number }>
      }).namespaces[0]!
      const mutated = await panelA.rpc('settings.mutate', {
        ns: engineNs.ns,
        ops: [{ op: 'set', path: ['baseURL'], value: 'https://relay.example/v1' }],
        expectedRevision: engineNs.revision,
      })
      expect(mutated.ok).toBe(true)
      if (!mutated.ok) throw new Error('unreachable')
      const mutatedView = mutated.value as { revision: number; value: { baseURL?: string } }
      expect(mutatedView.value.baseURL).toBe('https://relay.example/v1')
      const invalidation = await panelA.expect(
        message => message.k === 'frame' && message.stream === 'host'
          && message.frame.type === 'host/remote-event'
          && (message.frame as { event: string }).event === 'settings/document-updated',
      )
      if (invalidation.k !== 'frame') throw new Error('unreachable')
      expect((invalidation.frame as { args: unknown[] }).args).toEqual([engineNs.ns, mutatedView.revision])
      // The earlier credential write fanned its own invalidation out too.
      const credentialEvent = await panelA.expect(
        message => message.k === 'frame' && message.stream === 'host'
          && message.frame.type === 'host/remote-event'
          && (message.frame as { event: string }).event === 'credentials/updated',
      )
      if (credentialEvent.k !== 'frame') throw new Error('unreachable')
      expect((credentialEvent.frame as { args: unknown[] }).args).toEqual(['DEEPSEEK_API_KEY'])

      // ── the default-provider bit round-trips through the same mutate path ──
      // The page's 设为默认 action writes the provider field as one path op;
      // the section view and the storage both follow, and the engine keeps the
      // original default afterwards.
      const switchDefault = await panelA.rpc('settings.mutate', {
        ns: engineNs.ns,
        ops: [{ op: 'set', path: ['provider'], value: 'openai' }],
        expectedRevision: mutatedView.revision,
      })
      expect(switchDefault.ok).toBe(true)
      if (!switchDefault.ok) throw new Error('unreachable')
      expect((switchDefault.value as { value: { provider: string } }).value.provider).toBe('openai')
      expect((storageData.get('dsh-engine-settings') as { provider?: string }).provider).toBe('openai')
      const restoreDefault = await panelA.rpc('settings.mutate', {
        ns: engineNs.ns,
        ops: [{ op: 'set', path: ['provider'], value: PROVIDER }],
        expectedRevision: (switchDefault.value as { revision: number }).revision,
      })
      expect(restoreDefault.ok).toBe(true)
      if (!restoreDefault.ok) throw new Error('unreachable')
      expect((restoreDefault.value as { value: { provider: string } }).value.provider).toBe(PROVIDER)

      // ── respond: unknown rpcId answers the not-pending receipt ──
      panelA.send({
        k: 'respond',
        rpcId: 'no-such-server-request',
        result: { ok: true, value: {} },
      })
      const receipt = await panelA.expect(
        message => message.k === 'rpc.result' && message.rpcId === 'no-such-server-request',
      )
      if (receipt.k !== 'rpc.result') throw new Error('unreachable')
      expect(receipt.result).toEqual({ ok: true, value: { accepted: false, reason: 'not-pending' } })

      // ── mux since-replay: reconnecting client refetches the durable delta ──
      const knownSeq = (await ctx.sessionPersistence.open('session-main' as never, 'read').then(async (h) => {
        try {
          return (await h.read()).events.length - 1
        } finally {
          await h.close()
        }
      }))
      const panelC = connectSidePanel()
      await panelC.expect(message => message.k === 'ready')
      panelC.send({
        k: 'stream.open',
        stream: 'mux',
        rpcId: 'mux-open-c',
        payload: { since: { 'session-main': knownSeq - 2 } },
      })
      const replayed = await panelC.expect(
        message => message.k === 'frame' && message.stream === 'mux'
          && message.frame.type === 'session/event'
          && (message.frame as { event: { seq: number } }).event.seq === knownSeq - 1,
      )
      if (replayed.k !== 'frame') throw new Error('unreachable')
      expect((replayed.frame as { event: { seq: number } }).event.seq).toBe(knownSeq - 1)
    },
  )

  it(
    'authors agent presets: copy, read, makeDefault, create/select consumption, remove',
    { timeout: 120_000 },
    async () => {
      installChromeDouble()
      // Earlier tests left credentials, engine settings, and namespaces in the
      // shared storage double; the authoring flow wants a fresh roster and
      // deterministic engine defaults. Stale bridge listeners are dropped for
      // the same one-handler-per-rpc reason as the discoverModels test.
      storageData.clear()
      connectListeners.clear()
      const ctx = await bootComposition()
      const panel = connectSidePanel()
      await panel.expect(message => message.k === 'ready')

      // ── the fresh roster: the implicit default alone ──
      const fresh = await panel.rpc('agentPreset.list', {})
      expect(fresh.ok).toBe(true)
      if (!fresh.ok) throw new Error('unreachable')
      expect((fresh.value as { presets: Array<{ id: string }> }).presets.map(preset => preset.id))
        .toEqual(['default'])

      // ── copy refusals: bad id, reserved id, unknown source ──
      const badId = await panel.rpc('agentPreset.copy', { from: 'default', agentPreset: 'Bad_Id' })
      expect(badId.ok).toBe(false)
      if (badId.ok) throw new Error('unreachable')
      expect(badId.error.code).toBe('agent-preset-invalid')
      const reservedId = await panel.rpc('agentPreset.copy', { from: 'default', agentPreset: 'default' })
      expect(reservedId.ok).toBe(false)
      if (reservedId.ok) throw new Error('unreachable')
      expect(reservedId.error.code).toBe('agent-preset-invalid')
      const ghostSource = await panel.rpc('agentPreset.copy', { from: 'ghost', agentPreset: 'review' })
      expect(ghostSource.ok).toBe(false)
      if (ghostSource.ok) throw new Error('unreachable')
      expect(ghostSource.error.code).toBe('agent-preset-not-found')

      // ── copy creates a user preset (the section dialog's only creation path) ──
      const copied = await panel.rpc('agentPreset.copy', { from: 'default', agentPreset: 'review', name: '评审' })
      expect(copied.ok).toBe(true)
      if (!copied.ok) throw new Error('unreachable')
      expect(copied.value).toEqual({ agentPreset: 'review' })
      const afterCopy = await panel.rpc('agentPreset.list', {})
      expect(afterCopy.ok).toBe(true)
      if (!afterCopy.ok) throw new Error('unreachable')
      const copiedRows = (afterCopy.value as { presets: Array<{ id: string; trust: string; isDefault: boolean; name?: string }> }).presets
      expect(copiedRows.map(preset => [preset.id, preset.trust, preset.isDefault, preset.name])).toEqual([
        ['default', 'system', true, '默认'],
        ['review', 'user', false, '评审'],
      ])
      const doc = await panel.rpc('agentPreset.read', { agentPreset: 'review' })
      expect(doc.ok).toBe(true)
      if (!doc.ok) throw new Error('unreachable')
      expect((doc.value as { trust: string }).trust).toBe('user')
      expect((doc.value as { content: string }).content).toContain('"id": "review"')

      // ── definitions with overrides (the storage path is where a copied
      // preset is edited — openDocument reveals the location) ──
      storageData.set(AGENT_PRESET_STORE_KEY, [
        { id: 'review', name: '评审' },
        { id: 'pro', name: 'Pro', provider: PROVIDER, model: 'deepseek-v4-pro', systemPrompt: '始终以中文评审代码。' },
        { id: 'gone', provider: 'ghost-route' },
      ])
      const afterSeed = await panel.rpc('agentPreset.list', {})
      expect(afterSeed.ok).toBe(true)
      if (!afterSeed.ok) throw new Error('unreachable')
      const seededRows = (afterSeed.value as {
        presets: Array<{ id: string; broken?: string }>
      }).presets
      expect(seededRows.map(preset => preset.id)).toEqual(['default', 'gone', 'pro', 'review'])
      expect(seededRows.find(preset => preset.id === 'gone')?.broken).toContain('ghost-route')

      // ── makeDefault rides the settings face (exactly what the UI row writes) ──
      const madeDefault = await panel.rpc('settings.update', {
        ns: 'agent-presets',
        patch: { default: 'pro' },
      })
      expect(madeDefault.ok).toBe(true)
      if (!madeDefault.ok) throw new Error('unreachable')
      const afterDefault = await panel.rpc('agentPreset.list', {})
      expect(afterDefault.ok).toBe(true)
      if (!afterDefault.ok) throw new Error('unreachable')
      expect((afterDefault.value as { presets: Array<{ id: string; isDefault: boolean }> }).presets
        .map(preset => [preset.id, preset.isDefault])).toEqual([
        ['default', false],
        ['gone', false],
        ['pro', true],
        ['review', false],
      ])

      // ── session.create consumes the stored default: route + roster echo ──
      const createdPro = await panel.rpc('session.create', {})
      expect(createdPro.ok).toBe(true)
      if (!createdPro.ok) throw new Error('unreachable')
      const proSession = (createdPro.value as { sessionId: string; agentPreset: string })
      expect(proSession.agentPreset).toBe('pro')
      const models = await panel.rpc('session.models', { sessionId: proSession.sessionId })
      expect(models.ok).toBe(true)
      if (!models.ok) throw new Error('unreachable')
      expect((models.value as { current: { provider: string; model: string } }).current).toEqual({
        provider: PROVIDER,
        model: 'deepseek-v4-pro',
      })
      const listed = await panel.rpc('session.list', {})
      expect(listed.ok).toBe(true)
      if (!listed.ok) throw new Error('unreachable')
      const proRow = (listed.value as { items: Array<{ sessionId: string; agentPreset?: string }> }).items
        .find(item => item.sessionId === proSession.sessionId)
      expect(proRow?.agentPreset).toBe('pro')

      // ── the addendum reaches the agent's prompt assembly ──
      const proAgent = ctx.agents.get(proSession.sessionId as never)
      expect(proAgent).toBeDefined()
      const assembly = await ctx.systemPrompt.assemble(assembleContextFor(proAgent!))
      expect(assembly.sections.some(section => section.name === 'preset:pro'
        && section.text.includes('中文评审'))).toBe(true)

      // ── explicit create with a chosen id ──
      const createdReview = await panel.rpc('session.create', { agentPreset: 'review' })
      expect(createdReview.ok).toBe(true)
      if (!createdReview.ok) throw new Error('unreachable')
      expect((createdReview.value as { agentPreset: string }).agentPreset).toBe('review')

      // ── select swaps a blank session and logs the switch ──
      const switched = await panel.rpc('agentPreset.select', {
        sessionId: proSession.sessionId,
        agentPreset: 'review',
      })
      expect(switched.ok).toBe(true)
      if (!switched.ok) throw new Error('unreachable')
      expect(switched.value).toEqual({ agentPreset: 'review' })
      // The copy carries no route override, so the session falls back to the
      // engine default; the summary names the logged selection.
      const modelsAfterSwitch = await panel.rpc('session.models', { sessionId: proSession.sessionId })
      expect(modelsAfterSwitch.ok).toBe(true)
      if (!modelsAfterSwitch.ok) throw new Error('unreachable')
      expect((modelsAfterSwitch.value as { current: { model: string } }).current.model).toBe(MODEL)
      const listedAfterSwitch = await panel.rpc('session.list', {})
      expect(listedAfterSwitch.ok).toBe(true)
      if (!listedAfterSwitch.ok) throw new Error('unreachable')
      expect((listedAfterSwitch.value as { items: Array<{ sessionId: string; agentPreset?: string }> }).items
        .find(item => item.sessionId === proSession.sessionId)?.agentPreset).toBe('review')

      // ── a started session is locked ──
      await driveTurn(ctx, proSession.sessionId, '预设烟测')
      const locked = await panel.rpc('agentPreset.select', {
        sessionId: proSession.sessionId,
        agentPreset: 'pro',
      })
      expect(locked.ok).toBe(false)
      if (locked.ok) throw new Error('unreachable')
      expect(locked.error.code).toBe('agent-preset-locked')

      // ── remove: shipped preset refused, copies deletable, dangling default cleared ──
      const removeDefault = await panel.rpc('agentPreset.remove', { agentPreset: 'default' })
      expect(removeDefault.ok).toBe(false)
      if (removeDefault.ok) throw new Error('unreachable')
      expect(removeDefault.error.code).toBe('agent-preset-read-only')
      const removeReview = await panel.rpc('agentPreset.remove', { agentPreset: 'review' })
      expect(removeReview.ok).toBe(true)
      const removePro = await panel.rpc('agentPreset.remove', { agentPreset: 'pro' })
      expect(removePro.ok).toBe(true)
      const afterRemove = await panel.rpc('agentPreset.list', {})
      expect(afterRemove.ok).toBe(true)
      if (!afterRemove.ok) throw new Error('unreachable')
      const removedRows = (afterRemove.value as { presets: Array<{ id: string; isDefault: boolean }> }).presets
      // The broken 'gone' row stays listed (its id still occupies the roster,
      // so showing and deleting it is the way out) — the desktop rule.
      expect(removedRows.map(preset => [preset.id, preset.isDefault])).toEqual([
        ['default', true],
        ['gone', false],
      ])
      // A default the remove just deleted must not strand the next create.
      const createdAfterRemove = await panel.rpc('session.create', {})
      expect(createdAfterRemove.ok).toBe(true)
      if (!createdAfterRemove.ok) throw new Error('unreachable')
      expect((createdAfterRemove.value as { agentPreset: string }).agentPreset).toBe('default')
    },
  )

  it(
    'keeps model-context runtime snapshots out of session.history while the durable log retains them',
    { timeout: 120_000 },
    async () => {
      installChromeDouble()
      const ctx = await bootComposition()
      const panel = connectSidePanel()
      await panel.expect(message => message.k === 'ready')

      const agent = ctx.agents.get('session-main' as never)
      expect(agent).toBeDefined()
      // The runtime-context projection's exact wire shape (what agent-loop
      // appends before the first step of a fresh session): a plugin-sourced
      // user message carrying the model-facing policy context, including the
      // user-approval ASK_SENTENCE that starts "Approval policy: ask".
      const snapshot = createUserMessage({
        content: [{
          type: 'text',
          text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nApproval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.',
        }],
        source: {
          kind: 'plugin',
          plugin: '@deepseek-ai/dsh-system-prompt',
          form: 'snapshot',
          sections: [{ name: 'approval:policy', text: 'Approval policy: ask.' }],
        },
      })
      agent!.session.append('user/message', snapshot, { surfaceOp: 'append' })

      // The panel-facing transcript must not show the snapshot as a user
      // message (the extension shell's ConversationView renders every
      // user/message event as a chat bubble).
      const history = await panel.rpc('session.history', { sessionId: 'session-main' })
      expect(history.ok).toBe(true)
      if (!history.ok) throw new Error('unreachable')
      const rows = (history.value as {
        events: Array<{ event: { type: string; data: { source?: { kind?: string; plugin?: string } } } }>
      }).events
      expect(rows.some(row => row.event.type === 'user/message'
        && row.event.data.source?.kind === 'plugin'
        && row.event.data.source.plugin === '@deepseek-ai/dsh-system-prompt')).toBe(false)

      // The durable log keeps the event — the model input path is untouched.
      const inLog = agent!.session.snapshotEvents().some(event => event.type === 'user/message'
        && (event.data as { source?: { kind?: string; plugin?: string } }).source?.kind === 'plugin'
        && (event.data as { source?: { plugin?: string } }).source?.plugin === '@deepseek-ai/dsh-system-prompt')
      expect(inLog).toBe(true)
    },
  )

  it(
    'serves minimal dynamicCordisRunner answers and the real subagent RPC face',
    { timeout: 120_000 },
    async () => {
      installChromeDouble()
      await bootComposition()
      const panel = connectSidePanel()
      await panel.expect(message => message.k === 'ready')

      // ── dynamicCordisRunner: empty-host answers, never a refusal ──
      // (the ui-cordis / cordis-client-runner Client rows call these at apply
      // time; the refusal tier used to surface two console.error lines)
      const manifest = await panel.rpc('dynamicCordisRunner/syncInspectManifest', { args: { providers: [] } })
      expect(manifest.ok).toBe(true)
      if (!manifest.ok) throw new Error('unreachable')
      expect(manifest.value).toBeNull()

      const inventory = await panel.rpc('dynamicCordisRunner/inventory', {})
      expect(inventory.ok).toBe(true)
      if (!inventory.ok) throw new Error('unreachable')
      expect(inventory.value).toEqual([])

      const list = await panel.rpc('dynamicCordisRunner/list', {})
      expect(list.ok).toBe(true)
      if (!list.ok) throw new Error('unreachable')
      expect(list.value).toEqual([])

      const stop = await panel.rpc('dynamicCordisRunner/stopFromPanel', {
        args: { sessionId: 'session-main', pluginId: 'demo' },
      })
      expect(stop.ok).toBe(true)
      if (!stop.ok) throw new Error('unreachable')
      // The ui-cordis port treats reason 'not-running' as a successful stop.
      expect(stop.value).toEqual({ ok: false, reason: 'not-running', message: expect.any(String) })

      const undefine = await panel.rpc('dynamicCordisRunner/undefineFromPanel', {
        args: { sessionId: 'session-main', pluginId: 'demo' },
      })
      expect(undefine.ok).toBe(true)
      if (!undefine.ok) throw new Error('unreachable')
      expect(undefine.value).toEqual({ ok: false, reason: 'plugin-missing', message: expect.any(String) })

      const run = await panel.rpc('dynamicCordisRunner/runFromPanel', {
        args: { sessionId: 'session-main', pluginId: 'demo' },
      })
      expect(run.ok).toBe(true)
      if (!run.ok) throw new Error('unreachable')
      expect(run.value).toEqual({ ok: false, reason: 'not-running', message: expect.any(String) })

      // ── subagent.list: real projection through the composed service ──
      const subagents = await panel.rpc('subagent.list', { parentSessionId: 'session-main' })
      expect(subagents.ok).toBe(true)
      if (!subagents.ok) throw new Error('unreachable')
      expect(subagents.value).toEqual({ entries: [], parentAvailable: true })

      // ── subagent.prompt: real routing — domain refusals, never the generic
      // not-available-in-extension refusal. An UNKNOWN parent is a
      // session-not-found (ensureAgent owns lazy resume); a persisted parent
      // is resumed and the delivery lands — see the cold-parent test below. ──
      const ghostParent = await panel.rpc('subagent.prompt', {
        parentSessionId: 'session-ghost',
        childSessionId: 'session-child',
        mode: 'continuable',
        content: [{ type: 'text', text: '继续' }],
      })
      expect(ghostParent.ok).toBe(false)
      if (ghostParent.ok) throw new Error('unreachable')
      expect(ghostParent.error.code).toBe('session-not-found')

      const unknownChild = await panel.rpc('subagent.prompt', {
        parentSessionId: 'session-main',
        childSessionId: 'session-child',
        mode: 'continuable',
        content: [{ type: 'text', text: '继续' }],
      })
      expect(unknownChild.ok).toBe(false)
      if (unknownChild.ok) throw new Error('unreachable')
      expect(unknownChild.error.code).toBe('subagent-not-found')

      const badContent = await panel.rpc('subagent.prompt', {
        parentSessionId: 'session-main',
        childSessionId: 'session-child',
        mode: 'continuable',
        content: [],
      })
      expect(badContent.ok).toBe(false)
      if (badContent.ok) throw new Error('unreachable')
      expect(badContent.error.code).toBe('bad-request')

      // ── subagent.history: the catalog gate answers for an unknown child ──
      const history = await panel.rpc('subagent.history', {
        parentSessionId: 'session-main',
        childSessionId: 'session-child',
        mode: 'continuable',
      })
      expect(history.ok).toBe(false)
      if (history.ok) throw new Error('unreachable')
      expect(history.error.code).toBe('subagent-not-found')

      // ── subagent.interrupt: accepted receipt through the service (absent
      // targets are accepted no-ops) ──
      const interrupt = await panel.rpc('subagent.interrupt', {
        parentSessionId: 'session-main',
        childSessionId: 'session-child',
      })
      expect(interrupt.ok).toBe(true)
      if (!interrupt.ok) throw new Error('unreachable')
      expect(interrupt.value).toEqual({ accepted: true })

      // The panel still drives sessions: the subagent wiring must not disturb
      // the core surface.
      const describe = await panel.rpc('host.describe')
      expect(describe.ok).toBe(true)
    },
  )

  it(
    'delivers subagent.prompt to a continuable child whose parent is persisted but not mounted',
    { timeout: 120_000 },
    async () => {
      installChromeDouble()
      // Earlier tests booted their own compositions; drop their stale bridge
      // listeners so this boot's bridge is the only rpc responder.
      connectListeners.clear()
      const ctx = await bootComposition()
      const panel = connectSidePanel()
      await panel.expect(message => message.k === 'ready')

      // A second, non-configured parent session, then a continuable child of
      // it — the shape the sidepanel sees after an engine restart: the parent
      // exists only in persistence (the shell adopts the newest session; only
      // session-main is boot-restored) while the @-mention catalog still
      // lists the child.
      const coldParent = await ctx.agents.create({
        sessionId: SessionId('session-cold-parent'),
        agentOptions: { provider: PROVIDER, model: MODEL },
      })
      const started = await ctx.subagents.startContinuable({
        provider: 'spawn',
        label: '冷父代理的子代理',
        request: { prompt: [{ type: 'text', text: '初始任务' }], parent: coldParent.agent },
        signal: new AbortController().signal,
      })
      await vi.waitFor(() => {
        expect(ctx.agents.get(started.childId)).toBeUndefined()
      }, { timeout: 10_000 })
      await ctx.sessions.flush(coldParent.agent.session)
      await coldParent.dispose()
      expect(ctx.agents.get('session-cold-parent' as never)).toBeUndefined()

      // The catalog read never needs the parent Agent, so the mention menu
      // works even in this state (parentAvailable is a hint, not a gate).
      const listed = await panel.rpc('subagent.list', { parentSessionId: 'session-cold-parent' })
      expect(listed.ok).toBe(true)
      if (!listed.ok) throw new Error('unreachable')
      expect(listed.value).toMatchObject({
        parentAvailable: false,
        entries: [expect.objectContaining({ kind: 'child', mode: 'continuable', id: started.childId })],
      })

      // THE FIX UNDER TEST: the delivery resumes the cold parent (ensureAgent)
      // instead of refusing with subagent-parent-unavailable, then
      // cold-resumes the child and lands the message in its transcript.
      const prompted = await panel.rpc('subagent.prompt', {
        parentSessionId: 'session-cold-parent',
        childSessionId: started.childId,
        content: [{ type: 'text', text: '重启后投递' }],
      })
      expect(prompted.ok).toBe(true)
      if (!prompted.ok) throw new Error('unreachable')
      expect(prompted.value).toMatchObject({ messageId: expect.any(String) })

      // The delivered message reaches the child transcript once its resumed
      // turn runs (live session or persisted log — the same data plane the
      // capability panel reads).
      await vi.waitFor(async () => {
        const history = await panel.rpc('subagent.history', {
          parentSessionId: 'session-cold-parent',
          childSessionId: started.childId,
          mode: 'continuable',
        })
        expect(history.ok).toBe(true)
        if (!history.ok) throw new Error('unreachable')
        const texts = (history.value as {
          events: Array<{ event: { type: string; data: { content?: Array<{ type: string; text?: string }> } } }>
        }).events
          .filter(row => row.event.type === 'user/message')
          .flatMap(row => (row.event.data.content ?? [])
            .filter(block => block.type === 'text')
            .map(block => block.text ?? ''))
        expect(texts).toContain('重启后投递')
      }, { timeout: 15_000 })

      // The parent is now mounted for real: a second delivery rides the same
      // live Agent (no second resume, no registry collision).
      const second = await panel.rpc('subagent.prompt', {
        parentSessionId: 'session-cold-parent',
        childSessionId: started.childId,
        content: [{ type: 'text', text: '再投一条' }],
      })
      expect(second.ok).toBe(true)
    },
  )

  it(
    'routes llm.discoverModels probes by protocol and falls back to stored route keys',
    { timeout: 120_000 },
    async () => {
      installChromeDouble()
      // Earlier tests booted their own compositions, and every boot registered
      // a live bridge onConnect listener on the shared chrome double — each
      // would answer this test's rpcs too (fetch recorded once per instance).
      // Drop the stale listeners so one rpc runs exactly one handler.
      connectListeners.clear()
      await bootComposition()
      const panel = connectSidePanel()
      await panel.expect(message => message.k === 'ready')

      // ── fetch double: record every probe; script replies by URL suffix ──
      const probeCalls: Array<{
        url: string
        method: string
        headers: Record<string, string>
        body: unknown
      }> = []
      const probeReplies = new Map<string, Response>()
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        const url = String(input)
        probeCalls.push({
          url,
          method: init?.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init?.headers)),
          body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        })
        for (const [suffix, response] of probeReplies) {
          if (url.endsWith(suffix)) return response
        }
        return new Response('{}', { status: 200 })
      }) as typeof fetch

      try {
        // ── anthropic protocol: POST {base}/messages minimal ping ──
        const anthropic = await panel.rpc('llm.discoverModels', {
          provider: 'anthropic',
          baseURL: 'https://api.anthropic.com/v1',
          api: 'anthropic',
          apiKey: 'sk-ant-typed',
        })
        expect(anthropic.ok).toBe(true)
        if (!anthropic.ok) throw new Error('unreachable')
        expect(anthropic.value).toEqual({ models: [] })
        const anthropicCall = probeCalls[probeCalls.length - 1]
        expect(anthropicCall?.url).toBe('https://api.anthropic.com/v1/messages')
        expect(anthropicCall?.method).toBe('POST')
        expect(anthropicCall?.headers['x-api-key']).toBe('sk-ant-typed')
        expect(anthropicCall?.headers['anthropic-version']).toBe('2023-06-01')
        expect(anthropicCall?.headers['content-type']).toBe('application/json')
        expect(anthropicCall?.body).toEqual({
          model: 'claude-sonnet-4-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        })

        // ── anthropic non-ok: the status surfaces as a bad-request ──
        probeReplies.set('/messages', new Response('{"error":{"message":"no"}}', { status: 404, statusText: 'Not Found' }))
        const refused = await panel.rpc('llm.discoverModels', {
          provider: 'anthropic',
          baseURL: 'https://api.anthropic.com/v1',
          api: 'anthropic',
          apiKey: 'sk-ant-typed',
        })
        expect(refused.ok).toBe(false)
        if (refused.ok) throw new Error('unreachable')
        expect(refused.error.code).toBe('bad-request')
        expect(refused.error.message).toContain('404')
        probeReplies.delete('/messages')

        // ── declared route: stored-key fallback + missing-key refusal ──
        // A declared route probes with its stored credential (and its stored
        // protocol) when no key is typed; a ref named but nothing stored fails
        // loud instead of probing keyless.
        const declared = await panel.rpc('settings.mutate', {
          ns: 'llm-pi-ai',
          ops: [{
            op: 'set',
            path: ['providers', 'acme-gateway'],
            value: {
              displayName: 'Acme Gateway',
              api: 'anthropic',
              baseURL: 'https://api.acme.example/v1',
              apiKeyEnv: 'ACME_GATEWAY_API_KEY',
              models: [{ id: 'claude-x', name: 'Claude X' }],
            },
          }],
        })
        expect(declared.ok).toBe(true)
        if (!declared.ok) throw new Error('unreachable')
        const noKey = await panel.rpc('llm.discoverModels', {
          provider: 'acme-gateway',
          baseURL: 'https://api.acme.example/v1',
        })
        expect(noKey.ok).toBe(false)
        if (noKey.ok) throw new Error('unreachable')
        expect(noKey.error.code).toBe('bad-request')
        expect(noKey.error.message).toContain('没有可用的 API key')
        const storedCredential = await panel.rpc('credentials.set', {
          ref: 'ACME_GATEWAY_API_KEY',
          value: 'sk-acme-stored',
        })
        expect(storedCredential.ok).toBe(true)
        const storedProbe = await panel.rpc('llm.discoverModels', {
          provider: 'acme-gateway',
          baseURL: 'https://api.acme.example/v1',
        })
        expect(storedProbe.ok).toBe(true)
        if (!storedProbe.ok) throw new Error('unreachable')
        const storedCall = probeCalls[probeCalls.length - 1]
        expect(storedCall?.url).toBe('https://api.acme.example/v1/messages')
        expect(storedCall?.method).toBe('POST')
        expect(storedCall?.headers['x-api-key']).toBe('sk-acme-stored')
        expect(storedCall?.body).toEqual({
          model: 'claude-x',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        })

        // ── openai-responses protocol: POST {base}/responses minimal ping ──
        const responses = await panel.rpc('llm.discoverModels', {
          provider: 'resp-gateway',
          baseURL: 'https://api.resp.example/v1',
          api: 'openai-responses',
          apiKey: 'sk-resp',
        })
        expect(responses.ok).toBe(true)
        if (!responses.ok) throw new Error('unreachable')
        expect(responses.value).toEqual({ models: [] })
        const responsesCall = probeCalls[probeCalls.length - 1]
        expect(responsesCall?.url).toBe('https://api.resp.example/v1/responses')
        expect(responsesCall?.method).toBe('POST')
        expect(responsesCall?.headers['authorization']).toBe('Bearer sk-resp')
        expect(responsesCall?.body).toEqual({
          model: 'gpt-4o',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
          max_output_tokens: 16,
        })

        // ── openai protocol unchanged: GET {base}/models with the model list ──
        probeReplies.set('/models', new Response(JSON.stringify({ data: [{ id: 'm1', name: 'M1' }] }), { status: 200 }))
        const openai = await panel.rpc('llm.discoverModels', {
          baseURL: 'https://api.openai.example/v1',
          api: 'openai',
        })
        expect(openai.ok).toBe(true)
        if (!openai.ok) throw new Error('unreachable')
        expect(openai.value).toEqual({ models: [{ id: 'm1', name: 'M1' }] })
        const openaiCall = probeCalls[probeCalls.length - 1]
        expect(openaiCall?.url).toBe('https://api.openai.example/v1/models')
        expect(openaiCall?.method).toBe('GET')
        probeReplies.delete('/models')

        // ── SSRF guard still applies before any protocol branch ──
        const privateNet = await panel.rpc('llm.discoverModels', {
          baseURL: 'http://192.168.1.5/v1',
          api: 'anthropic',
        })
        expect(privateNet.ok).toBe(false)
        if (privateNet.ok) throw new Error('unreachable')
        expect(privateNet.error.code).toBe('bad-request')
        expect(privateNet.error.message).toContain('私有')
        expect(probeCalls).toHaveLength(5)
      } finally {
        globalThis.fetch = originalFetch
      }
    },
  )
})

// ───────────────────────── attachments (durable prompt images) ─────────────────────────

/** A 1×1 PNG's exact bytes — a real, fully decodable raster fixture. */
const ATTACHMENT_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

/** Wire shape of one user/message event's image content block. */
interface LoggedImageBlock {
  type: 'image'
  attachment: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }
}

/** The durable carriers that can own the prompt's content blocks. */
function contentCarriersOf(event: {
  data: { content?: unknown; message?: { content?: unknown }; inserted?: Array<{ content?: unknown }> }
}): unknown[] {
  const carriers: unknown[] = [event.data.content]
  if (event.data.message !== undefined) carriers.push(event.data.message.content)
  for (const inserted of event.data.inserted ?? []) carriers.push(inserted.content)
  return carriers
}

/** Every image block currently visible in the session's durable history. */
function imageBlocksOf(rows: Array<{ event: { type: string; data: Record<string, unknown> } }>): LoggedImageBlock[] {
  const blocks: LoggedImageBlock[] = []
  for (const row of rows) {
    if (row.event.type !== 'user/message' && row.event.type !== 'agent/inbox/spliced') continue
    for (const carrier of contentCarriersOf(row.event as never)) {
      if (!Array.isArray(carrier)) continue
      const block = carrier.find((entry): entry is LoggedImageBlock => (entry as { type?: string }).type === 'image')
      if (block !== undefined) blocks.push(block)
    }
  }
  return blocks
}

/** Poll `session.status` until the session's turn is no longer running. */
async function waitIdle(panel: TestClient): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const status = await panel.rpc('session.status', { sessionId: 'session-main' })
    if (status.ok && (status.value as { running?: boolean }).running !== true) return
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('attachment spec: session never went idle')
}

/** Count the image blocks in the current history (poll helper for the assertions above). */
async function countLoggedImages(panel: TestClient): Promise<number> {
  const history = await panel.rpc('session.history', { sessionId: 'session-main' })
  expect(history.ok).toBe(true)
  if (!history.ok) throw new Error('unreachable')
  return imageBlocksOf((history.value as { events: Array<{ event: { type: string; data: Record<string, unknown> } }> }).events).length
}

/** The first image block in the session's durable history, waiting for the turn to append it. */
async function firstLoggedImage(
  panel: TestClient,
  sessionId: string,
): Promise<{ event: { type: string }; block: LoggedImageBlock }> {
  const deadline = Date.now() + 10_000
  while (true) {
    const history = await panel.rpc('session.history', { sessionId })
    expect(history.ok).toBe(true)
    if (!history.ok) throw new Error('unreachable')
    const rows = (history.value as { events: Array<{ event: { type: string; data: Record<string, unknown> } }> }).events
    for (const row of [...rows].reverse()) {
      for (const block of imageBlocksOf([row])) {
        return { event: row.event, block }
      }
    }
    if (Date.now() > deadline) throw new Error('attachment spec: no image block found in history')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

describe('chrome-api-bridge attachments', () => {
  let panel: TestClient

  /** The composed attachment backend, memory-backed for the Node host. */
  class MemoryAttachmentStore extends ContentAddressedImageStore {
    constructor(ctx: Context) {
      const objects = new Map<string, Uint8Array>()
      super(
        ctx,
        async () => ({
          put: async (key, data) => {
            objects.set(key, new Uint8Array(data))
          },
          get: async (key) => {
            const data = objects.get(key)
            return data === undefined ? undefined : new Uint8Array(data)
          },
        }),
        // Fixed 1×1 probe standing in for createImageBitmap's full decode.
        async () => ({ width: 1, height: 1 }),
      )
    }
  }

  beforeAll(async () => {
    // Fresh double state and listener set: earlier its in this file leave
    // booted bridges behind, and this describe's assertions need the newest
    // composition to be the only RPC responder.
    storageData.clear()
    connectListeners.clear()
    installChromeDouble()
    const ctx = await bootComposition()
    ctx.plugin(MemoryAttachmentStore)
    panel = connectSidePanel()
    await panel.expect(message => message.k === 'ready')
  }, 120_000)

  const selectModel = async (model: string): Promise<void> => {
    const result = await panel.rpc('session.selectModel', { sessionId: 'session-main', provider: PROVIDER, model })
    expect(result.ok).toBe(true)
  }

  it(
    'promotes image parts on a vision model to durable references and serves verified reads',
    { timeout: 60_000 },
    async () => {
      await selectModel('deepseek-vision')
      const prompt = await panel.rpc('session.prompt', {
        sessionId: 'session-main',
        content: [
          { type: 'image', mediaType: 'image/png', data: bytesToBase64(ATTACHMENT_PNG), name: '/tmp/shot.png' },
          { type: 'text', text: '这张截图里有什么？' },
        ],
      })
      if (!prompt.ok) throw new Error(`vision prompt refused: ${JSON.stringify(prompt.error)}`)
      await selectModel('deepseek-v4-flash')

      const { event, block } = await firstLoggedImage(panel, 'session-main')
      // The durable log carries the content-addressed reference, path-free
      // display name, and true raster facts — never the temporary bytes.
      expect(['user/message', 'agent/inbox/spliced']).toContain(event.type)
      expect(block.attachment.attachmentId).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(block.attachment.mediaType).toBe('image/png')
      expect(block.attachment.bytes).toBe(ATTACHMENT_PNG.byteLength)
      expect(block.attachment.width).toBe(1)
      expect(block.attachment.height).toBe(1)
      expect(block.attachment.name).toBe('shot.png')

      // The authorized read returns the exact bytes back.
      const read = await panel.rpc('session.attachment', {
        sessionId: 'session-main',
        attachmentId: block.attachment.attachmentId,
      })
      expect(read.ok).toBe(true)
      if (!read.ok) throw new Error('unreachable')
      const value = read.value as { attachment: { attachmentId: string }; data: string }
      expect(value.attachment.attachmentId).toBe(block.attachment.attachmentId)
      expect(new Uint8Array(Buffer.from(value.data, 'base64'))).toEqual(ATTACHMENT_PNG)

      // A session cannot read an attachment its log does not reference.
      const foreign = await panel.rpc('session.attachment', {
        sessionId: 'session-main',
        attachmentId: `sha256:${'f'.repeat(64)}`,
      })
      expect(foreign.ok).toBe(false)
      if (foreign.ok) throw new Error('unreachable')
      expect(foreign.error.code).toBe('attachment-error')
      expect((foreign.error.details as { reason?: string }).reason).toBe('ATTACHMENT_NOT_REFERENCED')
    },
  )

  it(
    'refuses image parts on a text-only model before anything is stored',
    { timeout: 60_000 },
    async () => {
      await selectModel('deepseek-v4-flash')
      await waitIdle(panel)
      const beforeCount = await countLoggedImages(panel)

      const refused = await panel.rpc('session.prompt', {
        sessionId: 'session-main',
        content: [{ type: 'image', mediaType: 'image/png', data: bytesToBase64(ATTACHMENT_PNG) }],
      })
      expect(refused.ok).toBe(false)
      if (refused.ok) throw new Error('unreachable')
      expect(refused.error.code).toBe('attachment-error')
      expect(refused.error.message).toContain('不支持图片输入')
      expect((refused.error.details as { reason?: string }).reason).toBe('MODEL_DOES_NOT_SUPPORT_IMAGES')

      // The refusal happens before admission: no durable image appears.
      await waitIdle(panel)
      expect(await countLoggedImages(panel)).toBe(beforeCount)
    },
  )

  it(
    'rejects malformed image payloads and byte-limit overflows at admission',
    { timeout: 60_000 },
    async () => {
      await selectModel('deepseek-vision')

      // Non-canonical base64 is refused before any storage work.
      const badBase64 = await panel.rpc('session.prompt', {
        sessionId: 'session-main',
        content: [{ type: 'image', mediaType: 'image/png', data: 'not base64!!' }],
      })
      expect(badBase64.ok).toBe(false)
      if (badBase64.ok) throw new Error('unreachable')
      expect(badBase64.error.code).toBe('attachment-error')
      expect((badBase64.error.details as { reason?: string }).reason).toBe('INVALID_IMAGE_BASE64')

      // A byte-limit overflow refuses the whole prompt (PNG-signed payload so
      // type admission is not what trips).
      const oversizedBytes = new Uint8Array(5 * 1024 * 1024 + 1)
      oversizedBytes.set(ATTACHMENT_PNG.subarray(0, 12))
      const oversized = await panel.rpc('session.prompt', {
        sessionId: 'session-main',
        content: [{ type: 'image', mediaType: 'image/png', data: bytesToBase64(oversizedBytes) }],
      })
      expect(oversized.ok).toBe(false)
      if (oversized.ok) throw new Error('unreachable')
      expect(oversized.error.code).toBe('attachment-error')
      expect((oversized.error.details as { reason?: string }).reason).toBe('IMAGE_TOO_LARGE')

      // An unknown media type never reaches admission.
      const badType = await panel.rpc('session.prompt', {
        sessionId: 'session-main',
        content: [{ type: 'image', mediaType: 'image/svg+xml', data: bytesToBase64(ATTACHMENT_PNG) }],
      })
      expect(badType.ok).toBe(false)
      if (badType.ok) throw new Error('unreachable')
      expect(badType.error.code).toBe('bad-request')

      await selectModel('deepseek-v4-flash')
    },
  )

  it(
    'reads and writes the permission-mode knob',
    { timeout: 60_000 },
    async () => {
      installChromeDouble()
      const ctx = await bootComposition()
      const panel = connectSidePanel()
      await panel.expect(message => message.k === 'ready')

      // A fresh session folds to the composition default.
      const initial = await panel.rpc('session.permission.get', { sessionId: 'session-main' })
      expect(initial.ok).toBe(true)
      if (!initial.ok) throw new Error('unreachable')
      expect(initial.value).toEqual({ mode: 'ask-change' })

      // Switching appends the durable knob event; the fold follows the log.
      const switched = await panel.rpc('session.permission.set', { sessionId: 'session-main', mode: 'ask-always' })
      expect(switched.ok).toBe(true)
      if (!switched.ok) throw new Error('unreachable')
      expect(switched.value).toEqual({ mode: 'ask-always' })
      const agent = ctx.agents.get('session-main' as never)
      expect(agent).toBeDefined()
      expect(agent!.session.snapshotEvents().map(event => event.type)).toContain('permission/mode')

      // A repeat selection of the current mode is a no-op (no second event).
      const before = agent!.session.snapshotEvents().length
      const again = await panel.rpc('session.permission.set', { sessionId: 'session-main', mode: 'ask-always' })
      expect(again.ok).toBe(true)
      expect(agent!.session.snapshotEvents().length).toBe(before)

      // An unknown mode refuses at the wire before touching the session.
      const bad = await panel.rpc('session.permission.set', { sessionId: 'session-main', mode: 'yolo' })
      expect(bad.ok).toBe(false)
      if (bad.ok) throw new Error('unreachable')
      expect(bad.error.code).toBe('bad-request')
    },
  )
})

describe('chrome-api-bridge skill authoring', () => {
  let panel: TestClient

  beforeAll(async () => {
    storageData.clear()
    connectListeners.clear()
    installChromeDouble()
    await bootComposition()
    panel = connectSidePanel()
    await panel.expect(message => message.k === 'ready')
  }, 120_000)

  it('writes a stored skill and lists it through the skill provider', async () => {
    const write = await panel.rpc('skill.write', {
      name: 'bili-login-check',
      description: 'B 站登录态稳健检测：cookie 预检 + nav API。',
      whenToUse: '需要判断 bilibili.com 登录状态时。',
      content: '(async () => { /* cookie DedeUserID 预检 + fetch nav API */ })()',
    })
    expect(write.ok).toBe(true)
    if (!write.ok) throw new Error('unreachable')
    expect(write.value).toEqual({ written: true, name: 'bili-login-check' })

    const skills = await panel.rpc('skill.list', { sessionId: 'session-main' })
    expect(skills.ok).toBe(true)
    if (!skills.ok) throw new Error('unreachable')
    const listed = (skills.value as { skills: Array<{ name: string; description: string; whenToUse?: string }> })
      .skills.find(skill => skill.name === 'bili-login-check')
    expect(listed).toBeDefined()
    expect(listed!.description).toContain('nav API')
    expect(listed!.whenToUse).toContain('bilibili.com')
  })

  it('refuses malformed writes fail-loud', async () => {
    const badName = await panel.rpc('skill.write', { name: 'Not-Kebab', description: 'x', content: 'y' })
    expect(badName.ok).toBe(false)
    if (badName.ok) throw new Error('unreachable')
    expect(badName.error.message).toContain('kebab-case')

    const emptyContent = await panel.rpc('skill.write', { name: 'empty-content', description: 'x', content: '   ' })
    expect(emptyContent.ok).toBe(false)
    if (emptyContent.ok) throw new Error('unreachable')
    expect(emptyContent.error.message).toContain('content 不能为空')

    // Refusals must not leave roster residue.
    const roster = await panel.rpc('skill.list', { sessionId: 'session-main' })
    if (!roster.ok) throw new Error('unreachable')
    const names = (roster.value as { skills: Array<{ name: string }> }).skills.map(skill => skill.name)
    expect(names).toContain('bili-login-check')
    expect(names).not.toContain('Not-Kebab')
    expect(names).not.toContain('empty-content')
  })

  it('removes a stored skill and reflects the removal in skill.list', async () => {
    const remove = await panel.rpc('skill.remove', { name: 'bili-login-check' })
    expect(remove.ok).toBe(true)
    if (!remove.ok) throw new Error('unreachable')
    expect(remove.value).toEqual({ removed: true, name: 'bili-login-check' })

    const roster = await panel.rpc('skill.list', { sessionId: 'session-main' })
    if (!roster.ok) throw new Error('unreachable')
    expect((roster.value as { skills: Array<{ name: string }> }).skills)
      .not.toContainEqual(expect.objectContaining({ name: 'bili-login-check' }))
  })
})
