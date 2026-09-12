/**
 * `extension-ui-shell`: the extension-native root shell — replaces dsh's
 * ui-layout/ui-sidebar/ui-workspace trio (the desktop workspace chrome) with
 * an extension-panel layout:
 *
 *   ┌ header: tab selector (default = current tab) · session switcher ·      ┐
 *   │          new session · user plugins · settings   (2px run-line under   │
 *   │          it while busy)                                                │
 *   ├ view strip (对话 / 轨迹 — the SidePanel's conversation view tabs,        │
 *   │          rendered while the ui-trajectory plugin is up; 轨迹 mounts     │
 *   │          the shipped TrajectoryView over the shared Session window —   │
 *   │          see trajectory-host.tsx)                                      │
 *   ├ conversation (extension-native view over `session.history` RPC)        ┤
 *   ├ capability panel (the REAL dsh conversation slot tree, docked)         ┤
 *   ├ details (tool-call detail pane, opened from a transcript tool card;    ┤
 *   │          the user-plugin panel shares this aside, exclusive with it)   ┤
 *   └ composer (extension-native, sends over the same `dsh-api` Port)        ┘
 *
 * The plugin is registered as a STATIC module (the connection-module
 * precedent): the boot roster row carries the id, `registerStatic` wins over
 * any fetch, and no npm package is needed. It provides the `layout` service
 * (panel-action contract other plugins inject) and the theme presenter
 * ui-layout used to own, and declares the child slots the kept dsh UI
 * plugins render into:
 *   - 'sidebar.settings' (ui-settings-general SettingsRoot — trigger + panel
 *     ride one occupant, owner prop {wide}) — rendered in the header.
 *   - 'details' stays DECLARED (ui-conversation's DetailsPanel keeps its
 *     registration) but is not rendered: its content source is the plugin
 *     chat store the shell cannot write (see the Details aside paragraph).
 *   The 'conversation' slot stays DECLARED (ui-conversation still registers
 *   its occupant) but is no longer rendered as the panel's transcript: dsh's
 *   ConversationRoot draws its own transcript + composer, so rendering it
 *   wholesale would duplicate this file's ConversationView. Instead the
 *   capability panel below renders it DOCKED, with the duplicate transcript
 *   and duplicate composer bar hidden by CSS, exposing the regions that carry
 *   the shipped feature plugins.
 *
 * Capability panel (the conversation slot tree, docked above the composer):
 *   every conversation.* seat (`conversation.input.dock`, the composer
 *   takeover chain, `conversation.session.header.actions`/`.utilities`, …) is
 *   DECLARED by ui-conversation's own 'conversation' entry — "declaring is
 *   claiming" gives that entry the only renderSlot binding for the whole
 *   family, so the sanctioned way to surface its occupants is rendering
 *   `renderSlot('conversation', {})` itself. The panel hides the parts this
 *   shell already owns and keeps the rest live:
 *   - input docks: goal bar (ui-goal), todo strip + queue rows (ui-conversation);
 *   - plan chip: the plan-mode exit chip that survives the stripped dsh
 *     InputBar (renders only while the session is in plan mode);
 *   - session header: breadcrumbs + background-jobs / subagent-catalog
 *     actions (ui-jobs, ui-subagent) + log-export utility (dsh-session-log-export).
 *   Hidden as duplicates of shell-owned surfaces: the dsh transcript (the
 *   `conversation.session` body slot inside the scrollport — the shell
 *   renders its own ConversationView), the dsh InputBar's own composer (the
 *   shell ComposerBar is the visible sender; the bar stays MOUNTED so its
 *   input machine keeps feeding the docks, stripped to the plan/permission
 *   chip row), the answerable composer takeovers (approval / user questions /
 *   plan review / subagent read-only composer — the shell's InteractionCards
 *   answer the same engine waits over the mux tap), hero chrome, and view
 *   tabs.
 *   The seats are session-scoped: the shell bridges its session selection
 *   into the runtime (`ctx.sessions.open`, retried until the runtime list
 *   knows the id) and adopts runtime-initiated navigations (breadcrumb,
 *   subagent catalog) back into the shell state. Without the bridge the
 *   session-scoped entries render null — no dead regions, just absent ones.
 *   The section renders only while at least one dock/action/utility seat has
 *   an occupant, and collapses to a 工具 popover under 560 px (auto-inline
 *   while an approval/question wait is pending, so it can never hide behind
 *   a tap).
 *
 * Details aside: the 'details' slot occupant (ui-conversation's DetailsPanel)
 * reads its selection from the plugin-private chat store whose only writer is
 * the (hidden) ChatView — no sanctioned write path exists from this shell —
 * so the aside is shell-native instead: a transcript tool card's 详情 chip
 * opens it with that call's name, arguments, and output, driven by the same
 * layout contract (`layout.openDetails` / `closeDetails`).
 *
 * Conversation ergonomics layered on the raw log rendering:
 *   - assistant text blocks render as GFM Markdown (markdown-view.tsx);
 *   - the card-style composer sends on Cmd/Ctrl+Enter (Enter = newline) and
 *     interrupts a running turn on Esc; `/` lines execute as slash commands
 *     (`commands/execute`) whose durable flow nodes render as system rows,
 *     `//` escapes to a literal `/` prompt, and an unadmitted command falls
 *     back to a normal send with a notice;
 *   - while the composer text is a bare `/`-led command name, the SlashMenu
 *     (composer-bar.tsx) floats above the textarea with `commands/list` plus
 *     the shell-local `/export` filtered and keyboard-navigable — it only
 *     FILLS the input, the send pipeline above stays the execution path;
 *   - a word-bounded `@token` (line start or mid-message) floats the
 *     SubagentMenu with the session's continuable subagent children
 *     (`subagent.list`, one cached read per session); a send addressed
 *     `@名字 正文` routes through `subagent.prompt` to that child (body only,
 *     parent = this session), falling back to a normal send with a notice
 *     when the name resolves to nothing or the bridge refuses — the child's
 *     reply lives in its own session log, reachable via the capability
 *     panel's subagent catalog;
 *   - its toolbar (composer-bar.tsx) carries model switch, reasoning effort,
 *     context meter, and the send ⇄ stop button;
 *   - failed turns offer 重试 (last prompt per session) / 复制;
 *   - completed assistant replies offer hover 复制;
 *   - an empty transcript greets with example prompts that fill (not send).
 *
 * Tab targeting: the selector defaults to the CURRENT tab and follows tab
 * activation live; picking a tab activates it (chrome.tabs.update), which is
 * exactly the "target = active tab" semantics the engine's browser tools
 * already resolve per call.
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Brings the ctx.theme service typing + 'theme/change' event declaration.
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { MARKDOWN_CSS, MarkdownView } from './markdown-view.tsx'
import { rpc } from './rpc-client.ts'
import { POPOVER_CSS, usePopoverDismiss } from './popover.tsx'
import { ComposerBar, COMPOSER_CSS, dispatchSendLine, SlashMenu, SubagentMenu, useSubagents } from './composer-bar.tsx'
import { AttachmentStrip, ATTACHMENT_CSS, imagePromptParts, useComposerAttachments } from './composer-attachments.tsx'
import type { ModelGroup } from './composer-bar.tsx'
import { InteractionCards, INTERACTION_CARDS_CSS, useInteractionPendingCount } from './interaction-cards.tsx'
import { UserPluginPanel, USER_PLUGIN_PANEL_CSS } from './user-plugin-panel.tsx'
import { TrajectoryHost, useTrajectoryAvailable } from './trajectory-host.tsx'
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CopyIcon,
  GlobeIcon,
  HistoryIcon,
  PuzzleIcon,
  RetryIcon,
} from './icons.tsx'

// Slot declarations owned by THIS registrar (the root registration below
// declares these children; the replaced ui-layout/ui-sidebar rows used to
// carry the declarations — the declaring registrar owns them).
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** The conversation stream + composer (ui-conversation's ConversationRoot). */
    'conversation': { kind: 'single'; scope: 'session-maybe'; owner: Record<string, never> }
    /** Tool details pane (ui-conversation's DetailsPanel). */
    'details': { kind: 'single'; scope: 'session'; owner: Record<string, never> }
    /** Settings trigger + panel (ui-settings-general's SettingsRoot). */
    'sidebar.settings': { kind: 'single'; scope: 'root'; owner: { wide: boolean } }
    /** Frame-wide floating layer (badges, toasts). */
    'shell.overlay': { kind: 'list'; scope: 'root'; owner: Record<string, never> }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Panel-action contract (provided by this shell). */
    layout: {
      toggleSidebar(): void
      openDetails(): void
      closeDetails(): void
      /** Host-owned Session log export (returns false when the shell has none). */
      exportSessionLog?(sessionId: string): boolean
    }
    /**
     * Session-log export download controller (provided by the
     * `dsh-session-log-export` plugin; accessed guarded because that row is
     * lazy). Structural subset of its `SessionLogDownloadController`.
     */
    sessionLogDownload: { download(sessionId: string): Promise<void> }
  }
}

interface TabRow {
  id: number
  title: string
  url: string
  active: boolean
}

/** Module-scope context: slot components close over the owning plugin ctx. */
let shellCtx: ClientContext | undefined

/**
 * Module-scope exporter the dsh session-header chip routes through
 * (see the layout contract's `exportSessionLog`): the browser extension has
 * no HTTP host to stream the export ZIP from, so the shell owns the download
 * over the bridge RPC. Installed by the shell component on mount.
 */
let shellExport: ((sessionId: string) => boolean) | undefined

/** Body attribute selecting the dark base palette in the token stylesheets. */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/**
 * Global theme DOM applier — ui-layout's presenter, inlined (the plugin row
 * is dropped; the duty moved here). Pure DOM writes; retracts only what it
 * wrote itself.
 */
class ThemePresenter {
  private appliedTokens: string[] = []
  private readonly themeColorMeta: HTMLMetaElement

  constructor() {
    this.themeColorMeta = document.createElement('meta')
    this.themeColorMeta.name = 'theme-color'
  }

  apply(snapshot: { active: { colorScheme: string; tokens: Record<string, string> } }): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    const body = document.body
    if (scheme === 'dark') body.setAttribute(DARK_ATTRIBUTE, '')
    else body.removeAttribute(DARK_ATTRIBUTE)
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value)
      this.appliedTokens.push(name)
    }
    this.themeColorMeta.content = getComputedStyle(body).backgroundColor
    if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta)
  }

  dispose(): void {
    for (const name of this.appliedTokens) body_style().removeProperty(name)
    this.appliedTokens = []
    this.themeColorMeta.remove()
  }
}

function body_style(): CSSStyleDeclaration {
  return document.body.style
}

// ── layout service (panel-action contract; ui-conversation injects it) ──

/** One text extraction over the wire content shapes the transcript reads. */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as { type?: string; text?: string }
      return typeof b?.text === 'string' ? b.text : `[${String(b?.type ?? 'block')}]`
    })
    .join('\n')
}

/** One capped single line for non-prose events. */
function oneLine(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return text.length <= 300 ? text : `${text.slice(0, 299)}…`
}

/**
 * Render the durable log as readable markdown: prose events become sections,
 * tool/command events become quoted one-liners, anything else stays a typed
 * code line. The browser-download export keeps working without an HTTP host.
 */
function renderSessionMarkdown(entries: readonly unknown[]): string {
  const lines: string[] = ['# Session log', '']
  for (const entry of entries) {
    const e = entry as { seq?: number; type?: string; data?: Record<string, unknown> }
    const data = (e.data ?? {}) as Record<string, unknown>
    switch (e.type) {
      case 'user/message':
        lines.push('## 用户', '', blockText(data.content), '')
        break
      case 'assistant/message':
        lines.push('## 助手', '', blockText((data.message as Record<string, unknown> | undefined)?.content ?? data.content), '')
        break
      case 'tool/call':
        lines.push(`> 🔧 工具调用 \`${String(data.name ?? '')}\`：${oneLine(data.arguments ?? '')}`, '')
        break
      case 'tool/result':
        lines.push(`> ↩︎ 结果：${oneLine(data.content ?? data.result ?? data)}`, '')
        break
      case 'approval/asked':
      case 'approval/decided':
        break
      default:
        lines.push(`\`${String(e.type ?? 'event')}\` ${oneLine(data)}`, '')
    }
  }
  return `${lines.join('\n')}\n`
}

type LayoutListener = (open: boolean) => void

class ExtensionLayout {
  #open = false
  readonly #listeners = new Set<LayoutListener>()

  toggleSidebar(): void {
    // No sidebar in the extension shell; the contract method is a no-op.
  }

  openDetails(): void {
    this.#set(true)
  }

  closeDetails(): void {
    this.#set(false)
  }

  exportSessionLog(sessionId: string): boolean {
    return shellExport?.(sessionId) ?? false
  }

  isOpen(): boolean {
    return this.#open
  }

  subscribe(listener: LayoutListener): () => void {
    this.#listeners.add(listener)
    listener(this.#open)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #set(open: boolean): void {
    if (this.#open === open) return
    this.#open = open
    for (const listener of this.#listeners) listener(open)
  }
}

const layout = new ExtensionLayout()

// ── capability panel support (docked conversation slot tree) ──

/**
 * The conversation-family seats whose occupancy decides whether the
 * capability panel renders at all. Chain slots are excluded on purpose:
 * their entries register unconditionally and elect only while a wait is
 * pending, so ledger presence there is not an occupancy signal. Probed via
 * the plain-string `slots.snapshot` inspection face because the SlotMap
 * declarations of these keys live in ui-conversation's own compile
 * boundary, outside this program.
 */
const CAPS_SEATS: readonly string[] = [
  'conversation.input.dock',
  'conversation.session.header.actions',
  'conversation.session.header.utilities',
  'conversation.input.plan',
  'conversation.input.model',
  'conversation.composer.dock',
]

/** chrome.storage key of the persisted collapse preference (方案A). */
const CAPS_OPEN_STORAGE_KEY = 'dshx.caps.open'

/**
 * Natural body height (px) at or above which the docked tree counts as
 * "carries visible content" (方案B). Contentless docks render null and the
 * SHELL_CSS display:none's the transcript/composer halves, so everything
 * invisible measures 0; the smallest real seat (plan chip row) is far above.
 */
const CAPS_CONTENT_PX = 8

/**
 * Whether any capability seat has a live occupant (the empty-occupant
 * defense: no registrations → the whole panel stays unmounted instead of
 * rendering a blank strip). Re-reads on every seat's registration changes.
 */
export function useCapabilityOccupied(ctx: ClientContext | undefined): boolean {
  const [occupied, setOccupied] = useState(false)
  useEffect(() => {
    if (ctx === undefined) return undefined
    const slots = ctx.slots
    const read = (): void => {
      setOccupied(CAPS_SEATS.some(key => (slots.snapshot(key)[0]?.occupants.length ?? 0) > 0))
    }
    read()
    // The subscribe face is keyed by this program's SlotMap union; the seats
    // above are declared in ui-conversation's compile boundary, so the probe
    // subscribes through the same erased-string view snapshot() already takes.
    // The extracted face MUST be bound to `slots`: ctx.slots is a cordis
    // traceable proxy whose method faces rebind `this` only when invoked as a
    // method — a free call loses the receiver, and the SlotRegistry.subscribe
    // body then reads `_core` off `undefined` (or the page global) and throws
    // `TypeError: Cannot read properties of undefined (reading 'subscribe')`
    // during React effect commit, taking the whole shell down through the
    // root slot error boundary (white panel).
    const subscribe = (slots.subscribe as unknown as (this: unknown, key: string, fn: () => void) => () => void)
      .bind(slots)
    const offs = CAPS_SEATS.map(key => subscribe(key, read))
    return () => { for (const off of offs) off() }
  }, [ctx])
  return occupied
}

/**
 * Two-way session bridge between the shell's selection and the dsh runtime.
 *
 * Shell → runtime: session-scoped slot entries resolve only when the
 * runtime's current session is set, so every shell selection re-issues
 * `sessions.open` until the runtime list knows the id (a freshly created
 * session lands there via the host stream, hence the bounded retry).
 * Runtime → shell: navigations initiated inside slot panels (session
 * breadcrumbs, the subagent catalog) move the runtime current; those are
 * adopted back so the shell transcript follows.
 */
function useSessionBridge(ctx: ClientContext | undefined, sessionId: string, onRuntimeSelection: (id: string) => void): void {
  const adoptRef = useRef(onRuntimeSelection)
  adoptRef.current = onRuntimeSelection
  useEffect(() => {
    if (ctx === undefined) return undefined
    const sessions = ctx.sessions
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    const tryOpen = (): void => {
      const list = sessions.list.getSnapshot()
      if (list.current === sessionId) return
      if (list.byId[sessionId as SessionId] !== undefined) {
        try {
          sessions.open(sessionId as SessionId)
        } catch (error) {
          // select() throws only for an unknown id; a lost race against the
          // list refresh re-tries on the next publish.
          console.warn('session bridge: sessions.open failed', error)
        }
        return
      }
      tries += 1
      if (tries <= 8) timer = setTimeout(tryOpen, 1500)
    }
    tryOpen()
    const offList = sessions.list.subscribe(() => {
      const current = sessions.list.getSnapshot().current
      if (typeof current === 'string' && current !== sessionId) adoptRef.current(current)
    })
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      offList()
    }
  }, [ctx, sessionId])
}

/**
 * Number of pending interactions (approvals, questions) on the bridged
 * session's snapshot — drives the pending dot and the narrow-panel
 * force-inline rule. The session face materializes with the runtime window,
 * so attachment polls until the binding exists.
 */
function usePendingCount(ctx: ClientContext | undefined, sessionId: string): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (ctx === undefined) return undefined
    setCount(0)
    let off: (() => void) | undefined
    // Declared before the interval it clears: attach() self-stops the poll
    // once the session binding appears, so the assignment order is fixed.
    // oxlint-disable-next-line eslint/prefer-const
    let timer: ReturnType<typeof setInterval> | undefined
    const attach = (): void => {
      const binding = ctx.sessions.binding(sessionId as SessionId)
      if (binding === undefined) return
      const session = binding.session
      const read = (): void => { setCount(session.getSnapshot().pending.length) }
      read()
      off = session.subscribe(read)
      if (timer !== undefined) clearInterval(timer)
    }
    attach()
    timer = setInterval(attach, 1500)
    return () => {
      if (timer !== undefined) clearInterval(timer)
      off?.()
    }
  }, [ctx, sessionId])
  return count
}

/** Frozen material of one clicked tool card, rendered by the details aside. */
interface ToolDetail {
  /** Correlation id shared by the `tool/call` and `tool/result` pair. */
  readonly callId: string
  readonly name: string
  /** Model arguments, re-indented; '' when the call logged none. */
  readonly args: string
  /** Flattened text output; '' when the result carried none. */
  readonly result: string
  readonly ok: boolean
}

/**
 * The details aside body: the selected tool call's name, arguments, and
 * output. Shell-native by contract — see the module comment for why the
 * 'details' slot's own occupant cannot be driven from this shell.
 */
function ToolDetailsPanel({ detail, onClose }: { detail: ToolDetail | null; onClose: () => void }): JSX.Element {
  return (
    <div className="dshx-tooldetail">
      <div className="dshx-tooldetail-head">
        <span className="dshx-tooldetail-title">{detail?.name ?? '详情'}</span>
        <button type="button" className="dshx-iconbtn" aria-label="关闭详情" title="关闭详情" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      {detail === null
        ? <div className="dshx-tooldetail-empty">点击对话中工具卡片的「详情」，在这里查看它的输入与输出。</div>
        : (
          <div className="dshx-tooldetail-body">
            {detail.args !== '' && (
              <>
                <div className="dshx-tooldetail-label">输入</div>
                <pre className="dshx-pre">{detail.args}</pre>
              </>
            )}
            <div className="dshx-tooldetail-label">输出</div>
            {detail.result !== ''
              ? <pre className="dshx-pre">{detail.result}</pre>
              : <div className="dshx-tooldetail-empty">{detail.ok ? '（无文本输出）' : '（失败，无输出）'}</div>}
          </div>
        )}
    </div>
  )
}

/**
 * Narrow-panel (≤560 px) capability trigger: a slim 工具 row whose popover
 * carries the same docked slot tree. Pending waits surface as a dot so an
 * approval is never the only thing hidden behind the tap (the shell renders
 * this row only while nothing is pending — see ExtensionShell).
 */
function CapsToolsPopover({ children }: { children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const close = useCallback((): void => setOpen(false), [])
  const wrapRef = useRef<HTMLDivElement>(null)
  usePopoverDismiss(open, close, wrapRef)
  return (
    <div className="dshx-menuwrap" ref={wrapRef}>
      <button
        type="button"
        className="dshx-ghostbtn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(next => !next) }}
      >
        工具
        <ChevronDownIcon size={10} />
      </button>
      {open && <div className="dshx-pop dshx-pop--up dshx-caps-pop">{children}</div>}
    </div>
  )
}

// ── tab selector (chrome.tabs direct; the SidePanel has full API access) ──

async function queryTabs(): Promise<TabRow[]> {
  const tabs = await chrome.tabs.query({ currentWindow: true })
  return tabs
    .filter(tab => tab.id !== undefined)
    .map(tab => ({
      id: tab.id as number,
      title: tab.title ?? '',
      url: tab.url ?? '',
      active: tab.active === true,
    }))
}

function useTabs(): { tabs: TabRow[]; refresh: () => void; select: (id: number) => void } {
  const [tabs, setTabs] = useState<TabRow[]>([])
  const refresh = (): void => {
    void queryTabs().then(setTabs).catch(() => {})
  }
  const select = (id: number): void => {
    void chrome.tabs.update(id, { active: true }).catch(() => {})
    refresh()
  }
  useEffect(() => {
    refresh()
    const onActivated = (): void => refresh()
    const onUpdated = (): void => refresh()
    const onRemoved = (): void => refresh()
    chrome.tabs.onActivated.addListener(onActivated)
    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.tabs.onRemoved.addListener(onRemoved)
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.tabs.onRemoved.removeListener(onRemoved)
    }
  }, [refresh])
  return { tabs, refresh, select }
}

/**
 * Error boundary around dsh-provided slot subtrees. Several dsh panels call
 * host-only services (e.g. dynamicCordisRunner/syncInspectManifest) during
 * render; in the extension those refuse, and without this boundary one failed
 * provider unmounts the whole shell (white panel). Degrade to a quiet notice
 * instead — the rest of the shell keeps working.
 */
class SlotErrorBoundary extends Component<
  { children: ReactNode; label: string },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.warn('[extension-shell]', `${this.props.label} 渲染失败，已降级：`, error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="dshx-slot-fallback">该面板在扩展宿主中暂不可用。</div>
      )
    }
    return this.props.children
  }
}

// ── conversation view (extension-native; replaces dsh's ConversationRoot) ──

/** One content block off the durable log, as this view reads it (all-optional wire view). */
interface BlockData {
  type?: string
  text?: string
  /** tool-call block: provider call id + tool name + raw JSON arguments. */
  id?: string
  name?: string
  arguments?: string
  /** tool-result block: pairs with the `tool/call` carrying the same id. */
  toolCallId?: string
  isError?: boolean
  content?: BlockData[]
}

/** Event `data` payload fields this view consumes (wire view of `SessionEventMap`). */
interface EventData {
  /** `user/message`: the message's blocks directly on the event. */
  content?: BlockData[]
  /** `user/message`: durable attribution — plugin injections skip the chat flow. */
  source?: { kind?: string; plugin?: string }
  /** `assistant/message` / `tool/result`: blocks ride a nested message object. */
  message?: { content?: BlockData[] }
  /** `tool/call`: correlation + display identity. */
  callId?: string
  name?: string
  /** `tool/call`: raw JSON arguments string. */
  arguments?: string
  /** `tool/result`: present iff the tool failed structurally. */
  error?: unknown
  /** `turn/end`: why the turn closed. */
  reason?: { kind?: string; error?: { message?: string } }
  /** `command/run` / `command/done`: lifecycle pairing id. */
  commandId?: string
  /** `command/run`: verbatim text after the command name (separator included). */
  args?: string
  /** `command/done`: the handler's settled kind. */
  kind?: string
  /** `command/done`: the handler's verbatim outcome text. */
  text?: string
}

/** Settled outcome of one `command/run` row, keyed by its commandId. */
interface CommandDoneView {
  kind?: string
  text?: string
}

/** One `session.history` row: the event wrapped as `{ event }` by the bridge. */
interface SessionEventData {
  event: { type: string; seq: number; data?: EventData }
}

/** `session.history` ok value (wire view). */
interface HistoryValue {
  events?: SessionEventData[]
}

/**
 * Relative-time label for a history row (`updatedAt` epoch ms; seconds-scale
 * values are normalized). Future-skew clamps to 刚刚.
 *
 * @param updatedAt - persisted timestamp, possibly missing or mis-scaled.
 * @returns '刚刚' / 'N分钟前' / 'N小时前' / 'N天前' / 'MM-DD' / '' when unknown.
 */
function formatRelative(updatedAt: number | undefined): string {
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return ''
  const ms = updatedAt < 1e12 ? updatedAt * 1000 : updatedAt
  const diff = Math.max(0, Date.now() - ms)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}天前`
  const date = new Date(ms)
  const monthDay = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return date.getFullYear() === new Date().getFullYear() ? monthDay : `${date.getFullYear()}-${monthDay}`
}

/** Display label for a session id: short ids verbatim, long ids head-truncated. */
function shortSessionLabel(sessionId: string): string {
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 8)}…`
}

/**
 * Map `tool/call` callIds to their display identity so `tool/result` cards
 * (which carry only the correlation id) can name the invoked tool and the
 * details aside can show its arguments.
 */
function callIndex(events: readonly SessionEventData[]): Map<string, { name: string; arguments: string }> {
  const calls = new Map<string, { name: string; arguments: string }>()
  for (const row of events) {
    const ev = row.event
    if (ev.type !== 'tool/call') continue
    const d = ev.data
    if (typeof d?.callId === 'string' && typeof d.name === 'string') {
      calls.set(d.callId, { name: d.name, arguments: d.arguments ?? '' })
    }
  }
  return calls
}

/**
 * Pair `command/done` outcomes to their `command/run` rows by commandId (the
 * `command/run` row owns the card; `command/done` supplies its verdict).
 */
function commandIndex(events: readonly SessionEventData[]): Map<string, CommandDoneView> {
  const done = new Map<string, CommandDoneView>()
  for (const row of events) {
    const ev = row.event
    if (ev.type !== 'command/done') continue
    const d = ev.data
    if (typeof d?.commandId === 'string') {
      done.set(d.commandId, {
        ...(d.kind === undefined ? {} : { kind: d.kind }),
        ...(d.text === undefined ? {} : { text: d.text }),
      })
    }
  }
  return done
}

/** Re-indent model-produced JSON arguments; non-JSON falls back verbatim. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    // Model arguments are raw strings; parse failure keeps them as-is.
    return raw
  }
}

/** Collapse whitespace and ellipsize to one summary line. */
function summarize(text: string, max = 160): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

// Icons draw from icons.tsx (one home per SVG path, shared with the composer bar).

// ── clipboard chip (shared by reply copy + error copy) ──

/**
 * Small action chip writing `getText()` to the clipboard, flipping to a
 * transient check state on success. Clipboard denial degrades silently —
 * the chip just snaps back to its idle label.
 */
function CopyChip({ label, copiedLabel, getText }: { label: string; copiedLabel: string; getText: () => string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="dshx-chipbtn"
      title={copied ? copiedLabel : label}
      onClick={() => {
        void navigator.clipboard.writeText(getText()).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        }).catch(() => {})
      }}
    >
      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      <span>{copied ? copiedLabel : label}</span>
    </button>
  )
}

// ── stylesheet ──

/**
 * Shell stylesheet. The SidePanel is its own document, so the panel width IS
 * the viewport width — plain media queries give the responsive behavior
 * (narrow panels hide the title, shrink the model picker, and turn the
 * details pane into a floating overlay instead of squeezing the transcript).
 * Type ladder: 15 (headlines) / 13 (body) / 12 (meta) px; every spacing sits
 * on a 4-px step; surfaces and text come from `--dsw-alias-*` tokens so
 * light/dark stay paired.
 *
 * ── Responsive breakpoints (CENTRAL TABLE; the SidePanel document makes the
 *    panel width the viewport width, so plain media queries suffice) ────────
 *   ≤768 px  panel-slim: the details pane becomes a floating overlay over the
 *            transcript instead of squeezing it (`.dshx-details`);
 *   ≤560 px  header declutters (tighter gap/padding); the composer drops its
 *            right-side keyboard hint text (COMPOSER_CSS);
 *   ≤430 px  compact tier: header padding tightens, the effort segment sheds
 *            its 思考 keyword (leaving single-character segments), chip/model
 *            labels truncate harder, welcome card spacing shrinks (this sheet
 *            + COMPOSER_CSS carry the ≤430 rules together);
 *   ≤360 px  last-resort floor: the model badge collapses to icon-only so the
 *            toolbar can never push the send/stop button out of the card
 *            (COMPOSER_CSS).
 *
 *   Button discipline (every sheet): operation buttons pin one-line labels
 *   (`white-space:nowrap`, ellipsis on overflow) — ghost/chip/segment/example
 *   buttons, the caps toggle, and the details-aside chips; text-bearing rows
 *   (`dshx-error-actions`) wrap as whole buttons. Icon-only buttons
 *   (`dshx-iconbtn`/`dshx-send`/`dshx-stop`) need no rule. Ask-option cards
 *   keep the description wrappable (content, not a label) — see
 *   INTERACTION_CARDS_CSS.
 *
 * Exported so the caps-CSS regression tests can pin the hide rules.
 */
export const SHELL_CSS = `
.dshx-root{display:flex;flex-direction:column;height:100vh;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#171717)}
.dshx-slot-fallback{padding:10px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary,#999);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));border-radius:8px}
.dshx-header{position:relative;z-index:40;display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));flex:0 0 auto}
.dshx-select{min-width:0;height:28px;padding:0 8px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:transparent;color:inherit;outline:none;cursor:pointer;text-overflow:ellipsis;transition:border-color .15s ease,background .15s ease}
.dshx-select:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04))}
/* Tab selector shrinks first and never forces the row wider than the panel:
   min-width:0 lets flexbox shrink below content width (native <select> clips). */
.dshx-tab{flex:1 1 auto;min-width:0}
.dshx-iconbtn{flex:none;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#888);cursor:pointer;padding:0;transition:background .15s ease,color .15s ease,transform .1s ease}
.dshx-iconbtn:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#333)}
.dshx-iconbtn:active{transform:scale(.92)}
.dshx-iconbtn svg{display:block}
.dshx-iconbtn .dshx-chev{margin-left:-4px;color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-ghostbtn{border:none;background:transparent;cursor:pointer;height:28px;padding:0 8px;font-size:12px;line-height:28px;white-space:nowrap;color:var(--dsw-alias-label-secondary,#888);border-radius:8px;transition:background .15s ease,color .15s ease}
.dshx-ghostbtn:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#333)}
/* settings mount: anchors the SettingsRoot trigger in the header row (the
   dialog itself is viewport-fixed at z 1000 and styled by its own package —
   ui-settings-general full-bleeds its sheet at ≤768px, so no class-stem
   overrides live here). */
.dshx-settingsmount{flex:none;display:flex;align-items:center}
/* Floating-layer look lives in popover.tsx (POPOVER_CSS): SessionMenu and the
   composer's model/context popovers share one offset/radius/shadow/animation.*/
.dshx-loading{padding:48px 0 0;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#aaa)}
/* running indicator: 2px flowing gradient hairline under the header */
.dshx-runline{position:relative;height:2px;overflow:hidden;flex:none;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 14%,transparent)}
.dshx-runline::before{content:'';position:absolute;top:0;bottom:0;left:-45%;width:45%;background:linear-gradient(90deg,transparent,var(--dsw-alias-brand-primary,#4c7dfd),transparent);animation:dshx-flow 1.15s cubic-bezier(.45,0,.55,1) infinite}
@keyframes dshx-flow{to{transform:translateX(322%)}}
@media (prefers-reduced-motion:reduce){.dshx-runline::before{animation:none;left:35%}}
.dshx-body{display:flex;flex:1;min-height:0;position:relative}
.dshx-main{flex:1;min-width:0;display:flex;flex-direction:column}
.dshx-scroll{flex:1;overflow-y:auto;padding:12px 16px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.35)) transparent}
.dshx-details{width:340px;flex:0 0 340px;overflow:auto;border-left:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
@media (max-width: 768px){
  .dshx-details{position:absolute;top:0;right:0;bottom:0;width:min(320px,88%);flex:none;z-index:30;box-shadow:-8px 0 24px rgba(0,0,0,.18);background:var(--dsw-alias-bg-base,#fff)}
}
@media (max-width: 560px){
  .dshx-header{gap:5px;padding:8px 10px}
}
@media (max-width: 430px){
  .dshx-header{gap:4px;padding:8px}
  /* welcome guidance stays reachable at phone widths */
  .dshx-welcome{padding:36px 12px 16px;gap:10px}
  .dshx-welcome-sub{max-width:240px}
  .dshx-example{padding:7px 10px}
  .dshx-scroll{padding:10px 12px}
  .dshx-composer{padding:6px 8px 8px}
}
/* document-level scrollbars, ultra-thin */
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-corner{background:transparent}
::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.32));border-radius:10px;border:3px solid transparent;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background-color:var(--dsw-alias-scrollbar-hover-l2,rgba(127,127,127,.5))}
/* transcript bubbles */
.dshx-userrow{display:flex;justify-content:flex-end;margin:12px 0}
/* view strip — the SidePanel's conversation view tabs (对话 / 轨迹), the
   counterpart of the desktop conversation header's tab ring. Slim segmented
   row above the transcript area; hidden entirely while ui-trajectory has no
   ring entry (the strip would be a dead control). */
.dshx-viewstrip{display:flex;gap:4px;padding:8px 16px 0;flex:none}
.dshx-viewtab{border:none;background:transparent;cursor:pointer;height:24px;padding:0 10px;border-radius:8px;font-size:12px;line-height:24px;white-space:nowrap;color:var(--dsw-alias-label-secondary,#888);transition:background .15s ease,color .15s ease}
.dshx-viewtab:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#333)}
.dshx-viewtab.is-active{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.07));color:var(--dsw-alias-label-primary,#171717);font-weight:600}
/* trajectory host: bounded-height column for the view's fixed-height root
   (ui-trajectory's css.root is height:100% + its own inner virtual scroller). */
.dshx-trajectory{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.dshx-trajectory--loading{align-items:center;justify-content:center;padding:32px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-userbubble{max-width:85%;padding:8px 12px;border-radius:14px;border-bottom-right-radius:4px;background:var(--dsw-alias-brand-primary,#4c7dfd);color:#fff;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.dshx-assistant{position:relative;margin:12px 0;font-size:13px;display:flex;flex-direction:column;gap:8px}
.dshx-msgactions{opacity:0;margin-top:-4px;display:flex;transition:opacity .15s ease}
.dshx-assistant:hover>.dshx-msgactions,.dshx-assistant:focus-within>.dshx-msgactions{opacity:1}
/* collapsible cards: reasoning / tool-call / tool-result */
.dshx-card{margin:0;padding:4px 8px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}
.dshx-res{--edge:var(--dsw-alias-state-success-primary,#16a34a);border-left:3px solid var(--edge);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04))}
.dshx-res.iserr{--edge:var(--dsw-alias-state-error-primary,#dc2626)}
.dshx-summary{cursor:pointer;user-select:none;list-style:none;display:flex;align-items:center;gap:8px;min-width:0;padding:4px;border-radius:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#888);transition:background .15s ease}
.dshx-summary::-webkit-details-marker{display:none}
.dshx-summary:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05))}
.dshx-summary-name{flex:none;font-weight:600;color:inherit}
.dshx-summary-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit}
.dshx-chevron{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary,#aaa);transition:transform .15s ease}
details[open]>.dshx-summary .dshx-chevron{transform:rotate(90deg)}
.dshx-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--edge,var(--dsw-alias-label-tertiary,#aaa))}
.dshx-reason{font-size:12px;line-height:1.6;white-space:pre-wrap;color:var(--dsw-alias-label-secondary,#888);padding:4px}
.dshx-pre{margin:8px 0 4px;padding:8px;border-radius:8px;font-size:11px;line-height:1.5;background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.08));white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary,#333)}
/* failed turn card + its actions */
.dshx-error{margin:12px 0;padding:8px 12px;border-radius:10px;display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:1.6;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 8%,transparent);color:var(--dsw-alias-state-error-primary,#dc2626)}
.dshx-error-text{white-space:pre-wrap;word-break:break-word}
.dshx-error-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.dshx-chipbtn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:none;border-radius:8px;background:transparent;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary,#888);white-space:nowrap;transition:background .15s ease,color .15s ease}
.dshx-chipbtn:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#333)}
.dshx-chipbtn.iserr{color:var(--dsw-alias-state-error-primary,#dc2626)}
.dshx-chipbtn.iserr:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 12%,transparent)}
/* admitted slash command: system-feedback row (the durable flow node) */
.dshx-command{display:flex;align-items:baseline;gap:8px;margin:12px 0;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));font-size:12px;line-height:1.5}
.dshx-command-name{flex:none;font-weight:600;color:var(--dsw-alias-label-secondary,#888);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dshx-command-result{flex:1 1 auto;min-width:0;word-break:break-word;color:var(--dsw-alias-label-primary,#333)}
.dshx-command.iserr .dshx-command-result{color:var(--dsw-alias-state-error-primary,#dc2626)}
/* transient fallback hint inside the composer card */
.dshx-composer-notice{margin:8px 12px 0;padding:5px 10px;border-radius:8px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#888);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}
/* empty-state welcome */
.dshx-welcome{display:flex;flex-direction:column;align-items:center;gap:12px;padding:56px 16px 24px;text-align:center}
.dshx-welcome-glyph{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,var(--dsw-alias-brand-primary,#4c7dfd),color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 55%,#9b5cff))}
.dshx-welcome-title{font-size:15px;font-weight:700}
.dshx-welcome-sub{max-width:280px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#888)}
.dshx-examples{display:flex;flex-direction:column;gap:8px;width:100%;max-width:320px;margin-top:8px}
.dshx-example{padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;background:transparent;cursor:pointer;text-align:left;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#666);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:border-color .15s ease,background .15s ease,color .15s ease}
.dshx-example:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 6%,transparent);color:var(--dsw-alias-label-primary,#171717)}
.dshx-welcome-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#aaa)}
/* composer — card-style input card: two stacked zones (textarea above, the
   ComposerBar toolbar below a hairline), 14 px radius, one subtle border that
   turns brand-colored with a soft halo on focus, and an ambient (non-glowing)
   drop shadow. The whole card reads one step lighter than the canvas via
   bg-layer-1. Popovers anchored inside must NOT be clipped → no overflow cut. */
.dshx-composer{flex:0 0 auto;padding:8px 12px 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.dshx-capsule{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:14px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));box-shadow:0 1px 2px rgba(15,18,26,.04),0 4px 14px rgba(15,18,26,.05);transition:border-color .15s ease,box-shadow .15s ease}
.dshx-capsule:focus-within{border-color:var(--dsw-alias-brand-primary,#4c7dfd);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 14%,transparent),0 1px 2px rgba(15,18,26,.04)}
.dshx-inputwrap{padding:9px 12px 5px}
.dshx-input{display:block;width:100%;max-height:160px;min-height:20px;resize:none;border:none;background:transparent;color:inherit;font-size:13px;line-height:20px;padding:0;outline:none;font-family:inherit}
.dshx-input::placeholder{color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-send{flex:0 0 auto;width:32px;height:32px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;background:var(--dsw-alias-brand-primary,#4c7dfd);transition:background .15s ease,transform .1s ease,filter .15s ease}
.dshx-send:disabled{cursor:default;background:var(--dsw-alias-bg-layer-3,#c8c8c8);color:var(--dsw-alias-bg-base,#fff);opacity:.6}
.dshx-send:not(:disabled):hover{filter:brightness(.94)}
.dshx-send:not(:disabled):active{transform:scale(.92)}
.dshx-send svg{display:block}
.dshx-stop{flex:0 0 auto;width:32px;height:32px;border-radius:50%;border:1.5px solid var(--dsw-alias-state-error-primary,#dc2626);color:var(--dsw-alias-state-error-primary,#dc2626);background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;transition:background .15s ease}
.dshx-stop:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 10%,transparent)}
.dshx-stop-square{width:10px;height:10px;border-radius:2px;background:currentColor}
/* capability panel — the docked dsh conversation slot tree (see the module
   comment). The section owns only the frame; everything inside is dsh's own
   components at their own styles. The hide rules below remove exactly the
   regions this shell renders natively elsewhere, addressed through the
   framework's slot anchors ([data-slot=...]), component data attributes,
   and css-module class STEMS (the load-bearing convention of boot.ts
   debranding). */
.dshx-caps{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03)) 45%,transparent)}
.dshx-caps-head{display:flex;align-items:center;padding:4px 10px 2px}
.dshx-caps-toggle{display:inline-flex;align-items:center;gap:5px;flex:1 1 auto;min-width:0;border:none;background:transparent;cursor:pointer;padding:5px 8px;margin-left:-4px;border-radius:8px;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;transition:background .15s ease,color .15s ease}
.dshx-caps-toggle:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#888)}
.dshx-caps-toggle:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsh-alias-brand-primary,#4c7dfd) 30%,transparent)}
.dshx-caps-label{overflow:hidden;text-overflow:ellipsis}
.dshx-caps-toggle.is-pending,.dshx-caps-toggle.is-pending:hover{color:var(--dsw-alias-state-warning-primary,#f59e0b)}
.dshx-caps-chev{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary,#aaa);transition:transform .18s ease,color .18s ease}
.dshx-caps-toggle:hover .dshx-caps-chev{color:var(--dsw-alias-label-secondary,#888)}
.dshx-caps-chev.is-closed{transform:rotate(-90deg)}
.dshx-caps-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warning-primary,#f59e0b);animation:dshx-caps-pulse 1.6s ease-out infinite}
@keyframes dshx-caps-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f59e0b) 45%,transparent)}70%,100%{box-shadow:0 0 0 6px transparent}}
.dshx-caps-body{padding:2px 12px 10px;animation:dshx-caps-in .16s ease}
@keyframes dshx-caps-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
/* 用户气泡：暗色下出厂的 neutral-bluish-850（近黑）在侧栏里读作一团黑块，
   且与页面底色几乎无法区分。改用品牌蓝在暗底上调制的深蓝气泡——既与发送
   按钮/品牌色呼应，又保持足够对比度承托浅色文字。亮色主题保持出厂浅蓝。
   重定义必须落在 body 级：对话气泡由会话转录渲染，不在能力面板
   （.dshx-caps-body）子树内，scoped 覆盖够不着它。 */
body[data-ds-dark-theme]{
  --dsw-specific-bubble:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 26%,var(--dsw-static-neutral-bluish-850));
}
@media (prefers-reduced-motion:reduce){.dshx-caps-dot{animation:none}.dshx-caps-body{animation:none}}
/* time-context readings are model-facing only: the rows stay in the session
   log and the trajectory view (the audit surface), while the chat flow
   conceals them — each reading renders as a collapsed context row that has
   no actionable surface. The rule keys on the durable producer name the seat
   projects, never a client-side plugin table. */
[data-chat-flow-producer="time-context"]{display:none!important}
/* idle-empty strip (方案B): out of flow + invisible while the measured body
   stays mounted inside; never display:none, which would zero the measurement */
.dshx-caps.is-hidden{position:absolute;visibility:hidden;pointer-events:none}
/* collapsed clamp: clips the mounted tree without unmounting it */
.dshx-caps-body.is-collapsed{max-height:0;overflow:hidden;padding-top:0;padding-bottom:0}
/* The dsh subagent catalog popup anchors downward from the caps header —
   the bottom edge of the panel in this host — so it renders clipped to
   nothing. The menu carries a stable data hook; flip it upward here. */
.dshx-caps-body [data-catalog-menu]{top:auto;bottom:calc(100% + 5px);max-height:min(340px,42vh)}
/* dsh transcript duplicate — the shell renders its own ConversationView.
   Scoped to the session-body slot INSIDE the scrollport: the composer seat
   (docks, plan chip) rides the same scrollport and must stay live. */
.dshx-caps-body [data-slot="conversation.session"]{display:none!important}
/* The hidden transcript empties the scrollport; drop its authored gutter
   reservation and undo the hero-phase centering so the seat sits at the top. */
.dshx-caps-body [data-conversation-scroll]{scrollbar-gutter:auto!important;justify-content:flex-start!important}
/* hero chrome (blank-session phase): no workspace picker in the extension.
   HeroShell is the composerStack's root-classed direct child. */
.dshx-caps-body [class*="heroGlow"]{display:none!important}
.dshx-caps-body [class*="heroWorkspaceRow"]{display:none!important}
.dshx-caps-body [class*="composerStack"] > [class*="root"]{display:none!important}
.dshx-caps-body [class*="composerHero"]{align-self:stretch;width:auto;padding-bottom:0}
/* dsh answerable takeovers (approval / user questions / plan review /
   subagent read-only composer): the shell's InteractionCards answer the same
   engine waits over the mux tap, so a second answerable surface would race
   them. Direct children of the composer slot other than the framework's own
   fallback anchor are exactly the elected overlays. */
.dshx-caps-body [data-slot="conversation.composer"] > :not([data-chain-overlay-fallback]){display:none!important}
/* dsh InputBar duplicate — the shell ComposerBar is the visible sender. The
   bar must stay MOUNTED (its input machine feeds the docks), so its parts
   are stripped instead of the whole wrapper: the draft scrollport, the
   attach/+ and model/send chrome, notices, the permission chip, and the
   stats line. The plan-mode chip seat survives, aligned with the dock cards
   (row side pads = the dock inset pair). */
.dshx-caps-body [data-slot="conversation.composer.bar"] [data-input-scroll]{display:none!important}
.dshx-caps-body [data-slot="conversation.composer.bar"] [class*="trailing"]{display:none!important}
.dshx-caps-body [data-slot="conversation.composer.bar"] [class*="add"]{display:none!important}
.dshx-caps-body [data-slot="conversation.composer.bar"] [class*="accessory"]{display:none!important}
.dshx-caps-body [data-slot="conversation.composer.bar"] [class*="attachments"]{display:none!important}
.dshx-caps-body [data-slot="conversation.composer.bar"] [class*="notice"]{display:none!important}
.dshx-caps-body [data-slot="conversation.composer.bar"] [class*="trigger"]{display:none!important}
.dshx-caps-body [data-slot="conversation.composer.dock"]{display:none!important}
.dshx-caps-body [data-composer-card]{border:none;background:transparent;box-shadow:none;padding-top:0;gap:0}
.dshx-caps-body [data-slot="conversation.composer.bar"] [class*="row"]{padding:2px 16px 0}
/* the queue dock tucks under the input card by a negative margin; with the
   card stripped, the plain stack gap reads better */
.dshx-caps-body [class*="dock"]{margin-bottom:0!important}
/* dock cards (goal bar, todo strip, queue) carry the web composer's card
   width math — clearance/inset calc, capped max-width, auto margins. This
   host mounts the dock column in a plain full-width stack, so stretch every
   card (and the goal bar's inner pill) to the body width instead. */
.dshx-caps-body [data-testid="todo-panel"],
.dshx-caps-body [data-goal-bar],
.dshx-caps-body [data-goal-bar] > *,
.dshx-caps-body [class*="dock"]{
  box-sizing:border-box;width:100%;max-width:none;margin:0!important
}
/* view-tab ring: its targets (dsh transcript views) are hidden, so the tabs
   would be dead controls. */
.dshx-caps-body [class*="tabs"]{display:none!important}
/* narrow tier: slim one-row trigger + popover carrying the same body */
.dshx-caps--slim{display:flex;justify-content:flex-end;padding:2px 8px}
.dshx-caps-pop{width:min(440px,calc(100vw - 16px));padding:0 4px 4px}
.dshx-caps-pop .dshx-caps-body{max-height:56vh;overflow-y:auto;padding:0 8px 8px}
/* shell-native tool detail aside (the 'details' slot occupant needs the dsh
   chat store's selection, writable only from the hidden ChatView) */
.dshx-tooldetail{display:flex;flex-direction:column;height:100%;min-height:0}
.dshx-tooldetail-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.dshx-tooldetail-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}
.dshx-tooldetail-body{padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.dshx-tooldetail-label{font-size:11px;letter-spacing:.4px;color:var(--dsw-alias-label-tertiary,#999)}
.dshx-tooldetail-empty{padding:16px 12px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#aaa)}
/* unified keyboard focus ring */
.dshx-select:focus-visible,.dshx-iconbtn:focus-visible,.dshx-ghostbtn:focus-visible,.dshx-chipbtn:focus-visible,.dshx-chip:focus-visible,.dshx-segbtn:focus-visible,.dshx-example:focus-visible,.dshx-menuitem:focus-visible,.dshx-send:focus-visible,.dshx-stop:focus-visible,.dshx-caps-toggle:focus-visible,.dshx-viewtab:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 30%,transparent)}
`

// ── session switcher ──

/** `session.list` / `session.create` ok values (wire view). */
interface SessionListValue {
  items?: { sessionId?: string; updatedAt?: number }[]
}
interface SessionCreateValue {
  sessionId?: string
}
// ModelGroup (the `llm.models` group wire view) lives in composer-bar.tsx —
// the composer toolbar owns the model-picker surface now.

/** Normalized `session.list` row for the switcher (most recent first upstream). */
interface SessionSummary {
  sessionId: string
  updatedAt?: number | undefined
}

/** Recent-session feed behind the switcher: poll-free except a slow keep-fresh tick. */
function useSessions(): { sessions: SessionSummary[]; refresh: () => void } {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const refresh = useCallback((): void => {
    void rpc('session.list', {}).then((result) => {
      if (!result.ok) return
      const items = (result.value as SessionListValue | undefined)?.items ?? []
      setSessions(
        items
          .filter(item => typeof item?.sessionId === 'string')
          .slice(0, 20)
          .map(item => ({
            sessionId: item.sessionId as string,
            updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : undefined,
          })),
      )
    }).catch(() => {})
  }, [])
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 20000)
    return () => clearInterval(timer)
  }, [refresh])
  return { sessions, refresh }
}

/**
 * Header dropdown listing recent sessions (`session.list`, newest first) with
 * relative-time labels; the active session is highlighted and excluded from
 * re-selection cost via a check mark. Dismisses via the shared popover
 * contract: outside pointerdown or Esc (capture phase, so panel-level
 * shortcuts cannot eat it).
 */
function SessionMenu({ sessions, currentId, onSelect, onOpen }: {
  sessions: SessionSummary[]
  currentId: string
  onSelect: (sessionId: string) => void
  onOpen: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const close = useCallback((): void => setOpen(false), [])
  const wrapRef = useRef<HTMLDivElement>(null)
  usePopoverDismiss(open, close, wrapRef)

  return (
    <div className="dshx-menuwrap" ref={wrapRef}>
      <button
        type="button"
        className="dshx-iconbtn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="历史会话"
        title="历史会话"
        onClick={() => {
          if (!open) onOpen()
          setOpen(next => !next)
        }}
      >
        <HistoryIcon />
        <ChevronDownIcon size={10} />
      </button>
      {open && (
        <div className="dshx-pop dshx-pop--down" role="menu" aria-label="最近会话">
          <div className="dshx-menuhead">最近会话</div>
          {sessions.length === 0 && <div className="dshx-menuempty">暂无历史会话</div>}
          {sessions.map((item) => {
            const current = item.sessionId === currentId
            return (
              <button
                key={item.sessionId}
                type="button"
                role="menuitem"
                className={`dshx-menuitem${current ? ' is-current' : ''}`}
                title={item.sessionId}
                onClick={() => {
                  setOpen(false)
                  if (!current) onSelect(item.sessionId)
                }}
              >
                {current && <span className="dshx-menuitem-check"><CheckIcon size={12} /></span>}
                <span className="dshx-menuitem-name">{shortSessionLabel(item.sessionId)}</span>
                <span className="dshx-menuitem-time">{formatRelative(item.updatedAt)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── transcript pieces ──

/** User message: right-aligned bubble on the brand accent. */
function UserBubble({ text }: { text: string }): JSX.Element {
  return (
    <div className="dshx-userrow">
      <div className="dshx-userbubble">{text}</div>
    </div>
  )
}

/** Reasoning block: collapsed muted card inside the assistant bubble. */
function ReasoningCard({ text }: { text: string }): JSX.Element {
  return (
    <details className="dshx-card">
      <summary className="dshx-summary">
        思考过程
        <span className="dshx-chevron"><ChevronDownIcon size={12} /></span>
      </summary>
      <div className="dshx-reason">{text}</div>
    </details>
  )
}

/** Tool invocation requested by the model: collapsible name + arguments card. */
function ToolCallCard({ name, argumentsJson }: { name: string; argumentsJson: string }): JSX.Element {
  return (
    <details className="dshx-card">
      <summary className="dshx-summary">
        <span className="dshx-summary-name">工具调用 · {name}</span>
        <span className="dshx-chevron"><ChevronDownIcon size={12} /></span>
      </summary>
      <pre className="dshx-pre">{prettyJson(argumentsJson)}</pre>
    </details>
  )
}

/**
 * Completed tool call: status-colored collapsible card with a one-line summary.
 * The 详情 chip opens the shell details aside with this call's full material
 * (preventDefault keeps the chip from toggling the card's own expansion).
 */
function ToolResultCard({ name, ok, summary, detail, onOpenDetail }: {
  name: string
  ok: boolean
  summary: string
  detail: string
  onOpenDetail: () => void
}): JSX.Element {
  return (
    <details className={`dshx-card dshx-res${ok ? '' : ' iserr'}`}>
      <summary className="dshx-summary">
        <span className="dshx-dot" />
        <span className="dshx-summary-name">{name}</span>
        <span className="dshx-summary-text">{summary === '' ? (ok ? '完成' : '失败') : summary}</span>
        <button
          type="button"
          className="dshx-chipbtn"
          title="查看输入与输出"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onOpenDetail()
          }}
        >
          详情
        </button>
        <span className="dshx-chevron"><ChevronDownIcon size={12} /></span>
      </summary>
      {detail !== '' && <pre className="dshx-pre">{detail}</pre>}
    </details>
  )
}

/**
 * Admitted slash command: the durable flow node's transcript card — the
 * reconstructed `/name args` line plus the handler's settled verdict. The
 * dsh desktop UI renders the same lifecycle pairing as a persistent node;
 * here it is the shell's system feedback for `/` lines (which never reach
 * the model). A `command/done` not yet in view leaves the row pending.
 */
function CommandCard({ name, args, done }: {
  name: string
  args: string | undefined
  done: CommandDoneView | undefined
}): JSX.Element {
  const failed = done?.kind === 'error'
  const outcome = done === undefined
    ? '执行中…'
    : failed
      ? (done.text ?? '执行失败')
      : (done.text ?? '完成')
  return (
    <div className={`dshx-command${failed ? ' iserr' : ''}`} role="status">
      <span className="dshx-command-name">/{name}{args ?? ''}</span>
      <span className="dshx-command-result">{outcome}</span>
    </div>
  )
}

/** Turn failure: quiet tinted card offering 重试 (when a retryable prompt exists) + 复制. */
function ErrorBar({ message, retryText, onRetry }: {
  message: string
  retryText: string | null
  onRetry: (text: string) => void
}): JSX.Element {
  return (
    <div className="dshx-error">
      <div className="dshx-error-text">出错了：{message}</div>
      <div className="dshx-error-actions">
        {retryText !== null && (
          <button
            type="button"
            className="dshx-chipbtn iserr"
            title={`重新发送：${summarize(retryText, 80)}`}
            onClick={() => onRetry(retryText)}
          >
            <RetryIcon size={12} />
            重试
          </button>
        )}
        <CopyChip label="复制" copiedLabel="已复制" getText={() => message} />
      </div>
    </div>
  )
}

/**
 * Assistant message: text blocks render as GFM Markdown (markdown-view.tsx),
 * reasoning/tool-call blocks stay ordered collapsible cards. A plain-text
 * 复制 chip rides the tail on hover/focus — suppressed while the turn is
 * still streaming so mid-flight copies never race the log append.
 */
function AssistantBubble({ blocks, running }: { blocks: BlockData[]; running: boolean }): JSX.Element | null {
  const nodes: JSX.Element[] = []
  const textParts: string[] = []
  for (const [i, block] of blocks.entries()) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
      nodes.push(<MarkdownView key={i} text={block.text} />)
    } else if (block.type === 'reasoning' && typeof block.text === 'string') {
      nodes.push(<ReasoningCard key={i} text={block.text} />)
    } else if (block.type === 'tool-call' && typeof block.name === 'string') {
      nodes.push(<ToolCallCard key={i} name={block.name} argumentsJson={block.arguments ?? ''} />)
    }
    // Other block kinds (image, …) have no v1 presentation here.
  }
  if (nodes.length === 0) return null
  const fullText = textParts.join('\n\n')
  return (
    <div className="dshx-assistant">
      {nodes}
      {!running && fullText !== '' && (
        <div className="dshx-msgactions">
          <CopyChip label="复制" copiedLabel="已复制" getText={() => fullText} />
        </div>
      )}
    </div>
  )
}

/** Example prompts shown on an empty transcript; picking fills the composer. */
const EXAMPLE_PROMPTS: readonly string[] = [
  '总结这个页面的内容',
  '在这家店找最便宜的选项并下单提醒我',
  '帮我给这个视频点赞投币收藏',
]

/** Empty-transcript welcome card: product framing + tappable example prompts. */
function EmptyState({ onPick }: { onPick: (text: string) => void }): JSX.Element {
  return (
    <div className="dshx-welcome">
      <span className="dshx-welcome-glyph"><GlobeIcon size={20} /></span>
      <div className="dshx-welcome-title">OpenBrowserHarness</div>
      <div className="dshx-welcome-sub">让 Agent 替你浏览、阅读和操作网页——说一句话，把事办成。</div>
      <div className="dshx-examples">
        {EXAMPLE_PROMPTS.map(text => (
          <button key={text} type="button" className="dshx-example" onClick={() => onPick(text)}>
            {text}
          </button>
        ))}
      </div>
      <div className="dshx-welcome-hint">点击示例填入输入框，Cmd+Enter 发送</div>
    </div>
  )
}

/** Render one session event; unrendered kinds return null. */
function EventBubble({ event, calls, commands, running, retryText, onRetry, onOpenToolDetail }: {
  event: SessionEventData
  calls: Map<string, { name: string; arguments: string }>
  commands: Map<string, CommandDoneView>
  running: boolean
  retryText: string | null
  onRetry: (text: string) => void
  onOpenToolDetail: (detail: ToolDetail) => void
}): JSX.Element | null {
  const ev = event.event
  const d = ev.data ?? {}
  switch (ev.type) {
    case 'user/message': {
      // time-context readings are model-facing only: the durable log and the
      // Session log export keep every reading, while this deployment's chat
      // flow conceals them (the docked ui-conversation tree hides them via
      // its own producer attribute — this native view reads raw history).
      const source = d.source
      if (source?.kind === 'plugin' && source.plugin === 'time-context') return null
      const text = (d.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      if (text === '') return null
      return <UserBubble text={text} />
    }
    case 'assistant/message': {
      const blocks = d.message?.content ?? d.content ?? []
      return <AssistantBubble blocks={blocks} running={running} />
    }
    case 'command/run': {
      if (typeof d.name !== 'string') return null
      return (
        <CommandCard
          name={d.name}
          args={d.args}
          done={typeof d.commandId === 'string' ? commands.get(d.commandId) : undefined}
        />
      )
    }
    case 'command/done':
      // The paired `command/run` row owns the card; execute appends the pair
      // back-to-back, so both land in the same history page.
      return null
    case 'tool/result': {
      const block = (d.message?.content ?? []).find(candidate => candidate.type === 'tool-result')
      if (block === undefined || typeof block.toolCallId !== 'string') return null
      const call = calls.get(block.toolCallId)
      const name = call?.name ?? 'tool'
      const ok = d.error === undefined && block.isError !== true
      const detail = (block.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n').trim()
      return (
        <ToolResultCard
          name={name}
          ok={ok}
          summary={summarize(detail)}
          detail={detail}
          onOpenDetail={() => {
            onOpenToolDetail({
              callId: block.toolCallId as string,
              name,
              args: prettyJson(call?.arguments ?? ''),
              result: detail,
              ok,
            })
          }}
        />
      )
    }
    case 'turn/end': {
      if (d.reason?.kind === 'error') {
        return <ErrorBar message={d.reason.error?.message ?? '未知错误'} retryText={retryText} onRetry={onRetry} />
      }
      return null
    }
    default:
      return null
  }
}

/**
 * The conversation area: reads `session.history` for the active session over
 * the bridge Port and renders the event log as a chat transcript. Refreshes on
 * a 2 s poll while the engine streams (the simplification for live updates),
 * immediately whenever the parent sends a prompt (`refreshSeq` bump), and
 * re-reads from scratch when the active session changes; sticks to the bottom
 * while the reader is at the bottom.
 */
function ConversationView({ sessionId, refreshSeq, running, retryText, onRetry, onPickExample, onOpenToolDetail }: {
  sessionId: string
  refreshSeq: number
  running: boolean
  retryText: string | null
  onRetry: (text: string) => void
  onPickExample: (text: string) => void
  onOpenToolDetail: (detail: ToolDetail) => void
}): JSX.Element {
  const [events, setEvents] = useState<SessionEventData[]>([])
  const [loading, setLoading] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  const fetchEvents = useCallback(async () => {
    const result = await rpc('session.history', { sessionId })
    if (result.ok) {
      const value = result.value as HistoryValue | undefined
      setEvents(value?.events ?? [])
    }
    // A refused read (engine not up yet) keeps the previous transcript; the
    // next poll retries.
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    setLoading(true)
    stickToBottomRef.current = true
    void fetchEvents()
  }, [fetchEvents, refreshSeq])

  useEffect(() => {
    const timer = setInterval(() => {
      void fetchEvents()
    }, 2000)
    return () => clearInterval(timer)
  }, [fetchEvents])

  useEffect(() => {
    const el = listRef.current
    if (el === null || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [events])

  const handleScroll = (): void => {
    const el = listRef.current
    if (el === null) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const calls = callIndex(events)
  const commands = commandIndex(events)

  return (
    <div
      ref={listRef}
      onScroll={handleScroll}
      role="log"
      aria-live="polite"
      className="dshx-scroll"
    >
      {loading && <div className="dshx-loading">加载中…</div>}
      {!loading && events.length === 0 && <EmptyState onPick={onPickExample} />}
      {events.map(row => (
        <EventBubble
          key={row.event.seq}
          event={row}
          calls={calls}
          commands={commands}
          running={running}
          retryText={retryText}
          onRetry={onRetry}
          onOpenToolDetail={onOpenToolDetail}
        />
      ))}
    </div>
  )
}


// ── conversation view strip (the extension's conversation view tabs) ──

/** The two conversation surfaces the SidePanel can show for one session. */
export type ConversationViewId = 'chat' | 'trajectory'

/** Static tab copy (shell chrome — the surface is hardcoded zh-CN like the rest of the panel). */
const VIEW_TAB_LABELS: Readonly<Record<ConversationViewId, string>> = { chat: '对话', trajectory: '轨迹' }

/**
 * The extension's view switcher above the transcript — the SidePanel counterpart
 * of the desktop conversation header's view tab ring (Chat / 轨迹). Rendered only
 * while the ui-trajectory plugin has its ring entry registered; active state is
 * shell-owned and per-session (see viewBySession in ExtensionShell).
 */
export function ViewStrip({ available, active, onSelect }: {
  available: boolean
  active: ConversationViewId
  onSelect: (view: ConversationViewId) => void
}): JSX.Element | null {
  if (!available) return null
  return (
    <div className="dshx-viewstrip" role="tablist" aria-label="会话视图">
      {(Object.keys(VIEW_TAB_LABELS) as ConversationViewId[]).map(view => (
        <button
          key={view}
          type="button"
          role="tab"
          aria-selected={view === active}
          className={`dshx-viewtab${view === active ? ' is-active' : ''}`}
          onClick={() => { onSelect(view) }}
        >
          {VIEW_TAB_LABELS[view]}
        </button>
      ))}
    </div>
  )
}

// ── the shell component ──

type ExtensionShellProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'conversation' | 'details' | 'sidebar.settings' | 'shell.overlay'>

function ExtensionShell({ renderSlot }: ExtensionShellProps): JSX.Element {
  if (shellCtx === undefined) throw new Error('extension-ui-shell: context missing')
  const { tabs, select } = useTabs()
  const { sessions, refresh: refreshSessions } = useSessions()
  const [detailsOpen, setDetailsOpen] = useState(layout.isOpen())
  /** User-plugin panel visibility; exclusive with the tool-details aside. */
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const [inputText, setInputText] = useState('')
  /** Bumped on every send so ConversationView refetches immediately. */
  const [sentSeq, setSentSeq] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /**
   * Last sent prompt text PER SESSION — powers the ErrorBar 重试 chip. Keyed
   * by session so a switched-away conversation can never resend another
   * session's message; sessions without a recorded prompt simply get no chip.
   */
  const lastSentBySession = useRef(new Map<string, string>())
  /**
   * The session the transcript and composer talk to. Boots on session-main,
   * then adopts the NEWEST persisted session (so a fresh session survives
   * panel reloads). `session.create` mints each 新会话 with its own clean
   * durable log — old sessions' histories stay on disk, untouched.
   */
  const [sessionId, setSessionId] = useState('session-main')
  /**
   * Model catalog (provider groups) for the composer toolbar's model badge —
   * the header model <select> moved there. The catalog lists only CONFIGURED
   * providers; selection goes through `session.selectModel` (from ComposerBar),
   * which also persists the host default, so a picked route serves the very
   * next prompt.
   */
  const [groups, setGroups] = useState<ModelGroup[]>([])
  /**
   * Cached continuable subagent children of the active session — the @-mention
   * menu's candidates AND the mention router's resolution table (`subagent.list`
   * per session mount, re-read when a mention goes active or a mention send
   * lands, so mid-session children are addressable).
   */
  const { subagents, refresh: refreshSubagents } = useSubagents(sessionId)
  useEffect(() => {
    void rpc('session.list', {}).then((result) => {
      if (!result.ok) return
      const newest = (result.value as SessionListValue | undefined)?.items?.find(
        item => typeof item?.sessionId === 'string',
      )
      if (newest?.sessionId !== undefined) setSessionId(newest.sessionId)
    })
    const loadCatalog = (): void => {
      void rpc('llm.models', {}).then((result) => {
        if (!result.ok) return
        setGroups((result.value as { groups?: ModelGroup[] } | undefined)?.groups ?? [])
      })
    }
    loadCatalog()
    const catalogTimer = setInterval(loadCatalog, 15000)
    return () => clearInterval(catalogTimer)
  }, [])
  useEffect(() => layout.subscribe(setDetailsOpen), [])
  const active = tabs.find(tab => tab.active)

  // ── capability panel wiring (docked dsh conversation slot tree) ──
  // The bridge keeps the runtime's current session following the shell's
  // (and vice versa), which is what turns the session-scoped feature panels
  // — goal bar, todo strip, queue, approvals, questions, jobs, subagents,
  // log export — from declared-but-dark into rendered UI.
  useSessionBridge(shellCtx, sessionId, setSessionId)
  const pendingCount = usePendingCount(shellCtx, sessionId)
  // Interaction-channel waits (approval/question frames over the mux tap) —
  // the cards below render these, and the amber dot counts BOTH sources so
  // the indicator cannot disagree with a visible card.
  const interactionPending = useInteractionPendingCount()
  const anyPending = pendingCount > 0 || interactionPending > 0
  const capsOccupied = useCapabilityOccupied(shellCtx)
  const [capsOpen, setCapsOpen] = useState(true)

  // Persisted collapse posture (方案A): the boot read races the first paint
  // and a storage outage just leaves the default-open posture.
  useEffect(() => {
    let alive = true
    void chrome.storage.local.get(CAPS_OPEN_STORAGE_KEY).then((items) => {
      if (!alive) return
      const v = (items as Record<string, unknown>)[CAPS_OPEN_STORAGE_KEY]
      if (typeof v === 'boolean') setCapsOpen(v)
    }).catch(() => {})
    return () => { alive = false }
  }, [])
  const toggleCapsOpen = useCallback((): void => {
    setCapsOpen((open) => {
      const next = !open
      void chrome.storage.local.set({ [CAPS_OPEN_STORAGE_KEY]: next }).catch(() => {})
      return next
    })
  }, [])

  // Visible-content measurement (方案B): the body stays mounted while the
  // seats are occupied, and its inner wrapper's natural height IS the
  // visible-content signal — clipped (collapsed) or not, ResizeObserver reads
  // the wrapper's own box. -1 = not yet measured → assume visible so the
  // first paint never flashes the panel away.
  const capsBodyRef = useRef<HTMLDivElement | null>(null)
  const [capsContentPx, setCapsContentPx] = useState(-1)
  useEffect(() => {
    if (!capsOccupied) return undefined
    const el = capsBodyRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return undefined
    setCapsContentPx(-1)
    const ro = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height
      if (height !== undefined) setCapsContentPx(height)
    })
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [capsOccupied])

  // ── conversation view strip (对话 / 轨迹; see ViewStrip) ──
  // Available only while the ui-trajectory plugin has its conversation.view
  // ring entry registered. Active view is shell-owned per session: the SidePanel
  // counterpart of the desktop view tab ring, with the trajectory surface
  // mounted from the same shared Session window the docked dsh tree reads.
  const trajectoryAvailable = useTrajectoryAvailable(shellCtx)
  const [activeView, setActiveView] = useState<ConversationViewId>('chat')
  const viewBySessionRef = useRef(new Map<string, ConversationViewId>())
  useEffect(() => {
    setActiveView(viewBySessionRef.current.get(sessionId) ?? 'chat')
  }, [sessionId])
  const selectView = useCallback((view: ConversationViewId) => {
    viewBySessionRef.current.set(sessionId, view)
    setActiveView(view)
  }, [sessionId])
  const showTrajectory = trajectoryAvailable && activeView === 'trajectory'
  // The capability panel stays inline at every width: GoalBar/Todo/queue sit
  // above the composer and must be visible whenever they carry data — a
  // collapsed popover on narrow panels would hide the very seats this panel
  // exists to surface (a pending approval/question still force-expands via
  // capsExpanded below).
  const capsInline = true
  const capsExpanded = capsOpen || pendingCount > 0
  // Idle-empty hiding (方案B): the panel shows while expanded, while a wait
  // is pending, or while the tree actually renders content. Collapsed + idle
  // + contentless hides the whole strip — the section stays mounted but out
  // of flow and invisible, so the measurement keeps working and the docks
  // keep their state.
  const capsVisible = capsExpanded || anyPending || capsContentPx < 0 || capsContentPx >= CAPS_CONTENT_PX

  // ── details aside (shell-native; see the module comment) ──
  const [toolDetail, setToolDetail] = useState<ToolDetail | null>(null)
  const openToolDetail = useCallback((detail: ToolDetail): void => {
    setToolDetail(detail)
    setPluginsOpen(false)
    layout.openDetails()
  }, [])
  const closeDetails = useCallback((): void => {
    setToolDetail(null)
    layout.closeDetails()
  }, [])
  // A selection is session-bound material; a switched-away session must not
  // keep showing the previous session's tool call.
  useEffect(() => { setToolDetail(null) }, [sessionId])

  // ── running state: drives the send ⇄ stop button ──
  // Polled alongside the 2 s transcript refresh; a send flips it optimistically
  // so the stop button appears the moment the turn starts.
  const [running, setRunning] = useState(false)
  useEffect(() => {
    let alive = true
    const poll = (): void => {
      void rpc('session.status', { sessionId }).then((result) => {
        if (!alive) return
        setRunning((result.value as { running?: boolean } | undefined)?.running === true)
      }).catch(() => {})
    }
    poll()
    const timer = setInterval(poll, 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [sessionId])

  /** Grow the textarea with its content (capped by .dshx-input max-height). */
  const autosize = (): void => {
    const el = inputRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  /**
   * Transient hint next to the composer (unknown-command fallback feedback);
   * auto-clears so it never lingers on the send row.
   */
  const [composerNotice, setComposerNotice] = useState<string | null>(null)
  const noticeTimerRef = useRef<number | undefined>(undefined)
  const showComposerNotice = useCallback((text: string): void => {
    setComposerNotice(text)
    if (noticeTimerRef.current !== undefined) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setComposerNotice(null), 12000)
  }, [])
  useEffect(() => () => {
    if (noticeTimerRef.current !== undefined) clearTimeout(noticeTimerRef.current)
  }, [])

  // Staged composer images (attachment strip below the textarea): cleared on
  // session switch, carried into the next send's `session.prompt` content.
  const composerAttachments = useComposerAttachments(sessionId, showComposerNotice)

  /**
   * Queue one normal message to the model turn (the prompt half of the send
   * pipeline) and nudge the conversation view to refetch right away. One
   * parameter — the message body — matching the single-argument
   * `SendActions.prompt` seam (the router owns the session).
   */
  const promptSend = (text: string): void => {
    lastSentBySession.current.set(sessionId, text)
    // Attachments ride the same durable prompt: image parts first (the model
    // reads them as context), then the text body. The staging clears with the
    // send, mirroring the input reset.
    const imageParts = imagePromptParts(composerAttachments.attachments)
    const content = [
      ...imageParts,
      ...(text === '' && imageParts.length > 0 ? [] : [{ type: 'text' as const, text }]),
    ]
    void rpc('session.prompt', { sessionId, content })
    composerAttachments.clear()
    setRunning(true)
    setSentSeq(seq => seq + 1)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el !== null) el.style.height = 'auto'
    })
  }

  /**
   * The `/export` destination AND the Session log header chip's download (the
   * dsh chip routes through the layout hook to here): one bridge-RPC read of
   * the durable log, rendered to markdown and saved as a browser download.
   * The web host's HTTP-streamed ZIP controller cannot work here — an
   * extension page has no `/api/session.export` endpoint to fetch.
   */
  const exportSessionLog = useCallback((session: string): void => {
    void rpc('session.history', { sessionId: session }).then((result) => {
      if (!result.ok) {
        showComposerNotice(`导出失败：${result.error?.message ?? '未知原因'}`)
        return
      }
      const value = result.value as { entries?: unknown } | undefined
      const entries = Array.isArray(value?.entries)
        ? value.entries
        : Array.isArray(result.value)
          ? result.value
          : []
      if (entries.length === 0) {
        showComposerNotice('会话为空，没有可导出的内容')
        return
      }
      const blob = new Blob([renderSessionMarkdown(entries)], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `session-${session}.md`
      anchor.click()
      setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
    }).catch(() => {
      showComposerNotice('导出失败：桥不可用')
    })
  }, [showComposerNotice])
  useEffect(() => {
    shellExport = (sessionId: string): boolean => {
      exportSessionLog(sessionId)
      return true
    }
    return () => { shellExport = undefined }
  }, [exportSessionLog])

  /**
   * Route one composer line: `//` escapes to a literal `/` prompt, `/export`
   * hands off to the session-log export (the same browser download the
   * Session log header button drives), a `/` line executes as a slash command
   * (`commands/execute` — never sent to the model; the result surfaces as the
   * durable flow node), an `@名字 正文` line goes to that subagent
   * (`subagent.prompt` — parent = this session, child = the resolved entry,
   * body only), and anything else prompts unchanged. An unadmitted command,
   * an unresolved mention, or a refused subagent delivery falls back to a
   * normal send with a notice.
   */
  const sendPrompt = (text: string): void => {
    dispatchSendLine(sessionId, text, {
      prompt: promptSend,
      subagents,
      onCommandAdmitted: () => { setSentSeq(seq => seq + 1) },
      onSubagentSent: () => {
        setSentSeq(seq => seq + 1)
        refreshSubagents()
      },
      notice: showComposerNotice,
      exportLog: exportSessionLog,
    })
  }

  /** Example-prompt tap: fill the composer (focus + resize), never auto-send. */
  const pickExample = useCallback((text: string): void => {
    setInputText(text)
    requestAnimationFrame(() => {
      autosize()
      inputRef.current?.focus()
    })
  }, [])

  const canSend = inputText.trim() !== '' || composerAttachments.attachments.length > 0
  const retryText = lastSentBySession.current.get(sessionId) ?? null

  /** Abort the running turn (Esc in the textarea or the toolbar stop button). */
  const interrupt = (): void => {
    void rpc('session.interrupt', { sessionId })
  }

  /** Drain the composer into a prompt and reset the input. */
  const sendCurrent = (): void => {
    if (canSend) {
      sendPrompt(inputText.trim())
      setInputText('')
    }
  }

  return (
    <div className="dshx-root">
      <style>{[
        SHELL_CSS, POPOVER_CSS, COMPOSER_CSS, ATTACHMENT_CSS, MARKDOWN_CSS,
        INTERACTION_CARDS_CSS, USER_PLUGIN_PANEL_CSS,
      ].join('')}</style>
      <header className="dshx-header">
        {/* Header stays minimal: tab selector · session menu · new session ·
            user plugins · settings. The model picker lives in the composer
            bar, not here. */}
        <select
          className="dshx-select dshx-tab"
          value={active === undefined ? '' : String(active.id)}
          onChange={(event) => {
            const id = Number.parseInt(event.target.value, 10)
            if (Number.isFinite(id)) select(id)
          }}
          title={active === undefined ? '当前标签页' : `${active.title}\n${active.url}`}
        >
          {active === undefined && <option value="">（当前标签页）</option>}
          {tabs.map(tab => (
            <option key={tab.id} value={String(tab.id)}>
              {`${tab.active ? '▶ ' : ''}${tab.title === '' ? tab.url : tab.title}`.slice(0, 60)}
            </option>
          ))}
        </select>
        <SessionMenu
          sessions={sessions}
          currentId={sessionId}
          onSelect={setSessionId}
          onOpen={refreshSessions}
        />
        <button
          type="button"
          className="dshx-ghostbtn"
          title={`当前会话：${sessionId}`}
          onClick={() => {
            // Mint a genuinely fresh session: `session.create` gives it its
            // own clean durable log (the old sessions stay on disk). The
            // engine keeps one agent per session id, so no redirect-to-main
            // kicks in (that redirect only serves ids without an agent).
            void rpc('session.create', {}).then((result) => {
              const created = result.value as SessionCreateValue | undefined
              if (result.ok && typeof created?.sessionId === 'string') {
                setSessionId(created.sessionId)
                setSentSeq(seq => seq + 1)
                refreshSessions()
              }
            })
          }}
        >
          ＋ 新会话
        </button>
        <button
          type="button"
          className={`dshx-iconbtn${pluginsOpen ? ' is-active' : ''}`}
          aria-label="用户插件"
          aria-pressed={pluginsOpen}
          title="用户插件"
          onClick={() => {
            // The aside is exclusive: opening the plugin panel folds the
            // tool-details pane away (and vice versa, see openToolDetail).
            if (!pluginsOpen) layout.closeDetails()
            setPluginsOpen(next => !next)
          }}
        >
          <PuzzleIcon size={14} />
        </button>
        {/* Settings mount: the ui-settings-general SettingsRoot occupant
            (trigger + its fixed-position dialog). The box only anchors the
            36px trigger circle in the header row — the dialog paints
            viewport-fixed above everything (z 1000); its full-bleed narrow
            form and tab band styling are the package's own (direct package
            fix, no class-stem overrides needed here). */}
        <div className="dshx-settingsmount">
          {renderSlot('sidebar.settings', { wide: false })}
        </div>
      </header>
      {/* While a turn runs, this 2px gradient hairline makes activity visible at a glance. */}
      {running && <div className="dshx-runline" aria-hidden="true" />}
      <div className="dshx-body">
        <div className="dshx-main">
          <ViewStrip available={trajectoryAvailable} active={activeView} onSelect={selectView} />
          {showTrajectory ? (
            <SlotErrorBoundary label="轨迹视图">
              <TrajectoryHost ctx={shellCtx} sessionId={sessionId} />
            </SlotErrorBoundary>
          ) : (
            <ConversationView
              sessionId={sessionId}
              refreshSeq={sentSeq}
              running={running}
              retryText={retryText}
              onRetry={sendPrompt}
              onPickExample={pickExample}
              onOpenToolDetail={openToolDetail}
            />
          )}
        </div>
        {(detailsOpen || pluginsOpen) && (
          <aside className="dshx-details">
            {pluginsOpen
              ? (
                <UserPluginPanel
                  sessionId={sessionId}
                  sendPrompt={sendPrompt}
                  onClose={() => { setPluginsOpen(false) }}
                />
              )
              : <ToolDetailsPanel detail={toolDetail} onClose={closeDetails} />}
          </aside>
        )}
      </div>
      {/* Interaction cards: engine approval/question waits pushed over the
          mux tap (interaction-store). Flex-fixed with a capped scroll region
          so a card can never push the composer out of the panel. */}
      <InteractionCards />
      {/* Capability panel: the real dsh conversation slot tree (goal bar,
          todo strip, queue, approvals, questions, session header actions),
          docked between the transcript and the composer. renderSlot
          'conversation' is the only sanctioned render path for the
          conversation.* family — the seat occupants are declared (and hence
          render-authorized) by ui-conversation's own entry. The hide rules in
          SHELL_CSS remove the duplicate transcript/composer this tree also
          carries. Unmounted entirely when no seat has an occupant. */}
      {capsOccupied && (capsInline ? (
        <section className={`dshx-caps${capsVisible ? '' : ' is-hidden'}`}>
          {capsVisible && (
            <div className="dshx-caps-head">
              <button
                type="button"
                className={`dshx-caps-toggle${anyPending ? ' is-pending' : ''}`}
                aria-expanded={capsExpanded}
                onClick={toggleCapsOpen}
              >
                <span className={`dshx-caps-chev${capsExpanded ? '' : ' is-closed'}`}>
                  <ChevronDownIcon size={10} />
                </span>
                <PuzzleIcon size={11} />
                <span className="dshx-caps-label">能力面板</span>
                {anyPending && <span className="dshx-caps-dot" aria-label="有待处理的确认或提问" />}
              </button>
            </div>
          )}
          {/* Always mounted while the seats are occupied: the collapsed clamp
              keeps the tree measurable (方案B) and the docks keep their
              state; the expanded body is unclamped. */}
          <div className={`dshx-caps-body${capsExpanded ? '' : ' is-collapsed'}`}>
            <div ref={capsBodyRef}>
              <SlotErrorBoundary label="能力面板">
                {renderSlot('conversation', {})}
              </SlotErrorBoundary>
            </div>
          </div>
        </section>
      ) : (
        <div className="dshx-caps dshx-caps--slim">
          <CapsToolsPopover>
            <div className="dshx-caps-body">
              <SlotErrorBoundary label="能力面板">
                {renderSlot('conversation', {})}
              </SlotErrorBoundary>
            </div>
          </CapsToolsPopover>
        </div>
      ))}
      {/* Extension composer: the shell's own input card, sending directly via
          session.prompt over the same Port the capability panels' runtime
          session rides. dsh's InputBar stays mounted inside the capability
          panel — stripped by SHELL_CSS to its plan/permission chip row — to
          keep its input machine state alive for the docks; this card is the
          one visible sender.
          Card anatomy: .dshx-capsule = two stacked zones — textarea above,
          ComposerBar toolbar below a hairline divider. Send semantics:
          Cmd/Ctrl+Enter sends, bare Enter is a newline, Esc interrupts while
          the turn runs. */}
      <div className="dshx-composer">
        <div className="dshx-capsule" title={running ? '运行中 · 按 Esc 可中断' : undefined}>
          {composerNotice !== null && (
            <div className="dshx-composer-notice" role="status">{composerNotice}</div>
          )}
          <div className="dshx-inputwrap">
            {/* Candidate menus (fill only — the send pipeline in
                dispatchSendLine stays the single execution path). The slash
                menu renders unless the text is a bare `/`-led command name;
                the @ menu unless the text ends in a word-bounded `@token` —
                the two shapes are disjoint, so at most one is ever open.
                Either one's keydown listener swallows the Escape that closes
                it, so the Esc-interrupt binding below cannot fire on the same
                press. */}
            <SlashMenu
              sessionId={sessionId}
              text={inputText}
              onChange={setInputText}
              textareaRef={inputRef}
            />
            <SubagentMenu
              subagents={subagents}
              text={inputText}
              onChange={setInputText}
              textareaRef={inputRef}
              onMentionActive={refreshSubagents}
            />
            <textarea
              ref={inputRef}
              className="dshx-input"
              autoFocus
              value={inputText}
              onChange={(e) => {
                setInputText(e.target.value)
                autosize()
              }}
              onKeyDown={(e) => {
                // IME pass-through: while composing (picking candidates), Enter
                // commits text and Esc cancels the composition — neither may
                // send or interrupt.
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Escape' && running) {
                  // Esc from a focused composer aborts the turn (capture-style
                  // courtesy: no modifier gymnastics, one deliberate binding).
                  e.preventDefault()
                  e.stopPropagation()
                  interrupt()
                  return
                }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  sendCurrent()
                }
                // Bare Enter falls through: newline, never auto-send.
              }}
              placeholder="给 Agent 发送指令…（Cmd+Enter 发送）"
              rows={1}
            />
            <AttachmentStrip handle={composerAttachments} />
          </div>
          <ComposerBar
            sessionId={sessionId}
            running={running}
            canSend={canSend}
            groups={groups}
            onSend={sendCurrent}
            onInterrupt={interrupt}
          />
        </div>
      </div>
    </div>
  )
}

// ── plugin entry ──

export const name = 'extension-ui-shell'
// 'locale' backs the trajectory view's toolbar translate (trajectory-host) —
// the cordis traceable proxy refuses service reads outside this declared
// inject, so an undeclared read would throw at render time.
export const inject: readonly string[] = ['slots', 'theme', 'workspaces', 'sessions', 'locale']

export function apply(ctx: ClientContext): void {
  shellCtx = ctx

  ctx.effect(() => {
    // The panel-action contract ui-conversation/ui-sidebar reach for.
    const disposeService = ctx.reflect.provide('layout', layout as never)

    // Exclusive root render authority with the slots the kept dsh UI plugins
    // occupy ('conversation'/'details' from ui-conversation; SettingsRoot
    // from ui-settings-general renders its own trigger + panel).
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    }, ExtensionShell)

    return () => {
      disposeRegistration()
      void disposeService()
    }
  }, 'extension-ui-shell: layout service + root registration')

  // Theme presentation (ui-layout's former duty): project resolved snapshots
  // onto the document so the dsh token palette reaches every surface.
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => {
      presenter.apply(snapshot)
    })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'extension-ui-shell: theme presenter')
}
