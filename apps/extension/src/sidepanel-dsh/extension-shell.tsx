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
 *   DECLARED by ui-conversation's 'main' entry — "declaring is claiming" gives
 *   that entry the only renderSlot binding for the whole family, so the
 *   sanctioned way to surface its occupants is rendering
 *   `renderSlot('main', {}, { entryKey: 'conversation' })` itself. The panel hides the parts this
 *   shell already owns and keeps the rest live:
 *   - input docks: goal bar (ui-goal), todo strip + queue rows (ui-conversation);
 *   - plan chip: the plan-mode exit chip that survives the stripped dsh
 *     InputBar (renders only while the session is in plan mode);
 *   - session header: breadcrumbs + background-jobs / subagent-catalog
 *     actions (ui-subagent) + log-export utility (dsh-session-log-export).
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
 *   - the card-style composer sends on Enter (Shift+Enter = newline) and
 *     interrupts a running turn on Esc; `/` lines execute as slash commands
 *     (`commands/execute`) whose durable flow nodes render as system rows,
 *     `//` escapes to a literal `/` prompt, and an unadmitted command falls
 *     back to a normal send with a notice — except a LOCAL rpc timeout, which
 *     reports a background execution (the handler runs to settlement
 *     server-side) instead of feeding the line to the model;
 *   - pasting or dropping image files onto the composer stages them as
 *     attachments (pickImageFiles filters the raster whitelist; other files
 *     are silently ignored, while picker-chosen wrong types keep addFiles'
 *     refusal notice);
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
 *   - an empty transcript greets with the brand welcome (no example cards).
 *
 * Tab targeting: the selector defaults to the CURRENT tab and follows tab
 * activation live; picking a tab activates it (chrome.tabs.update), which is
 * exactly the "target = active tab" semantics the engine's browser tools
 * already resolve per call.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Brings the ctx.theme service typing + 'theme/change' event declaration.
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { MARKDOWN_CSS, MarkdownView } from './markdown-view.tsx'
import { rpc } from './rpc-client.ts'
import { POPOVER_CSS, usePopoverDismiss } from './popover.tsx'
import { ComposerBar, COMPOSER_CSS, dispatchSendLine, SlashMenu, SubagentMenu, useSubagents } from './composer-bar.tsx'
import { AttachmentStrip, ATTACHMENT_CSS, imagePromptParts, pickImageFiles, useComposerAttachments } from './composer-attachments.tsx'
import type { ModelGroup } from './composer-bar.tsx'
import { InteractionCards, INTERACTION_CARDS_CSS, useInteractionPendingCount } from './interaction-cards.tsx'
import { UserPluginPanel, USER_PLUGIN_PANEL_CSS } from './user-plugin-panel.tsx'
import { ServicesPanel, UPDATE_CHECK_STORAGE_KEY, type UpdateCheckCache } from './services-panel.tsx'
import { MCP_PANEL_CSS } from './mcp-panel.tsx'
import { CREDENTIALS_CARD_CSS } from './credentials-card.tsx'
import { ACCOUNT_CARD_CSS } from './account-card.tsx'
import { SCHEDULE_CARD_CSS, AutomationPanel } from './automation-panel.tsx'
import { NEW_SESSION_ID, TrajectoryHost } from './trajectory-host.tsx'
import { installShellLocale, shellT, useShellT } from './locales/index.ts'
import type { ShellLocaleKey } from './locales/index.ts'

/**
 * Panel-owned session selection, published by the shell so the workspace
 * stub's `openSession` reaches the panel state ("current" is panel-owned
 * upstream 0.2.2 — the sessions face no longer carries it).
 */
let panelSessionOpener: ((sessionId: string) => void) | undefined
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CopyIcon,
  ClockIcon,
  ExpandIcon,
  FolderIcon,
  FullscreenIcon,
  HistoryIcon,
  PencilIcon,
  PuzzleIcon,
  RetryIcon,
  ServerIcon,
} from './icons.tsx'
import {
  localWorkspaceStatus,
  migrateLegacyWorkspace,
  pickLocalWorkspace,
  reauthorizeLocalWorkspace,
  removeLocalWorkspace,
  moveSentinelWorkspaceTo,
  type LocalWorkspaceStatus,
} from './dir-workspace.ts'
import {
  readSessionWorkspace,
  setActiveWorkspace,
} from '../shared/dir-handles.ts'

// Slot declarations owned by THIS registrar (the root registration below
// declares these children; the replaced ui-layout/ui-sidebar rows used to
// carry the declarations — the declaring registrar owns them).
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Central panel selected by entry key; `conversation` hosts the Conversation. */
    'main': { kind: 'keyed'; scope: 'root' }
    /** The conversation stream + composer (ui-conversation's ConversationRoot). */
    'conversation': {
      kind: 'single'
      scope: 'session-maybe'
      owner: { sessionId: SessionId }
    }
    /** Tool details pane (ui-conversation's DetailsPanel). */
    'details': { kind: 'single'; scope: 'session'; owner: Record<string, never> }
    /** Settings trigger + panel (ui-settings-general's SettingsRoot). */
    'sidebar.settings': { kind: 'single'; scope: 'root'; owner: { wide: boolean; labeled?: boolean } }
    /** Frame-wide floating layer (badges, toasts). */
    'shell.overlay': { kind: 'list'; scope: 'root'; owner: Record<string, never> }
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** This shell's main-view retention (the roster excludes ui-workspace, whose navigation owns the label upstream). */
    mainView: unknown
  }
}

/**
 * Structural twin of the `dsh-session-log-export` client's carrier seam
 * (`SessionLogExportOverrides` — that package declares its own version; the
 * extension program cannot import it without merging the upstream client
 * declaration graph). The fetcher answers the plugin's document-relative
 * `/api/session.export` and `/api/session.markdown` routes; the save hands
 * the download route to the browser with a real object URL.
 */
interface SessionLogExportOverrides {
  /** Replaces the export download's and the Markdown copy's HTTP carrier. */
  readonly fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>
  /** Replaces the browser save of the export download route. */
  readonly save?: (url: string, filename: string) => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Panel-action contract (provided by this shell). */
    layout: {
      toggleSidebar(): void
      openDetails(): void
      closeDetails(): void
    }
    /** Carrier overrides the session-log-export plugin reads on activation. */
    sessionLogExportOverrides?: SessionLogExportOverrides
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
      return typeof b.text === 'string' ? b.text : `[${b.type ?? 'block'}]`
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
  const t = shellT()
  const lines: string[] = ['# Session log', '']
  for (const entry of entries) {
    const e = entry as { seq?: number; type?: string; data?: Record<string, unknown> }
    const data = e.data ?? {}
    switch (e.type) {
      case 'user/message':
        lines.push(t('shell.export.headingUser'), '', blockText(data.content), '')
        break
      case 'assistant/message':
        lines.push(t('shell.export.headingAssistant'), '', blockText((data.message as Record<string, unknown> | undefined)?.content ?? data.content), '')
        break
      case 'tool/call':
        lines.push(t('shell.export.toolCall', { name: typeof data.name === 'string' ? data.name : '', arguments: oneLine(data.arguments ?? '') }), '')
        break
      case 'tool/result':
        lines.push(t('shell.export.toolResult', { result: oneLine(data.content ?? data.result ?? data) }), '')
        break
      case 'approval/asked':
      case 'approval/decided':
        break
      default:
        lines.push(`\`${typeof e.type === 'string' ? e.type : 'event'}\` ${oneLine(data)}`, '')
    }
  }
  return `${lines.join('\n')}\n`
}

/** Thrown when a session's durable log carries no exportable entries. */
class SessionLogEmptyError extends Error {
  constructor() {
    super(shellT()('shell.export.empty'))
    this.name = 'SessionLogEmptyError'
  }
}

/** Read one session's durable log over the bridge RPC and render it to markdown. */
async function readSessionMarkdown(sessionId: string): Promise<string> {
  const result = await rpc('session.history', { sessionId })
  if (!result.ok) throw new Error(result.error?.message ?? shellT()('shell.common.unknownReason'))
  // The 0.2.2 bridge pages `{ events: [{ event }, ...] }`; the pre-sync shape
  // was a bare `entries` array — both stay readable here.
  const value = result.value as { events?: unknown; entries?: unknown } | undefined
  const raw = Array.isArray(value?.events)
    ? value.events
    : Array.isArray(value?.entries)
      ? value.entries
      : Array.isArray(result.value)
        ? result.value
        : []
  const entries = raw.map((item): unknown => {
    if (item !== null && typeof item === 'object' && 'event' in item) {
      const wrapper = item as Record<string, unknown>
      return wrapper.event
    }
    return item
  })
  if (entries.length === 0) throw new SessionLogEmptyError()
  return renderSessionMarkdown(entries)
}

/** Save rendered markdown as a browser download named after the session. */
function downloadSessionMarkdown(sessionId: string, markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `session-${sessionId}.md`
  anchor.click()
  setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
}

/**
 * The bridge carriers the `dsh-session-log-export` plugin rides (provided as
 * `sessionLogExportOverrides` in apply): an extension page has no HTTP host
 * behind `/api/session.export` and `/api/session.markdown`, so the plugin's
 * header download and Markdown-copy gestures read the durable log over the
 * same RPC the composer's `/export` uses — markdown text replaces the ZIP
 * route, and the save keeps the fork's `.md` filename.
 */
const sessionLogExportCarriers: SessionLogExportOverrides = {
  fetcher(input, init) {
    const url = new URL(String(input), document.baseURI)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') return Promise.resolve(new Response('missing or invalid sessionId query parameter', { status: 400 }))
    if (init?.method === 'HEAD') return Promise.resolve(new Response(null, { status: 200 }))
    return readSessionMarkdown(sessionId)
      .then(markdown => new Response(markdown, {
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      }))
      .catch((error: unknown) => {
        if (error instanceof SessionLogEmptyError) return new Response('session is empty', { status: 404 })
        throw error
      })
  },
  save(url) {
    const sessionId = new URL(url, document.baseURI).searchParams.get('sessionId') ?? ''
    if (sessionId === '') return
    void readSessionMarkdown(sessionId).then((markdown) => {
      downloadSessionMarkdown(sessionId, markdown)
    }).catch((error: unknown) => {
      // The controller has already marked the download successful by the
      // time save returns — a late bridge failure has no dialog channel
      // left, so the failure surfaces in the console only.
      console.error('[export-carriers] save failed:', error)
    })
  },
}

type LayoutListener = (open: boolean) => void

/**
 * Structural twin of ui-layout's `ILayout` action face (that module's client
 * entry is excluded; the shell owns the layout presenter). The 0.2.2 carried
 * rows read beyond the 0.1.5 panel actions — ui-sidebar-right subscribes
 * `panelInfo` and reports rightbar presentation — so the stub covers the
 * whole face with single-panel semantics: one central panel (the
 * Conversation), no rightbar chrome.
 */
class ExtensionLayout {
  #open = false
  readonly #listeners = new Set<LayoutListener>()
  /** ui-layout's PanelInfo projection, single-panel: no selected main key. */
  readonly panelInfo = {
    getSnapshot: (): { activePanelId: string | null } => ({ activePanelId: null }),
    subscribe: (_listener: () => void): (() => void) => () => undefined,
  }

  toggleSidebar(): void {
    // No sidebar in the extension shell; the contract method is a no-op.
  }

  /** Selecting a global central panel is unreachable (one panel); a no-op keeps the face complete. */
  selectPanel(_panelId: string | null): void {}

  /** No layout navigation exists; the signal never aborts. */
  beginNavigation(): AbortSignal {
    return new AbortController().signal
  }

  /** No rightbar chrome: both presentation reports are no-ops. */
  openRightbar(_track: boolean, _fullscreen: boolean): void {}

  /** No rightbar chrome: both presentation reports are no-ops. */
  closeRightbar(): void {}

  openDetails(): void {
    this.#set(true)
  }

  closeDetails(): void {
    this.#set(false)
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
 * the plain-string `slots.entriesOfSlot` face because the SlotMap
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
    // The seats above are declared in ui-conversation's compile boundary,
    // outside this program's SlotMap union, so both faces are keyed by plain
    // strings here. Method syntax keeps the erasure a plain cast (the
    // parameter check stays bivariant); no `as unknown` is involved.
    const erased = slots as {
      entriesOfSlot(key: string): readonly unknown[]
      subscribe(key: string, fn: () => void): () => void
    }
    // entriesOfSlot is the winning-entry (what outlets render) view; a
    // declaration alone is not occupancy.
    const entriesOfSlot = erased.entriesOfSlot.bind(slots)
    const read = (): void => {
      setOccupied(CAPS_SEATS.some(key => entriesOfSlot(key).length > 0))
    }
    read()
    // The extracted faces MUST be bound to `slots`: ctx.slots is a cordis
    // traceable proxy whose method faces rebind `this` only when invoked as a
    // method — a free call loses the receiver, and the SlotRegistry.subscribe
    // body then reads `_core` off `undefined` (or the page global) and throws
    // `TypeError: Cannot read properties of undefined (reading 'subscribe')`
    // during React effect commit, taking the whole shell down through the
    // root slot error boundary (white panel).
    const subscribe = erased.subscribe.bind(slots)
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
    // The fresh-session start has no runtime id to bridge.
    if (sessionId === NEW_SESSION_ID) return undefined
    // The client sessions face (ISessions) rides the same service key the
    // engine's SessionStore merges under; the panel consumes the client half.
    // Upstream moved "current" into the panel itself (SessionListState no
    // longer carries it), so adoption is: once the id shows up in the face's
    // list, hand it to the shell selection.
    const sessions = ctx.sessions
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    let pulled = false
    const tryOpen = (): void => {
      const list = sessions.list.getSnapshot()
      if (list.byId[sessionId as SessionId] !== undefined) {
        adoptRef.current(sessionId)
        return
      }
      // The service list is fed by api-session/* remote notifications, whose
      // push leg the extension does not run; its own pull (`refresh()`) rides
      // the typert remote and resolves without landing rows here. The shell's
      // plain `session.list` rpc works, so feed its rows through the same
      // handler the remote notifications use, then re-check.
      if (!pulled) {
        pulled = true
        void rpc('session.list', {}).then((result) => {
          if (!result.ok) return
          const items = (result.value as SessionListValue | undefined)?.items ?? []
          const feeder = sessions as unknown as { handleSessionAdded(summary: unknown): void }
          for (const item of items) {
            if (typeof item.sessionId !== 'string') continue
            feeder.handleSessionAdded({
              sessionId: item.sessionId,
              updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
              running: item.running === true,
              blank: (item as { blank?: boolean }).blank === true,
              ...(item.projections !== undefined ? { projections: item.projections } : {}),
            })
          }
          tryOpen()
        }).catch(() => {})
        return
      }
      tries += 1
      if (tries <= 8) timer = setTimeout(tryOpen, 1500)
    }
    tryOpen()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
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
      const read = (): void => { setCount(session.getSnapshot().pendingSubmissions.length) }
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
  const t = useShellT()
  return (
    <div className="dshx-tooldetail">
      <div className="dshx-tooldetail-head">
        <span className="dshx-tooldetail-title">{detail?.name ?? t('shell.toolDetail.title')}</span>
        <button type="button" className="dshx-iconbtn" aria-label={t('shell.toolDetail.close')} title={t('shell.toolDetail.close')} onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      {detail === null
        ? <div className="dshx-tooldetail-empty">{t('shell.toolDetail.emptyHint')}</div>
        : (
          <div className="dshx-tooldetail-body">
            {detail.args !== '' && (
              <>
                <div className="dshx-tooldetail-label">{t('shell.toolDetail.input')}</div>
                <pre className="dshx-pre">{detail.args}</pre>
              </>
            )}
            <div className="dshx-tooldetail-label">{t('shell.toolDetail.output')}</div>
            {detail.result !== ''
              ? <pre className="dshx-pre">{detail.result}</pre>
              : <div className="dshx-tooldetail-empty">{detail.ok ? t('shell.toolDetail.noTextOutput') : t('shell.toolDetail.failedNoOutput')}</div>}
          </div>
        )}
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
      active: tab.active,
    }))
}

function useTabs(): { tabs: TabRow[]; refresh: () => void; select: (id: number) => void } {
  const [tabs, setTabs] = useState<TabRow[]>([])
  // Stable identity: the effect below keys on it. A fresh function per render
  // re-ran the effect every commit, and each run's queryTabs().then(setTabs)
  // handed back a new array — a self-sustaining render loop paced by the rpc
  // round-trip (thousands of renders per second).
  const refresh = useCallback((): void => {
    void queryTabs().then(setTabs).catch(() => {})
  }, [])
  const select = (id: number): void => {
    void chrome.tabs.update(id, { active: true }).catch(() => {})
    refresh()
  }
  useEffect(() => {
    refresh()
    const onActivated = (): void => { refresh() }
    const onUpdated = (): void => { refresh() }
    const onRemoved = (): void => { refresh() }
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
    console.warn('[extension-shell]', `${this.props.label} failed to render; degraded to a notice:`, error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="dshx-slot-fallback">{shellT()('shell.slotFallback')}</div>
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
  /**
   * `user/message`: durable attribution — plugin injections skip the chat
   * flow; `skill-invocation` sources carry the loaded skill's name.
   */
  source?: { kind?: string; plugin?: string; name?: string }
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
 * values are normalized). Future-skew clamps to "just now".
 *
 * @param updatedAt - persisted timestamp, possibly missing or mis-scaled.
 * @returns the relative label, `MM-DD` past a week, or '' when unknown.
 */
function formatRelative(updatedAt: number | undefined): string {
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return ''
  const t = shellT()
  const ms = updatedAt < 1e12 ? updatedAt * 1000 : updatedAt
  const diff = Math.max(0, Date.now() - ms)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t('shell.time.justNow')
  if (minutes < 60) return t('shell.time.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('shell.time.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return t('shell.time.daysAgo', { count: days })
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
          setTimeout(() => { setCopied(false) }, 1600)
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
/* newer-release dot on the plugin trigger (the 关于 check's cached outcome) */
.dshx-iconbtn{position:relative}
.dshx-updot{position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warning-primary,#f59e0b);animation:dshx-caps-pulse 1.6s ease-out infinite}
@media (prefers-reduced-motion:reduce){.dshx-updot{animation:none}}
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
  .dshx-welcome{padding:24px 12px 16px;gap:12px}
  .dshx-welcome-sub{max-width:240px}
  .dshx-example{gap:8px;padding:8px 10px}
  .dshx-welcome-glyph{width:48px;height:48px}
  .dshx-scroll{padding:10px 12px}
  .dshx-composer{padding:0 8px 8px}
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
/* Settings surface compaction (SidePanel-width overrides for the desktop
 * settings chrome; attribute selectors survive the css-module hash): the
 * theme cubes collapse to one row, rows share one rhythm, and controls stop
 * jumping between huge and tiny. */
[class*="cubeRow"]{flex-wrap:nowrap;gap:6px}
[class*="themeCube"]{flex:1 1 0;min-width:0;padding:10px 8px;border-radius:12px;gap:3px;font-size:12px;line-height:16px}
[class*="themeCube"] svg{width:14px;height:14px}
/* trajectory toolbar: pill-chip stats + search, the dsh trajectory look */
.dshx-trj-toolbar{display:flex;align-items:center;gap:6px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.08));flex:none}
.dshx-trj-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 10px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04));font-size:11.5px;color:var(--dsw-alias-label-secondary,#888)}
.dshx-trj-chip b{color:var(--dsw-alias-label-primary,#333);font-weight:600;font-variant-numeric:tabular-nums}
.dshx-trj-search{margin-left:auto;padding:4px 10px;border:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.12));border-radius:999px;background:transparent;color:inherit;font-size:12px;width:150px}
.dshx-trj-search:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4c7dfd)}
/* 输入/模型/工具 swimlane strip: three 10px lanes of colored windows */
.dshx-trj-lanes{flex:none;display:grid;grid-template-columns:32px 1fr;row-gap:3px;align-items:center;padding:8px 16px 7px;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.06))}
.dshx-trj-lane-label{font-size:10.5px;line-height:1;color:var(--dsw-alias-label-secondary,#888);text-align:right;padding-right:6px}
.dshx-trj-lane{position:relative;height:10px;border-radius:5px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.045));overflow:hidden}
.dshx-trj-lane i{position:absolute;top:1.5px;bottom:1.5px;border-radius:3px;opacity:.78}
.dshx-trj-lane.is-input i{background:#34c77b}
.dshx-trj-lane.is-model i{background:#7c5cfc}
.dshx-trj-lane.is-tool i{background:#f0a04b}
/* timeline cards: left spine + node dots, white bordered cards off the rail */
.dshx-trj-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:10px 16px 14px}
.dshx-trj-empty{padding:24px 8px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-trj-items{position:relative;padding-left:22px;min-height:100%}
.dshx-trj-items::before{content:'';position:absolute;left:9px;top:8px;bottom:8px;width:1px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.16))}
.dshx-trj-turn{position:relative;margin:2px 0 8px;font-size:10.5px;font-weight:600;letter-spacing:.5px;color:var(--dsw-alias-label-tertiary,#999)}
.dshx-trj-turn::before{content:'';position:absolute;left:-17px;top:50%;transform:translateY(-50%);width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-border-l3,rgba(0,0,0,.22))}
.dshx-trj-row{position:relative;display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;background:var(--dsw-alias-bg-overlay,#fff);font-size:12px;line-height:1.5;box-shadow:0 1px 2px rgba(15,18,26,.04);transition:box-shadow .15s ease,border-color .15s ease}
.dshx-trj-row:hover{box-shadow:0 2px 8px rgba(15,18,26,.08)}
.dshx-trj-row::before{content:'';position:absolute;left:-16px;top:50%;transform:translateY(-50%);width:7px;height:7px;box-sizing:border-box;border-radius:50%;background:var(--dsw-alias-bg-overlay,#fff);border:1.5px solid #c3c7cf}
.dshx-trj-row.is-user::before{border-color:#3b82f6}
.dshx-trj-row.is-assistant::before{border-color:#7c5cfc}
.dshx-trj-row.is-tool::before{border-color:#e8890c;background:#e8890c}
.dshx-trj-row.is-skill::before{border-color:#e8a44e}
.dshx-trj-row.is-failed::before{border-color:var(--dsw-alias-danger,#e5484d);background:var(--dsw-alias-danger,#e5484d)}
.dshx-trj-tag{flex:none;display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:6px;font-size:11px;font-weight:600;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#666)}
.dshx-trj-tag.is-user{background:rgba(59,130,246,.12);color:#3b6ae1}
.dshx-trj-tag.is-assistant{background:#eeebff;color:#7c5cfc}
.dshx-trj-tag.is-tool{background:#fff3e0;color:#c47717;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600}
.dshx-trj-tag.is-skill{background:rgba(240,150,40,.1);color:#a8681a}
.dshx-trj-tag.is-system{background:rgba(80,180,120,.14);color:#2c8a52}
.dshx-trj-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,inherit);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.dshx-trj-arrow{flex:none;color:var(--dsw-alias-label-tertiary,#aaa);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.dshx-trj-result{flex:1.4 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#888);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.dshx-trj-dur{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#aaa);font-variant-numeric:tabular-nums}
.dshx-trj-row.is-subdued .dshx-trj-text{color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-trj-row.is-failed .dshx-trj-text,.dshx-trj-row.is-failed .dshx-trj-tag,.dshx-trj-row.is-failed .dshx-trj-result{color:var(--dsw-alias-danger,#e5484d)}
.dshx-trajectory--loading{align-items:center;justify-content:center;padding:32px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary,#aaa)}
/* the user bubble anchors on the static DeepSeek blue, not --dsw-alias-brand-primary:
   the brand alias is monochrome by design (near-black in light, near-white in dark),
   which read as a black slab in light mode and white-on-white text in dark. */
.dshx-userbubble{max-width:85%;padding:8px 12px;border-radius:14px;border-bottom-right-radius:4px;background:var(--dsw-static-deepseek-500,#4176e6);color:#fff;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
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
/* loaded-skill instruction body: collapsed machine-input row, never a bubble */
.dshx-skillrow{margin:10px 0;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));font-size:12px}
.dshx-skillrow-head{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;list-style:none;color:var(--dsw-alias-label-secondary,#888)}
.dshx-skillrow-head::-webkit-details-marker{display:none}
.dshx-skillrow-tag{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;letter-spacing:.12em;color:#c47717;background:rgba(240,150,40,.12);border-radius:5px;padding:1px 6px}
.dshx-skillrow-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-primary,#333)}
.dshx-skillrow-body{padding:4px 12px 10px;max-height:220px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary,#777);border-top:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
/* transient fallback hint inside the composer card */
.dshx-composer-notice{margin:8px 12px 0;padding:5px 10px;border-radius:8px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#888);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}
/* empty-state welcome — a centered composition: the empty scrollport centers
   the card block vertically (margin:auto inside a flex column), an ambient
   brand wash gives the hero depth, and the suggestion cards carry icon /
   label / hover-arrow. All colors ride tokens, so dark mode inherits. */
.dshx-scroll:has(>.dshx-welcome){display:flex;flex-direction:column}
.dshx-welcome{position:relative;display:flex;flex-direction:column;align-items:center;gap:14px;margin:auto;padding:32px 16px;text-align:center}
.dshx-welcome::before{display:none}
.dshx-welcome>*{position:relative}
/* the welcome glyph is the toolbar icon artwork itself (public/icons/icon.svg,
   rendered as an <img>): one mark everywhere, so the tile carries its own
   rounded corners and the holder only adds a soft host-side shadow */
.dshx-welcome-glyph{width:56px;height:56px;filter:drop-shadow(0 6px 16px rgba(10,16,40,.22))}
.dshx-welcome-glyph img{display:block;width:100%;height:100%}
.dshx-welcome-title{font-size:17px;font-weight:700;letter-spacing:-.01em}
.dshx-welcome-sub{max-width:260px;font-size:12.5px;line-height:1.75;color:var(--dsw-alias-label-secondary,#888)}
.dshx-examples{display:flex;flex-direction:column;gap:8px;width:100%;max-width:320px;margin-top:10px}
.dshx-example{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:14px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));cursor:pointer;text-align:left;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#666);transition:border-color .16s ease,background .16s ease,color .16s ease,transform .16s ease,box-shadow .16s ease}
.dshx-example-icon{flex:none;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:8px;color:var(--dsw-alias-brand-primary,#4c7dfd);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 9%,transparent);transition:background .16s ease,color .16s ease}
.dshx-example-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshx-example svg.dshx-example-arrow{flex:none;width:14px;height:14px;margin-left:auto;color:var(--dsw-alias-label-tertiary,#aaa);opacity:0;transform:translateX(-4px);transition:opacity .16s ease,transform .16s ease,color .16s ease}
.dshx-example:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 6%,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-label-primary,#171717);transform:translateY(-1px);box-shadow:0 3px 10px rgba(15,18,26,.07)}
.dshx-example:hover .dshx-example-icon{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 16%,transparent)}
.dshx-example:hover svg.dshx-example-arrow{opacity:1;transform:none;color:var(--dsw-alias-brand-primary,#4c7dfd)}
.dshx-example:active{transform:translateY(0);box-shadow:none}
.dshx-welcome-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-welcome-hint kbd{display:inline-block;min-width:16px;margin:0 1px;padding:1px 4px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-bottom-width:2px;border-radius:5px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));font:inherit;font-size:10px;line-height:14px;text-align:center;color:var(--dsw-alias-label-secondary,#888)}
/* header primary action: one clear affordance among the ghost controls */
.dshx-primarybtn{flex:none;border:none;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 10%,transparent);cursor:pointer;height:28px;padding:0 10px;font-size:12px;line-height:28px;white-space:nowrap;color:var(--dsw-alias-brand-primary,#4c7dfd);font-weight:600;border-radius:8px;transition:background .15s ease,filter .15s ease}
.dshx-primarybtn:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 16%,transparent);filter:none}
.dshx-primarybtn:active{filter:brightness(.95)}
/* composer — card-style input card: two stacked zones (textarea above, the
   ComposerBar toolbar below a hairline), 14 px radius, one subtle border that
   turns brand-colored with a soft halo on focus, and an ambient (non-glowing)
   drop shadow. The whole card reads one step lighter than the canvas via
   bg-layer-1. Popovers anchored inside must NOT be clipped → no overflow cut.
   The strip is an unpainted spacer: the capsule and the capability card carry
   their own borders, so a wide host never shows a full-bleed divider line. */
.dshx-composer{flex:0 0 auto;padding:0 12px 12px}
.dshx-capsule{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:14px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));box-shadow:0 1px 2px rgba(15,18,26,.04),0 4px 14px rgba(15,18,26,.05);transition:border-color .15s ease,box-shadow .15s ease}
.dshx-capsule:focus-within{border-color:var(--dsw-alias-brand-primary,#4c7dfd);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 14%,transparent),0 1px 2px rgba(15,18,26,.04)}
.dshx-inputwrap{padding:9px 12px 5px}
.dshx-input{display:block;width:100%;max-height:160px;min-height:20px;resize:none;border:none;background:transparent;color:inherit;font-size:13px;line-height:20px;padding:0;outline:none;font-family:inherit}
.dshx-input::placeholder{color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-send{flex:0 0 auto;width:32px;height:32px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(160deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 88%,#fff),var(--dsw-alias-brand-primary,#4c7dfd));box-shadow:0 2px 8px color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 35%,transparent);transition:box-shadow .15s ease,transform .1s ease,filter .15s ease}
.dshx-send:disabled{cursor:default;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 8%,transparent);color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 32%,transparent);box-shadow:none}
.dshx-send:not(:disabled):hover{filter:brightness(.96);box-shadow:0 3px 12px color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 45%,transparent)}
.dshx-send:not(:disabled):active{transform:scale(.92)}
.dshx-send svg{display:block}
.dshx-stop + .dshx-send,.dshx-send + .dshx-stop{margin-left:6px}
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
/* capability dock = one rounded card in the same material and width lane as
   the composer capsule above it (the old full-width border-top strip read as
   unexplained chrome). The lane (.dshx-caps-lane) mirrors the composer's
   side paddings, and the centered cap rides the cards themselves (the rule
   after .dshx-caps), so the card and capsule boundaries coincide on every
   width — a dragged-wide side panel included, not only ?view=full. */
.dshx-caps-lane{flex:0 0 auto;padding:0 12px 12px}
.dshx-caps{margin:0;padding:4px 6px 6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:14px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));box-shadow:0 1px 2px rgba(15,18,26,.04),0 4px 14px rgba(15,18,26,.05)}
/* the one width lane, both postures: side paddings come from the lane
   wrappers (12 px each), the centered 760 cap rides the cards, so the
   capability card and the input capsule share one column at every width */
.dshx-composer .dshx-capsule,
.dshx-caps-lane .dshx-caps{width:100%;max-width:760px;margin:0 auto;box-sizing:border-box}
.dshx-caps-body{padding:2px 6px 8px}
/* 用户气泡：暗色下出厂的 neutral-bluish-850（近黑）在侧栏里读作一团黑块，
   且与页面底色几乎无法区分。改用品牌蓝在暗底上调制的深蓝气泡——既与发送
   按钮/品牌色呼应，又保持足够对比度承托浅色文字。亮色主题保持出厂浅蓝。
   重定义必须落在 body 级：对话气泡由会话转录渲染，不在能力面板
   （.dshx-caps-body）子树内，scoped 覆盖够不着它。 */
body[data-ds-dark-theme]{
  --dsw-specific-bubble:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 26%,var(--dsw-static-neutral-bluish-850));
}
/* time-context readings are model-facing only: the rows stay in the session
   log and the trajectory view (the audit surface), while the chat flow
   conceals them — each reading renders as a collapsed context row that has
   no actionable surface. The rule keys on the durable producer name the seat
   projects, never a client-side plugin table. */
[data-chat-flow-producer="time-context"]{display:none!important}
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
/* shell-native tool detail aside (the 'details' slot occupant needs the dsh
   chat store's selection, writable only from the hidden ChatView) */
.dshx-tooldetail{display:flex;flex-direction:column;height:100%;min-height:0}
.dshx-tooldetail-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.dshx-tooldetail-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}
.dshx-tooldetail-body{padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.dshx-tooldetail-label{font-size:11px;letter-spacing:.4px;color:var(--dsw-alias-label-tertiary,#999)}
.dshx-tooldetail-empty{padding:16px 12px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#aaa)}
/* unified keyboard focus ring */
.dshx-select:focus-visible,.dshx-iconbtn:focus-visible,.dshx-ghostbtn:focus-visible,.dshx-primarybtn:focus-visible,.dshx-chipbtn:focus-visible,.dshx-chip:focus-visible,.dshx-segbtn:focus-visible,.dshx-example:focus-visible,.dshx-menuitem:focus-visible,.dshx-send:focus-visible,.dshx-stop:focus-visible,.dshx-viewtab:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 30%,transparent)}
/* brand-fill surface with a hard-coded #fff foreground: the brand alias is
   monochrome (near-black in light, near-white in dark), so dark mode needs
   the enabled foreground flipped to ink or the send arrow vanishes —
   disabled keeps its own brand-mix ghost (theme-invariant both ways). The
   welcome glyph is the toolbar icon artwork (an img) and needs no
   foreground. */
body[data-ds-dark-theme] .dshx-send:not(:disabled){color:var(--dsw-static-neutral-bluish-1000,#171717)}
/* ≤560px the history button sits ~210px from the panel's left edge; the
   300px right-anchored sheet would spill past it. Pin the sheet inside the
   panel instead (viewport = this extension page). Doubled specificity beats
   POPOVER_CSS, which joins after SHELL_CSS. */
@media (max-width: 560px){
  .dshx-pop.dshx-sessionspop{position:fixed;left:8px;right:8px;top:50px;width:auto}
}
/* ── full-page posture (?view=full): dsh-desktop-like rail + hero frame ──
   The stage wrapper is layout-inert in the docked posture (display:contents
   keeps runline/body/caps/composer as direct flex children of the root), so
   only the is-full rules change any existing geometry. */
.dshx-stage{display:contents}
.dshx-root.is-full{flex-direction:row}
.dshx-root.is-full .dshx-stage{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.dshx-root.is-full .dshx-header{display:none}
.dshx-main{position:relative}
.dshx-rail{width:248px;box-sizing:border-box;flex:none;display:flex;flex-direction:column;gap:8px;min-height:0;padding:14px 12px 12px;border-right:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));background:var(--dsw-alias-bg-base,#fff);overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.35)) transparent}
@media (max-width:640px){.dshx-rail{width:200px}}
.dshx-railbrand{display:flex;align-items:center;gap:8px;padding:2px 4px}
.dshx-railbrand img{width:22px;height:22px;flex:none}
.dshx-railbrand-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}
.dshx-railnav{display:flex;flex-direction:column;gap:2px}
.dshx-railitem{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;font-size:12.5px;text-align:left;transition:background .15s ease,color .15s ease}
.dshx-railitem:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#171717)}
.dshx-railitem.is-armed{color:var(--error,#dc2626)}
.dshx-railitem-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshx-railitem-host{display:flex}
.dshx-raillabel{font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary,#999);padding:8px 4px 0}
.dshx-railsearch{flex:none;height:30px;min-width:0;padding:0 10px;border:0;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#171717);font-size:12px}
.dshx-railsearch:focus-visible{outline:none;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 30%,transparent)}
.dshx-railsessions{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.35)) transparent}
.dshx-railsession{position:relative;display:flex;align-items:center;gap:2px;border-radius:8px}
.dshx-railsession-main{flex:1;min-width:0;display:flex;align-items:center;gap:6px;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#171717);cursor:pointer;text-align:left}
.dshx-railsession-main:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05))}
.dshx-railsession.is-active .dshx-railsession-main{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06))}
.dshx-railsession.is-active .dshx-railsession-title{font-weight:600}
.dshx-railsession-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.dshx-railsession-time{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#999)}
.dshx-railsession-op{flex:none;display:flex;align-items:center;justify-content:center;width:20px;height:20px;margin-right:2px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer;opacity:0;transition:opacity .15s ease,color .15s ease}
.dshx-railsession:hover .dshx-railsession-op,.dshx-railsession-op.is-armed,.dshx-railsession-op:focus-visible{opacity:1}
.dshx-railsession-op:hover{color:var(--dsw-alias-label-primary,#171717)}
.dshx-railsession-op.is-armed{color:var(--error,#dc2626)}
.dshx-railrename{flex:1;min-width:0;height:26px;padding:0 8px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 55%,transparent);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#171717);font-size:12px}
.dshx-railrename:focus-visible{outline:none}
.dshx-railempty{padding:12px 8px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#999)}
.dshx-railfooter{flex:none;display:flex;flex-direction:column;gap:2px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
/* hero: brand welcome + composer centered mid-stage over the transcript —
   the extra bottom padding lifts the composition's center of mass (the dsh
   desktop hero sits above the vertical midpoint) */
.dshx-hero{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;width:100%;padding:32px 24px 16vh;overflow-y:auto;background:var(--dsw-alias-bg-base,#fff)}
.dshx-hero .dshx-welcome{margin:0;flex:none}
.dshx-hero-composer{width:100%;max-width:760px;flex:none}
.dshx-hero-composer .dshx-composer{padding:0}
/* Full-page posture: the welcome composition scales up to fill the stage —
   the compact sizes above are tuned for the 340px side panel and read as a
   small floating block on a desktop viewport. The composer keeps the docked
   lane's 760px cap so the first send doesn't jump the input width. */
.dshx-root.is-full .dshx-hero{gap:36px}
/* Full-page hero canvas: one smooth brand radial ON the hero element itself —
   it spans the whole stage so the fade can never show a box edge, and the
   welcome column's own ::before glow (a 7%-tint ellipse on a fixed box) is
   switched off: on a wide canvas its sRGB fade read as a gray rectangle. */
.dshx-root.is-full .dshx-hero{background:radial-gradient(1200px 760px at 50% 24%,color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 5%,transparent),transparent 58%),var(--dsw-alias-bg-base,#fff)}
/* The welcome column shrink-wraps to its widest text child, so the
   percentage-width example list would ride that narrower box — give the
   column the example list's target width instead. */
.dshx-root.is-full .dshx-hero .dshx-welcome{gap:20px;min-width:min(640px,calc(100vw - 320px))}
.dshx-root.is-full .dshx-hero .dshx-welcome-glyph{width:96px;height:96px}
.dshx-root.is-full .dshx-hero .dshx-welcome-title{font-size:30px;letter-spacing:-.02em}
.dshx-root.is-full .dshx-hero .dshx-welcome-sub{max-width:520px;font-size:15px}
.dshx-root.is-full .dshx-hero .dshx-examples{max-width:640px;gap:10px;margin-top:16px}
.dshx-root.is-full .dshx-hero .dshx-example{gap:14px;padding:14px 18px;border-radius:16px;font-size:14px;border-color:transparent;box-shadow:none}
.dshx-root.is-full .dshx-hero .dshx-example:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 40%,transparent);box-shadow:0 3px 10px rgba(15,18,26,.07)}
.dshx-root.is-full .dshx-hero .dshx-example-icon{width:34px;height:34px;border-radius:10px}
.dshx-root.is-full .dshx-hero .dshx-example-icon svg{width:18px;height:18px}
.dshx-root.is-full .dshx-hero .dshx-example svg.dshx-example-arrow{width:16px;height:16px}
.dshx-root.is-full .dshx-hero .dshx-welcome-hint{font-size:13px}
.dshx-root.is-full .dshx-hero .dshx-welcome-hint kbd{font-size:11.5px;line-height:17px;padding:1px 6px}
/* the only full-page strip override left: the hero rule zeroes the whole
   padding, and the centered hero lane still wants the 12 px side gutters */
.dshx-root.is-full .dshx-composer{padding-left:12px;padding-right:12px}
/* hero phase hides the capability strip entirely: an empty session has
   nothing for it to say, and the strip read as unexplained chrome */
.dshx-root.is-full:has(.dshx-hero) .dshx-caps-lane{display:none}
/* ── phone-style settings (extension-settings-root) ──
   The extension's own sheet chrome (dshx-set* classes) plus a scoped restyle
   of the upstream section rows inside the drill-down body. Row targeting uses
   the stable [data-slot] anchors and safe class stems only — the two
   sheet-guard stems stay out of this stylesheet (see caps-css spec). */
.dshx-setovl{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(15,18,26,.42)}
.dshx-setmask{position:absolute;inset:0}
.dshx-setpage{position:relative;display:flex;flex-direction:column;width:min(560px,calc(100vw - 32px));height:min(640px,calc(100vh - 48px));border-radius:16px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 24px 64px rgba(15,18,26,.24);overflow:hidden}
@media (max-width:640px){
  .dshx-setpage{width:100vw;height:100vh;border-radius:0}
}
.dshx-sethead{flex:none;display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.dshx-settitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600;text-align:center}
.dshx-setback,.dshx-setclose{flex:none;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#777);cursor:pointer;transition:background .15s ease,color .15s ease}
.dshx-setback:hover,.dshx-setclose:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#171717)}
.dshx-setback:focus-visible,.dshx-setclose:focus-visible,.dshx-setrow:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 30%,transparent)}
.dshx-setmenu{flex:1;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.35)) transparent}
.dshx-setrow{display:flex;align-items:center;gap:10px;width:100%;padding:13px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,#171717);cursor:pointer;font-size:13px;text-align:left;transition:border-color .15s ease,background .15s ease}
.dshx-setrow:hover{border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.2));background:var(--dsw-alias-bg-base,#fff)}
.dshx-setrowicon{display:flex;align-items:center;color:var(--dsw-alias-label-secondary,#777)}
.dshx-setrowlabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.dshx-setrowchev{display:flex;align-items:center;color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-setempty{padding:20px 12px;font-size:12px;line-height:1.7;text-align:center;color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-setbody{flex:1;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.35)) transparent}
/* Section content becomes one inset group card: the settings slot wrapper is
   a real element, and the card is the section container one level below it
   (rows keep their hairline separators inside it). The {hash}_section stem
   covers every section package's container uniformly; the direct-child scope
   keeps an inner page section (the plugins inventory reuses the same stem)
   from nesting a second card inside the first. */
.dshx-setbody [data-slot="settings.section"] > [class*="_section"]{flex:none;min-width:0;max-width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;background:var(--dsw-alias-bg-base,#fff);padding:0 12px}
/* The sheet header already names the page, so the in-card page heading and
   intro line are chrome the card doesn't need — hidden on every section
   page (plugins _heading, models/agent-preset _title, all three _intro;
   row titles sit deeper in each tree and never match). */
.dshx-setbody [data-slot="settings.section"] > [class*="_section"] > [class*="_heading"],
.dshx-setbody [data-slot="settings.section"] > [class*="_section"] > [class*="_title"],
.dshx-setbody [data-slot="settings.section"] > [class*="_section"] > [class*="_intro"]{display:none}
/* Working-area pages (the plugins inventory, the agent-preset cards) are not
   row columns: their group heads carry no top padding of their own, so the
   card interior adds the 12px breathing instead of leaning on row padding
   ([data-settings-page] is the stable component attribute those section
   components render for this). */
.dshx-setbody [data-slot="settings.section"] > [class*="_section"][data-settings-page]{padding:12px}
/* General rows keep their upstream padding/hairline styling — a bare
   [class*="row"] here would also hit the models section's rowCard/rowHead
   stems and flatten those cards. */
.dshx-setbody [data-slot="settings.general.item"] [class*="title"]{font-size:13px}
.dshx-setbody [data-slot="settings.general.item"] [class*="desc"]{font-size:11px}
/* The permission row's unavailable-route essay reads as breakage on this
   host; the row keeps its control (the composer chip covers the mode). */
.dshx-setbody [role="alert"]{display:none}
/* ── extension presets page (Agent 预设 drill-down, presets-page.tsx) ──
   The root carries the section card's own material (it has no _section
   stem, so the generic card rule above doesn't double-card it). */
.dshx-sproot{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;background:var(--dsw-alias-bg-base,#fff);padding:12px;font-size:13px}
.dshx-sphead{margin:2px 0 0;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary,#999)}
.dshx-splist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.dshx-sprow{display:flex;align-items:flex-start;gap:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;padding:10px 12px;transition:border-color .15s ease}
.dshx-sprow.is-default{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 45%,transparent)}
.dshx-sprow.is-broken{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 45%,transparent)}
.dshx-sprow-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.dshx-sprow-top{display:flex;align-items:center;gap:6px;min-width:0}
.dshx-sprow-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshx-sptag{flex:none;padding:1px 7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:999px;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#888)}
.dshx-sptag.is-solid{border-color:transparent;background:var(--dsw-alias-label-primary,#171717);color:var(--dsw-alias-bg-base,#fff)}
.dshx-spid{flex:none;margin-left:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-sprow-desc{margin:0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#888)}
.dshx-sprow-actions{flex:none;display:flex;align-items:center;gap:2px;padding-top:2px}
.dshx-spact{flex:none;height:26px;padding:0 8px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#888);cursor:pointer;font-size:11.5px;line-height:26px;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;transition:background .15s ease,color .15s ease}
.dshx-spact:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#171717)}
.dshx-spact.is-armed.is-arming{background:color-mix(in srgb,var(--error,#dc2626) 12%,transparent);color:var(--error,#dc2626)}
.dshx-spempty{padding:10px 12px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:12px;font-size:12px;color:var(--dsw-alias-label-tertiary,#aaa);text-align:center}
.dshx-spcreate{align-self:stretch;display:flex;align-items:center;justify-content:center;height:40px;border:1px dashed var(--dsw-alias-border-l3,rgba(0,0,0,.2));border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary,#171717);cursor:pointer;font-size:13px;transition:background .15s ease}
.dshx-spcreate:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04))}
.dshx-spform{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;padding:12px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03))}
.dshx-spform-row{display:flex;gap:10px}
.dshx-spform-row .dshx-spfield{flex:1;min-width:0}
.dshx-spfield{display:flex;flex-direction:column;gap:4px;min-width:0}
.dshx-spfield-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}
.dshx-spinput,.dshx-sptext{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;padding:7px 9px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#171717);font:inherit;font-size:12.5px;outline:none}
.dshx-sptext{resize:vertical;line-height:1.6}
.dshx-spinput:focus-visible,.dshx-sptext:focus-visible{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 22%,transparent)}
.dshx-spform-actions{display:flex;justify-content:flex-end;gap:8px}
.dshx-sperror{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#dc2626)}
.dshx-spdocovl{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;background:rgba(15,18,26,.42)}
.dshx-spdocmask{position:absolute;inset:0}
.dshx-spdoc{position:relative;display:flex;flex-direction:column;width:min(680px,calc(100vw - 32px));max-height:min(600px,calc(100vh - 48px));border-radius:16px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 24px 64px rgba(15,18,26,.24);overflow:hidden}
.dshx-spdochead{flex:none;display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.dshx-spdoctitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600;text-align:center}
.dshx-spdoccode{flex:1;min-height:0;margin:0;padding:12px;overflow:auto;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));color:var(--dsw-alias-label-secondary,#555);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
/* 预设能力开关网格（presets-page 表单）：chip 三态视觉——浅=跟随默认，实底=开，描边=关 */
.dshx-spcaps{display:flex;flex-wrap:wrap;gap:6px}
.dshx-spcap{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:999px;padding:4px 10px;background:transparent;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer;font-size:11.5px;transition:background .15s ease,color .15s ease,border-color .15s ease}
.dshx-spcap:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05))}
.dshx-spcap.is-touched.is-on{background:var(--dsw-alias-label-primary,#171717);color:var(--dsw-alias-bg-base,#fff);border-color:transparent}
.dshx-spcap.is-touched:not(.is-on){border-color:color-mix(in srgb,var(--error,#dc2626) 55%,transparent);color:var(--error,#dc2626)}
.dshx-auto-fieldlabel{display:flex;align-items:center;justify-content:space-between;gap:8px}
/* ── 服务面板四卡精修（account/credentials/mcp/schedule）──
   四卡自有样式按 340px 侧栏调；服务面板的全宽双列里原样铺开就是灰板。
   本块只做面板级 dressing：卡片表面、输入与按钮规格统一（scoped 到
   .dshx-up——服务面板独占的 overlay 容器），层级靠留白与描边不靠重色。 */
.dshx-up .dshx-acct,.dshx-up .dshx-cred,.dshx-up .dshx-mcp,.dshx-up .dshx-sched{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:14px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 1px 2px rgba(15,18,26,.04);padding:14px;gap:10px}
.dshx-up .dshx-acct-head,.dshx-up .dshx-cred-head,.dshx-up .dshx-mcp-head,.dshx-up .dshx-sched-head{padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));margin-bottom:2px}
.dshx-up .dshx-acct-title,.dshx-up .dshx-cred-title,.dshx-up .dshx-mcp-title,.dshx-up .dshx-sched-title{font-size:13.5px}
.dshx-up .dshx-acct-sub,.dshx-up .dshx-cred-sub,.dshx-up .dshx-mcp-sub,.dshx-up .dshx-sched-sub{margin-left:auto}
.dshx-up .dshx-cred-row,.dshx-up .dshx-mcp-row,.dshx-up .dshx-sched-row{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));border-radius:10px;padding:8px 10px}
/* MCP 服务器卡（服务面板）：状态点 + 拨片开关 + 命令提示 */
.dshx-up .dshx-mcpsrv{gap:8px}
/* 较长的 locale（en）下副标题换行，不挤压标题：标题保持一行 */
.dshx-up .dshx-mcpsrv .dshx-cred-head{flex-wrap:wrap}
.dshx-up .dshx-mcpsrv .dshx-cred-title{flex:0 0 auto;white-space:nowrap}
.dshx-mcpsrv-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-mcpsrv-dot[data-state="waiting"]{background:var(--dsw-alias-state-warning-primary,#f59e0b)}
.dshx-mcpsrv-dot[data-state="connected"]{background:var(--dsw-alias-state-success-primary,#22a06b);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#22a06b) 18%,transparent)}
.dshx-mcpsrv-status{font-size:12px;color:var(--dsw-alias-label-secondary,#888)}
.dshx-mcpsrv-hint code{display:block;margin-top:4px;padding:5px 8px;border-radius:7px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#888);user-select:all;word-break:break-all}
.dshx-switch{flex:0 0 auto;position:relative;width:34px;height:20px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));cursor:pointer;padding:0;transition:background .18s ease,border-color .18s ease}
.dshx-switch .dshx-switch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 1px 2px rgba(15,18,26,.3);transition:transform .18s ease}
.dshx-switch.is-on{background:var(--dsh-alias-brand-primary,#4c7dfd);border-color:color-mix(in srgb,var(--dsh-alias-brand-primary,#4c7dfd) 60%,transparent)}
.dshx-switch.is-on .dshx-switch-knob{transform:translateX(14px)}
.dshx-switch:disabled{opacity:.55;cursor:default}
.dshx-switch:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsh-alias-brand-primary,#4c7dfd) 30%,transparent)}
.dshx-up .dshx-cred-rowops,.dshx-up .dshx-mcp-rowops,.dshx-up .dshx-sched-rowops{margin-left:auto}
.dshx-up .dshx-cred-input,.dshx-up .dshx-mcp-input,.dshx-up .dshx-sched-input{height:32px;border-radius:8px;border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-base,#fff);padding:0 10px;font-size:12.5px;transition:border-color .15s ease,box-shadow .15s ease}
.dshx-up .dshx-cred-input::placeholder,.dshx-up .dshx-mcp-input::placeholder,.dshx-up .dshx-sched-input::placeholder{color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-up .dshx-cred-input:focus,.dshx-up .dshx-mcp-input:focus,.dshx-up .dshx-sched-input:focus{outline:none;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 22%,transparent)}
.dshx-up .dshx-acct button,.dshx-up .dshx-cred button,.dshx-up .dshx-mcp button,.dshx-up .dshx-sched button{width:auto;height:28px;padding:0 14px;border-radius:8px;font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#171717);transition:background .15s ease,border-color .15s ease,opacity .15s ease}
.dshx-up .dshx-acct button:hover:not(:disabled),.dshx-up .dshx-cred button:hover:not(:disabled),.dshx-up .dshx-mcp button:hover:not(:disabled),.dshx-up .dshx-sched button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05))}
.dshx-up .dshx-acct button:disabled,.dshx-up .dshx-cred button:disabled,.dshx-up .dshx-mcp button:disabled,.dshx-up .dshx-sched button:disabled{opacity:.45;cursor:default}
.dshx-up .dshx-cred-form button,.dshx-up .dshx-mcp-form button{align-self:flex-end}
.dshx-up .dshx-acct-ops button{background:var(--dsw-alias-label-primary,#171717);color:var(--dsw-alias-bg-base,#fff);border-color:transparent}
.dshx-up .dshx-acct-ops button:hover:not(:disabled){background:var(--dsw-alias-label-primary,#171717);filter:opacity(.88)}
`

// ── session switcher ──

/** `session.list` / `session.create` ok values (wire view). */
interface SessionListValue {
  items?: {
    sessionId?: string
    updatedAt?: number
    title?: string
    /** Live agent presence at listing time (drives the boot adopt decision). */
    running?: boolean
    projections?: { values?: { title?: unknown } }
  }[]
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
  /** Folded `session/title` value; undefined falls back to the short id. */
  title?: string | undefined
  /** Live turn state from the listing; a running session cannot be deleted. */
  running?: boolean | undefined
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
          .filter(item => typeof item.sessionId === 'string')
          .slice(0, 20)
          .map(item => ({
            sessionId: item.sessionId as string,
            updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : undefined,
            title: typeof item.title === 'string'
              ? item.title
              : typeof item.projections?.values?.title === 'string'
                ? item.projections.values.title
                : undefined,
            running: item.running === true,
          })),
      )
    }).catch(() => {})
  }, [])
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 20000)
    return () => { clearInterval(timer) }
  }, [refresh])
  return { sessions, refresh }
}

/**
 * Header dropdown listing recent sessions (`session.list`, newest first) with
 * relative-time labels; the active session is highlighted and excluded from
 * re-selection cost via a check mark. Each row carries a rename pencil that
 * swaps in an inline editor committing through `session.rename`, plus a
 * two-step delete (first click arms, second click deletes through
 * `session.delete`). Dismisses via the shared popover contract: outside
 * pointerdown or Esc (capture phase, so panel-level shortcuts cannot eat it).
 */
function SessionMenu({ sessions, currentId, onSelect, onOpen, onRename, onDelete, onClearAll }: {
  sessions: SessionSummary[]
  currentId: string
  onSelect: (sessionId: string) => void
  onOpen: () => void
  onRename: (sessionId: string, title: string) => void
  onDelete: (sessionId: string) => void
  onClearAll: () => void
}): JSX.Element {
  const t = useShellT()
  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  /** The row whose delete affordance is armed (first click of the two-step confirm). */
  const [armedDeleteId, setArmedDeleteId] = useState<string | undefined>(undefined)
  /** Whether the footer clear-all affordance is armed (first click of its two-step confirm). */
  const [armedClearAll, setArmedClearAll] = useState(false)
  /** Content-search state: undefined while no query is active (the recents list). */
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<readonly { sessionId: string; snippet: string }[] | undefined>(undefined)
  const [searchHasMore, setSearchHasMore] = useState(false)
  const [searching, setSearching] = useState(false)
  /** Bumps on every query change; only the newest generation may land results. */
  const searchGeneration = useRef(0)
  const close = useCallback((): void => {
    setOpen(false)
    setArmedDeleteId(undefined)
    setArmedClearAll(false)
    // Leaving the menu also leaves the search: the next open starts on the
    // recents list, not on a stale query's results.
    setSearchQuery('')
    setSearchResults(undefined)
    setSearchHasMore(false)
    setSearching(false)
  }, [])
  const wrapRef = useRef<HTMLDivElement>(null)
  usePopoverDismiss(open, close, wrapRef)

  // Content search over the Host's visible-message index. Debounced, and each
  // query generation supersedes the previous one's response (a stale answer
  // must not overwrite a newer one — the rpc face has no cancellation, so the
  // guard is a per-effect generation counter). Failures fall back to the
  // recents list quietly — search is an enhancement, not a load-bearing path.
  useEffect(() => {
    if (!open) return undefined
    const query = searchQuery.trim()
    if (query === '') {
      setSearchResults(undefined)
      setSearchHasMore(false)
      setSearching(false)
      return undefined
    }
    setSearching(true)
    const generation = ++searchGeneration.current
    const timer = setTimeout(() => {
      void rpc('session.search', { query }, 15_000).then((result) => {
        if (searchGeneration.current !== generation) return
        if (result.ok) {
          const value = result.value as { items?: { sessionId?: unknown; snippet?: unknown }[]; hasMore?: boolean } | undefined
          setSearchResults((value?.items ?? [])
            .filter(item => typeof item.sessionId === 'string' && typeof item.snippet === 'string')
            .map(item => ({ sessionId: item.sessionId as string, snippet: item.snippet as string })))
          setSearchHasMore(value?.hasMore === true)
        } else {
          setSearchResults([])
          setSearchHasMore(false)
        }
        setSearching(false)
      }).catch(() => {
        if (searchGeneration.current === generation) { setSearchResults(undefined); setSearching(false) }
      })
    }, 250)
    return () => { clearTimeout(timer) }
  }, [open, searchQuery])

  const beginRename = useCallback((item: SessionSummary): void => {
    setArmedDeleteId(undefined)
    setArmedClearAll(false)
    setRenamingId(item.sessionId)
    setDraft(item.title ?? shortSessionLabel(item.sessionId))
  }, [])

  const commitRename = useCallback((): void => {
    if (renamingId !== undefined && draft.trim() !== '') onRename(renamingId, draft.trim())
    setRenamingId(undefined)
  }, [renamingId, draft, onRename])

  const titleOf = useCallback((sessionId: string): string => {
    const known = sessions.find(item => item.sessionId === sessionId)
    return known?.title !== undefined && known.title !== '' ? known.title : shortSessionLabel(sessionId)
  }, [sessions])

  return (
    <div className="dshx-menuwrap" ref={wrapRef}>
      <button
        type="button"
        className="dshx-iconbtn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('shell.sessionMenu.historyLabel')}
        title={t('shell.sessionMenu.historyLabel')}
        onClick={() => {
          if (!open) onOpen()
          setOpen(next => !next)
        }}
      >
        <HistoryIcon />
        <ChevronDownIcon size={10} />
      </button>
      {open && (
        <div className="dshx-pop dshx-pop--down dshx-sessionspop" role="menu" aria-label={t('shell.sessionMenu.recentHeading')}>
          <div className="dshx-menuhead">{t('shell.sessionMenu.recentHeading')}</div>
          <input
            type="text"
            className="dshx-search-input"
            placeholder={t('shell.sessionMenu.searchPlaceholder')}
            aria-label={t('shell.sessionMenu.searchLabel')}
            value={searchQuery}
            onChange={(event) => { setSearchQuery(event.target.value) }}
            onKeyDown={(event) => { event.stopPropagation() }}
          />
          {searchQuery.trim() !== '' ? (
            searching && searchResults === undefined ? <div className="dshx-menuempty">{t('shell.sessionMenu.searching')}</div>
              : searchResults !== undefined && searchResults.length > 0 ? (
                <>
                  {searchResults.map((item) => {
                    const current = item.sessionId === currentId
                    return (
                      <button
                        key={item.sessionId}
                        type="button"
                        role="menuitem"
                        className={`dshx-menuitem has-snippet${current ? ' is-current' : ''}`}
                        title={item.sessionId}
                        onClick={() => {
                          setOpen(false)
                          setSearchQuery('')
                          setSearchResults(undefined)
                          if (!current) onSelect(item.sessionId)
                        }}
                      >
                        {current && <span className="dshx-menuitem-check"><CheckIcon size={12} /></span>}
                        <span className="dshx-menuitem-name">
                          {titleOf(item.sessionId)}
                          <span className="dshx-snippet">{item.snippet}</span>
                        </span>
                      </button>
                    )
                  })}
                  {searchHasMore && <div className="dshx-search-more">{t('shell.sessionMenu.moreMatches')}</div>}
                </>
              )
                : <div className="dshx-menuempty">{searching ? t('shell.sessionMenu.searching') : t('shell.sessionMenu.noMatches')}</div>
          ) : (
            <>
              {sessions.length === 0 && <div className="dshx-menuempty">{t('shell.sessionMenu.empty')}</div>}
              {sessions.map((item) => {
                const current = item.sessionId === currentId
                const label = item.title !== undefined && item.title !== ''
                  ? item.title
                  : shortSessionLabel(item.sessionId)
                if (renamingId === item.sessionId) {
                  return (
                    <div key={item.sessionId} className="dshx-menuitem is-rename">
                      <input
                        autoFocus
                        className="dshx-rename-input"
                        value={draft}
                        aria-label={t('shell.sessionMenu.titleInput')}
                        onChange={(event) => { setDraft(event.target.value) }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitRename()
                          if (event.key === 'Escape') setRenamingId(undefined)
                        }}
                        onClick={(event) => { event.stopPropagation() }}
                      />
                      <button
                        type="button"
                        className="dshx-iconbtn"
                        title={t('shell.sessionMenu.saveTitle')}
                        onClick={(event) => { event.stopPropagation(); commitRename() }}
                      >
                        <CheckIcon size={12} />
                      </button>
                    </div>
                  )
                }
                return (
                  <button
                    key={item.sessionId}
                    type="button"
                    role="menuitem"
                    className={`dshx-menuitem${current ? ' is-current' : ''}`}
                    title={item.sessionId}
                    onClick={() => {
                      setOpen(false)
                      setArmedDeleteId(undefined)
                      setArmedClearAll(false)
                      if (!current) onSelect(item.sessionId)
                    }}
                  >
                    {current && <span className="dshx-menuitem-check"><CheckIcon size={12} /></span>}
                    <span className="dshx-menuitem-name">{label}</span>
                    <span className="dshx-menuitem-time">{formatRelative(item.updatedAt)}</span>
                    <span
                      className="dshx-menuitem-rename"
                      role="button"
                      aria-label={t('shell.sessionMenu.rename')}
                      title={t('shell.sessionMenu.rename')}
                      onClick={(event) => {
                        event.stopPropagation()
                        beginRename(item)
                      }}
                    >
                      <PencilIcon size={12} />
                    </span>
                    <span
                      className={`dshx-menuitem-delete${armedDeleteId === item.sessionId ? ' is-armed' : ''}`}
                      role="button"
                      aria-label={armedDeleteId === item.sessionId ? t('shell.sessionMenu.deleteConfirm') : t('shell.sessionMenu.delete')}
                      title={armedDeleteId === item.sessionId ? t('shell.sessionMenu.deleteConfirmAgain') : t('shell.sessionMenu.delete')}
                      onClick={(event) => {
                        event.stopPropagation()
                        setArmedClearAll(false)
                        if (armedDeleteId === item.sessionId) {
                          setArmedDeleteId(undefined)
                          setOpen(false)
                          onDelete(item.sessionId)
                          return
                        }
                        setArmedDeleteId(item.sessionId)
                      }}
                    >
                      <CloseIcon size={12} />
                    </span>
                  </button>
                )
              })}
              {sessions.length > 0 && (
                <div className="dshx-menufoot">
                  <button
                    type="button"
                    className={`dshx-clearall${armedClearAll ? ' is-armed' : ''}`}
                    onClick={() => {
                      if (armedClearAll) {
                        setArmedClearAll(false)
                        setOpen(false)
                        onClearAll()
                        return
                      }
                      setArmedDeleteId(undefined)
                      setArmedClearAll(true)
                    }}
                  >
                    {armedClearAll
                      ? t('shell.sessionMenu.clearAllConfirm', { count: sessions.length })
                      : t('shell.sessionMenu.clearAll', { count: sessions.length })}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── transcript pieces ──

/** User message: right-aligned bubble on the static DeepSeek blue (theme-invariant). */
function UserBubble({ text }: { text: string }): JSX.Element {
  return (
    <div className="dshx-userrow">
      <div className="dshx-userbubble">{text}</div>
    </div>
  )
}

/** Reasoning block: collapsed muted card inside the assistant bubble. */
function ReasoningCard({ text }: { text: string }): JSX.Element {
  const t = useShellT()
  return (
    <details className="dshx-card">
      <summary className="dshx-summary">
        {t('shell.transcript.reasoning')}
        <span className="dshx-chevron"><ChevronDownIcon size={12} /></span>
      </summary>
      <div className="dshx-reason">{text}</div>
    </details>
  )
}

/** Tool invocation requested by the model: collapsible name + arguments card. */
function ToolCallCard({ name, argumentsJson }: { name: string; argumentsJson: string }): JSX.Element {
  const t = useShellT()
  return (
    <details className="dshx-card">
      <summary className="dshx-summary">
        <span className="dshx-summary-name">{t('shell.transcript.toolCall', { name })}</span>
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
  const t = useShellT()
  return (
    <details className={`dshx-card dshx-res${ok ? '' : ' iserr'}`}>
      <summary className="dshx-summary">
        <span className="dshx-dot" />
        <span className="dshx-summary-name">{name}</span>
        <span className="dshx-summary-text">{summary === '' ? (ok ? t('shell.transcript.done') : t('shell.transcript.failed')) : summary}</span>
        <button
          type="button"
          className="dshx-chipbtn"
          title={t('shell.transcript.viewDetail')}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onOpenDetail()
          }}
        >
          {t('shell.transcript.details')}
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
  const t = useShellT()
  const failed = done?.kind === 'error'
  const outcome = done === undefined
    ? t('shell.transcript.running')
    : failed
      ? (done.text ?? t('shell.transcript.commandFailed'))
      : (done.text ?? t('shell.transcript.done'))
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
  const t = useShellT()
  return (
    <div className="dshx-error">
      <div className="dshx-error-text">{t('shell.transcript.errorPrefix', { message })}</div>
      <div className="dshx-error-actions">
        {retryText !== null && (
          <button
            type="button"
            className="dshx-chipbtn iserr"
            title={t('shell.transcript.resendTitle', { text: summarize(retryText, 80) })}
            onClick={() => { onRetry(retryText) }}
          >
            <RetryIcon size={12} />
            {t('shell.transcript.retry')}
          </button>
        )}
        <CopyChip label={t('shell.transcript.copy')} copiedLabel={t('shell.transcript.copied')} getText={() => message} />
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
  const t = useShellT()
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
          <CopyChip label={t('shell.transcript.copy')} copiedLabel={t('shell.transcript.copied')} getText={() => fullText} />
        </div>
      )}
    </div>
  )
}

/** Empty-transcript welcome: brand framing + the slash-command pointer. */
function EmptyState(): JSX.Element {
  const t = useShellT()
  return (
    <div className="dshx-welcome">
      {/* The brand tile IS the toolbar icon (public/icons/icon.svg): one mark
          everywhere. sidepanel.html sits at the extension root, so the
          manifest-copied icons/ directory is addressable relative to it. */}
      <span className="dshx-welcome-glyph"><img src="icons/icon.svg" alt="" /></span>
      <div className="dshx-welcome-title">{t('shell.brand.name')}</div>
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
      // A loaded skill's instruction body is machine input the model follows:
      // render a collapsed row naming the skill, never the raw <skill_content>
      // text as a chat bubble. The skill-catalog reminder never reaches this
      // view (the api-bridge history face drops it).
      if (source?.kind === 'skill-invocation') {
        const name = typeof source.name === 'string' && source.name !== '' ? source.name : 'skill'
        const text = (d.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
        return (
          <details className="dshx-skillrow">
            <summary className="dshx-skillrow-head">
              <span className="dshx-skillrow-tag">{shellT()('shell.transcript.skillTag')}</span>
              <span className="dshx-skillrow-name">{name}</span>
              <span className="dshx-chevron"><ChevronDownIcon size={12} /></span>
            </summary>
            <div className="dshx-skillrow-body">{text}</div>
          </details>
        )
      }
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
        return <ErrorBar message={d.reason.error?.message ?? shellT()('shell.common.unknownError')} retryText={retryText} onRetry={onRetry} />
      }
      return null
    }
    default:
      return null
  }
}

/**
 * The rail's local-folder workspace row (the engine mounts the picked folder
 * as `/local/...` over the shared IndexedDB handle — see dir-workspace.ts):
 * pick, re-grant after a browser restart, or remove. Re-reads its status
 * whenever it regains a user gesture (a pick/re-grant click) so the badge
 * tracks the browser's permission state.
 */
function RailWorkspaceSection({ sessionKey }: { sessionKey: string }): JSX.Element {
  const t = useShellT()
  const [status, setStatus] = useState<LocalWorkspaceStatus | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await localWorkspaceStatus(sessionKey))
    } catch {
      // The handle store is unreadable: render the unpicked state.
      setStatus({ permission: 'none' })
    }
  }, [sessionKey])
  useEffect(() => { void refresh() }, [refresh])

  if (status === undefined) return <div className="dshx-raillabel" style={{ visibility: 'hidden' }}>{t('shell.rail.workspace')}</div>
  const entry = status.entry
  const needsRegrant = entry !== undefined && status.permission !== 'granted'

  const pick = async (): Promise<void> => {
    setBusy(true)
    try {
      await pickLocalWorkspace(sessionKey)
      await refresh()
    } catch (err) {
      // User cancelled the picker (or the browser refused): keep the old state,
      // but surface real failures — a silent catch here would hide a stuck pick.
      console.warn('[ws] pick failed:', err)
    } finally {
      setBusy(false)
    }
  }
  const regrant = async (): Promise<void> => {
    setBusy(true)
    try {
      await reauthorizeLocalWorkspace(sessionKey)
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      await removeLocalWorkspace(sessionKey)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="dshx-raillabel">{t('shell.rail.workspace')}</div>
      {entry === undefined ? (
        <button
          type="button"
          className="dshx-railitem"
          disabled={busy}
          title={t('shell.rail.pickFolderTitle')}
          onClick={() => { void pick() }}
        >
          <FolderIcon size={14} />
          <span className="dshx-railitem-label">{t('shell.rail.pickFolder')}</span>
        </button>
      ) : (
        <div className={`dshx-railsession${needsRegrant ? ' is-regrant' : ''}`} title={needsRegrant ? t('shell.rail.regrantNeeded') : t('shell.rail.grantedTitle')}>
          <span className="dshx-railsession-main" style={{ cursor: 'default' }}>
            <FolderIcon size={14} />
            <span className="dshx-railsession-title">{entry.name}</span>
          </span>
          {needsRegrant && (
            <button
              type="button"
              className="dshx-railsession-op is-armed"
              aria-label={t('shell.rail.regrantLabel')}
              title={t('shell.rail.regrant')}
              disabled={busy}
              onClick={() => { void regrant() }}
            >
              ↻
            </button>
          )}
          <button
            type="button"
            className="dshx-railsession-op"
            aria-label={t('shell.rail.removeLabel')}
            title={t('shell.rail.remove')}
            disabled={busy}
            onClick={() => { void remove() }}
          >
            <CloseIcon size={12} />
          </button>
        </div>
      )}
    </>
  )
}

/**
 * The full-page posture's left rail — the dsh-desktop sidebar counterpart:
 * brand row, 新会话, plugin/settings navigation, a persistent session list
 * (search, rename, two-step delete, two-step clear-all — the same handlers
 * the header SessionMenu binds), and a browser-fullscreen toggle. The rail
 * never renders in the docked side panel; the slot mount for settings arrives
 * as a rendered element (`settingsMount` prop — the rail passes the labeled
 * owner variant) so exactly one settings root
 * exists per document.
 */
function SessionRail({
  sessions, currentId, onSelect, onNewSession, onRename, onDelete, onClearAll,
  pluginsOpen, servicesOpen, automationOpen, updateAvailable,
  onOpenPlugins, onOpenServices, onOpenAutomation, settingsMount,
}: {
  sessions: SessionSummary[]
  currentId: string
  onSelect: (sessionId: string) => void
  onNewSession: () => void
  onRename: (sessionId: string, title: string) => void
  onDelete: (sessionId: string) => void
  onClearAll: () => void
  pluginsOpen: boolean
  servicesOpen: boolean
  automationOpen: boolean
  updateAvailable: boolean
  onOpenPlugins: () => void
  onOpenServices: () => void
  onOpenAutomation: () => void
  settingsMount: ReactNode
}): JSX.Element {
  const t = useShellT()
  const [query, setQuery] = useState('')
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  /** The row whose delete affordance is armed (first click of the two-step confirm). */
  const [armedDeleteId, setArmedDeleteId] = useState<string | undefined>(undefined)
  /** Whether the footer clear-all affordance is armed (first click of its two-step confirm). */
  const [armedClearAll, setArmedClearAll] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const sync = (): void => { setFullscreen(document.fullscreenElement !== null) }
    document.addEventListener('fullscreenchange', sync)
    return () => { document.removeEventListener('fullscreenchange', sync) }
  }, [])

  // Title/id filter over the recents feed — the rail's lightweight counterpart
  // of the popover's content search (full-text search stays a popover feature).
  const needle = query.trim().toLowerCase()
  const shown = needle === ''
    ? sessions
    : sessions.filter(item =>
      (item.title ?? '').toLowerCase().includes(needle) || item.sessionId.toLowerCase().includes(needle))

  const toggleFullscreen = (): void => {
    if (document.fullscreenElement !== null) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => {})
  }

  return (
    <aside className="dshx-rail">
      <div className="dshx-railbrand">
        <img src="icons/icon.svg" alt="" />
        <span className="dshx-railbrand-name">{t('shell.brand.name')}</span>
      </div>
      <button type="button" className="dshx-primarybtn" title={t('shell.rail.newTaskTitle')} onClick={onNewSession}>
        {t('shell.rail.newTask')}
      </button>
      <nav className="dshx-railnav">
        <button
          type="button"
          className={`dshx-railitem${pluginsOpen ? ' is-active' : ''}`}
          onClick={onOpenPlugins}
        >
          <PuzzleIcon size={14} />
          <span className="dshx-railitem-label">{t('shell.rail.userPlugins')}</span>
        </button>
        <button
          type="button"
          className={`dshx-railitem${automationOpen ? ' is-active' : ''}`}
          onClick={onOpenAutomation}
        >
          <ClockIcon size={14} />
          <span className="dshx-railitem-label">{t('shell.rail.automation')}</span>
        </button>
        <button
          type="button"
          className={`dshx-railitem${servicesOpen ? ' is-active' : ''}`}
          aria-label={updateAvailable ? t('shell.rail.servicesUpdate') : t('shell.rail.services')}
          title={updateAvailable ? t('shell.rail.servicesUpdate') : undefined}
          onClick={onOpenServices}
        >
          <ServerIcon size={14} />
          <span className="dshx-railitem-label">{t('shell.rail.services')}</span>
          {updateAvailable && <span className="dshx-updot" aria-hidden="true" />}
        </button>
        <div className="dshx-railitem-host">{settingsMount}</div>
      </nav>
      <RailWorkspaceSection sessionKey={currentId} />
      <div className="dshx-raillabel">{t('shell.rail.sessions')}</div>
      <input
        className="dshx-railsearch"
        value={query}
        placeholder={t('shell.rail.searchPlaceholder')}
        onChange={(event) => { setQuery(event.target.value) }}
      />
      <div className="dshx-railsessions">
        {shown.map((item) => {
          const current = item.sessionId === currentId
          if (renamingId === item.sessionId) {
            return (
              <div key={item.sessionId} className="dshx-railsession is-rename">
                <input
                  autoFocus
                  className="dshx-railrename"
                  value={draft}
                  onChange={(event) => { setDraft(event.target.value) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      if (draft.trim() !== '') onRename(item.sessionId, draft.trim())
                      setRenamingId(undefined)
                    }
                    if (event.key === 'Escape') setRenamingId(undefined)
                  }}
                  onBlur={() => {
                    if (renamingId !== undefined) {
                      if (draft.trim() !== '') onRename(item.sessionId, draft.trim())
                      setRenamingId(undefined)
                    }
                  }}
                />
              </div>
            )
          }
          return (
            <div key={item.sessionId} className={`dshx-railsession${current ? ' is-active' : ''}`}>
              <button
                type="button"
                className="dshx-railsession-main"
                title={item.sessionId}
                onClick={() => {
                  setArmedDeleteId(undefined)
                  if (!current) onSelect(item.sessionId)
                }}
              >
                <span className="dshx-railsession-title">{item.title ?? t('shell.rail.untitled')}</span>
                <span className="dshx-railsession-time">{formatRelative(item.updatedAt)}</span>
              </button>
              <button
                type="button"
                className="dshx-railsession-op"
                aria-label={t('shell.rail.renameLabel')}
                title={t('shell.rail.rename')}
                onClick={() => { setRenamingId(item.sessionId); setDraft(item.title ?? '') }}
              >
                <PencilIcon size={12} />
              </button>
              <button
                type="button"
                className={`dshx-railsession-op${armedDeleteId === item.sessionId ? ' is-armed' : ''}`}
                aria-label={t('shell.rail.deleteLabel')}
                title={armedDeleteId === item.sessionId ? t('shell.rail.deleteConfirmAgain') : t('shell.rail.delete')}
                onClick={() => {
                  if (armedDeleteId === item.sessionId) {
                    onDelete(item.sessionId)
                    setArmedDeleteId(undefined)
                  } else {
                    setArmedDeleteId(item.sessionId)
                  }
                }}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          )
        })}
        {shown.length === 0 && (
          <div className="dshx-railempty">{needle === '' ? t('shell.rail.emptyHistory') : t('shell.rail.emptyFilter')}</div>
        )}
      </div>
      <div className="dshx-railfooter">
        <button
          type="button"
          className={`dshx-railitem${armedClearAll ? ' is-armed' : ''}`}
          title={armedClearAll ? t('shell.rail.confirmAgain') : t('shell.rail.clearAllTitle')}
          onClick={() => {
            if (armedClearAll) {
              onClearAll()
              setArmedClearAll(false)
            } else {
              setArmedClearAll(true)
            }
          }}
        >
          <span className="dshx-railitem-label">{armedClearAll ? t('shell.rail.confirmAgain') : t('shell.rail.clearAll')}</span>
        </button>
        <button type="button" className="dshx-railitem" onClick={toggleFullscreen}>
          <FullscreenIcon size={14} />
          <span className="dshx-railitem-label">{fullscreen ? t('shell.rail.exitFullscreen') : t('shell.rail.fullscreen')}</span>
        </button>
      </div>
    </aside>
  )
}

/**
 * The conversation area: reads `session.history` for the active session over
 * the bridge Port and renders the event log as a chat transcript. Refreshes on
 * a 2 s poll while the engine streams (the simplification for live updates),
 * immediately whenever the parent sends a prompt (`refreshSeq` bump), and
 * re-reads from scratch when the active session changes; sticks to the bottom
 * while the reader is at the bottom.
 */
function ConversationView({ sessionId, refreshSeq, running, retryText, onRetry, onOpenToolDetail, onEmptyChange }: {
  sessionId: string
  refreshSeq: number
  running: boolean
  retryText: string | null
  onRetry: (text: string) => void
  onOpenToolDetail: (detail: ToolDetail) => void
  /** Reports the empty-transcript phase (full-page hero gate); optional so the narrow panel is untouched. */
  onEmptyChange?: ((empty: boolean) => void) | undefined
}): JSX.Element {
  const [events, setEvents] = useState<SessionEventData[]>([])
  const [loading, setLoading] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  const fetchEvents = useCallback(async () => {
    // The fresh-session sentinel has no history by definition: clear the
    // transcript instead of keeping the previous conversation's text (a
    // refused read otherwise keeps it, which would leak a deleted session's
    // content after its delete fell back to the fresh start).
    if (sessionId === NEW_SESSION_ID) {
      setEvents([])
      setLoading(false)
      return
    }
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
    return () => { clearInterval(timer) }
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

  // The full-page posture gates its hero on this phase; the fresh-session
  // sentinel is empty by definition, and a settled refused read keeps the
  // previous events (so the phase only flips on settled facts).
  // The full-page hero gates on "no conversation yet": a freshly created
  // session still carries one engine boot event in its history, so the count
  // alone would keep the hero away from exactly the sessions it is for.
  const hasConversation = events.some((event) => {
    const type = event.event.type
    return type === 'user/message' || type === 'assistant/message'
  })
  const empty = !loading && !hasConversation
  useEffect(() => {
    onEmptyChange?.(empty)
  }, [empty, onEmptyChange])

  return (
    <div
      ref={listRef}
      onScroll={handleScroll}
      role="log"
      aria-live="polite"
      className="dshx-scroll"
    >
      {loading && <div className="dshx-loading">{shellT()('shell.common.loading')}</div>}
      {!loading && events.length === 0 && <EmptyState />}
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
const VIEW_TAB_LABEL_KEYS: Readonly<Record<ConversationViewId, ShellLocaleKey>> = { chat: 'shell.viewStrip.chat', trajectory: 'shell.viewStrip.trajectory' }

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
  const t = useShellT()
  if (!available) return null
  return (
    <div className="dshx-viewstrip" role="tablist" aria-label={t('shell.viewStrip.label')}>
      {(Object.keys(VIEW_TAB_LABEL_KEYS) as ConversationViewId[]).map(view => (
        <button
          key={view}
          type="button"
          role="tab"
          aria-selected={view === active}
          className={`dshx-viewtab${view === active ? ' is-active' : ''}`}
          onClick={() => { onSelect(view) }}
        >
          {t(VIEW_TAB_LABEL_KEYS[view])}
        </button>
      ))}
    </div>
  )
}

// ── the shell component ──

type ExtensionShellProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'main' | 'conversation' | 'details' | 'sidebar.settings' | 'shell.overlay'>

function ExtensionShell({ renderSlot }: ExtensionShellProps): JSX.Element {
  const t = useShellT()
  if (shellCtx === undefined) throw new Error('extension-ui-shell: context missing')
  const { tabs, select } = useTabs()
  const { sessions, refresh: refreshSessions } = useSessions()
  const [detailsOpen, setDetailsOpen] = useState(layout.isOpen())
  /** User-plugin panel visibility; exclusive with the tool-details aside. */
  const [pluginsOpen, setPluginsOpen] = useState(false)
  /** Services panel visibility; exclusive with plugins and the tool-details aside. */
  const [servicesOpen, setServicesOpen] = useState(false)
  /** Automation panel visibility; exclusive with plugins/services and the details aside. */
  const [automationOpen, setAutomationOpen] = useState(false)
  /** A newer release exists (cached by the services panel's 关于 check) — dots the plugin trigger. */
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [inputText, setInputText] = useState('')
  /**
   * Learned sites whose cheat sheet is being injected right now (feeds the
   * composer's status chip). Polled on the same 3s cadence as the transcript
   * refresh; a refused read keeps the last snapshot.
   */
  const [siteKnowledge, setSiteKnowledge] = useState<readonly { readonly host: string; readonly bytes: number }[]>([])
  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      const result = await rpc('siteLearn.status', {}, 8000)
      if (!alive || !result.ok) return
      const sites = (result.value as { sites?: Array<{ host?: unknown; bytes?: unknown }> } | undefined)?.sites
      if (!Array.isArray(sites)) return
      setSiteKnowledge(sites
        .filter(site => typeof site?.host === 'string' && typeof site?.bytes === 'number')
        .map(site => ({ host: site.host as string, bytes: site.bytes as number })))
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  /** Bumped on every send so ConversationView refetches immediately. */
  const [sentSeq, setSentSeq] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** True between compositionstart/compositionend: an IME session is live, so Enter commits candidates instead of sending. */
  const composerComposingRef = useRef(false)
  /**
   * Last sent prompt text PER SESSION — powers the ErrorBar 重试 chip. Keyed
   * by session so a switched-away conversation can never resend another
   * session's message; sessions without a recorded prompt simply get no chip.
   */
  const lastSentBySession = useRef(new Map<string, string>())
  /**
   * The session the transcript and composer talk to. Boots on the sentinel
   * fresh-session id; a session still RUNNING at boot is adopted instead so
   * live work stays visible. `session.create` mints real 新会话 ids with
   * their own clean durable logs — old sessions' histories stay on disk.
   */
  const [sessionId, setSessionId] = useState(NEW_SESSION_ID)
  // Workspace follows the session: switching sessions repoints the ACTIVE
  // workspace to that session's remembered folder (the engine's per-operation
  // read resolves through the pointer, so the /local mount follows without a
  // restart). The fresh-session sentinel key migrates to the minted id on
  // first send; the pre-session-scoped global folder attaches to fresh
  // sessions once at boot.
  const workspaceSessionRef = useRef(sessionId)
  // The preset picked on the fresh-session sentinel: the mint (first send /
  // 新建任务) composes it into the session.create payload — the sentinel has
  // no agent, so agentPreset.select cannot run against it.
  const sentinelPresetRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    const previous = workspaceSessionRef.current
    workspaceSessionRef.current = sessionId
    const apply = async (): Promise<void> => {
      try {
        if (previous === NEW_SESSION_ID && sessionId === NEW_SESSION_ID) await migrateLegacyWorkspace()
        const entry = await readSessionWorkspace(sessionId).catch(() => undefined)
        await setActiveWorkspace(entry === undefined ? undefined : sessionId)
      } catch {
        // A storage outage keeps the previous mount; the next switch retries.
      }
    }
    void apply()
  }, [sessionId])
  useEffect(() => {
    // Publish the panel-owned selection for the workspace stub's openSession
    // delegation; "current" lives in the panel upstream 0.2.2.
    panelSessionOpener = setSessionId
    return () => { panelSessionOpener = undefined }
  }, [setSessionId])
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
      // Fresh-session start (NEW_SESSION_ID) stands unless a session is still
      // RUNNING at boot — abandoning that would strand live work behind the
      // switcher. History is otherwise the user's own pick.
      const running = (result.value as SessionListValue | undefined)?.items?.find(
        item => item.running === true && typeof item.sessionId === 'string',
      )
      if (running?.sessionId !== undefined) setSessionId(running.sessionId)
    })
    const loadCatalog = (): void => {
      void rpc('llm.models', {}).then((result) => {
        if (!result.ok) return
        setGroups((result.value as { groups?: ModelGroup[] } | undefined)?.groups ?? [])
      })
    }
    loadCatalog()
    const catalogTimer = setInterval(loadCatalog, 15000)
    return () => { clearInterval(catalogTimer) }
  }, [])
  // Cold-resume pre-warm: the active session's first send pays the resume —
  // and, once per stored generation, the legacy repair pass over the whole
  // log — which can outrun a send-sized RPC timeout on a long-lived session.
  // Moving that cost into mount idle time means the user's first send meets a
  // live agent. Fire-and-forget with a repair-sized budget; a failure (engine
  // still booting, session gone) is never surfaced — the send retries cold.
  // The sentinel fresh session has nothing persisted to warm.
  useEffect(() => {
    if (sessionId === NEW_SESSION_ID) return
    void rpc('session.warm', { sessionId }, 60_000)
  }, [sessionId])
  useEffect(() => layout.subscribe(setDetailsOpen), [])
  // The services panel's 关于 check caches its outcome; the rail's 服务 dot
  // (and the plugin panel's entry row, in the narrow posture) mirrors it so a
  // newer release is visible without opening the panel at all.
  useEffect(() => {
    if (typeof chrome === 'undefined' || chrome.storage === undefined) return undefined
    const read = async (): Promise<void> => {
      const stored = await chrome.storage.local.get(UPDATE_CHECK_STORAGE_KEY)
      const cache = stored[UPDATE_CHECK_STORAGE_KEY] as UpdateCheckCache | undefined
      setUpdateAvailable(cache?.available === true)
    }
    void read()
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>): void => {
      if (UPDATE_CHECK_STORAGE_KEY in changes) {
        setUpdateAvailable((changes[UPDATE_CHECK_STORAGE_KEY].newValue as UpdateCheckCache | undefined)?.available === true)
      }
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => { chrome.storage.onChanged.removeListener(onChanged) }
  }, [])
  const active = tabs.find(tab => tab.active)

  // ── capability panel wiring (docked dsh conversation slot tree) ──
  // The bridge keeps the runtime's current session following the shell's
  // (and vice versa), which is what turns the session-scoped feature panels
  // — goal bar, todo strip, queue, approvals, questions, jobs, subagents,
  // log export — from declared-but-dark into rendered UI.
  useSessionBridge(shellCtx, sessionId, setSessionId)
  // The runtime's current session comes from the session whose mainView
  // retention count exceeds zero — upstream's ui-workspace navigation owns
  // that retain call, and the roster excludes ui-workspace. The shell
  // retains the selected session itself, or the session-scoped seats (the
  // session header, its jobs/subagent/log-export actions) never leave the
  // hero phase and stay dark.
  useEffect(() => {
    const ctx = shellCtx
    if (ctx === undefined) return undefined
    if (sessionId === NEW_SESSION_ID) return undefined
    let reference: { release(): void } | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    const tryRetain = (): void => {
      try {
        reference = ctx.sessions.retain(sessionId as SessionId, { source: 'mainView' })
      } catch {
        // A session minted moments ago may not be resolvable yet — bounded
        // retry, same pacing as the bridge's list feeding.
        if (tries < 8) {
          tries += 1
          timer = setTimeout(tryRetain, 1500)
        }
      }
    }
    tryRetain()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      reference?.release()
    }
  }, [sessionId])
  const pendingCount = usePendingCount(shellCtx, sessionId)
  // Interaction-channel waits (approval/question frames over the mux tap) —
  // the cards below render these, and the amber dot counts BOTH sources so
  // the indicator cannot disagree with a visible card.
  const interactionPending = useInteractionPendingCount()
  const anyPending = pendingCount > 0 || interactionPending > 0
  const capsOccupied = useCapabilityOccupied(shellCtx)

  // ── conversation view strip (对话 / 轨迹; see ViewStrip) ──
  // Available only while the ui-trajectory plugin has its conversation.view
  // ring entry registered. Active view is shell-owned per session: the SidePanel
  // counterpart of the desktop view tab ring, with the trajectory surface
  // mounted from the same shared Session window the docked dsh tree reads.
  // The native trajectory view renders from session.history, so the strip is always available.
  const trajectoryAvailable = true
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

  // ── details aside (shell-native; see the module comment) ──
  const [toolDetail, setToolDetail] = useState<ToolDetail | null>(null)
  const openToolDetail = useCallback((detail: ToolDetail): void => {
    setToolDetail(detail)
    setPluginsOpen(false)
    setServicesOpen(false)
    setAutomationOpen(false)
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
  // The 繁忙时的发送行为 preference (settings → 通用设置): what a send during
  // a live turn does — queue behind it (durable next-turn inbox, consumed
  // automatically) or steer (injected into the running step). Read from the
  // ui-conversation settings namespace blob; refreshed on any settings write.
  const [busyEnter, setBusyEnter] = useState<'queue' | 'steer'>('queue')
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void chrome.storage.local.get('dsh-api-settings-namespaces').then((items) => {
        if (!alive) return
        const raw = items['dsh-api-settings-namespaces'] as
          | Record<string, { value?: Record<string, unknown> }>
          | undefined
        const value = raw?.['ui-conversation']?.value
        const mode = value?.busyEnter
        if (mode === 'queue' || mode === 'steer') setBusyEnter(mode)
      }).catch(() => {})
    }
    read()
    const listener = (changes: Record<string, unknown>, area: string): void => {
      if (area === 'local' && Object.hasOwn(changes, 'dsh-api-settings-namespaces')) read()
    }
    chrome.storage.onChanged.addListener(listener)
    return () => {
      alive = false
      chrome.storage.onChanged.removeListener(listener)
    }
  }, [])
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
    noticeTimerRef.current = window.setTimeout(() => { setComposerNotice(null) }, 12000)
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
  const promptSend = (text: string, mode?: 'queue' | 'steer'): void => {
    // Attachments ride the same durable prompt: image parts first (the model
    // reads them as context), then the text body. The staging clears with the
    // send, mirroring the input reset.
    const imageParts = imagePromptParts(composerAttachments.attachments)
    const content = [
      ...imageParts,
      ...(text === '' && imageParts.length > 0 ? [] : [{ type: 'text' as const, text }]),
    ]
    const deliver = (target: string): void => {
      lastSentBySession.current.set(target, text)
      // rpc() never rejects — every refusal resolves {ok:false} — so without
      // this check a failed prompt (engine down, session-not-found, model
      // route broken) would silently vanish: the input clears, nothing renders.
      // The send-sized budget covers a send that races the mount warm-up and
      // pays the cold resume (plus the one-time repair) inside this RPC.
      const payload: Record<string, unknown> = { sessionId: target, content }
      // A running-turn send carries the busy-enter mode: queue (the engine's
      // durable next-turn inbox — consumed automatically when the live turn
      // ends) or steer (injected into the running step). Idle sends omit it.
      if (mode !== undefined) payload.mode = mode
      void rpc('session.prompt', payload, 60_000).then((result) => {
        if (result.ok) {
          if (mode === 'queue') showComposerNotice(shellT()('shell.notice.queued'))
          if (mode === 'steer') showComposerNotice(shellT()('shell.notice.steered'))
          return
        }
        setRunning(false)
        showComposerNotice(shellT()('shell.notice.sendFailed', { reason: result.error?.message ?? shellT()('shell.common.unknownReason') }))
        // Restore the drafted text so the failure never eats the message.
        setInputText(current => current === '' ? text : current)
      })
      composerAttachments.clear()
      setRunning(true)
      setSentSeq(seq => seq + 1)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (el !== null) el.style.height = 'auto'
      })
    }
    if (sessionId === NEW_SESSION_ID) {
      // First send on the fresh-session start materializes the session: mint
      // it, adopt its real id (retry chip and transcript key on it), then
      // deliver the prompt. A failed mint restores the draft.
      void rpc('session.create', {}).then((result) => {
        const created = (result.value as SessionCreateValue | undefined)?.sessionId
        if (!result.ok || typeof created !== 'string') {
          setRunning(false)
          showComposerNotice(shellT()('shell.notice.sendFailed', { reason: result.error?.message ?? shellT()('shell.notice.sessionCreateFailed') }))
          setInputText(current => current === '' ? text : current)
          return
        }
        moveSentinelWorkspaceTo(created)
        adoptSentinelPreset(created)
        setSessionId(created)
        refreshSessions()
        deliver(created)
      })
      return
    }
    deliver(sessionId)
  }

  /**
   * The `/export` destination: one bridge-RPC read of the durable log,
   * rendered to markdown and saved as a browser download. The session header
   * menu's download and Markdown copy ride the same read through the
   * `sessionLogExportOverrides` carriers (their failure notices live in the
   * plugin's own toast/dialog state).
   */
  const exportSessionLog = useCallback((session: string): void => {
    void readSessionMarkdown(session).then((markdown) => {
      downloadSessionMarkdown(session, markdown)
    }).catch((error: unknown) => {
      showComposerNotice(shellT()('shell.notice.exportFailed', { reason: error instanceof Error ? error.message : shellT()('shell.common.bridgeUnavailable') }))
    })
  }, [showComposerNotice])

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
  /**
   * Resolve the command-execution target for the composer's send router: the
   * current session id, or — on the fresh-session start — a minted and
   * adopted session (a command's lifecycle logs into a real session, so the
   * `session-new` sentinel can never execute one; without this the first
   * `/`-line of a fresh panel always fell back to a plain model send).
   */
  /** A sentinel preset pick composes into the minted session via select. */
  const adoptSentinelPreset = (created: string): void => {
    const pending = sentinelPresetRef.current
    sentinelPresetRef.current = undefined
    if (pending === undefined) return
    void rpc('agentPreset.select', { sessionId: created, agentPreset: pending }).catch(() => {})
  }

  const ensureCommandSession = (): Promise<string> => {
    if (sessionId !== NEW_SESSION_ID) return Promise.resolve(sessionId)
    return rpc('session.create', {}).then((result) => {
      const created = (result.value as SessionCreateValue | undefined)?.sessionId
      if (!result.ok || typeof created !== 'string') {
        throw new Error(result.error?.message ?? shellT()('shell.notice.sessionCreateFailed'))
      }
      moveSentinelWorkspaceTo(created)
      adoptSentinelPreset(created)
      setSessionId(created)
      refreshSessions()
      return created
    })
  }

  const sendPrompt = (text: string, mode?: 'queue' | 'steer'): void => {
    // The mode only applies to the plain-model send: slash commands, subagent
    // delivery, and exports are their own pipeline and never queue.
    dispatchSendLine(sessionId, text, {
      prompt: (line) => { promptSend(line, mode) },
      subagents,
      onCommandAdmitted: () => { setSentSeq(seq => seq + 1) },
      onSubagentSent: () => {
        setSentSeq(seq => seq + 1)
        refreshSubagents()
      },
      notice: showComposerNotice,
      exportLog: exportSessionLog,
      ensureSession: ensureCommandSession,
    })
  }

  const canSend = inputText.trim() !== '' || composerAttachments.attachments.length > 0
  const retryText = lastSentBySession.current.get(sessionId) ?? null

  /** Abort the running turn (Esc in the textarea or the toolbar stop button). */
  const interrupt = (): void => {
    void rpc('session.interrupt', { sessionId })
  }

  /** Drain the composer into a prompt and reset the input. */
  const sendCurrent = (mode?: 'queue' | 'steer'): void => {
    if (canSend) {
      // A send during a live turn carries the busy-enter mode (queue/steer);
      // an idle send is a plain prompt and omits the field.
      sendPrompt(inputText.trim(), running ? mode ?? busyEnter : undefined)
      setInputText('')
    }
  }

  // ── full-page posture (?view=full) ──
  // sidepanel.html is a plain SPA page, so it doubles as a fullscreen tab:
  // the header's expand button (or a bookmark) opens `?view=full`, which
  // renders the dsh-desktop-like rail + hero frame. The standalone settings
  // page (settings.html — the manifest options_ui target) is always full. Static
  // per page load — the docked side panel keeps its compact column, and the
  // two postures never mix in one document.
  const fullMode = window.location.pathname.endsWith('/settings.html')
    || new URLSearchParams(window.location.search).get('view') === 'full'
  // The standalone settings page ships a language-neutral document title; the
  // tab reads it in the active locale (the panel tab keeps the brand name).
  const settingsTitle = t('shell.documentTitle.settings')
  useEffect(() => {
    if (window.location.pathname.endsWith('/settings.html')) document.title = settingsTitle
  }, [settingsTitle])
  const [sessionEmpty, setSessionEmpty] = useState(true)
  const handleEmptyChange = useCallback((empty: boolean): void => { setSessionEmpty(empty) }, [])
  // Hero only for the chat view: the trajectory view owns its own empty state.
  const heroPhase = fullMode && sessionEmpty && !showTrajectory

  /** Mint a genuinely fresh session (the header/rail ＋ button). */
  const startNewSession = (): void => {
    void rpc('session.create', {}).then((result) => {
      const created = result.value as SessionCreateValue | undefined
      if (result.ok && typeof created?.sessionId === 'string') {
        adoptSentinelPreset(created.sessionId)
        setSessionId(created.sessionId)
        setSentSeq(seq => seq + 1)
        refreshSessions()
      }
    })
  }
  const renameSession = (renameId: string, title: string): void => {
    void rpc('session.rename', { sessionId: renameId, title }).then((result) => {
      if (!result.ok) {
        console.warn('session.rename failed:', result.error)
        return
      }
      refreshSessions()
    }).catch((error: unknown) => {
      console.warn('session.rename failed:', error)
    })
  }
  const deleteSession = (deleteId: string): void => {
    void rpc('session.delete', { sessionId: deleteId }).then((result) => {
      if (!result.ok) {
        showComposerNotice(shellT()('shell.notice.deleteFailed', { reason: result.error?.message ?? shellT()('shell.common.unknownReason') }))
        return
      }
      refreshSessions()
      if (deleteId === sessionId) {
        // Never linger on a deleted conversation: fall back to the
        // fresh-session start, exactly like the boot behavior.
        setSessionId(NEW_SESSION_ID)
        setSentSeq(seq => seq + 1)
      }
    })
  }
  const clearAllSessions = (): void => {
    // A running turn owns its session's log — the engine refuses the
    // delete, so block the whole clear up front with one actionable
    // notice instead of a per-row failure pile.
    const running = sessions.filter(item => item.running)
    if (running.length > 0) {
      showComposerNotice(shellT()('shell.notice.runningSessionsBlock', { count: running.length }))
      return
    }
    void (async () => {
      let failed = 0
      for (const item of sessions) {
        const result = await rpc('session.delete', { sessionId: item.sessionId })
        if (!result.ok) failed += 1
      }
      refreshSessions()
      if (sessions.some(item => item.sessionId === sessionId)) {
        // The current conversation was among the cleared rows: land
        // on the fresh-session start, same as a per-row delete.
        setSessionId(NEW_SESSION_ID)
        setSentSeq(seq => seq + 1)
      }
      if (failed > 0) {
        showComposerNotice(shellT()('shell.notice.clearPartial', { count: failed }))
      }
    })()
  }
  // Rendered once per posture: the docked header and the full-page rail each
  // call the same slot with their own owner args (labeled toggles the rail's
  // text-row variant) — fullMode is static, so exactly one mounts at a time.
  // conversation phase, centered under the hero headline while a full-page
  // session is still empty. Hero and dock render mutually exclusively, so the
  // textarea remount loses nothing (inputText and attachments live up here).
  const composerElement = (
    <div className="dshx-composer">
      <div className="dshx-capsule" title={running ? t('shell.capsule.runningTitle') : undefined}>
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
              press. The fresh-session start borrows the most recent existing
              session for the one-shot roster fetch (the sentinel is refused);
              executing a picked line still mints the session first. */}
          <SlashMenu
            sessionId={sessionId === NEW_SESSION_ID && sessions[0] !== undefined
              ? sessions[0].sessionId
              : sessionId}
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
            onCompositionStart={() => { composerComposingRef.current = true }}
            onCompositionEnd={() => { composerComposingRef.current = false }}
            onPaste={(e) => {
              // Clipboard pastes often carry text plus screenshot files;
              // non-images are silently ignored (no refusal notice — that
              // stays the picker path's job) and a text-only paste keeps
              // the browser's default insert.
              const images = pickImageFiles(e.clipboardData?.files)
              if (images.length > 0) {
                e.preventDefault()
                composerAttachments.addFiles(images)
              }
            }}
            onDragOver={(e) => {
              // Only file drags need the drop allowance; text drags keep
              // the textarea's default drop-insert behavior.
              if ((e.dataTransfer?.files?.length ?? 0) > 0) e.preventDefault()
            }}
            onDrop={(e) => {
              const images = pickImageFiles(e.dataTransfer?.files)
              if ((e.dataTransfer?.files?.length ?? 0) > 0) {
                // Swallow every file drop (a stray non-image must not
                // navigate the panel frame); only whitelisted images stage.
                e.preventDefault()
                if (images.length > 0) composerAttachments.addFiles(images)
              }
            }}
            onKeyDown={(e) => {
              // IME pass-through: while composing (picking candidates), Enter
              // commits the candidate text and Esc cancels the composition —
              // neither may send or interrupt. The ref covers engines where
              // the commit-Enter keydown races the compositionend event.
              if (e.nativeEvent.isComposing || composerComposingRef.current) return
              if (e.key === 'Escape' && running) {
                // Esc from a focused composer aborts the turn (capture-style
                // courtesy: no modifier gymnastics, one deliberate binding).
                e.preventDefault()
                e.stopPropagation()
                interrupt()
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                // Enter sends (bare, or with Cmd/Ctrl); Shift+Enter stays a
                // newline. The IME guard above keeps candidate-commit Enters
                // from reaching this branch.
                e.preventDefault()
                sendCurrent()
              }
            }}
            placeholder={t('shell.composer.placeholder')}
            rows={1}
          />
          <AttachmentStrip handle={composerAttachments} />
        </div>
        <ComposerBar
          sessionId={sessionId}
          running={running}
          canSend={canSend}
          groups={groups}
          siteKnowledge={siteKnowledge}
          onSend={sendCurrent}
          onInterrupt={interrupt}
          onPendingPreset={(id) => { sentinelPresetRef.current = id }}
          runSend={running ? {
            label: busyEnter === 'steer' ? t('shell.composer.steerLabel') : t('shell.composer.queueLabel'),
            send: () => { sendCurrent(busyEnter) },
          } : undefined}
        />
      </div>
    </div>
  )

  return (
    <div className={`dshx-root${fullMode ? ' is-full' : ''}`}>
      <style>{[
        SHELL_CSS, POPOVER_CSS, COMPOSER_CSS, ATTACHMENT_CSS, MARKDOWN_CSS,
        INTERACTION_CARDS_CSS, USER_PLUGIN_PANEL_CSS, MCP_PANEL_CSS, SCHEDULE_CARD_CSS,
        CREDENTIALS_CARD_CSS, ACCOUNT_CARD_CSS,
        // The boot style sheet's contenteditable-composer rule reads this
        // property; writing it here keeps the placeholder in the active locale.
        `:root { --dshx-composer-placeholder: ${JSON.stringify(t('shell.composer.shortPlaceholder'))}; }`,
      ].join('')}</style>
      {fullMode && (
        <SessionRail
          sessions={sessions}
          currentId={sessionId}
          onSelect={setSessionId}
          onNewSession={startNewSession}
          onRename={renameSession}
          onDelete={deleteSession}
          onClearAll={clearAllSessions}
          pluginsOpen={pluginsOpen}
          servicesOpen={servicesOpen}
          automationOpen={automationOpen}
          updateAvailable={updateAvailable}
          onOpenPlugins={() => { setPluginsOpen(true); setServicesOpen(false); setAutomationOpen(false) }}
          onOpenServices={() => { setServicesOpen(true); setPluginsOpen(false); setAutomationOpen(false) }}
          onOpenAutomation={() => { setAutomationOpen(true); setPluginsOpen(false); setServicesOpen(false) }}
          settingsMount={renderSlot('sidebar.settings', { wide: false, labeled: true })}
        />
      )}
      {!fullMode && (
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
            title={active === undefined ? t('shell.tabs.current') : `${active.title}\n${active.url}`}
          >
            {active === undefined && <option value="">{t('shell.tabs.currentOption')}</option>}
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
            onRename={renameSession}
            onDelete={deleteSession}
            onClearAll={clearAllSessions}
          />
          <button
            type="button"
            className="dshx-primarybtn"
            title={t('shell.tabs.currentSession', { name: sessionId === NEW_SESSION_ID ? t('shell.tabs.newTask') : sessionId })}
            onClick={startNewSession}
          >
            {t('shell.rail.newTask')}
          </button>
          <button
            type="button"
            className={`dshx-iconbtn${pluginsOpen ? ' is-active' : ''}`}
            aria-label={t('shell.rail.userPlugins')}
            aria-pressed={pluginsOpen}
            title={t('shell.rail.userPlugins')}
            onClick={() => {
            // The overlays are exclusive: opening the plugin panel folds the
            // tool-details pane, the automation panel and the services panel
            // away (and vice versa, see openToolDetail and the rail rows).
            // Update news lives on the services panel (its entry row carries
            // the dot).
              if (!pluginsOpen) layout.closeDetails()
              setServicesOpen(false)
              setAutomationOpen(false)
              setPluginsOpen(next => !next)
            }}
          >
            <PuzzleIcon size={14} />
          </button>
          <button
            type="button"
            className={`dshx-iconbtn${automationOpen ? ' is-active' : ''}`}
            aria-label={t('shell.rail.automation')}
            aria-pressed={automationOpen}
            title={t('shell.rail.automation')}
            onClick={() => {
              if (!automationOpen) layout.closeDetails()
              setServicesOpen(false)
              setPluginsOpen(false)
              setAutomationOpen(next => !next)
            }}
          >
            <ClockIcon size={14} />
          </button>
          <button
            type="button"
            className="dshx-iconbtn"
            aria-label={t('shell.tabs.openInTab')}
            title={t('shell.tabs.openInTab')}
            onClick={() => { void chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html?view=full') }) }}
          >
            <ExpandIcon size={14} />
          </button>
          {/* Settings mount: the extension settings root's 36px trigger circle
            (the sheet paints viewport-fixed above everything, z 1000). The
            full-page posture renders the same slot in its rail instead. */}
          <div className="dshx-settingsmount">
            {renderSlot('sidebar.settings', { wide: false })}
          </div>
        </header>
      )}
      <div className="dshx-stage">
        {/* While a turn runs, this 2px gradient hairline makes activity visible at a glance. */}
        {running && <div className="dshx-runline" aria-hidden="true" />}
        <div className="dshx-body">
          <div className="dshx-main">
            <ViewStrip available={trajectoryAvailable} active={activeView} onSelect={selectView} />
            {showTrajectory ? (
              <SlotErrorBoundary label={t('shell.slotLabel.trajectory')}>
                <TrajectoryHost sessionId={sessionId} refreshSeq={sentSeq} />
              </SlotErrorBoundary>
            ) : (
              <ConversationView
                sessionId={sessionId}
                refreshSeq={sentSeq}
                running={running}
                retryText={retryText}
                onRetry={sendPrompt}
                onOpenToolDetail={openToolDetail}
                onEmptyChange={handleEmptyChange}
              />
            )}
            {/* Full-page hero: brand welcome + the composer centered mid-stage
              (the dsh-desktop empty-session composition), painted over the
              transcript while it lasts. ConversationView stays mounted
              underneath so its poll flips the phase the moment history lands. */}
            {heroPhase && (
              <div className="dshx-hero">
                <EmptyState />
                <div className="dshx-hero-composer">{composerElement}</div>
              </div>
            )}
          </div>
          {(detailsOpen || pluginsOpen || servicesOpen || automationOpen) && (pluginsOpen || servicesOpen || automationOpen
            ? (
            // Full-bleed overlay: the plugin / automation / services panel
            // fills the whole SidePanel window the way the settings sheet
            // does, instead of squeezing its cards into the 340px details
            // aside.
              <div className="dshx-up-overlay">
                {pluginsOpen
                  ? (
                    <UserPluginPanel
                      sessionId={sessionId}
                      sendPrompt={sendPrompt}
                      onClose={() => { setPluginsOpen(false) }}
                      onOpenServices={() => { setPluginsOpen(false); setServicesOpen(true); setAutomationOpen(false) }}
                      updateAvailable={updateAvailable}
                    />
                  )
                  : servicesOpen
                    ? <ServicesPanel onClose={() => { setServicesOpen(false) }} />
                    : (
                      <AutomationPanel
                        onClose={() => { setAutomationOpen(false) }}
                        sessionId={sessionId}
                        ensureSession={ensureCommandSession}
                      />
                    )}
              </div>
            )
            : (
              <aside className="dshx-details">
                <ToolDetailsPanel detail={toolDetail} onClose={closeDetails} />
              </aside>
            ))}
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
          carries. Unmounted entirely when no seat has an occupant, and hidden
          on the empty-session welcome (the labeled 能力面板 strip is gone:
          the card earns its place only once a conversation exists, or a
          pending approval needs the surface). */}
        {capsOccupied && (!sessionEmpty || anyPending) && (
        // The lane mirrors the composer's own horizontal geometry (same side
        // paddings, same centered width cap), so the capability card and the
        // input capsule above always share one width lane.
          <div className="dshx-caps-lane">
            <section className="dshx-caps">
              <div className="dshx-caps-body">
                <SlotErrorBoundary label={t('shell.slotLabel.capabilities')}>
                  {renderSlot('main', {}, { entryKey: 'conversation' })}
                </SlotErrorBoundary>
              </div>
            </section>
          </div>
        )}
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
        {!heroPhase && composerElement}
      </div>
      {/* Root overlay seats (dsh-client-ui-context-menu's menu root, the
          session-log-export copy toast): upstream mounts them in ui-layout's
          AppFrame, which the roster excludes — the shell renders the seat. */}
      {renderSlot('shell.overlay', {})}
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
  // The shell's own copy rides the upstream locale service; every panel and
  // card module translates through the seat this installs.
  installShellLocale(ctx)
  // The engine names providers in the language this panel shows, and it cannot
  // see a browser-detected locale: report the active one now and on every switch.
  const reportLanguage = (active: string): void => { void rpc('ui/language', { language: active }) }
  reportLanguage(ctx.locale.getSnapshot().active)
  ctx.on('locale/change', (snapshot) => { reportLanguage(snapshot.active) })
  // Route mux-tapped control frames (projection, queue, jobs) into the
  // sessions live stores: the transport layer (connection module) has no
  // `sessions` inject (it would close a dependency cycle), so the frames
  // bridge through this client-local event and the shell — which already
  // declares `sessions` — applies them. Projection docks (todo strip, goal
  // bar) read the projection arm; the queue dock and jobs surfaces read the
  // other two.
  ctx.on('mux/control', (frame) => {
    try {
      ctx.sessions.applyControlFrame(frame)
    } catch (error) {
      console.error('[mux/control] apply failed:', error)
    }
  })


  ctx.effect(() => {
    // The panel-action contract ui-conversation/ui-sidebar reach for.
    const disposeService = ctx.reflect.provide('layout', layout)

    // The 0.1.5 conversation/agent-preset plugins read the desktop workspace
    // navigator (ctx.uiWorkspace) — the SidePanel has no workspace chrome, so
    // the stub keeps those injects satisfiable: openSession delegates to the
    // sessions service (the shell's own list follows its selection), and the
    // workspace pickers are unreachable here (the hero workspace row is
    // de-branded away), so their methods refuse loudly instead of pretending.
    const workspaceStub = {
      openSession(sessionId: string): void {
        if (panelSessionOpener === undefined) {
          throw new Error('uiWorkspace: panel session selection is not ready; cannot open a session')
        }
        panelSessionOpener(sessionId)
      },
      openWorkspace(): Promise<void> {
        throw new Error('uiWorkspace: the SidePanel has no workspace; cannot open a workspace')
      },
      forkSession(): Promise<void> {
        throw new Error('uiWorkspace: the SidePanel has no workspace; cannot fork a session into a new workspace')
      },
    }
    const disposeWorkspace = ctx.reflect.provide('uiWorkspace', workspaceStub)

    // The SidePanel IS the local owner: every resource access answer is true.
    // ui-session and ui-settings-general inject the `remoteAccess` service
    // (upstream wires the api-remote-access client face the extension does not
    // carry — its Host snapshot stream has no extension endpoint), so the
    // shell provides this owner-shaped stub before those plugins activate.
    const alwaysTrue = {
      getSnapshot: () => true,
      subscribe: () => () => undefined,
    }
    const remoteAccessStub = {
      source: () => alwaysTrue,
      whenAccess: (_action: string, callback: () => unknown): (() => void) => {
        callback()
        return () => undefined
      },
      whenResourceAccess: (_kind: string, _id: string, _action: string, callback: () => unknown): (() => void) => {
        callback()
        return () => undefined
      },
    }
    const disposeRemoteAccess = ctx.reflect.provide('remoteAccess', remoteAccessStub)

    // The session-log-export plugin's download and Markdown-copy carriers:
    // this panel has no HTTP host behind the plugin's `/api/session.*`
    // routes, so the carriers read the durable log over the bridge RPC
    // instead (the plugin reads the overrides when its lazy row activates).
    const disposeExportCarriers = ctx.reflect.provide('sessionLogExportOverrides', sessionLogExportCarriers)

    // The workspace selector share ConversationRoot reads (`useWorkspaces`):
    // on the desktop ui-workspace supplies this root hook seat; the roster
    // excludes ui-workspace, so the shell provides the seat from the same
    // `workspaces` service its inject already declares.
    const workspaces = ctx.get('workspaces') as IWorkspaces
    const disposeHooks = ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })

    // Exclusive root render authority with the slots the kept dsh UI plugins
    // occupy ('conversation'/'details' from ui-conversation; SettingsRoot
    // from ui-settings-general renders its own trigger + panel).
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        // The desktop root frame (ui-layout) declares 'main' as a keyed slot;
        // ui-conversation's `slots.inject('main', …)` prepares its whole
        // conversation slot family (input.dock incl. the goal bar, todo strip,
        // queue) the moment that declaration exists. The native shell replaced
        // the frame without this declaration, which left every dock dead.
        // ConversationPanel itself stays unrendered: the shell renders
        // ConversationRoot directly and that root places the docks.
        'main': { kind: 'keyed', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    }, ExtensionShell)

    return () => {
      disposeRegistration()
      disposeHooks()
      void disposeWorkspace()
      void disposeRemoteAccess()
      void disposeExportCarriers()
      void disposeService()
    }
  }, 'extension-ui-shell: layout/uiWorkspace/export carriers services + root registration')

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
