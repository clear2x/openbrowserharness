/**
 * `ui-bridge`: the SidePanel ↔ engine bridge inside the Offscreen host.
 *
 * Owns every named `dsh-ui` Port, translates each UiMessage into engine
 * actions over the dsh services, and fans engine facts back out as
 * EngineMessages:
 *
 * - session.list  → sessionPersistence.list + per-log event counts
 *                   (cached by revision, live sessions override) → SessionSummary[]
 * - session.create→ ctx.agents.create (fresh session + agent) + title bookkeeping
 * - session.select→ switch current; lazily resume a persisted session
 * - session.history → stored events (handle.read fromSeq) merged with the live
 *                   session's tail, deduped by seq
 * - prompt        → followup on the current agent (creating the session first
 *                   when none exists)
 * - steer / cancel→ agent.steer / agent.cancel({kind:'user'})
 * - status        → agent-status mirror of the current agent
 * - settings.get/set → chrome.storage.local (API key routed through the
 *                   credentials service so `credentials/updated` fires)
 *
 * Subscriptions: `session/event` → {t:'event'}, `agent/status` →
 * {t:'agent-status'}. Every connect gets an immediate {t:'ready'}.
 *
 * Startup recovery: after boot the most recently updated persisted session is
 * resumed (cold recovery with synthetic turn closers — dsh's native
 * prepare/load path) so the SidePanel can continue the conversation. The
 * restore is idempotent: an already-live agent is left untouched.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: loads the `ctx.sessionPersistence` Context augmentation from the
// persistence seam (the IndexedDB backend's own types carry the interface,
// but not the module augmentation into this program).
import type {} from '@deepseek-ai/dsh-session-persistence'
import { AGENT_CHANNEL, UI_PORT_NAME } from '../shared/protocol'
import type {
  EngineMessage,
  EngineSettings,
  SerializedSessionEvent,
  SessionSummary,
  UiMessage,
} from '../shared/protocol'
import { DEEPSEEK_API_KEY_REF } from './credentials'
import {
  currentEngineConfig,
  readEngineSettings,
  writeEngineSettings,
} from './settings-store'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ui-bridge'

/** Engine services the bridge drives. */
export const inject = ['agents', 'sessions', 'sessionPersistence', 'credentials']

/** This plugin has no config. */
export interface Config {}

const TITLES_KEY = 'dsh-session-titles'
const PROVIDER = 'deepseek-official'
const FALLBACK_TITLE_CHARS = 24

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

function isChromeRuntimeAvailable(): boolean {
  return typeof chrome !== 'undefined' && chrome.runtime !== undefined
}

function isStorageAvailable(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    chrome.storage !== undefined &&
    chrome.storage.local !== undefined
  )
}

/**
 * The bridge handle {@link apply} publishes for the offscreen boot entry:
 * restoration runs only after `loader.await()` (the agent factory the resume
 * path needs is itself a plugin that activates during that await), so the
 * plugin's own apply must not trigger it.
 */
export interface UiBridgeHandle {
  /**
   * Resume the most recently updated persisted session (or adopt the one live
   * startup agent) so the SidePanel can continue where it left off.
   * Idempotent per engine lifetime.
   */
  restoreLatest(): Promise<void>
}

/** The currently applied bridge, if the plugin has activated. */
let activeBridge: UiBridgeHandle | undefined

/**
 * The live bridge handle for the offscreen boot entry.
 * @returns the handle, or `undefined` before the ui-bridge plugin activated.
 */
export function uiBridge(): UiBridgeHandle | undefined {
  return activeBridge
}

/** One persisted-session summary fact, cached per durable revision. */
interface SummaryFacts {
  eventCount: number
  updatedAt: number
  firstUserText: string
}

function mintSessionId(): SessionId {
  const uuid =
    globalThis.crypto.randomUUID?.() ?? `t${Date.now()}-${Math.random().toString(16).slice(2)}`
  return SessionId(`session-${uuid}`)
}

/** Serialize one SessionEvent for the Port (nested `data`; the UI reads both shapes). */
export function serializeEvent(event: SessionEvent): SerializedSessionEvent {
  return {
    seq: event.seq,
    type: event.type,
    time: event.time,
    data: event.data,
  }
}

/** Derive a short title from the first user message text. */
function titleFromText(text: string): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim()
  return flat.slice(0, FALLBACK_TITLE_CHARS)
}

export function apply(ctx: Context, _config: Config): void {
  void _config

  // ── bridge state ──
  const ports = new Set<chrome.runtime.Port>()
  const handles = new Map<SessionId, AgentHandle>()
  const factsCache = new Map<string, SummaryFacts>()
  const titleOverrides = new Map<string, string>()
  let currentSessionId: SessionId | undefined
  let restored = false

  const broadcast = (msg: EngineMessage): void => {
    for (const port of ports) {
      try {
        port.postMessage(msg)
      } catch {
        ports.delete(port)
      }
    }
  }

  const post = (port: chrome.runtime.Port, msg: EngineMessage): void => {
    try {
      port.postMessage(msg)
    } catch {
      ports.delete(port)
    }
  }

  const broadcastError = (message: string): void => {
    broadcast({ t: 'error', message })
  }

  // ── titles (durable overrides in chrome.storage.local) ──

  const loadTitles = async (): Promise<void> => {
    if (!isStorageAvailable()) return
    try {
      const items = await chrome.storage.local.get(TITLES_KEY)
      const raw = items[TITLES_KEY] as Record<string, string> | undefined
      if (raw !== null && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw)) {
          if (typeof value === 'string' && value.length > 0) titleOverrides.set(key, value)
        }
      }
    } catch {
      // Titles are cosmetic; absence is non-fatal.
    }
  }

  const persistTitle = async (sessionId: SessionId, title: string): Promise<void> => {
    if (title === '') return
    titleOverrides.set(sessionId, title)
    if (!isStorageAvailable()) return
    try {
      const items = await chrome.storage.local.get(TITLES_KEY)
      const raw = (items[TITLES_KEY] ?? {}) as Record<string, string>
      raw[sessionId] = title
      // Bound the map: keep the newest 200 titles.
      const entries = Object.entries(raw)
      if (entries.length > 200) {
        const trimmed = Object.fromEntries(entries.slice(entries.length - 200))
        await chrome.storage.local.set({ [TITLES_KEY]: trimmed })
      } else {
        await chrome.storage.local.set({ [TITLES_KEY]: raw })
      }
    } catch {
      warn('保存会话标题失败')
    }
  }

  // ── summaries ──

  const liveFactsOf = (sessionId: SessionId): SummaryFacts | undefined => {
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) return undefined
    let updatedAt = session.header.createdAt
    let firstUserText = ''
    const liveEvents = session.snapshotEvents()
    for (const event of liveEvents) {
      if (event.time > updatedAt) updatedAt = event.time
      if (firstUserText === '' && event.type === 'user/message') {
        const message = event.data as { content?: Array<{ type?: string; text?: string }> }
        const text = (message.content ?? [])
          .filter(block => block.type === 'text')
          .map(block => block.text ?? '')
          .join(' ')
        firstUserText = titleFromText(text)
      }
    }
    return { eventCount: liveEvents.length, updatedAt, firstUserText }
  }

  const storedFactsOf = async (
    sessionId: SessionId,
    revision: string,
  ): Promise<SummaryFacts> => {
    const cached = factsCache.get(revision)
    if (cached !== undefined) return cached
    let facts: SummaryFacts = { eventCount: 0, updatedAt: 0, firstUserText: '' }
    try {
      const readHandle = await ctx.sessionPersistence.open(sessionId, 'read')
      const { events } = await readHandle.read()
      await readHandle.close()
      let updatedAt = 0
      let firstUserText = ''
      for (const event of events) {
        if (event.time > updatedAt) updatedAt = event.time
        if (firstUserText === '' && event.type === 'user/message') {
          const message = event.data as { content?: Array<{ type?: string; text?: string }> }
          const text = (message.content ?? [])
            .filter(block => block.type === 'text')
            .map(block => block.text ?? '')
            .join(' ')
          firstUserText = titleFromText(text)
        }
      }
      facts = { eventCount: events.length, updatedAt, firstUserText }
    } catch (err) {
      warn(`读取会话事件计数失败（${sessionId}）：`, errText(err))
    }
    factsCache.set(revision, facts)
    return facts
  }

  const listSummaries = async (): Promise<SessionSummary[]> => {
    const snapshots = await ctx.sessionPersistence.list()
    const summaries: SessionSummary[] = []
    for (const snapshot of snapshots) {
      const { header, revision } = snapshot
      const live = liveFactsOf(header.id)
      const facts = live ?? (await storedFactsOf(header.id, String(revision)))
      const title =
        titleOverrides.get(header.id) ??
        facts.firstUserText
      summaries.push({
        sessionId: header.id,
        title,
        createdAt: header.createdAt,
        updatedAt: facts.updatedAt || header.createdAt,
        eventCount: facts.eventCount,
      })
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt || a.createdAt - b.createdAt)
    return summaries
  }

  const broadcastSessions = async (): Promise<void> => {
    try {
      broadcast({ t: 'sessions', items: await listSummaries() })
    } catch (err) {
      warn('枚举会话失败：', errText(err))
      broadcastError(`枚举会话失败：${errText(err)}`)
    }
  }

  const currentRunning = (): { running: boolean; sessionId?: SessionId } => {
    const agent = currentSessionId === undefined ? undefined : ctx.agents.get(currentSessionId)
    if (agent === undefined) return { running: false }
    return { running: agent.status === 'running', sessionId: agent.id }
  }

  // ── agent lifecycle helpers ──

  const agentOptions = (): { provider: string; model: string } => ({
    provider: PROVIDER,
    model: currentEngineConfig().model,
  })

  /** The live agent for a session, or undefined. */
  const liveAgent = (sessionId: SessionId): Agent | undefined =>
    ctx.agents.get(sessionId)

  /**
   * Ensure a live agent for a persisted-or-known session: resume it (cold
   * recovery with synthetic closers through the native prepare path); create
   * nothing new — the caller decides identity.
   */
  const resumeAgent = async (sessionId: SessionId): Promise<Agent> => {
    const existing = liveAgent(sessionId)
    if (existing !== undefined) return existing
    const persisted = (await ctx.sessionPersistence.list()).some(
      snapshot => snapshot.header.id === sessionId,
    )
    if (!persisted) throw new Error(`会话 ${sessionId} 不存在`)
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: agentOptions(),
    })
    handles.set(sessionId, handle)
    return handle.agent
  }

  /** Create a fresh session + agent and make it current. */
  const createSession = async (title?: string): Promise<Agent> => {
    const sessionId = mintSessionId()
    const handle = await ctx.agents.create({
      sessionId,
      agentOptions: agentOptions(),
    })
    handles.set(sessionId, handle)
    currentSessionId = sessionId
    if (title !== undefined && title !== '') {
      await persistTitle(sessionId, title)
    }
    log(`已创建会话 ${sessionId}`)
    return handle.agent
  }

  /** The agent a prompt targets: the current one, or a brand-new session. */
  const ensurePromptAgent = async (): Promise<Agent> => {
    if (currentSessionId !== undefined) {
      const existing = liveAgent(currentSessionId)
      if (existing !== undefined) return existing
      return resumeAgent(currentSessionId)
    }
    return createSession()
  }

  // ── history ──

  const historyFrom = async (
    sessionId: SessionId,
    fromSeq: number,
  ): Promise<SerializedSessionEvent[]> => {
    const from = Math.max(0, Math.floor(fromSeq))
    let events: SessionEvent[] = []
    try {
      const readHandle = await ctx.sessionPersistence.open(sessionId, 'read')
      try {
        const stored = await readHandle.read(from)
        events = [...stored.events]
      } finally {
        await readHandle.close()
      }
    } catch {
      // Not persisted (fresh session) — the live log is the whole history.
    }
    const live = ctx.sessions.get(sessionId)
    if (live !== undefined) {
      const maxStored = events.at(-1)?.seq ?? from - 1
      for (const event of live.snapshotEvents()) {
        if (event.seq >= from && event.seq > maxStored) events.push(event)
      }
      events.sort((a, b) => a.seq - b.seq)
    }
    return events.map(serializeEvent)
  }

  // ── UiMessage handling ──

  const handleUiMessage = (port: chrome.runtime.Port, msg: UiMessage): void => {
    switch (msg.t) {
      case 'hello': {
        void (async () => {
          const running = currentRunning()
          post(port, {
            t: 'ready',
            running: running.running,
            sessions: await listSummaries().catch(() => []),
          })
        })()
        return
      }
      case 'session.list': {
        void broadcastSessions()
        return
      }
      case 'session.create': {
        void (async () => {
          if (msg.title === undefined) {
            await createSession()
          } else {
            await createSession(msg.title)
          }
          await broadcastSessions()
        })().catch((err: unknown) => {
          broadcastError(`创建会话失败：${errText(err)}`)
        })
        return
      }
      case 'session.select': {
        const sessionId = SessionId(msg.sessionId)
        currentSessionId = sessionId
        void (async () => {
          await resumeAgent(sessionId)
          await broadcastSessions()
        })().catch((err: unknown) => {
          warn(`恢复会话 ${sessionId} 失败：`, errText(err))
          broadcastError(`恢复会话失败：${errText(err)}`)
        })
        return
      }
      case 'session.history': {
        const sessionId = SessionId(msg.sessionId)
        const fromSeq = msg.fromSeq ?? 0
        void (async () => {
          const events = await historyFrom(sessionId, fromSeq)
          post(port, { t: 'history', sessionId, events, upToDate: true })
        })().catch((err: unknown) => {
          broadcastError(`读取会话历史失败：${errText(err)}`)
        })
        return
      }
      case 'prompt': {
        void (async () => {
          const agent = await ensurePromptAgent()
          currentSessionId = agent.id
          agent.followup(
            createUserMessage({
              content: [{ type: 'text', text: msg.text }],
              source: { kind: 'user' },
            }),
          )
          // First prompt of a session derives the durable title.
          if (!titleOverrides.has(agent.id)) {
            await persistTitle(agent.id, titleFromText(msg.text))
          }
          post(port, { t: 'prompt-accepted', sessionId: agent.id })
          void broadcastSessions()
        })().catch((err: unknown) => {
          broadcastError(`发送指令失败：${errText(err)}`)
        })
        return
      }
      case 'steer': {
        const agent = currentSessionId === undefined ? undefined : liveAgent(currentSessionId)
        if (agent === undefined) {
          broadcastError('当前没有可插话的运行中会话')
          return
        }
        agent.steer(
          createUserMessage({
            content: [{ type: 'text', text: msg.text }],
            source: { kind: 'user' },
          }),
        )
        return
      }
      case 'cancel': {
        const agent = currentSessionId === undefined ? undefined : liveAgent(currentSessionId)
        if (agent === undefined) return
        agent.cancel({ kind: 'user' })
        return
      }
      case 'status': {
        const running = currentRunning()
        post(port, {
          t: 'agent-status',
          sessionId: running.sessionId ?? currentSessionId ?? '',
          status: running.running ? 'running' : 'idle',
        })
        return
      }
      case 'settings.get': {
        void readEngineSettings()
          .then((settings) => {
            post(port, { t: 'settings', settings })
          })
          .catch((err: unknown) => {
            broadcastError(`读取设置失败：${errText(err)}`)
          })
        return
      }
      case 'settings.set': {
        void applySettings(msg.patch)
          .then((settings) => {
            post(port, { t: 'settings', settings })
          })
          .catch((err: unknown) => {
            broadcastError(`保存设置失败：${errText(err)}`)
          })
        return
      }
    }
  }

  /** Persist a settings patch; the API key routes through the credentials service. */
  const applySettings = async (patch: Partial<EngineSettings>): Promise<EngineSettings> => {
    if (patch.apiKey !== undefined) {
      if (patch.apiKey === '') {
        await ctx.credentials.unset(DEEPSEEK_API_KEY_REF)
      } else {
        await ctx.credentials.set(DEEPSEEK_API_KEY_REF, patch.apiKey)
      }
    }
    await writeEngineSettings(patch)
    return readEngineSettings()
  }

  // ── engine fact subscriptions ──

  ctx.on('session/event', (session, event) => {
    broadcast({ t: 'event', sessionId: session.id, event: serializeEvent(event) })
  })

  ctx.on('agent/status', ({ agent, status }) => {
    broadcast({
      t: 'agent-status',
      sessionId: agent.id,
      status,
      ...(status === 'running' ? { detail: agent.options.model } : {}),
    })
  })

  // ── Port management ──

  if (isChromeRuntimeAvailable()) {
    try {
      chrome.runtime.onConnect.addListener((port) => {
        if (port.name !== UI_PORT_NAME) return
        ports.add(port)
        port.onDisconnect.addListener(() => {
          ports.delete(port)
        })
        port.onMessage.addListener((message: unknown) => {
          if (typeof message !== 'object' || message === null) return
          const t = (message as { t?: unknown }).t
          if (typeof t !== 'string') return
          handleUiMessage(port, message as UiMessage)
        })
        // Immediate ready snapshot; the UI's own hello re-requests the rest.
        const running = currentRunning()
        post(port, {
          t: 'ready',
          running: running.running,
          sessions: [],
        })
      })
    } catch (err) {
      warn('注册 UI Port 监听失败：', errText(err))
    }
  }

  // ── agent-channel probe (watchdog liveness) ──

  /**
   * Whether ANY live agent is mid-turn — the watchdog's busy signal. Unlike
   * {@link currentRunning} this covers background sessions and subagents, so a
   * busy engine that is merely slow to answer still reports itself as running.
   */
  const anyEngineRunning = (): boolean =>
    ctx.agents.list().some(agent => agent.status === 'running')

  if (isChromeRuntimeAvailable()) {
    try {
      chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          (message as { channel?: unknown }).channel === AGENT_CHANNEL &&
          (message as { type?: unknown }).type === 'offscreen-ping'
        ) {
          sendResponse({ ok: true, running: anyEngineRunning() })
          return false
        }
        return false // foreign messages (CDP requests target the SW): passive
      })
    } catch (err) {
      warn('注册 offscreen-ping 监听失败：', errText(err))
    }
  }

  // ── startup recovery ──

  /** Bounded wait for the agent-loop's configured `main` startup (tracked past its fiber's apply). */
  const STARTUP_POLL_MS = 200
  const STARTUP_POLL_BUDGET_MS = 10_000

  const waitForStartupAgent = async (): Promise<void> => {
    const deadline = Date.now() + STARTUP_POLL_BUDGET_MS
    while (ctx.agents.roots().length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, STARTUP_POLL_MS))
    }
  }

  /**
   * Resume the most recently updated persisted session so the SidePanel can
   * continue where it left off; with no persisted history, adopt the one live
   * startup agent (the composition's pre-configured `main`). Idempotent: live
   * agents are never re-created, and the routine runs at most once per engine
   * lifetime. Called by the offscreen boot entry after `loader.await()`.
   */
  const restoreLatestSession = async (): Promise<void> => {
    if (restored) return
    restored = true
    await loadTitles()
    try {
      // The configured agent's restore-or-create runs asynchronously past its
      // fiber's apply: wait for it before touching the session list, or a
      // resume of the same session id would race its in-flight registration.
      await waitForStartupAgent()
      const summaries = await listSummaries()
      const latest = summaries[0]
      if (latest === undefined) {
        // First boot: no durable history yet — the agent-loop's pre-configured
        // `main` agent is the conversation target until the user switches.
        const [startupAgent] = ctx.agents.roots()
        if (startupAgent !== undefined) {
          currentSessionId = startupAgent.id
          log(`无历史会话，已采用启动代理 ${startupAgent.id}`)
        } else {
          log('没有可恢复的历史会话')
        }
        return
      }
      const existing = liveAgent(SessionId(latest.sessionId))
      const agent = existing ?? (await resumeAgent(SessionId(latest.sessionId)))
      currentSessionId = agent.id
      log(`已恢复最近会话 ${agent.id}（${latest.eventCount} 个事件）`)
    } catch (err) {
      warn('恢复最近会话失败：', errText(err))
    }
  }

  activeBridge = { restoreLatest: restoreLatestSession }
}
