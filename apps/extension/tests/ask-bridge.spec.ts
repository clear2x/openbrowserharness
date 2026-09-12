/**
 * chrome-ask-bridge spec: the interaction channel end-to-end over the
 * `dsh-api` Port — the engine side composed for real (dsh-user-approval +
 * dsh-user-questions + dsh-tool-ask-user + chrome-api-bridge +
 * chrome-ask-bridge on top of the api-bridge spec's proven harness), the
 * panel side driven exactly the way the dsh Web UI's panels do: catch the
 * answerable mux frame, echo its rpcId on a `{ k: 'respond' }` message with
 * the ApprovalPanel / QuestionComposer body shape, and observe the receipt
 * plus the resolved frame.
 *
 * Asserts both happy paths (approval rejected; question answered) and the
 * fail-closed withdrawals: the user's cancel error branch, and last-port
 * disconnect cancelling every pending wait.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Timer from '@deepseek-ai/cordis-plugin-timer'
import type { FiberState } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as llmRetry from '@deepseek-ai/dsh-llm-retry'
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
import * as AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as toolTodo from '@deepseek-ai/dsh-tool-todo'
import * as toolBrowser from '@deepseek-ai/dsh-tool-browser'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as userApproval from '@deepseek-ai/dsh-user-approval'
import * as userQuestions from '@deepseek-ai/dsh-user-questions'
import * as Commands from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import * as messageFeedback from '@deepseek-ai/dsh-message-feedback'
import * as SkillRegistry from '@deepseek-ai/dsh-skill'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as userPluginTools from '../src/offscreen/user-plugin-tools.ts'
import { setUserPluginHost } from '../src/chrome/user-plugins.ts'
import * as StorageHub from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as chromeStorageKv from '../src/chrome/storage-kv.ts'
import ChromeCredentialProvider from '../src/chrome/credentials.ts'
import * as chromeBrowserProvider from '../src/chrome/browser-provider.ts'
import * as uiBridgePlugin from '../src/chrome/ui-bridge.ts'
import * as apiBridgePlugin from '../src/chrome/api-bridge.ts'
import * as planModePlugin from '@deepseek-ai/dsh-plan-mode'
import * as permissionModePlugin from '../src/offscreen/permission-mode.ts'
import { API_PORT_NAME } from '../src/chrome/api-bridge.ts'
import * as chromeAskBridge from '../src/chrome/chrome-ask-bridge.ts'
import type { ApiPortDownMessage, ApiPortUpMessage, ApiRpcResult } from '../src/chrome/api-bridge.ts'

const PROVIDER = 'deepseek'
const MODEL = 'deepseek-v4-flash'

/** Mirrors the offscreen entry: FiberState is a const enum erased from the built cordis lib. */
const FIBER_ACTIVE = 2

// ───────────────────────── in-memory chrome double ─────────────────────────

const connectListeners = new Set<(port: unknown) => void>()
const storageData = new Map<string, unknown>()

/** The SidePanel client mints a FRESH rpcId per delivered frame (PortApiClient.tapStream). */
function mintFrameRpcId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `frame-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function installChromeDouble(): void {
  // Test isolation: the chrome double and its listener registry are module
  // state; each test starts from an empty bridge-listener set.
  connectListeners.clear()
  storageData.clear()
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
        },
        remove: async (keys: string | string[] | object): Promise<void> => {
          const names = typeof keys === 'string'
            ? [keys]
            : Array.isArray(keys)
              ? keys
              : Object.keys(keys)
          for (const name of names) storageData.delete(name)
        },
      },
      onChanged: {
        addListener: (): void => undefined,
        removeListener: (): void => undefined,
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

  constructor(private readonly end: FakePortEnd) {
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

  send(up: ApiPortUpMessage): void {
    this.end.postMessage(up)
  }

  /** The panel's respond leg: echo the requested frame's rpcId, await the receipt. */
  async respond(rpcId: string, result: ApiRpcResult): Promise<{ accepted: boolean; reason?: string }> {
    this.send({ k: 'respond', rpcId, result })
    const answer = await this.expect(
      message => message.k === 'rpc.result' && message.rpcId === rpcId,
    )
    if (answer.k !== 'rpc.result') throw new Error('unreachable: predicate guarantees rpc.result')
    if (!answer.result.ok) throw new Error(`respond receipt failed: ${answer.result.error.message}`)
    return answer.result.value as { accepted: boolean; reason?: string }
  }
}

/** Connect one SidePanel test client; the engine sees the server-side end. */
function connectSidePanel(): { client: TestClient; server: FakePortEnd } {
  const server = new FakePortEnd(API_PORT_NAME)
  const clientEnd = new FakePortEnd(API_PORT_NAME)
  server.peer = clientEnd
  clientEnd.peer = server
  for (const listener of [...connectListeners]) {
    listener(server as unknown as chrome.runtime.Port)
  }
  return { client: new TestClient(clientEnd), server }
}

// ───────────────────────── composition ─────────────────────────

class ScriptedAdapter extends LlmAdapter {
  override async *stream(_options: GenerateOptions): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function bootComposition(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Loader)
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
    '@deepseek-ai/dsh-tool-ask-user': toolAskUser,
    '@deepseek-ai/dsh-user-approval': userApproval,
    '@deepseek-ai/dsh-user-questions': userQuestions,
    '@deepseek-ai/dsh-commands': Commands,
    '@deepseek-ai/dsh-goal': GoalService,
    '@deepseek-ai/dsh-message-feedback': messageFeedback,
    '@deepseek-ai/dsh-skill': SkillRegistry,
    '@deepseek-ai/dsh-session-projection': SessionProjection,
    '@deepseek-ai/dsh-subagent': Subagents,
    '@deepseek-ai/dsh-storage': StorageHub,
    'chrome-storage-kv': chromeStorageKv,
    '@deepseek-ai/dsh-storage-domain': storageDomain,
    'chrome-credentials': ChromeCredentialProvider,
    'chrome-browser-provider': chromeBrowserProvider,
    'ui-bridge': uiBridgePlugin,
    'chrome-api-bridge': apiBridgePlugin,
    'chrome-ask-bridge': chromeAskBridge,
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

  const memory = createMemoryDatabase()
  class MemoryBackedPersistence extends IndexedDbPersistence {
    constructor(pctx: Context, config: Record<string, unknown>) {
      super(pctx, config as never, { openDatabase: memory.open })
    }
  }
  ctx.plugin(MemoryBackedPersistence, { dbName: 'ask-bridge-spec' })

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
    { name: '@deepseek-ai/dsh-user-approval' },
    { name: '@deepseek-ai/dsh-user-questions' },
    { name: '@deepseek-ai/dsh-tool-ask-user' },
    { name: '@deepseek-ai/dsh-commands' },
    { name: '@deepseek-ai/dsh-goal' },
    { name: '@deepseek-ai/dsh-storage' },
    { name: 'chrome-storage-kv' },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'chrome' } },
    { name: '@deepseek-ai/dsh-message-feedback', config: { maxNoteBytes: 8192 } },
    // The bridge's inject array names subagents since the RPC face landed;
    // compose the subagent service and its projection registry or the bridge
    // fiber stays PENDING forever.
    { name: '@deepseek-ai/dsh-session-projection' },
    { name: '@deepseek-ai/dsh-subagent' },
    { name: 'chrome-credentials' },
    { name: 'chrome-browser-provider' },
    { name: 'ui-bridge' },
    // The bridge injects permissionMode (session.permission.*); the knob
    // service rides the plan-mode service, so both rows precede the bridge.
    { name: '@deepseek-ai/dsh-plan-mode', config: { section: '计划模式下只做研究，不执行变更。' } },
    { name: 'permission-mode' },
    { name: 'chrome-api-bridge' },
    { name: 'chrome-ask-bridge' },
    { name: 'chrome-user-plugin-tools' },
  ]
  for (const row of rows) {
    await ctx.loader.create({
      name: row.name,
      ...(row.config === undefined ? {} : { config: row.config }),
    })
  }
  ctx.llm.registerAdapter([PROVIDER], new ScriptedAdapter())

  await ctx.loader.await()
  const notActive = Array.from(ctx.loader.entries())
    .filter(entry => entry.fiber === undefined || entry.fiber.state !== (FIBER_ACTIVE as FiberState))
    .map(entry => `${entry.options.name}(${entry.fiber?.state ?? 'fiberless'})`)
  expect(notActive).toEqual([])

  const deadline = Date.now() + 10_000
  while (ctx.agents.roots().length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const [agent] = ctx.agents.roots()
  expect(agent).toBeDefined()
  // approval.request() requires an open turn: open one the way the loop does.
  agent!.session.append('turn/start', { turn: 1 })
  await agent!.whenIdle()
  return ctx
}

/** One mux-frame catch keyed by frame type, minting the client-side envelope id the way the real client layer does. */
async function nextFrameOfType(
  client: TestClient,
  type: string,
): Promise<{ rpcId: string; frame: Record<string, unknown> }> {
  const message = await client.expect(
    down => down.k === 'frame' && down.stream === 'mux' && (down.frame as { type?: string }).type === type,
  )
  if (message.k !== 'frame') throw new Error('unreachable: predicate guarantees frame')
  // The port frame message carries no rpcId; the client mints one per delivery
  // and every respond echoes it — exactly what PortApiClient.tapStream does.
  return { rpcId: mintFrameRpcId(), frame: message.frame as Record<string, unknown> }
}

describe('chrome-ask-bridge', () => {
  it(
    'round-trips an approval ask to the panel and settles the request',
    { timeout: 120_000 },
    async () => {
      installChromeDouble()
      const ctx = await bootComposition()
      const { client } = connectSidePanel()
      await client.expect(message => message.k === 'ready')
      client.send({ k: 'stream.open', stream: 'mux', rpcId: 'mux-open-1' })

      const agent = ctx.agents.roots()[0]!
      const pending = ctx.approval.request({
        agent,
        toolName: 'page_evaluate',
        callId: ToolCallId('call-1'),
        reason: '请求在页面上下文中执行脚本。参数：{"function":"1+1"}',
      })

      const { rpcId, frame } = await nextFrameOfType(client, 'approval/requested')
      expect(frame['sessionId']).toBe('session-main')
      expect(frame['toolName']).toBe('page_evaluate')
      expect(frame['callId']).toBe('call-1')
      expect(frame['approvalId']).toEqual(expect.any(String))

      // The respond echoes the CLIENT-minted frame id, not the engine's — the
      // bridge must correlate on the payload's approvalId.
      const receipt = await client.respond(rpcId, {
        ok: true,
        value: { sessionId: 'session-main', approvalId: frame['approvalId'], outcome: 'rejected' },
      })
      expect(receipt.accepted).toBe(true)
      await expect(pending).resolves.toBe('rejected')

      const resolved = await nextFrameOfType(client, 'approval/resolved')
      expect(resolved.frame['approvalId']).toBe(frame['approvalId'])
      expect(resolved.frame['outcome']).toBe('rejected')
    },
  )

  it(
    'round-trips a question ask, delivering the answer batch to the tool caller',
    { timeout: 120_000 },
    async () => {
      installChromeDouble()
      const ctx = await bootComposition()
      const { client } = connectSidePanel()
      await client.expect(message => message.k === 'ready')
      client.send({ k: 'stream.open', stream: 'mux', rpcId: 'mux-open-2' })

      const agent = ctx.agents.roots()[0]!
      const pending = ctx.userQuestions.ask({
        questions: [{
          id: 'q1',
          question: '继续执行哪一步？',
          options: [{ label: '选项A' }, { label: '选项B' }],
        }],
        agent,
        signal: new AbortController().signal,
      })

      const { rpcId, frame } = await nextFrameOfType(client, 'question/requested')
      expect(frame['sessionId']).toBe('session-main')
      expect(frame['questions']).toEqual([{
        id: 'q1',
        question: '继续执行哪一步？',
        options: [{ label: '选项A' }, { label: '选项B' }],
      }])

      const receipt = await client.respond(rpcId, {
        ok: true,
        value: {
          sessionId: 'session-main',
          answer: { answers: [{ id: 'q1', selected: ['选项A'] }] },
        },
      })
      expect(receipt.accepted).toBe(true)
      await expect(pending).resolves.toEqual({
        answers: [{ id: 'q1', selected: ['选项A'] }],
      })

      // The resolved frame echoes the RESPOND's rpcId (the client's pending-wait
      // key) so the answering panel's wait actually settles.
      const resolved = await nextFrameOfType(client, 'question/resolved')
      expect(resolved.frame['questionRpcId']).toBe(rpcId)
      expect(resolved.frame['outcome']).toBe('answered')
    },
  )

  it(
    'rejects the ask with ASK_CANCELLED when the panel cancels the question flow',
    { timeout: 120_000 },
    async () => {
      installChromeDouble()
      const ctx = await bootComposition()
      const { client } = connectSidePanel()
      await client.expect(message => message.k === 'ready')
      client.send({ k: 'stream.open', stream: 'mux', rpcId: 'mux-open-3' })

      const agent = ctx.agents.roots()[0]!
      const pending = ctx.userQuestions.ask({
        questions: [{ id: 'q1', question: '继续吗？' }],
        agent,
        signal: new AbortController().signal,
      })
      const { rpcId } = await nextFrameOfType(client, 'question/requested')

      const receipt = await client.respond(rpcId, {
        ok: false,
        error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
      })
      expect(receipt.accepted).toBe(true)
      await expect(pending).rejects.toMatchObject({
        name: 'UserQuestionError',
        code: 'ASK_CANCELLED',
      })

      const resolved = await nextFrameOfType(client, 'question/resolved')
      expect(resolved.frame['questionRpcId']).toBe(rpcId)
      expect(resolved.frame['outcome']).toBe('cancelled')
    },
  )

  it(
    'withdraws every pending wait fail-closed when the last port disconnects',
    { timeout: 120_000 },
    async () => {
      installChromeDouble()
      const ctx = await bootComposition()
      const { client, server } = connectSidePanel()
      await client.expect(message => message.k === 'ready')
      client.send({ k: 'stream.open', stream: 'mux', rpcId: 'mux-open-4' })

      const agent = ctx.agents.roots()[0]!
      const approvalPending = ctx.approval.request({
        agent,
        toolName: 'page_navigate',
        callId: ToolCallId('call-2'),
      })
      const questionPending = ctx.userQuestions.ask({
        questions: [{ id: 'q9', question: '等谁？' }],
        agent,
        signal: new AbortController().signal,
      })
      await nextFrameOfType(client, 'approval/requested')
      await nextFrameOfType(client, 'question/requested')

      // Last audience gone → the bridge's cancel hook withdraws both waits.
      server.disconnect()
      await expect(approvalPending).resolves.toBe('cancelled')
      await expect(questionPending).rejects.toMatchObject({
        name: 'UserQuestionError',
        code: 'ASK_ABORTED',
      })
    },
  )
})
