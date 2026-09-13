/**
 * Composition spec for the offscreen engine line: boots the SAME composition
 * src/offscreen/main.ts mounts (Loader + static module map + entry rows)
 * under Node, with two host-specific substitutions the environment forces —
 * the IndexedDB backend runs over the package's in-memory structural double
 * (Node has no `indexedDB` global), and `chrome-llm` is replaced by a
 * scripted adapter (the chrome.storage-backed key resolution has no Node
 * answer, and the provider route admits exactly one adapter).
 *
 * Asserts the whole line activates, one fixture turn flows through the
 * durable event log, and the ui-bridge's startup recovery resumes the most
 * recently persisted session.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Timer from '@deepseek-ai/cordis-plugin-timer'
import type { FiberState } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as llmRetry from '@deepseek-ai/dsh-llm-retry'
import * as BrowserSeam from '@deepseek-ai/dsh-browser'
import SessionStore from '@deepseek-ai/dsh-session'
import IndexedDbPersistence from '@deepseek-ai/dsh-session-persistence-indexeddb'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
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
import * as timeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import * as repeatToolReminder from '@deepseek-ai/dsh-repeat-tool-reminder'
import * as timeContext from '@deepseek-ai/dsh-time-context'
import * as toolBrowser from '@deepseek-ai/dsh-tool-browser'
import OpfsFileSystem from '@deepseek-ai/dsh-fs-opfs'
import * as fsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as WebSeam from '@deepseek-ai/dsh-web'
import * as WebSearchDeepseek from '@deepseek-ai/dsh-web-search-deepseek'
import * as toolWeb from '@deepseek-ai/dsh-tool-web'
import ChromeCredentialProvider from '../src/chrome/credentials.ts'
import * as chromeBrowserProvider from '../src/chrome/browser-provider.ts'
import * as uiBridgePlugin from '../src/chrome/ui-bridge.ts'
import { uiBridge } from '../src/chrome/ui-bridge.ts'

const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'
const REPLY = '你好，我是扩展引擎组合行的烟测回复。'

/** Mirrors the offscreen entry: FiberState is a const enum erased from the built cordis lib. */
const FIBER_ACTIVE = 2

/** In-memory chrome.storage.local double (the storage-backed credential provider's store). */
const storageData = new Map<string, unknown>()

/**
 * Node substitution 3: chrome.storage.local over an in-memory map, installed
 * BEFORE the composition boots so the chrome-credentials row's resolve answers
 * a keyless read (empty → absent) instead of failing on an undefined chrome
 * global — which would surface as a provider error rather than the clean
 * missing-credential refusal the search-chain assertion expects.
 */
function installChromeStorageDouble(): void {
  const chromeMock = {
    storage: {
      local: {
        async get(keys: string[]): Promise<Record<string, unknown>> {
          const out: Record<string, unknown> = {}
          for (const key of keys) {
            const value = storageData.get(key)
            if (value !== undefined) out[key] = value
          }
          return out
        },
        async set(items: Record<string, unknown>): Promise<void> {
          for (const [key, value] of Object.entries(items)) storageData.set(key, value)
        },
        async remove(names: string[]): Promise<void> {
          for (const name of names) storageData.delete(name)
        },
      },
      onChanged: { addListener: (): void => {} },
    },
  } as never
  ;(globalThis as { chrome?: unknown }).chrome = chromeMock
}

class ScriptedAdapter extends LlmAdapter {
  override async *stream(_options: GenerateOptions): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: REPLY }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 6 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The static module map (entry name → namespace), as in src/offscreen/main.ts. */
const MODULES: Record<string, object> = {
  '@deepseek-ai/cordis-plugin-timer': Timer,
  '@deepseek-ai/dsh-llm': LlmRuntime,
  '@deepseek-ai/dsh-llm-retry': llmRetry,
  '@deepseek-ai/dsh-browser': BrowserSeam,
  '@deepseek-ai/dsh-session': SessionStore,
  '@deepseek-ai/dsh-session-checkpoint-policy': checkpointPolicy,
  '@deepseek-ai/dsh-session-projection': SessionProjection,
  '@deepseek-ai/dsh-token-meter': TokenMeter,
  '@deepseek-ai/dsh-compaction-basic': compactionBasic,
  '@deepseek-ai/dsh-tools': ToolRuntime,
  '@deepseek-ai/dsh-system-prompt': SystemPrompt,
  '@deepseek-ai/dsh-agent': AgentRegistry,
  '@deepseek-ai/dsh-agent-default-model': AgentDefaultModel,
  '@deepseek-ai/dsh-agent-loop': AgentLoop,
  '@deepseek-ai/dsh-tool-todo': toolTodo,
  '@deepseek-ai/dsh-tool-call-timeout-policy': timeoutPolicy,
  '@deepseek-ai/dsh-repeat-tool-reminder': repeatToolReminder,
  '@deepseek-ai/dsh-time-context': timeContext,
  '@deepseek-ai/dsh-tool-browser': toolBrowser,
  '@deepseek-ai/dsh-fs-opfs': OpfsFileSystem,
  '@deepseek-ai/dsh-fs-observation-policy': fsObservationPolicy,
  '@deepseek-ai/dsh-tool-fs': toolFs,
  '@deepseek-ai/dsh-web': WebSeam,
  '@deepseek-ai/dsh-web-search-deepseek': WebSearchDeepseek,
  '@deepseek-ai/dsh-tool-web': toolWeb,
  'chrome-credentials': ChromeCredentialProvider,
  'chrome-browser-provider': chromeBrowserProvider,
  'ui-bridge': uiBridgePlugin,
}

describe('offscreen engine composition', () => {
  it(
    'activates every row, drives one turn, and resumes the latest session',
    { timeout: 90_000 },
    async () => {
      installChromeStorageDouble()
      const ctx = new Context()
      await ctx.plugin(Loader)
      ctx.loader.internal = {
        import: async (name: string) => {
          const mod = MODULES[name]
          if (mod === undefined) throw new Error(`引擎宿主未捆绑插件模块：${name}`)
          return mod
        },
      } as never

      // Node substitution 1: the IndexedDB backend over the in-memory double.
      const memory = createMemoryDatabase()
      class MemoryBackedPersistence extends IndexedDbPersistence {
        constructor(pctx: Context, config: Record<string, unknown>) {
          super(pctx, config as never, { openDatabase: memory.open })
        }
      }
      ctx.plugin(MemoryBackedPersistence, { dbName: 'composition-spec' })

      const rows: Array<{ name: string; config?: Record<string, unknown> }> = [
        { name: '@deepseek-ai/cordis-plugin-timer' },
        { name: '@deepseek-ai/dsh-llm' },
        { name: '@deepseek-ai/dsh-llm-retry' },
        { name: '@deepseek-ai/dsh-browser' },
        { name: '@deepseek-ai/dsh-session' },
        { name: '@deepseek-ai/dsh-session-checkpoint-policy' },
        { name: '@deepseek-ai/dsh-session-projection' },
        { name: '@deepseek-ai/dsh-token-meter' },
        {
          name: '@deepseek-ai/dsh-compaction-basic',
          config: { thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192, compactionRetries: 1 },
        },
        { name: '@deepseek-ai/dsh-tools' },
        { name: '@deepseek-ai/dsh-system-prompt', config: { persona: '' } },
        { name: '@deepseek-ai/dsh-agent' },
        { name: '@deepseek-ai/dsh-agent-default-model', config: { provider: PROVIDER, model: MODEL } },
        {
          name: '@deepseek-ai/dsh-agent-loop',
          config: { agents: [{ id: 'main', sessionId: 'session-main', provider: PROVIDER, model: MODEL }] },
        },
        { name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
        // The fs capability trio the offscreen composition mounts (browser
        // mirror of the base yml fs rows): the OPFS provider, the
        // observed-state policy, and the model-facing read/write/edit tools.
        // tool-fs-search stays out — it spawns the ripgrep binary through
        // ctx.subprocess, which no browser host provides.
        { name: '@deepseek-ai/dsh-fs-opfs' },
        { name: '@deepseek-ai/dsh-fs-observation-policy' },
        { name: '@deepseek-ai/dsh-tool-fs' },
        // The web-search trio the offscreen composition mounts (base yml
        // mirror): web seam pinned to the DeepSeek provider, provider row, and
        // the model-facing web_search tool (fetch stays disabled).
        { name: '@deepseek-ai/dsh-web', config: { searchProvider: 'deepseek-official' } },
        { name: '@deepseek-ai/dsh-web-search-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
        { name: '@deepseek-ai/dsh-tool-web', config: { fetch: false, searchTimeoutMs: 60000 } },
        // The guard/context trio the offscreen composition mounts (browser
        // safe subset): tool timeout, repeat-call reminders, time context.
        { name: '@deepseek-ai/dsh-tool-call-timeout-policy' },
        { name: '@deepseek-ai/dsh-repeat-tool-reminder', config: { thresholds: [3, 5, 8], argumentsPreviewChars: 500 } },
        { name: '@deepseek-ai/dsh-time-context', config: { refreshIntervalMs: 60000 } },
        { name: '@deepseek-ai/dsh-tool-browser' },
        { name: 'chrome-credentials' },
        { name: 'chrome-browser-provider' },
        { name: 'ui-bridge' },
      ]
      for (const row of rows) {
        await ctx.loader.create({
          name: row.name,
          ...(row.config === undefined ? {} : { config: row.config }),
        })
      }

      // Node substitution 2: the scripted adapter owns the provider route.
      ctx.llm.registerAdapter([PROVIDER], new ScriptedAdapter())

      await ctx.loader.await()
      const notActive = Array.from(ctx.loader.entries())

        .filter(entry => entry.fiber === undefined || entry.fiber.state !== (FIBER_ACTIVE as FiberState))
        .map(entry => `${entry.options.name}(${entry.fiber?.state ?? 'fiberless'})`)
      expect(notActive).toEqual([])

      // The web-search trio activates: the model-facing tool registers, the
      // fetch twin stays out (fetch: false), and the seam selects the DeepSeek
      // provider — a keyless search fails with the provider's structured
      // credential-missing code instead of the seam's no-provider refusal,
      // proving the whole search chain is wired.
      const searchTool = ctx.tools.get('web_search')
      expect(searchTool).toBeDefined()
      expect(searchTool?.name).toBe('web_search')
      expect(ctx.tools.get('web_fetch')).toBeUndefined()
      await expect(
        ctx.web.search({ query: 'composition smoke', maxResults: 1 }),
      ).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })

      // The fs trio activates: the OPFS provider answers ctx.fs with no
      // sandbox mode (OPFS origin scoping is the containment, so the tool
      // suite advertises no escalation fields), the read/write/edit tools
      // register over it, and the subprocess-backed search suite stays out.
      expect(ctx.fs).toBeDefined()
      expect(ctx.fs.sandboxMode).toBeUndefined()
      expect(ctx.tools.get('read')).toBeDefined()
      expect(ctx.tools.get('write')).toBeDefined()
      expect(ctx.tools.get('edit')).toBeDefined()
      expect(ctx.tools.get('glob')).toBeUndefined()
      expect(ctx.tools.get('grep')).toBeUndefined()

      // The configured agent's restore-or-create startup runs past its
      // fiber's apply — poll like the boot entry's restore does.
      const deadline = Date.now() + 10_000
      while (ctx.agents.roots().length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const [agent] = ctx.agents.roots()
      expect(agent).toBeDefined()
      expect(agent!.id).toBe('session-main')
      await agent!.whenIdle()

      const seen: string[] = []
      const dispose = ctx.on('session/event', (session, event) => {
        if (session === agent!.session) seen.push(`${event.seq}:${event.type}`)
      })
      agent!.followup(
        createUserMessage({ content: [{ type: 'text', text: '打个招呼' }], source: { kind: 'user' } }),
      )
      await agent!.whenIdle()
      await ctx.sessions.flush(agent!.session)
      dispose()

      // 0.1.5 layout: the durable turn opens with the inbox splice record and
      // may carry interleaved projection events, so assert order-sensitive
      // milestones rather than exact seq positions.
      const types = seen.map(entry => entry.replace(/^\d+:/, ''))
      expect(seen).toContain('0:agent/inbox/spliced')
      expect(types).toContain('turn/start')
      expect(types).toContain('user/message')
      expect(types).toContain('assistant/message')
      expect(types[types.length - 1]).toBe('turn/end')

      // Startup recovery: the bridge resumes the (now persisted) main session.
      await uiBridge()?.restoreLatest()
      const persisted = await ctx.sessionPersistence.list()
      expect(persisted.map(h => h.header.id)).toContain('session-main')
    },
  )
})
