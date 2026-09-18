/**
 * Offscreen engine-host entry: boots the dsh harness inside the extension's
 * long-lived offscreen document — the browser twin of the web shell's
 * `boot.tsx`, minus everything file- or yml-backed.
 *
 * Boot chain (mirrors the web kernel's plugin face):
 * 1. patch the `process` global (FIRST import — vendor loader probes it at
 *    construction time);
 * 2. `new Context()` → `ctx.plugin(Loader)` → replace the loader's Node
 *    module-system hook with a STATIC module map (name → namespace import:
 *    no files, no yml, no dynamic fetch in an extension page);
 * 3. await the settings store so the pre-configured `main` agent starts on
 *    the user's current model, then `loader.create({ name, config })` one
 *    entry per composition row (configs copied from the headless/base yml
 *    rows of the same id);
 * 4. `loader.await()` → sweep every entry ACTIVE (fail loud, keep the host
 *    alive) → resume the most recent persisted session through the ui-bridge
 *    handle → mount the user-plugin host (storage-declared plugins evaluated
 *    in the manifest-sandboxed iframe, event names bridged onto ctx) → start
 *    the 20s heartbeat toward the Service Worker.
 *
 * The document itself is owned by the background watchdog: it recreates this
 * page when its liveness probe fails, and this entry re-runs the whole chain
 * on every (re)load. Nothing is exported — the module IS the entry point.
 */

import '../shims/globals.ts'

import { Context } from '@deepseek-ai/cordis'
import type { FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Timer from '@deepseek-ai/cordis-plugin-timer'
import * as LlmRuntime from '@deepseek-ai/dsh-llm'
import * as llmRetry from '@deepseek-ai/dsh-llm-retry'
import * as BrowserSeam from '@deepseek-ai/dsh-browser'
import * as SessionStore from '@deepseek-ai/dsh-session'
import * as SessionPersistenceIndexedDb from '@deepseek-ai/dsh-session-persistence-indexeddb'
import * as sessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import * as TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as compactionBasic from '@deepseek-ai/dsh-compaction-basic'
import * as ToolRuntime from '@deepseek-ai/dsh-tools'
import * as SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as AgentRegistry from '@deepseek-ai/dsh-agent'
import * as AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import * as AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as toolTodo from '@deepseek-ai/dsh-tool-todo'
import * as timeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import * as repeatToolReminder from '@deepseek-ai/dsh-repeat-tool-reminder'
import * as timeContext from '@deepseek-ai/dsh-time-context'
import * as toolBrowser from '@deepseek-ai/dsh-tool-browser'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as userApproval from '@deepseek-ai/dsh-user-approval'
import * as WebSeam from '@deepseek-ai/dsh-web'
import * as WebSearchDeepseek from '@deepseek-ai/dsh-web-search-deepseek'
import * as toolWeb from '@deepseek-ai/dsh-tool-web'
import * as chromeCredentials from '../chrome/credentials.ts'
import * as chromeLlm from '../chrome/llm.ts'
import * as chromeBrowserProvider from '../chrome/browser-provider.ts'
import * as chromeAttachmentStore from '../chrome/attachment-store.ts'
import * as uiBridgePlugin from '../chrome/ui-bridge.ts'
import { uiBridge } from '../chrome/ui-bridge.ts'
import * as chromeApiBridge from '../chrome/api-bridge.ts'
import * as chromeAskBridge from '../chrome/chrome-ask-bridge.ts'
import * as chromeToolGate from './chrome-tool-gate.ts'
import * as permissionMode from './permission-mode.ts'
import * as userPluginTools from './user-plugin-tools.ts'
import * as chromeSkillStorage from '../chrome/skill-storage.ts'
import * as chromeSkillWrite from './chrome-skill-write.ts'
import * as SkillRegistry from '@deepseek-ai/dsh-skill'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import * as sessionTitleFirstPromptLlm from '@deepseek-ai/dsh-session-title-first-prompt-llm'
import * as userQuestions from '@deepseek-ai/dsh-user-questions'
import * as Commands from '@deepseek-ai/dsh-commands'
import * as commandFeedback from '@deepseek-ai/dsh-command-feedback'
import * as planMode from '@deepseek-ai/dsh-plan-mode'
import GoalService from '@deepseek-ai/dsh-goal'
import * as goalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import * as commandGoal from '@deepseek-ai/dsh-command-goal'
import * as toolGoal from '@deepseek-ai/dsh-tool-goal'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as spillPolicy from '@deepseek-ai/dsh-spill-policy'
import OpfsFileSystem from '@deepseek-ai/dsh-fs-opfs'
import * as fsObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as toolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as StorageHub from '@deepseek-ai/dsh-storage'
import * as chromeStorageKv from '../chrome/storage-kv.ts'
import { UserPluginHost, setUserPluginHost } from '../chrome/user-plugins.ts'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as messageFeedback from '@deepseek-ai/dsh-message-feedback'
import { DEFAULT_DB_NAME } from '@deepseek-ai/dsh-session-persistence-indexeddb'
import { DEFAULT_MODEL, initSettingsCache, readEngineSettings, resolveActiveProvider, writeEngineSettings } from '../chrome/settings-store'
import { PROVIDER_PRESETS } from '../chrome/llm-providers.ts'
import { readDeclaredProfiles } from '../chrome/custom-providers.ts'
import { AGENT_CHANNEL } from '../shared/protocol'

function log(...args: unknown[]): void {
  console.log('[dsh-offscreen]', ...args)
}

function warn(...args: unknown[]): void {
  console.warn('[dsh-offscreen]', ...args)
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

// ───────────────────────── static module map ─────────────────────────

/**
 * Every loader entry name this host can import, mapped to its statically
 * bundled module namespace. The loader's `unwrapExports` normalizes ESM/CJS
 * shapes; function plugins deliberately ship NAMED exports only (a `default`
 * would be unwrapped to a bare function and lose their `inject`/`Config` —
 * see the agent-spine-demo module comment and docs/postmortem/0001).
 */
const MODULES: Readonly<Record<string, object>> = {
  '@deepseek-ai/cordis-plugin-timer': Timer,
  '@deepseek-ai/dsh-llm': LlmRuntime,
  '@deepseek-ai/dsh-llm-retry': llmRetry,
  '@deepseek-ai/dsh-browser': BrowserSeam,
  '@deepseek-ai/dsh-session': SessionStore,
  '@deepseek-ai/dsh-session-persistence-indexeddb': SessionPersistenceIndexedDb,
  '@deepseek-ai/dsh-session-checkpoint-policy': sessionCheckpointPolicy,
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
  '@deepseek-ai/dsh-tool-ask-user': toolAskUser,
  '@deepseek-ai/dsh-user-approval': userApproval,
  '@deepseek-ai/dsh-web': WebSeam,
  '@deepseek-ai/dsh-web-search-deepseek': WebSearchDeepseek,
  '@deepseek-ai/dsh-tool-web': toolWeb,
  'chrome-credentials': chromeCredentials,
  'chrome-llm': chromeLlm,
  'chrome-browser-provider': chromeBrowserProvider,
  'ui-bridge': uiBridgePlugin,
  'chrome-api-bridge': chromeApiBridge,
  'chrome-ask-bridge': chromeAskBridge,
  'chrome-tool-gate': chromeToolGate,
  'permission-mode': permissionMode,
  'chrome-user-plugin-tools': userPluginTools,
  'chrome-skill-storage': chromeSkillStorage,
  'chrome-skill-write': chromeSkillWrite,
  'chrome-attachment-store': chromeAttachmentStore,
  '@deepseek-ai/dsh-skill': SkillRegistry,
  '@deepseek-ai/dsh-tool-skill': toolSkill,
  '@deepseek-ai/dsh-session-title': SessionTitle,
  '@deepseek-ai/dsh-session-title-first-prompt-llm': sessionTitleFirstPromptLlm,
  '@deepseek-ai/dsh-user-questions': userQuestions,
  '@deepseek-ai/dsh-commands': Commands,
  '@deepseek-ai/dsh-command-feedback': commandFeedback,
  '@deepseek-ai/dsh-plan-mode': planMode,
  '@deepseek-ai/dsh-goal': GoalService,
  '@deepseek-ai/dsh-goal-round-driver': goalRoundDriver,
  '@deepseek-ai/dsh-command-goal': commandGoal,
  '@deepseek-ai/dsh-tool-goal': toolGoal,
  '@deepseek-ai/dsh-jobs-local': JobsLocal,
  '@deepseek-ai/dsh-tool-jobs': toolJobs,
  '@deepseek-ai/dsh-fs-opfs': OpfsFileSystem,
  '@deepseek-ai/dsh-fs-observation-policy': fsObservationPolicy,
  '@deepseek-ai/dsh-tool-fs': toolFs,
  '@deepseek-ai/dsh-spill-policy': spillPolicy,
  '@deepseek-ai/dsh-session-projection': SessionProjection,
  '@deepseek-ai/dsh-subagent': Subagents,
  '@deepseek-ai/dsh-subagent-spawn-in-process': SubagentSpawnInProcess,
  '@deepseek-ai/dsh-tool-subagent': toolSubagent,
  '@deepseek-ai/dsh-storage': StorageHub,
  'chrome-storage-kv': chromeStorageKv,
  '@deepseek-ai/dsh-storage-domain': storageDomain,
  '@deepseek-ai/dsh-message-feedback': messageFeedback,
}

/** One composition row: the loader entry name plus its config (if any). */
interface CompositionRow {
  name: string
  config?: Record<string, unknown>
}

/**
 * The composition line (rows and config shapes copied from the
 * `examples/headless-agent/cordis.yml` / `packages/bundle/base/cordis.patch.yml`
 * rows of the same id, minus the Node-backed plugins this host replaces).
 */
function compositionRows(model: string, provider: string): CompositionRow[] {
  return [
    { name: '@deepseek-ai/cordis-plugin-timer' },
    { name: '@deepseek-ai/dsh-llm' },
    { name: '@deepseek-ai/dsh-llm-retry' },
    // The browser seam (ctx.browser): the CDP provider below and the
    // model-facing tool suite both inject it; omitted config auto-selects
    // the single registered provider.
    { name: '@deepseek-ai/dsh-browser' },
    { name: '@deepseek-ai/dsh-session' },
    {
      name: '@deepseek-ai/dsh-session-persistence-indexeddb',
      config: { dbName: DEFAULT_DB_NAME, legacyUnknownEventRepair: true },
    },
    { name: '@deepseek-ai/dsh-session-checkpoint-policy' },
    { name: '@deepseek-ai/dsh-token-meter' },
    {
      name: '@deepseek-ai/dsh-compaction-basic',
      config: {
        thresholdRatio: 0.8,
        retainRatio: 0.16,
        maxTokens: 8192,
        compactionRetries: 1,
      },
    },
    { name: '@deepseek-ai/dsh-tools' },
    { name: '@deepseek-ai/dsh-system-prompt', config: { persona: '' } },
    { name: '@deepseek-ai/dsh-agent' },
    {
      name: '@deepseek-ai/dsh-agent-default-model',
      config: { provider, model },
    },
    {
      name: '@deepseek-ai/dsh-agent-loop',
      config: {
        agents: [
          // Stable identity: every engine (re)start restores-or-creates the
          // same durable conversation through the loop's native cold-recovery
          // path (prepare/load + synthetic turn closers).
          { id: 'main', sessionId: 'session-main', provider, model },
        ],
      },
    },
    { name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },

    // ── web 搜索（base/cordis.patch.yml 同 id 行的浏览器镜像）：web 能力缝 →
    // DeepSeek 搜索提供者（Messages 端点，复用 DEEPSEEK_API_KEY 凭据）→
    // 模型面 web_search 工具。fetch 保持禁用：该提供者推迟 SSRF 防护，扩展
    // 宿主不挂 fetch 提供者，模型不会自行选择请求目标。
    { name: '@deepseek-ai/dsh-web', config: { searchProvider: 'deepseek-official' } },
    { name: '@deepseek-ai/dsh-web-search-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
    { name: '@deepseek-ai/dsh-tool-web', config: { fetch: false, searchTimeoutMs: 60000 } },

    // ── 守卫/上下文（浏览器安全子集）：工具超时、重复调用提醒、时间上下文 ──
    { name: '@deepseek-ai/dsh-tool-call-timeout-policy' },
    { name: '@deepseek-ai/dsh-repeat-tool-reminder', config: { thresholds: [3, 5, 8], argumentsPreviewChars: 500 } },
    { name: '@deepseek-ai/dsh-time-context', config: { refreshIntervalMs: 60000 } },

    // ── dsh 特性保留：skills / plan / goal / jobs / commands / 标题 / 子代理 ──
    { name: '@deepseek-ai/dsh-skill' },
    { name: 'chrome-skill-storage' },
    { name: '@deepseek-ai/dsh-tool-skill' },
    { name: 'chrome-skill-write' },
    { name: '@deepseek-ai/dsh-session-title', config: { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } },
    { name: '@deepseek-ai/dsh-session-title-first-prompt-llm', config: { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000 } },
    // ── 交互底座：审批策略服务 → 问题服务 → ask_user_question 工具 ──
    { name: '@deepseek-ai/dsh-user-approval' },
    { name: '@deepseek-ai/dsh-user-questions' },
    { name: '@deepseek-ai/dsh-tool-ask-user' },
    { name: '@deepseek-ai/dsh-commands' },
    { name: '@deepseek-ai/dsh-command-feedback' },
    { name: '@deepseek-ai/dsh-plan-mode', config: { section: "You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement \u2014 including an answer confirming something you asked \u2014 approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode." } },
    { name: '@deepseek-ai/dsh-goal' },
    { name: '@deepseek-ai/dsh-goal-round-driver' },
    { name: '@deepseek-ai/dsh-command-goal' },
    { name: '@deepseek-ai/dsh-tool-goal' },
    { name: '@deepseek-ai/dsh-jobs-local' },
    { name: '@deepseek-ai/dsh-tool-jobs' },

    // ── fs 能力缝（base yml fs 行的浏览器镜像）：OPFS 提供者（ctx.fs）→
    // 观测态策略 → 模型面 read/write/edit 工具。OPFS 的 origin 隔离本身就是
    // 约束边界（模型只能触碰本扩展 origin 的私有文件区），因此它替代 Node 侧
    // 的 landlock fs-sandbox 行；ctx.fs.sandboxMode 保持 undefined，工具套件
    // 不宣告升级字段。tool-fs-search 不组：glob/grep 经 ctx.subprocess 拉起
    // 打包的 ripgrep 二进制，浏览器宿主没有子进程缝。默认读写（base 行同款
    // 无 config），相对路径解析到 OPFS 根 '/'。
    { name: '@deepseek-ai/dsh-fs-opfs' },
    { name: '@deepseek-ai/dsh-fs-observation-policy' },
    { name: '@deepseek-ai/dsh-tool-fs' },

    { name: '@deepseek-ai/dsh-spill-policy', config: { maxInlineBytes: 50000 } },
    // The projection registry the subagent service's child catalog and the
    // api-bridge's subagent.* RPC face fold through (listChildren rejects a
    // deployment without it).
    { name: '@deepseek-ai/dsh-session-projection' },
    { name: '@deepseek-ai/dsh-subagent' },
    { name: '@deepseek-ai/dsh-subagent-spawn-in-process', config: { providerName: 'spawn' } },
    { name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable' } },

    // ── 消息反馈侧车：KV 存储（chrome.storage 后端）+ 域层 + 服务 ──
    { name: '@deepseek-ai/dsh-storage' },
    { name: 'chrome-storage-kv' },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'chrome' } },
    { name: '@deepseek-ai/dsh-message-feedback', config: { maxNoteBytes: 8192 } },
    { name: '@deepseek-ai/dsh-tool-browser' },
    // 浏览器/文件变更权限闸门（permission/mode 四档矩阵 → ctx.approval）与
    // 面板交互桥（approval/question 帧推送 + respond 结算）。闸门为事件面
    // 插件，放在 dsh-tool-browser 之后保证工具已注册；permission-mode 服务
    // （会话权限旋钮 + plan 同步）供闸门折叠与 api-bridge RPC 读写。
    { name: 'permission-mode' },
    { name: 'chrome-tool-gate' },
    { name: 'chrome-ask-bridge' },
    { name: 'chrome-credentials' },
    // ── 附件能力缝（ctx.attachments）：OPFS 内容寻址图片存储。composer 图片
    // 经 session.prompt 晋升为 durable 引用，适配器与 session.attachment 读回。──
    { name: 'chrome-attachment-store' },
    { name: 'chrome-llm' },
    { name: 'chrome-browser-provider' },
    { name: 'ui-bridge' },
    // The ApiProxy service surface for the real dsh Web UI in the SidePanel
    // (named Port `dsh-api`): rpc round-trips, mux/host event streams, and
    // the structured-unavailable refusals for everything the extension host
    // cannot serve.
    { name: 'chrome-api-bridge' },
    // Model-facing tools over the user-plugin lane (list/write/remove/toggle).
    // Tool registration only binds definitions; execute resolves the host at
    // call time, so composing before the host singleton is set is safe.
    { name: 'chrome-user-plugin-tools' },
  ]
}

// ───────────────────────── entry sweep ─────────────────────────

/**
 * Runtime mirror of cordis' `const enum FiberState`: the enum is erased from
 * the built cordis lib the bundle resolves, so the values (fixed by the
 * declaration order in vendor/cordis/src/fiber.ts) are restated here and kept
 * honest by the `satisfies` check against the type-only import above.
 */
const FiberStates = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const satisfies Record<string, FiberState>

const FIBER_STATE_LABELS: Readonly<Record<number, string>> = {
  [FiberStates.PENDING]: 'pending（等待未到位的服务）',
  [FiberStates.LOADING]: 'loading',
  [FiberStates.ACTIVE]: 'active',
  [FiberStates.FAILED]: 'failed（apply 抛错，详见控制台）',
  [FiberStates.DISPOSED]: 'disposed',
  [FiberStates.UNLOADING]: 'unloading',
}

/**
 * Sweep every loader entry after the tree quiesced: an entry without a fiber
 * failed its import; a fiber not ACTIVE failed its apply or is still pending
 * on a service that never arrived (cordis inject waiting has no timeout, so
 * this sweep is the fail-loud compensation). Mirrors the web kernel's
 * assertEntriesActive.
 */
function assertEntriesActive(ctx: Context): void {
  const failures: string[] = []
  for (const entry of ctx.loader.entries()) {
    const name = entry.options.name
    if (entry.fiber === undefined) {
      failures.push(`${name}：模块导入失败（详见控制台）`)
      continue
    }
    const state = entry.fiber.state
    if (state === (FiberStates.ACTIVE as FiberState)) continue
    if (state === (FiberStates.PENDING as FiberState)) {
      const missing = Object.keys(entry.fiber.inject).filter(
        service => ctx.get(service) === undefined,
      )
      failures.push(
        `${name}：pending（等待服务：${missing.join('、') || '未知'}）`,
      )
      continue
    }
    failures.push(`${name}：${FIBER_STATE_LABELS[state] ?? String(state)}`)
  }
  if (failures.length > 0) {
    throw new Error(
      `引擎组合行有 ${String(failures.length)} 项未激活：\n${failures.join('\n')}`,
    )
  }
}

// ───────────────────────── heartbeat ─────────────────────────

const HEARTBEAT_INTERVAL_MS = 20_000

/**
 * Liveness heartbeat toward the Service Worker: keeps the SW warm between
 * user interactions and surfaces message-channel breakage (context
 * invalidated during extension reload) in the console. Failures are
 * non-fatal — the SW's own watchdog owns the rebuild decision.
 */
function startHeartbeat(): void {
  const timer = setInterval(() => {
    try {
      chrome.runtime.sendMessage(
        { channel: AGENT_CHANNEL, type: 'ping' },
        () => {
          // Consume lastError explicitly: an asleep-but-waking SW or a closed
          // channel answers with "Receiving end does not exist" here.
          const lastError = chrome.runtime.lastError
          if (lastError !== undefined && lastError !== null) {
            warn('心跳未送达后台服务：', lastError.message ?? '')
          }
        },
      )
    } catch (err) {
      warn('心跳发送失败（扩展上下文可能已失效）：', errText(err))
    }
  }, HEARTBEAT_INTERVAL_MS)
  // Keep the interval off the unload path's teardown list: the offscreen
  // document's lifetime IS the engine's lifetime.
  void timer
}

// ───────────────────────── boot ─────────────────────────

async function boot(): Promise<void> {
  // Prime the synchronous settings cache before the LLM adapter's options
  // thunk can run, then await the committed values so the pre-configured
  // `main` agent starts on the user's current model. A storage failure falls
  // back to defaults — boot must not die on an unreadable settings document.
  initSettingsCache()
  const settings = await readEngineSettings().catch(() => null)
  const model = settings?.model || DEFAULT_MODEL
  // A persisted route whose custom profile was deleted would strand every
  // request with NO_ADAPTER; validate it against the adapter universe
  // (presets + declared custom routes) and self-heal to the stock provider.
  const resolved = resolveActiveProvider(
    settings?.provider,
    PROVIDER_PRESETS.map(preset => preset.id),
    Object.keys(await readDeclaredProfiles().catch(() => ({}))),
  )
  if (resolved.corrected) {
    warn(`引擎持久化路由 "${settings?.provider}" 没有对应的供应商（自定义路由可能已被删除），本次启动回落到 "${resolved.provider}"`)
    await writeEngineSettings({ provider: resolved.provider }).catch((err: unknown) => {
      warn('引擎回落路由持久化失败（下次启动将再次回落）：', errText(err))
    })
  }
  const activeProvider = resolved.provider

  const ctx = new Context()
  await ctx.plugin(Loader)
  const loader = ctx.loader

  // The vendored Loader's Node module-system probe resolves to undefined
  // under the browser `process` shim; install the static importer BEFORE any
  // entry exists so tree.import never falls back to a bare dynamic import
  // (a guaranteed loud failure inside an extension page).
  loader.internal = {
    import: (name: string): Promise<unknown> => {
      const mod = MODULES[name]
      if (mod === undefined) {
        throw new Error(`引擎宿主未捆绑插件模块：${name}`)
      }
      return Promise.resolve(mod)
    },
  } as never

  log('开始组装引擎组合行（provider:', activeProvider, 'model:', model, 'settings.provider:', settings?.provider, 'settings.model:', settings?.model, '）')
  for (const row of compositionRows(model, activeProvider)) {
    const id = await loader.create({
      name: row.name,
      ...(row.config === undefined ? {} : { config: row.config }),
    })
    const entry = loader.resolve(id)
    if (entry.fiber === undefined) {
      // A failed import leaves the entry fiberless (Entry._init logs the
      // cause); collect it here instead of failing the whole create loop.
      warn(`插件 ${row.name} 导入失败`)
    }
  }

  try {
    await loader.await()
  } catch (err) {
    // await only aggregates ("loader fibers failed"); enumerate the per-entry
    // states before surfacing so the report names who and why.
    warn('loader.await 汇报失败，逐条检查组合行：', errText(err))
  }
  assertEntriesActive(ctx)
  log('引擎组合行已全部激活')

  // Resume the most recent persisted session (or adopt the pre-configured
  // `main` agent on first boot) so the SidePanel continues where it left off.
  await uiBridge()?.restoreLatest()

  // Browser extension patch: AsyncLocalStorage cannot propagate across
  // `await` in the browser, so `requireInitiator()` fails during tool
  // execution (the stored agent is lost after async boundaries). Patch it
  // to fall back to the live root agent — the extension host runs exactly
  // one initiator (session-main), so this is always the correct answer.
  {
    const registry = ctx.agents as unknown as {
      requireInitiator: () => unknown
      currentInitiator: () => unknown
      roots: () => unknown[]
    }
    const original = registry.requireInitiator.bind(registry)
    registry.requireInitiator = (): unknown => {
      try {
        return original()
      } catch {
        const root = registry.roots()[0]
        if (root !== undefined) return root
        throw original()
      }
    }
    log('requireInitiator 浏览器补丁已安装（ALS 回退到根 agent）')
  }

  // User plugins (extension twin of dsh's bundle/self-modification lane):
  // storage-declared plugins are evaluated inside the manifest-sandboxed
  // iframe (MV3 CSP forbids dynamic evaluation in extension pages) and their
  // declared event names bridge back onto this ctx. A failed user-plugin lane
  // degrades to console noise — the engine composition itself must stay up.
  try {
    const plugins = new UserPluginHost(ctx)
    setUserPluginHost(plugins)
    await plugins.start()
    ctx.effect(() => () => { plugins.dispose() }, 'user-plugins host')
    log('用户插件宿主已启动')
  } catch (err) {
    warn('用户插件宿主启动失败（引擎继续运行）：', errText(err))
  }

  startHeartbeat()
  log('offscreen 引擎宿主就绪')
}

void boot().catch((err: unknown) => {
  // Keep the document alive on boot failure: the failure report lives in the
  // console, and the background watchdog decides rebuilds from its own probe.
  console.error('[dsh-offscreen] 引擎启动失败：', errText(err))
})
