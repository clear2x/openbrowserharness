/**
 * Extension background Service Worker (no DOM).
 *
 * Responsibilities:
 * - route `dsh-cdp` channel requests to the CDP operation dispatcher
 *   (asynchronous sendResponse, return true);
 * - answer `dsh-agent` channel commands: `ping` (self, for UI/diagnostics),
 *   `ensure_offscreen` (idempotent offscreen document creation),
 *   `offscreen-ping` (answered ONLY by the offscreen host — passively ignored
 *   here so the probe observes the engine, not our own echo);
 * - keep the Offscreen engine host alive: a 1-minute watchdog alarm pings the
 *   offscreen document (8s timeout) and rebuilds it only when it is truly
 *   dead — a ping miss shortly after an engine that reported a running agent
 *   is spared for a grace window, because dropping the document mid-turn is
 *   exactly what crash-orphans its in-flight tool calls into `interrupted`
 *   results on cold recovery;
 * - open the side panel on toolbar action clicks;
 * - mirror chrome.debugger.onDetach into the controller state.
 *
 * All listener registrations happen synchronously at the top level (SWs are
 * killed and restarted around events; listeners must exist in the first turn).
 */

import { AGENT_CHANNEL, isAgentCommand, isCdpRequest, isStorageRequest } from '../shared/protocol'
import type { AgentCommandResponse, CdpRequest, StorageRequest, StorageResponse } from '../shared/protocol'
import { cdpController } from './cdp'
import { notePanelWindow } from './dock'
import { executeCdpOp } from './ops'

const OFFSCREEN_URL = 'offscreen.html'
const WATCHDOG_ALARM = 'dsh-offscreen-watchdog'
const WATCHDOG_PING_TIMEOUT_MS = 8_000
/**
 * How long an engine that recently reported a running agent is spared from the
 * watchdog rebuild after a missed ping. A slow engine (LLM stream, large log
 * I/O, browser-process freeze under memory pressure) can miss one probe while
 * still making progress; dropping the document mid-turn orphans its open tool
 * calls, which cold recovery then closes as `interrupted`. Three minutes of
 * total silence means the engine is genuinely gone and the rebuild resumes it
 * from the durable log.
 */
const ENGINE_RUNNING_GRACE_MS = 180_000

/**
 * The time of the most recent pong that reported a live running agent (epoch
 * ms; 0 = never seen running). Drives the {@link ENGINE_RUNNING_GRACE_MS} spar.
 */
let lastEngineRunningAt = 0

function log(...args: unknown[]): void {
  console.log('[dsh-bg]', ...args)
}

function warn(...args: unknown[]): void {
  console.warn('[dsh-bg]', ...args)
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

// ───────────────────────── offscreen lifecycle ─────────────────────────

/** Whether the offscreen engine document currently exists. */
async function hasOffscreen(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    })
    return contexts.length > 0
  } catch (err) {
    warn('查询 offscreen 上下文失败：', errText(err))
    return false
  }
}

/**
 * Idempotently create the offscreen engine document. An "only one offscreen
 * document" error means it already exists and is swallowed.
 */
export async function ensureOffscreen(): Promise<boolean> {
  if (await hasOffscreen()) return true
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
      justification: 'dsh agent 长时任务运行时',
    })
    log('offscreen 引擎文档已创建')
    return true
  } catch (err) {
    if (/single offscreen|only one/i.test(errText(err))) return true
    warn('创建 offscreen 文档失败：', errText(err))
    return false
  }
}

/** Drop the offscreen document (before a watchdog rebuild). */
async function dropOffscreen(): Promise<void> {
  try {
    // @types/chrome 0.0.287 types closeDocument with no filter argument; an
    // extension can hold at most one offscreen document, so the argumentless
    // overload targets exactly ours.
    await chrome.offscreen.closeDocument()
  } catch {
    // Absent or racing teardown — the create below is the load-bearing step.
  }
}

/**
 * Probe the offscreen engine with a dedicated `offscreen-ping` on the agent
 * channel; resolves `alive` only when the ENGINE answered, plus whether the
 * engine reported any agent mid-turn at answer time.
 */
async function pingOffscreen(): Promise<{ alive: boolean; running: boolean }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (alive: boolean, running = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ alive, running })
    }
    const timer = setTimeout(() => finish(false), WATCHDOG_PING_TIMEOUT_MS)
    try {
      chrome.runtime.sendMessage(
        { channel: AGENT_CHANNEL, type: 'offscreen-ping' },
        (response: unknown) => {
          // Explicitly consume lastError (absence of a receiver, etc.).
          void chrome.runtime.lastError
          const r = response as AgentCommandResponse | undefined
          finish(r !== undefined && r.ok === true, r?.running === true)
        },
      )
    } catch {
      finish(false)
    }
  })
}

/** Watchdog step: probe the engine; rebuild only a truly dead one. */
async function watchdogCheck(): Promise<void> {
  if (!(await hasOffscreen())) {
    await ensureOffscreen()
    return
  }
  const probe = await pingOffscreen()
  if (probe.alive) {
    if (probe.running) lastEngineRunningAt = Date.now()
    return
  }
  // A missed ping right after an engine that was mid-turn is most likely a
  // slow or transiently frozen document, not a dead one — killing it would
  // crash-orphan its in-flight tool calls. Spare it for the grace window; a
  // genuinely dead engine goes quiet far past it and gets rebuilt.
  if (Date.now() - lastEngineRunningAt < ENGINE_RUNNING_GRACE_MS) {
    warn('offscreen 引擎 ping 超时，但近期有 agent 在运行，本轮跳过重建（宽限内）')
    return
  }
  warn('offscreen 引擎无响应，正在重建…')
  await dropOffscreen()
  await ensureOffscreen()
}

// ───────────────────────── message routing ─────────────────────────

function handleCdpRequest(message: CdpRequest, sendResponse: (response?: unknown) => void): void {
  void executeCdpOp(message.op, message.tabId, message.params ?? {})
    .then((response) => {
      sendResponse(response)
    })
    .catch((err: unknown) => {
      sendResponse({ ok: false, error: errText(err) })
    })
}

/** chrome.storage.local ops on behalf of contexts without storage bindings (offscreen). */
async function handleStorageRequest(message: StorageRequest): Promise<Record<string, unknown> | undefined> {
  switch (message.op) {
    case 'get': {
      const all = (await chrome.storage.local.get(null)) as Record<string, unknown>
      if (message.keys === null) return all
      const wanted: Record<string, unknown> = {}
      for (const key of message.keys) wanted[key] = all[key]
      return wanted
    }
    case 'set':
      await chrome.storage.local.set(message.items)
      return undefined
    case 'remove':
      await chrome.storage.local.remove(message.keys as never)
      return undefined
  }
}

// Rebroadcast committed storage changes so storage-deprived contexts stay live.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  void chrome.runtime.sendMessage({ channel: 'dsh-storage', kind: 'changed', area, changes }).catch(() => {
    // No listener (sidepanel closed, offscreen mid-restart): changes resync on next read.
  })
})

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (isStorageRequest(message)) {
    // Offscreen documents lack chrome.storage bindings; the SW owns storage.
    void handleStorageRequest(message)
      .then((data) => {
        sendResponse({ ok: true, ...(data === undefined ? {} : { data }) } satisfies StorageResponse)
      })
      .catch((err: unknown) => {
        sendResponse({ ok: false, error: errText(err) } satisfies StorageResponse)
      })
    return true // asynchronous sendResponse
  }
  if (isCdpRequest(message)) {
    handleCdpRequest(message, sendResponse)
    return true // asynchronous sendResponse
  }
  if (isAgentCommand(message)) {
    switch (message.type) {
      case 'ping':
        // Answered by the SW itself — a diagnostics surface for the UI.
        sendResponse({ ok: true } satisfies AgentCommandResponse)
        return false
      case 'ensure_offscreen':
        void ensureOffscreen()
          .then((ok) => {
            sendResponse({ ok } satisfies AgentCommandResponse)
          })
          .catch((err: unknown) => {
            sendResponse({ ok: false, error: errText(err) } satisfies AgentCommandResponse)
          })
        return true
      case 'offscreen-ping':
        // The offscreen engine owns this answer; stay passive.
        return false
      case 'panel-window':
        // The SidePanel's host window: browser ops dock the operated tab here.
        notePanelWindow(message.windowId)
        sendResponse({ ok: true } satisfies AgentCommandResponse)
        return false
    }
  }
  return false // foreign messages: no asynchronous response
})

// ───────────────────────── debugger session mirroring ─────────────────────────

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    cdpController.handleDetached(source.tabId)
  }
})

// ───────────────────────── watchdog alarm ─────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return
  void watchdogCheck().catch((err: unknown) => {
    warn('看门狗检查失败：', errText(err))
  })
})

try {
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 })
} catch (err) {
  warn('创建看门狗定时器失败：', errText(err))
}

// ───────────────────────── side panel & startup recovery ─────────────────────────

try {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
} catch (err) {
  warn('设置工具栏点击打开面板失败：', errText(err))
}

// First install / extension update: open the side panel so the user sees the
// UI immediately instead of hunting for the toolbar icon.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    void chrome.windows.getCurrent().then((w) => {
      if (w.id !== undefined) void chrome.sidePanel.open({ windowId: w.id }).catch(() => {})
    }).catch(() => {})
  }
})

// SW (re)start: re-adopt debugger sessions this extension still holds (the
// in-memory attach map was lost, the browser layer stayed attached), and make
// sure the engine document exists.
void (async () => {
  await cdpController.recoverFromBrowserState()
  await ensureOffscreen()
})().catch((err: unknown) => {
  warn('后台启动恢复失败：', errText(err))
})
