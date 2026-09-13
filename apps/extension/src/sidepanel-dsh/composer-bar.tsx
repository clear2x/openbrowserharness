/**
 * ComposerBar — the horizontal toolbar under the composer textarea:
 *
 *   [⌘ model badge ▾] [💡 关|低|中|高] [◔ 62% · 126k/200k]        hint  [send]
 *
 * Left cluster: three 24-px chips.
 *   - Model badge lists every configured provider group/model (`llm.models`)
 *     in an upward popover; picking one calls `session.selectModel`, which
 *     also persists the host default. Rows carry 思考/视觉 capability badges
 *     when the wire discloses reasoning or image input for that model.
 *   - Reasoning-effort segment maps 关/低/中/高 → off/low/medium/high onto the
 *     same `session.selectModel` call plus `reasoningEffort`; unset stays
 *     half-transparent and sends no effort field (host default behavior). A
 *     catalogued model whose wire row carries no reasoning metadata hides the
 *     segment — that model cannot take an effort.
 *   - Context meter reads `session.usage` on a 5 s poll and pairs totalTokens
 *     with the selected model's context window ("62% · 126k/200k"); the window
 *     prefers the wire's per-model value, then the provider group's, and only
 *     then falls back to the local estimate table. Without a known window it
 *     shows the bare k-format total. The chip HIDES while the usage RPC fails
 *     or reports unavailable.
 * Right side: the send ⇄ stop button (state machine owned by the parent).
 *
 * Local selection state boots from `session.models` (the host's authoritative
 * provider/model/effort), so chips display reality rather than guesses; chip
 * clicks update optimistically because `selectModel` applies to the next
 * prompt immediately.
 *
 * The module also owns the composer SEND pipeline (`dispatchSendLine`): the
 * shell's `sendPrompt` routes every line through it, so `/` slash commands
 * execute over `commands/execute` instead of reaching the model, `/export`
 * hands off to the shell's session-log export (the same download the Session
 * log header button drives — a client-side action, never a model prompt),
 * `//` escapes to a literal `/` prompt, and an unadmitted command falls back
 * to a normal send with a notice.
 *
 * The module also owns the composer's slash-CANDIDATE menu (`SlashMenu`):
 * while the composer text is a bare `/`-led command name (no arguments, no
 * `//` escape), the menu floats above the textarea with the engine's
 * registered commands (`commands/list`, fetched once per session) merged
 * with the shell-local `/export` row. It only FILLS the composer — name
 * prefix/description filtering, ↑↓ highlight, Enter fills the highlighted
 * line plus a trailing space, Tab completes the name and keeps the menu,
 * Esc/outside click dismisses — so the send pipeline above stays the single
 * execution path and typing a full command by hand works with the menu
 * closed (a failed or refused `commands/list` degrades to no menu at all).
 *
 * The module also owns the composer's @-MENTION pipeline to subagents. While
 * the text ends in a word-bounded `@token` (start of text, after whitespace,
 * mid-message included), the `SubagentMenu` floats above the textarea with
 * the session's continuable subagent children (`subagent.list`, fetched once
 * per session and cached; one-shot and diagnostic rows can never receive a
 * prompt, so they are not candidates). The menu mirrors the slash menu's
 * fill-only interaction. The send pipeline routes a line addressed
 * `@名字 正文` through `subagent.prompt` (parent = the current session,
 * child = the entry the name resolves, body only); a name resolving to no
 * cached child, or a refused delivery, falls back to a normal send with a
 * notice. `/` stays line-start-only, `@` rides any word boundary — the two
 * candidate menus can never be open at once.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { RefObject } from 'react'
import { rpc } from './rpc-client.ts'
import { usePopoverDismiss } from './popover.tsx'
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, CpuIcon, GaugeIcon, LightbulbIcon, ShieldIcon } from './icons.tsx'
import { isPermissionMode, PERMISSION_MODES, type PermissionMode } from '../shared/permission-mode.ts'

/**
 * Shared dismissal for the composer's inline menus (slash commands, @mentions):
 * outside pointerdown (the popup and the textarea itself count as inside) or
 * Escape. The Escape swallow must stop propagation so the shell's
 * Esc-interrupt never sees the press. This hook owns both listeners directly —
 * unlike the chip popovers the anchor is a popup+textarea PAIR.
 */
function useInlineMenuDismiss(
  open: boolean,
  popRef: RefObject<HTMLDivElement | null>,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  dismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (popRef.current?.contains(target) === true) return
      if (textareaRef.current?.contains(target) === true) return
      dismiss()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      dismiss()
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, popRef, textareaRef, dismiss])
}

/**
 * Shared navigation/accept keys for the composer's inline menus while open. A
 * native target-phase listener fires before the shell's React handler, so
 * handled keys are stopped from reaching it. IME composing passes through —
 * Enter/arrows commit or pick candidate text and the menu must not react.
 */
function useInlineMenuKeys<Row>(
  open: boolean,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  activeRow: Row | undefined,
  candidateCount: number,
  setActive: (next: (current: number) => number) => void,
  accept: (row: Row, suffix: string) => void,
): void {
  useEffect(() => {
    const el = textareaRef.current
    if (el === null || !open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        setActive(current => Math.min(
          candidateCount - 1,
          Math.max(0, current + (event.key === 'ArrowDown' ? 1 : -1)),
        ))
        return
      }
      const row = activeRow
      if (row === undefined) return
      if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        accept(row, ' ')
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        accept(row, '')
      }
    }
    el.addEventListener('keydown', onKeyDown)
    return () => { el.removeEventListener('keydown', onKeyDown) }
  }, [open, activeRow, candidateCount, accept, textareaRef, setActive])
}

/** Switcher display copy per wire value; the table is exhaustive over `PermissionMode`. */
const MODE_ITEM_TABLE: Readonly<Record<PermissionMode, { label: string; description: string }>> = {
  'ask-always': { label: '每次确认', description: '点击/输入/跳转等每次操作前先问我' },
  'ask-change': { label: '变更确认', description: '仅新增/修改/删除类操作先问我' },
  full: { label: '完全访问', description: '网页操作不再询问' },
}

/** Switcher entries in wire order. */
const MODE_ITEMS: ReadonlyArray<{ value: PermissionMode; label: string; description: string }>
  = PERMISSION_MODES.map(value => ({ value, ...MODE_ITEM_TABLE[value] }))

/** `session.permission.get/set` ok value (wire view). */
interface PermissionValue {
  mode?: string
  planActive?: boolean
}

/** `llm.models` group (the catalog of CONFIGURED providers only). */
export interface ModelGroup {
  id?: string
  name?: string
  /** Provider-level context capacity in tokens when the host declares one. */
  contextWindow?: number
  models?: Array<{
    id?: string
    name?: string
    /** Provider-disclosed combined context capacity in tokens (exact route). */
    contextWindow?: number
    /** Declared input modalities; `image` membership means vision. */
    inputModalities?: Array<'text' | 'image'>
    /** Adapter-exposed reasoning metadata; presence means selectable effort. */
    reasoning?: { efforts?: Array<unknown>; defaultEffort?: string }
  }>
}

/** `session.models` ok value (wire view) — the boot source for chip state. */
interface SessionModelsValue {
  current?: { provider?: string; model?: string; reasoningEffort?: string }
}

/** `session.usage` ok value (wire view) — real token-meter readings. */
interface UsageValue {
  totalTokens?: number
  surfaceTokens?: number | undefined
  baselineKind?: string | undefined
}

/** What the chips know about the active model pairing (+ optional effort). */
interface Selection {
  provider?: string | undefined
  model?: string | undefined
  /** Present iff this client (or the logged request header) set one. */
  effort?: string | undefined
}

export interface ComposerBarProps {
  sessionId: string
  running: boolean
  canSend: boolean
  /** Catalog from the parent's 15 s `llm.models` poll (configured groups only). */
  groups: ModelGroup[]
  onSend(): void
  onInterrupt(): void
}

// ── send pipeline ──

/** Side effects the send pipeline needs from the owning shell. */
export interface SendActions {
  /**
   * Normal-message send (also the unknown-command fallback). One argument:
   * the message body. The router already owns the session, so it is not
   * re-passed here — a two-argument seam once let an implementation read the
   * first argument as the text and send the session id to the model.
   */
  prompt(line: string): void
  /**
   * `/export` destination: the shell's session-log export (the same browser
   * download the Session log header button drives). Never prompts the model.
   */
  exportLog(sessionId: string): void
  /** A slash command was admitted: refresh the transcript for its durable flow node. */
  onCommandAdmitted(): void
  /**
   * An addressed subagent prompt was accepted by the bridge: refresh the
   * transcript (the child's reply streams into its own session log, which the
   * capability panel's subagent catalog renders).
   */
  onSubagentSent(): void
  /** Transient hint rendered next to the composer. */
  notice(text: string): void
  /**
   * The shell's cached continuable children (`useSubagents`) the mention
   * router resolves `@名字` against.
   */
  subagents: readonly SubagentCandidate[]
}

/**
 * The reason text a failed mention delivery carries in its fallback notice.
 * The bridge's structured refusal message is the only diagnostic the user
 * gets (the notice lives 4 s), so it rides verbatim — trimmed, and truncated
 * to 80 characters so a stack-ish message cannot push the actionable tail
 * ("已按普通消息发送") out of the panel.
 * @param outcome - the refused rpc outcome whose error summary is extracted.
 * @returns a single-line reason of at most 80 characters.
 */
function refusalSummary(outcome: { error?: { message?: string } | undefined }): string {
  const raw = outcome.error?.message?.trim() ?? ''
  const message = raw !== '' ? raw : '未知原因'
  return message.length <= 80 ? message : `${message.slice(0, 79)}…`
}

/**
 * Route one composer line to its destination. A `//` prefix escapes to a
 * literal `/` prompt (one slash stripped); the bare `/export` line hands off
 * to `exportLog` — the export implementation supports no format argument, so
 * only the exact command is client-side and anything after it still resolves
 * through `commands/execute`; any other `/` line goes to `commands/execute`
 * (payload matching the api-bridge typert envelope
 * `{ args: { agentId, line } }`) — an admitted command never reaches the
 * model, its result surfaces as the durable `command/run`/`command/done`
 * flow nodes the transcript renders; a line the service does not resolve
 * (unknown command) or a bridge failure falls back to a normal send with a
 * notice. A line addressed `@名字 正文` goes to `subagent.prompt` (payload
 * `{ parentSessionId, childSessionId, content }`): the longest matching
 * `@label` (then the `@id`) picks the child and the body after the mention is
 * the message text; a name resolving to no cached child, or a refused
 * delivery, falls back to a normal send of the full line with a notice that
 * carries the refusal summary (see {@link refusalSummary}).
 * Anything else prompts unchanged.
 */
export function dispatchSendLine(sessionId: string, line: string, actions: SendActions): void {
  if (line.startsWith('//')) {
    actions.prompt(line.slice(1))
    return
  }
  if (line.startsWith('@')) {
    const matched = matchMentionLine(line, actions.subagents)
    if (matched !== null) {
      void rpc('subagent.prompt', {
        parentSessionId: sessionId,
        childSessionId: matched.childId,
        content: [{ type: 'text', text: matched.body }],
      }).then((result) => {
        if (result.ok) {
          actions.onSubagentSent()
          return
        }
        actions.notice(`子代理「${matched.label}」投递失败（${refusalSummary(result)}）：已按普通消息发送`)
        actions.prompt(line)
      })
      return
    }
    // Mention-SHAPED but unresolved (a hand-typed name the cache does not
    // know); a bare `@` or `@ word` is just text and sends silently.
    const stray = /^@([^\s@]+)/.exec(line)?.[1]
    if (stray !== undefined && MENTION_SHAPE.test(line)) {
      actions.notice(`未找到子代理「${stray}」，已按普通消息发送`)
    }
    actions.prompt(line)
    return
  }
  if (!line.startsWith('/')) {
    actions.prompt(line)
    return
  }
  if (line === '/export') {
    actions.exportLog(sessionId)
    return
  }
  void rpc('commands/execute', { args: { agentId: sessionId, line } }).then((result) => {
    if (result.ok && result.value !== undefined) {
      actions.onCommandAdmitted()
      return
    }
    actions.notice(result.ok
      ? `未知命令「${line}」，已按普通消息发送`
      : '命令服务不可用，已按普通消息发送')
    actions.prompt(line)
  })
}

// ── slash-command candidate menu ──

/** One candidate row of the composer's `/` menu (engine command or shell-local). */
interface SlashCandidate {
  /** Command name without the leading slash (`export`, `plan`, `plan:policy`). */
  readonly name: string
  /** Human-readable summary rendered beside the name. */
  readonly description: string
}

/**
 * The shell-local `/export` row, merged ahead of the engine's list: the bare
 * `/export` line resolves client-side in `dispatchSendLine` above (the same
 * browser download as the Session log header button), so the menu advertises
 * it even when the engine's own list omits it — and the local row wins when
 * the engine also registers one.
 */
const LOCAL_EXPORT: SlashCandidate = {
  name: 'export',
  description: '导出本会话日志（浏览器下载）',
}

/**
 * Composer text shapes that open the menu: the WHOLE text is `/` plus command
 * name characters — mirroring the send pipeline, where only a leading-slash
 * line executes as a command. A space (arguments under way) or a second slash
 * (the `//` escape) keeps the menu closed.
 */
const SLASH_SHAPE = /^\/([A-Za-z0-9_:-]*)$/

/**
 * One-shot `commands/list` fetch per session (the menu is discovery help, not
 * live state — no poll): the engine's registered commands merged with the
 * shell-local `/export` row. A refused or failed read, or a malformed row,
 * is dropped silently — the menu simply never opens, and typing a full
 * command by hand still routes through the send pipeline.
 *
 * @param sessionId - agent whose command registry is listed (typert envelope).
 * @returns the merged candidate rows; empty until the first success.
 */
function useSlashCommands(sessionId: string): SlashCandidate[] {
  const [commands, setCommands] = useState<SlashCandidate[]>([])
  useEffect(() => {
    let alive = true
    setCommands([])
    void rpc('commands/list', { args: { agentId: sessionId } }).then((result) => {
      if (!alive || !result.ok) return
      const rows = Array.isArray(result.value) ? result.value : []
      const wire = rows
        .map(row => row as { name?: unknown; description?: unknown })
        .filter(row => typeof row.name === 'string' && row.name.length > 0)
        .map(row => ({
          name: row.name as string,
          description: typeof row.description === 'string' ? row.description : '',
        }))
      setCommands([LOCAL_EXPORT, ...wire.filter(row => row.name !== LOCAL_EXPORT.name)])
    }).catch(() => {})
    return () => {
      alive = false
    }
  }, [sessionId])
  return commands
}

/**
 * Candidates for the query being typed: command-name prefix matches first
 * (wire order), then description substring matches; case-insensitive. The
 * two tiers are disjoint per row, so no dedup is needed.
 *
 * @param commands  merged candidate source rows.
 * @param query     text after the leading `/` ('' lists everything).
 * @returns rows in menu order (name matches, then description matches).
 */
function filterSlashCommands(commands: readonly SlashCandidate[], query: string): SlashCandidate[] {
  if (query === '') return [...commands]
  const needle = query.toLowerCase()
  const byName: SlashCandidate[] = []
  const byDesc: SlashCandidate[] = []
  for (const row of commands) {
    if (row.name.toLowerCase().startsWith(needle)) byName.push(row)
    else if (row.description.toLowerCase().includes(needle)) byDesc.push(row)
  }
  return [...byName, ...byDesc]
}

/** Props for the composer's slash-command candidate menu. */
export interface SlashMenuProps {
  sessionId: string
  /** The live composer text; the menu keys off its leading-slash shape. */
  text: string
  /** Replaces the composer text on accept (a FILL — never a send). */
  onChange(text: string): void
  /** The composer textarea the menu floats above and listens to for keys. */
  textareaRef: RefObject<HTMLTextAreaElement>
}

/**
 * The composer's `/` candidate menu, mounted inside the shell's input wrap
 * (`.dshx-inputwrap`) so it floats above the textarea. Renders null unless
 * the text is a bare `/`-led command name with at least one matching
 * candidate. Interaction:
 *   - ↑/↓ move the highlight; hover follows the pointer;
 *   - Enter fills the highlighted command plus a trailing space (the user
 *     adds arguments, then sends) and closes — bare Enter only, so the
 *     shell's Cmd/Ctrl+Enter send binding passes through untouched;
 *   - Tab completes the name without the trailing space and keeps the menu
 *     open for refinement;
 *   - Esc and outside pointerdown dismiss until the text is edited again;
 *     the Escape swallow stops propagation so the shell's Esc-interrupt
 *     binding cannot fire on the same press.
 * Keys ride a native textarea listener (target phase) so handled keys are
 * stopped before the shell's React handler; IME composition is passed
 * through untouched.
 */
export function SlashMenu({ sessionId, text, onChange, textareaRef }: SlashMenuProps): JSX.Element | null {
  const commands = useSlashCommands(sessionId)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const dismiss = useCallback((): void => { setDismissed(true) }, [])
  const popRef = useRef<HTMLDivElement>(null)
  const activeRowRef = useRef<HTMLButtonElement | null>(null)

  const query = SLASH_SHAPE.exec(text)?.[1] ?? null
  const candidates = useMemo(
    () => (query === null ? [] : filterSlashCommands(commands, query)),
    [commands, query],
  )
  const open = query !== null && candidates.length > 0 && !dismissed
  const activeRow = candidates.length === 0 ? undefined : candidates[Math.min(active, candidates.length - 1)]
  const accept = useCallback((row: SlashCandidate, suffix: string): void => {
    onChange(`/${row.name}${suffix}`)
  }, [onChange])

  // Any edit re-arms the menu after an Esc/outside dismissal; a fresh query
  // lands the highlight back on the first row.
  useEffect(() => { setDismissed(false) }, [text])
  useEffect(() => { setActive(0) }, [query])

  // Keep the highlighted row visible when ↑/↓ moves past the popup's scroll
  // edge (jsdom has no scrollIntoView; the guard keeps the no-op silent).
  useEffect(() => {
    const el = activeRowRef.current
    if (el === null || typeof el.scrollIntoView !== 'function') return
    el.scrollIntoView({ block: 'nearest' })
  }, [activeRow])

  // Dismissal: outside pointerdown (the popup and the textarea itself count
  // as inside) or Escape, with the same Escape swallow as the @-menu.
  useInlineMenuDismiss(open, popRef, textareaRef, dismiss)

  // Navigation/accept keys on the textarea while the menu is open. A native
  // target-phase listener fires before the shell's React handler, so handled
  // keys are stopped from reaching it.
  useInlineMenuKeys(open, textareaRef, activeRow, candidates.length, setActive, accept)

  if (!open) return null
  return (
    <div ref={popRef} className="dshx-pop dshx-pop--up dshx-slashpop" role="listbox" aria-label="斜杠命令">
      {candidates.map((row, index) => {
        const isActive = row === activeRow
        return (
          <button
            key={row.name}
            ref={isActive ? activeRowRef : undefined}
            type="button"
            role="option"
            aria-selected={isActive}
            className={`dshx-menuitem dshx-slashitem${isActive ? ' is-active' : ''}`}
            title={row.description}
            onMouseMove={() => { setActive(index) }}
            // preventDefault keeps the click from stealing focus from the
            // textarea, so the user can keep typing arguments right away.
            onMouseDown={(event) => { event.preventDefault() }}
            onClick={() => { accept(row, ' ') }}
          >
            <span className="dshx-slashitem-name">/{row.name}</span>
            <span className="dshx-slashitem-desc">{row.description}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── @ subagent-mention candidates + routing ──

/**
 * Wire view of one `subagent.list` row the composer cares about: only
 * CONTINUABLE children can receive a prompt (`subagent.prompt` gates on the
 * continuable mode and refuses one-shot and diagnostic rows), so those never
 * become candidates and mention lines never address them.
 */
export interface SubagentCandidate {
  /** The durable child session id — the prompt's `childSessionId` address. */
  readonly id: string
  /** The child's durable creation label — the `@`-mention name. */
  readonly label: string
  /** Live activity at listing time; `inactive` when only persistence has it. */
  readonly activity: 'running' | 'inactive'
}

/**
 * One-shot `subagent.list` fetch per session (cached; no poll): the
 * continuable direct children of the session. A refused or failed read, or a
 * malformed row, is dropped silently — the menu simply never opens, and a
 * mention line resolving to nothing falls back to a normal send with a
 * notice, so a stale cache can never lose a message.
 *
 * The read is re-driven by {@link useSubagents.refresh}: children spawned
 * after the session mounted (a background `subagent` tool call mid-conversation)
 * would otherwise stay invisible to the mention menu until a session switch.
 *
 * @param sessionId - the parent session whose direct children are listed.
 * @returns the continuable children in wire order plus a manual refresh; empty until first success.
 */
export interface SubagentsHandle {
  readonly subagents: readonly SubagentCandidate[]
  /** Re-reads `subagent.list` for this session (throttled to one call per 3s). */
  refresh(): void
}

const SUBAGENTS_REFRESH_THROTTLE_MS = 3000

/** Fold one `subagent.list` wire reply into continuable mention candidates. */
function parseSubagentRows(value: unknown): SubagentCandidate[] {
  const rows = (value as { entries?: unknown } | undefined)?.entries
  if (!Array.isArray(rows)) return []
  const parsed: SubagentCandidate[] = []
  for (const row of rows) {
    const wire = row as { kind?: unknown; mode?: unknown; id?: unknown; label?: unknown; activity?: unknown }
    if (wire.kind !== 'child' || wire.mode !== 'continuable') continue
    if (typeof wire.id !== 'string' || wire.id === '') continue
    if (typeof wire.label !== 'string' || wire.label === '') continue
    parsed.push({
      id: wire.id,
      label: wire.label,
      activity: wire.activity === 'running' ? 'running' : 'inactive',
    })
  }
  return parsed
}

export function useSubagents(sessionId: string): SubagentsHandle {
  const [subagents, setSubagents] = useState<SubagentCandidate[]>([])
  const lastFetchRef = useRef(0)
  const aliveRef = useRef(true)
  const loadRef = useRef<() => void>(() => {})
  const fetchList = useCallback((): void => {
    void rpc('subagent.list', { parentSessionId: sessionId }).then((result) => {
      if (!aliveRef.current || !result.ok) return
      setSubagents(parseSubagentRows(result.value))
    }).catch(() => {})
  }, [sessionId])
  useEffect(() => {
    aliveRef.current = true
    setSubagents([])
    lastFetchRef.current = Date.now()
    fetchList()
    return () => {
      aliveRef.current = false
    }
  }, [fetchList])
  loadRef.current = () => {
    if (!aliveRef.current) return
    const now = Date.now()
    if (now - lastFetchRef.current < SUBAGENTS_REFRESH_THROTTLE_MS) return
    lastFetchRef.current = now
    fetchList()
  }
  const refresh = useCallback(() => { loadRef.current() }, [])
  return { subagents, refresh }
}

/**
 * The @-mention query being typed: the text's trailing `@token` — no
 * whitespace and no nested `@` inside, and the `@` itself on a word boundary
 * (text start or after whitespace). A mid-message mention qualifies; an
 * email's glued `@` and a completed mention (trailing space, as the fill
 * leaves it) do not. The caret is assumed at the text end, the same
 * whole-text simplification the slash menu makes.
 *
 * @returns the token and the index of its `@`, or null when no mention is active.
 */
export function parseMentionQuery(text: string): { query: string; at: number } | null {
  const at = text.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(text.charAt(at - 1))) return null
  const query = text.slice(at + 1)
  if (/[\s@]/.test(query)) return null
  return { query, at }
}

/**
 * Candidates for the query being typed: label-prefix matches first, then
 * label substring, then id substring; case-insensitive. The tiers are
 * disjoint per row, so no dedup is needed.
 *
 * @param subagents cached continuable children.
 * @param query    text after the `@` ('' lists everything).
 * @returns rows in menu order (label prefix, label part, id part).
 */
export function filterSubagents(subagents: readonly SubagentCandidate[], query: string): SubagentCandidate[] {
  if (query === '') return [...subagents]
  const needle = query.toLowerCase()
  const byLabelPrefix: SubagentCandidate[] = []
  const byLabelPart: SubagentCandidate[] = []
  const byId: SubagentCandidate[] = []
  for (const row of subagents) {
    const label = row.label.toLowerCase()
    if (label.startsWith(needle)) byLabelPrefix.push(row)
    else if (label.includes(needle)) byLabelPart.push(row)
    else if (row.id.toLowerCase().includes(needle)) byId.push(row)
  }
  return [...byLabelPrefix, ...byLabelPart, ...byId]
}

/**
 * Resolve one send-time mention line against the cached children: the
 * LONGEST `@label` prefix followed by a space wins (multi-word labels), then
 * the `@id` prefix. The body after the single separating whitespace run is
 * the message text.
 *
 * @returns the addressed child and the body, or null when no cached child
 *   matches (or the line carries no body — a bare `@名字` is not a send).
 */
export function matchMentionLine(
  line: string,
  subagents: readonly SubagentCandidate[],
): { childId: string; label: string; body: string } | null {
  const byLabel = [...subagents].sort((a, b) => b.label.length - a.label.length)
  for (const row of byLabel) {
    if (line.startsWith(`@${row.label} `)) {
      return { childId: row.id, label: row.label, body: line.slice(row.label.length + 2) }
    }
  }
  const mention = /^@([^\s@]+)[ \t]+([\s\S]+)$/.exec(line)
  if (mention !== null) {
    const name = mention[1]
    const body = mention[2]
    if (name !== undefined && body !== undefined) {
      const row = subagents.find(candidate => candidate.id === name)
      if (row !== undefined) return { childId: row.id, label: row.label, body }
    }
  }
  return null
}

/** A line that LOOKS addressed (`@名字 ` + body) but resolved to no cached child. */
const MENTION_SHAPE = /^@[^\s@]+[ \t]/

/** Props for the composer's @-mention candidate menu. */
export interface SubagentMenuProps {
  /** The shell's cached continuable children (`useSubagents`). */
  subagents: readonly SubagentCandidate[]
  /** The live composer text; the menu keys off its trailing `@token`. */
  text: string
  /** Replaces the composer text on accept (a FILL — never a send). */
  onChange(text: string): void
  /** The composer textarea the menu floats above and listens to for keys. */
  textareaRef: RefObject<HTMLTextAreaElement>
  /**
   * Fired when a mention query becomes active (an `@token` appears): the hook
   * re-reads `subagent.list` so children spawned mid-session join the menu
   * instead of waiting for a session switch.
   */
  onMentionActive?(): void
}

/**
 * The composer's `@` candidate menu, mounted inside the shell's input wrap
 * (`.dshx-inputwrap`) beside the slash menu. Renders null unless the text
 * ends in a word-bounded `@token` with at least one matching candidate.
 * Interaction mirrors {@link SlashMenu}: ↑/↓ highlight, hover follows the
 * pointer, Enter/click fill `@名字 ` (mid-text mentions keep their prefix),
 * Tab completes the bare name and keeps the menu open, Esc and outside
 * pointerdown dismiss until the text is edited again (the Escape swallow
 * stops propagation so the shell's Esc-interrupt binding cannot fire on the
 * same press); keys ride a native textarea listener (target phase) and IME
 * composition passes through untouched. Rows show the mention name, the
 * child session id, and a 运行中/空闲 activity badge.
 */
export function SubagentMenu({ subagents, text, onChange, textareaRef, onMentionActive }: SubagentMenuProps): JSX.Element | null {
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const dismiss = useCallback((): void => { setDismissed(true) }, [])
  const popRef = useRef<HTMLDivElement>(null)
  const activeRowRef = useRef<HTMLButtonElement | null>(null)

  const mention = parseMentionQuery(text)
  const query = mention?.query ?? null
  const candidates = useMemo(
    () => (query === null ? [] : filterSubagents(subagents, query)),
    [subagents, query],
  )
  const open = query !== null && candidates.length > 0 && !dismissed
  const activeRow = candidates.length === 0 ? undefined : candidates[Math.min(active, candidates.length - 1)]
  const accept = useCallback((row: SubagentCandidate, suffix: string): void => {
    if (mention === null) return
    onChange(`${text.slice(0, mention.at)}@${row.label}${suffix}`)
  }, [mention, onChange, text])

  // Any edit re-arms the menu after an Esc/outside dismissal; a fresh query
  // lands the highlight back on the first row.
  useEffect(() => { setDismissed(false) }, [text])
  useEffect(() => { setActive(0) }, [query])
  // A mention query going active re-reads the roster (throttled in the hook)
  // so mid-session children are mentionable without a session switch.
  const queryActive = query !== null
  useEffect(() => {
    if (queryActive) onMentionActive?.()
  }, [queryActive, onMentionActive])

  // Keep the highlighted row visible when ↑/↓ moves past the popup's scroll
  // edge (jsdom has no scrollIntoView; the guard keeps the no-op silent).
  useEffect(() => {
    const el = activeRowRef.current
    if (el === null || typeof el.scrollIntoView !== 'function') return
    el.scrollIntoView({ block: 'nearest' })
  }, [activeRow])

  // Dismissal: outside pointerdown (the popup and the textarea itself count
  // as inside) or Escape, with the same Escape swallow as the slash menu.
  useInlineMenuDismiss(open, popRef, textareaRef, dismiss)

  // Navigation/accept keys on the textarea while the menu is open; shared
  // handler with the slash menu.
  useInlineMenuKeys(open, textareaRef, activeRow, candidates.length, setActive, accept)

  if (!open) return null
  return (
    <div ref={popRef} className="dshx-pop dshx-pop--up dshx-slashpop" role="listbox" aria-label="子代理">
      {candidates.map((row, index) => {
        const isActive = row === activeRow
        return (
          <button
            key={row.id}
            ref={isActive ? activeRowRef : undefined}
            type="button"
            role="option"
            aria-selected={isActive}
            className={`dshx-menuitem dshx-slashitem${isActive ? ' is-active' : ''}`}
            title={`@${row.label} · ${row.id}`}
            onMouseMove={() => { setActive(index) }}
            // preventDefault keeps the click from stealing focus from the
            // textarea, so the user can keep typing the message right away.
            onMouseDown={(event) => { event.preventDefault() }}
            onClick={() => { accept(row, ' ') }}
          >
            <span className="dshx-slashitem-name">@{row.label}</span>
            <span className="dshx-slashitem-desc">{row.id}</span>
            <span className="dshx-menuitem-badge">{row.activity === 'running' ? '运行中' : '空闲'}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── reasoning-effort choices ──

const EFFORTS: ReadonlyArray<readonly ['off' | 'low' | 'medium' | 'high', string]> = [
  ['off', '关'],
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
]

// ── context-window facts ──

/**
 * Context windows the panel knows. The `llm.models` wire view now carries real
 * per-model windows (and a provider-level window), so capacity math prefers the
 * host's disclosure over the advisory local tables: exact model window first,
 * then the provider group's window, then the local estimate table below (group
 * defaults from each preset's `contextWindow`, refined by model-id patterns for
 * families that differ from their route default). A custom route with a
 * declared window rides the wire like any other model; one absent from both
 * wire and tables degrades the chip to the bare-token format.
 */
const GROUP_WINDOW_DEFAULTS: Record<string, number> = {
  deepseek: 1_000_000,
  openai: 128_000,
  anthropic: 200_000,
  moonshot: 128_000,
  zhipu: 128_000,
  qwen: 128_000,
  openrouter: 128_000,
  ollama: 128_000,
}

const MODEL_WINDOW_OVERRIDES: ReadonlyArray<readonly [RegExp, number]> = [
  [/claude/i, 200_000],
  [/gemini/i, 1_000_000],
  [/gpt-4o|gpt-4\.1|o[34]-/i, 128_000],
]

/** Where a resolved window came from — the meter note names the source. */
type WindowSource = 'model' | 'provider' | 'local'

function windowFacts(
  provider: string | undefined,
  model: string | undefined,
  groups: readonly ModelGroup[],
): { window: number | undefined; source: WindowSource } {
  // 1. The exact model's disclosed window (the host's real value).
  const group = groups.find(candidate => candidate.id === provider)
  const entry = group?.models?.find(candidate => candidate.id === model)
  if (typeof entry?.contextWindow === 'number' && entry.contextWindow > 0) {
    return { window: entry.contextWindow, source: 'model' }
  }
  // 2. The provider group's disclosed window.
  if (typeof group?.contextWindow === 'number' && group.contextWindow > 0) {
    return { window: group.contextWindow, source: 'provider' }
  }
  // 3. Local estimate table (hosts without wire metadata, unlisted models).
  if (model !== undefined && model !== '') {
    const override = MODEL_WINDOW_OVERRIDES.find(([pattern]) => pattern.test(model))
    if (override !== undefined) return { window: override[1], source: 'local' }
  }
  if (provider === undefined || !(provider in GROUP_WINDOW_DEFAULTS)) {
    return { window: undefined, source: 'local' }
  }
  return { window: GROUP_WINDOW_DEFAULTS[provider], source: 'local' }
}

/** Compact token count: whole thousands below 1M ('126k'), millions above ('1M'). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  return `${Math.round(n / 1000)}k`
}

/** Grouped integer for the details popover (raw meter readings stay exact). */
const fmtExact = (n: number): string => n.toLocaleString('en-US')

// ── component ──

export function ComposerBar({ sessionId, running, canSend, groups, onSend, onInterrupt }: ComposerBarProps): JSX.Element {
  const [selection, setSelection] = useState<Selection>({})
  const [usage, setUsage] = useState<Required<Pick<UsageValue, 'totalTokens'>> & UsageValue | null>(null)
  const [permission, setPermission] = useState<PermissionMode | null>(null)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [meterPopOpen, setMeterPopOpen] = useState(false)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const modelWrapRef = useRef<HTMLDivElement>(null)
  const meterWrapRef = useRef<HTMLDivElement>(null)
  const modeWrapRef = useRef<HTMLDivElement>(null)

  usePopoverDismiss(modelMenuOpen, () => { setModelMenuOpen(false) }, modelWrapRef)
  usePopoverDismiss(meterPopOpen, () => { setMeterPopOpen(false) }, meterWrapRef)
  usePopoverDismiss(modeMenuOpen, () => { setModeMenuOpen(false) }, modeWrapRef)

  // Boot the chip pairings from the host's authoritative selection; switching
  // sessions re-reads (each session carries its own last-used pairing).
  useEffect(() => {
    let alive = true
    setSelection({})
    void rpc('session.models', { sessionId }).then((result) => {
      if (!alive || !result.ok) return
      const current = (result.value as SessionModelsValue | undefined)?.current
      const bootProvider = typeof current?.provider === 'string' ? current.provider : undefined
      const bootModel = typeof current?.model === 'string' ? current.model : undefined
      const bootEffort = typeof current?.reasoningEffort === 'string' ? current.reasoningEffort : undefined
      setSelection({ provider: bootProvider, model: bootModel, effort: bootEffort })
      // Self-heal a pairing persisted before this guard: an effort level on a
      // catalogued model without reasoning metadata bricks every request
      // (UNSUPPORTED_REASONING_EFFORT) — clear it once on boot.
      const bootEntry = result.ok
        ? groups.find(candidate => candidate.id === bootProvider)?.models?.find(candidate => candidate.id === bootModel)
        : undefined
      if (bootEffort !== undefined && bootEntry !== undefined && bootEntry.reasoning === undefined) {
        setSelection({ provider: bootProvider, model: bootModel, effort: undefined })
        void rpc('session.selectModel', { sessionId, provider: bootProvider, model: bootModel }).catch(() => {})
      }
    }).catch(() => {})
    return () => {
      alive = false
    }
  }, [sessionId])

  // 5 s usage poll: a successful read feeds the meter; any failure (bridge
  // down, meter uncomposed) hides the chip until the next success.
  useEffect(() => {
    let alive = true
    const tick = (): void => {
      void rpc('session.usage', { sessionId }).then((result) => {
        if (!alive) return
        if (!result.ok) {
          setUsage(null)
          return
        }
        const v = result.value as UsageValue | undefined
        setUsage(typeof v?.totalTokens === 'number'
          ? {
            totalTokens: v.totalTokens,
            surfaceTokens: typeof v.surfaceTokens === 'number' ? v.surfaceTokens : undefined,
            baselineKind: typeof v.baselineKind === 'string' ? v.baselineKind : undefined,
          }
          : null)
      }).catch(() => {})
    }
    tick()
    const timer = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [sessionId])

  // 5 s permission poll: the folded session knob. Re-syncs any switch (the
  // optimistic update stands until the next tick confirms or corrects it).
  useEffect(() => {
    let alive = true
    const tick = (): void => {
      void rpc('session.permission.get', { sessionId }).then((result) => {
        if (!alive || !result.ok) return
        const v = result.value as PermissionValue | undefined
        if (v === undefined || typeof v.mode !== 'string' || !isPermissionMode(v.mode)) return
        setPermission(v.mode)
      }).catch(() => {})
    }
    tick()
    const timer = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [sessionId])

  /**
   * Install {provider, model[, effort]}: optimistic local update, then the RPC
   * (which also persists the host default). A refusal leaves the optimistic
   * state standing — the next prompt surfaces the real routing error, and
   * `session.models` re-syncs on the next session switch.
   */
  const applySelection = (next: Selection): void => {
    setSelection(current => ({ ...current, ...next }))
    const payload: Record<string, unknown> = { sessionId, provider: next.provider, model: next.model }
    if (next.effort !== undefined) payload.reasoningEffort = next.effort
    void rpc('session.selectModel', payload).catch(() => {})
  }

  /**
   * Apply one picker selection. A model row passes a catalogued model id
   * (kept verbatim); a provider-group header click passes none. A model that
   * is not in the target group resolves to the group default — the wire
   * group carries no explicit default-model field (api-bridge
   * ModelProviderGroupView), so the group's first catalogued model stands
   * in. An empty group selects nothing.
   */
  const pickModel = (provider: string, model: string | undefined): void => {
    setModelMenuOpen(false)
    const group = groups.find(candidate => candidate.id === provider)
    const entry = model === undefined ? undefined : group?.models?.find(candidate => candidate.id === model)
    const resolved = entry?.id ?? group?.models?.[0]?.id
    if (resolved === undefined) return
    // Effort rides along ONLY when the target model declares reasoning
    // support: the runtime hard-refuses a reasoningEffort on a model without
    // reasoning metadata (UNSUPPORTED_REASONING_EFFORT), so carrying a stale
    // level across a provider switch bricks every later request. An
    // uncatalogued target stays unknowable — the level rides and the segment
    // stays visible for the user to correct.
    const target = group?.models?.find(candidate => candidate.id === resolved)
    const supportsEffort = target === undefined || target.reasoning !== undefined
    applySelection({ provider, model: resolved, ...(supportsEffort ? {} : { effort: undefined }) })
  }

  const pickEffort = (effort: string): void => {
    const current = groups
      .find(candidate => candidate.id === selection.provider)
      ?.models?.find(candidate => candidate.id === selection.model)
    if (current !== undefined && current.reasoning === undefined) {
      // A catalogued model without reasoning metadata hard-refuses any level;
      // clear the stuck selection instead of sending a doomed request.
      setSelection(current => ({ ...current, effort: undefined }))
      if (selection.provider !== undefined && selection.model !== undefined) {
        applySelection({ provider: selection.provider, model: selection.model, effort: undefined })
      }
      return
    }
    const provider = selection.provider ?? groups[0]?.id
    const model = selection.model ?? groups[0]?.models?.[0]?.id
    // No catalog yet and nothing logged: there is no pairing to re-send, so
    // the segment records locally and waits for a real pairing.
    if (provider === undefined || model === undefined) {
      setSelection(current => ({ ...current, effort }))
      return
    }
    applySelection({ provider, model, effort })
  }

  /**
   * Switch the permission mode: optimistic local update, then the RPC (which
   * appends the durable knob event and syncs plan state engine-side). The 5 s
   * poll re-syncs either way, including the plan-commit correction for a
   * mid-turn switch.
   */
  const pickPermissionMode = (mode: PermissionMode): void => {
    setModeMenuOpen(false)
    setPermission(mode)
    void rpc('session.permission.set', { sessionId, mode }).catch(() => {})
  }

  // ── derived display ──

  const modelLabel = (() => {
    const group = groups.find(candidate => candidate.id === selection.provider)
    const found = group?.models?.find(candidate => candidate.id === selection.model)
    return found?.name ?? found?.id ?? selection.model ?? '默认模型'
  })()

  // The segment is ALWAYS visible (user requirement): thinking is a per-call
  // posture the user controls, not a property the catalog gets to hide. A
  // catalogued model without reasoning metadata clears a picked level instead
  // of sending it (pickEffort), so the always-on segment can never brick a
  // request the way the old hide-on-unsupported behavior did.
  const effortSegmentVisible = true

  const windowFactsValue = windowFacts(selection.provider, selection.model, groups)
  const windowTokens = windowFactsValue.window
  const windowSource = windowFactsValue.source

  const meterChipLabel = (() => {
    if (usage === null) return ''
    if (windowTokens === undefined || windowTokens <= 0) return fmtTokens(usage.totalTokens)
    const pct = Math.min(999, Math.round((usage.totalTokens / windowTokens) * 100))
    return `${pct}% · ${fmtTokens(usage.totalTokens)}/${fmtTokens(windowTokens)}`
  })()

  return (
    <>
      <div className="dshx-cbar">
        {/* model badge */}
        <div className="dshx-menuwrap" ref={modelWrapRef}>
          <button
            type="button"
            className="dshx-chip"
            aria-haspopup="menu"
            aria-expanded={modelMenuOpen}
            title={`模型：${selection.provider === undefined ? '默认' : `${selection.provider} · `}${modelLabel}`}
            onClick={() => { setModelMenuOpen(open => !open) }}
          >
            <CpuIcon size={12} />
            <span className="dshx-chiplabel">{modelLabel}</span>
            <ChevronDownIcon size={10} />
          </button>
          {modelMenuOpen && (
            <div className="dshx-pop dshx-pop--up dshx-pop--left" role="menu" aria-label="选择模型">
              <div className="dshx-menuhead">选择模型</div>
              {groups.length === 0 && <div className="dshx-menuempty">暂无已配置的模型，请到设置里添加 API Key</div>}
              {groups.map(group => (
                <div key={group.id ?? group.name ?? ''}>
                  {/* Provider-group header: clicking it switches the provider and
                      lands on the group's default model (first catalogued row). */}
                  <button
                    type="button"
                    className="dshx-menuhead dshx-menugroup"
                    title={`切换到 ${group.name ?? group.id ?? ''} 的默认模型`}
                    onClick={() => {
                      if (group.id !== undefined) pickModel(group.id, undefined)
                    }}
                  >
                    {group.name ?? group.id ?? ''}
                  </button>
                  {(group.models ?? []).map((model) => {
                    const current = group.id === selection.provider && model.id === selection.model
                    return (
                      <button
                        key={`${group.id}/${model.id ?? ''}`}
                        type="button"
                        role="menuitem"
                        className={`dshx-menuitem${current ? ' is-current' : ''}`}
                        title={`${group.name ?? group.id ?? ''} · ${model.name ?? model.id ?? ''}`}
                        onClick={() => {
                          if (group.id !== undefined && model.id !== undefined) pickModel(group.id, model.id)
                        }}
                      >
                        {current && <span className="dshx-menuitem-check"><CheckIcon size={12} /></span>}
                        <span className="dshx-menuitem-name">{model.name ?? model.id ?? ''}</span>
                        {model.inputModalities?.includes('image') === true && (
                          <span className="dshx-menuitem-badge">视觉</span>
                        )}
                        {model.reasoning !== undefined && (
                          <span className="dshx-menuitem-badge">思考</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* reasoning-effort segment (hidden for catalogued models without reasoning) */}
        {effortSegmentVisible && (
          <div
            className={`dshx-seg${selection.effort === undefined ? ' is-unset' : ''}`}
            role="group"
            aria-label="思考强度"
            title={selection.effort === undefined ? '思考强度：未设置（跟随模型默认）' : '思考强度'}
          >
            <span className="dshx-seg-kw">
              <LightbulbIcon size={12} />
              思考
            </span>
            {EFFORTS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`dshx-segbtn${selection.effort === value ? ' is-on' : ''}`}
                aria-pressed={selection.effort === value}
                title={`思考强度：${label}${selection.effort === undefined && value === 'off' ? '（当前跟随默认）' : ''}`}
                onClick={() => { pickEffort(value) }}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* context meter */}
        {usage !== null && (
          <div className="dshx-menuwrap" ref={meterWrapRef}>
            <button
              type="button"
              className="dshx-chip"
              aria-haspopup="dialog"
              aria-expanded={meterPopOpen}
              title={`上下文：${meterChipLabel}`}
              onClick={() => { setMeterPopOpen(open => !open) }}
            >
              <GaugeIcon size={12} />
              <span className="dshx-chiplabel">{meterChipLabel}</span>
            </button>
            {meterPopOpen && (
              <div className="dshx-pop dshx-pop--up dshx-pop--left dshx-meterpop" role="dialog" aria-label="上下文用量明细">
                <div className="dshx-menuhead">上下文用量</div>
                <div className="dshx-meterrow">
                  <span>累计 Tokens</span>
                  <b>{fmtExact(usage.totalTokens)}</b>
                </div>
                <div className="dshx-meterrow">
                  <span>基线口径</span>
                  <b>{usage.baselineKind ?? '—'}</b>
                </div>
                <div className="dshx-meterrow">
                  <span>表层 Tokens</span>
                  <b>{usage.surfaceTokens === undefined ? '—' : fmtExact(usage.surfaceTokens)}</b>
                </div>
                {windowTokens !== undefined && (
                  <div className="dshx-meternote">
                    模型窗口 {fmtTokens(windowTokens)} tokens（
                    {windowSource === 'local' ? '依据本地面板内置资料估算' : '由模型目录提供'}）
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* permission-mode switcher (hidden until the first successful read) */}
        {permission !== null && (
          <div className="dshx-menuwrap" ref={modeWrapRef}>
            <button
              type="button"
              className="dshx-chip"
              aria-haspopup="menu"
              aria-expanded={modeMenuOpen}
              title={`权限模式：${MODE_ITEM_TABLE[permission].label}`}
              onClick={() => { setModeMenuOpen(open => !open) }}
            >
              <ShieldIcon size={12} />
              <span className="dshx-chiplabel">{MODE_ITEM_TABLE[permission].label}</span>
              <ChevronDownIcon size={10} />
            </button>
            {modeMenuOpen && (
              <div className="dshx-pop dshx-pop--up dshx-pop--left dshx-modepop" role="menu" aria-label="权限模式">
                <div className="dshx-menuhead">权限模式</div>
                {MODE_ITEMS.map((item) => {
                  const current = permission === item.value
                  return (
                    <button
                      key={item.value}
                      type="button"
                      role="menuitem"
                      className={`dshx-menuitem${current ? ' is-current' : ''}`}
                      title={item.description}
                      onClick={() => { pickPermissionMode(item.value) }}
                    >
                      {current && <span className="dshx-menuitem-check"><CheckIcon size={12} /></span>}
                      <span className="dshx-modeitem-text">
                        <span className="dshx-menuitem-name">{item.label}</span>
                        <span className="dshx-modeitem-desc">{item.description}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        <span className="dshx-csp" />

        <span className="dshx-hint">{running ? 'Esc 中断' : 'Cmd+Enter 发送'}</span>

        {running ? (
          <button
            type="button"
            className="dshx-stop"
            aria-label="中断"
            title="中断当前任务（或按 Esc）"
            onClick={onInterrupt}
          >
            <span className="dshx-stop-square" />
          </button>
        ) : (
          <button
            type="button"
            className="dshx-send"
            onClick={onSend}
            disabled={!canSend}
            aria-label="发送消息"
            title="发送（Cmd+Enter）"
          >
            <ArrowUpIcon size={16} />
          </button>
        )}
      </div>
    </>
  )
}

/**
 * Composer surface styles (the card shell lives in the root stylesheet, which
 * concatenates this export next to the shared popover base). The stylesheet is
 * injected once by extension-shell's root <style> tag.
 *
 * Chips: 24 px tall, icon + short label, transparent → bg-layer-2 on hover;
 * long labels ellipsize so a chatty model name cannot push the row to wrap.
 * Breakpoint discipline (<768/<560/<430, plus the ≤360 icon-only floor) is
 * documented centrally above SHELL_CSS in extension-shell.tsx; the tiers here
 * progressively drop the hint text (≤560), the segment keyword (≤430), and
 * finally the model-badge label (≤360).
 *
 * The slash-command menu (dshx-slashpop) anchors inside .dshx-inputwrap
 * (which gains position:relative here), floating above the textarea on the
 * LEFT composer edge; its width caps at the viewport minus gutters, so the
 * narrow-panel tiers need no extra rules of their own. The @-mention menu
 * (SubagentMenu) reuses the same sheet geometry and row classes plus the
 * capability-badge chip, so it carries no styles of its own.
 */
export const COMPOSER_CSS = `
/* left cluster layout. Popover wrappers/chips inside the bar are shrinkable
   (min-width:0 + max-width:100%) so flexbox trims labels progressively on a
   narrow panel; labels ellipsize via their own max-width, and the bar itself
   must NOT clip (no overflow:hidden) — the model/usage popovers anchor to
   .dshx-menuwrap and open upward past the card edge. */
.dshx-cbar{display:flex;align-items:center;gap:4px;min-width:0;padding:6px 8px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06))}
.dshx-cbar .dshx-menuwrap{position:relative;flex:0 1 auto;min-width:0}
.dshx-cbar .dshx-chip{max-width:100%}
.dshx-csp{flex:1 1 auto;min-width:0}
.dshx-hint{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#aaa);white-space:nowrap}
/* chip base */
.dshx-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 7px;max-width:150px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#888);cursor:pointer;font-size:11px;line-height:24px;transition:background .15s ease,color .15s ease}
.dshx-chip:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.07));color:var(--dsw-alias-label-primary,#333)}
.dshx-chiplabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px}
/* reasoning-effort segmented control */
.dshx-seg{display:inline-flex;align-items:center;height:24px;padding:0 2px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px;color:var(--dsw-alias-label-secondary,#888)}
.dshx-seg.is-unset{opacity:.55}
.dshx-seg-kw{display:inline-flex;align-items:center;gap:3px;padding-left:4px;font-size:11px;color:var(--dsw-alias-label-secondary,#888)}
.dshx-segbtn{height:20px;margin:1px 0;padding:0 6px;border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:11px;line-height:20px;white-space:nowrap;transition:background .15s ease,color .15s ease}
.dshx-segbtn:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.08))}
.dshx-segbtn.is-on{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 15%,transparent);color:var(--dsw-alias-brand-primary,#4c7dfd);font-weight:600}
/* capability badges inside model-menu rows (思考/视觉) */
.dshx-menuitem-badge{flex:none;height:14px;padding:0 5px;border-radius:7px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.07));color:var(--dsw-alias-label-tertiary,#999);font-size:10px;line-height:14px;white-space:nowrap}
/* provider-group header rows: clickable switch-to-group-default */
.dshx-menugroup{display:flex;width:100%;align-items:center;border:none;background:transparent;color:inherit;cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color .15s ease}
.dshx-menugroup:hover{color:var(--dsw-alias-label-primary,#333)}
/* usage details popover rows */
.dshx-meterpop{width:min(260px,calc(100vw - 32px))}
.dshx-meterrow{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:6px 8px;border-radius:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#888)}
.dshx-meterrow b{font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#171717)}
.dshx-meternote{padding:4px 8px 2px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#aaa)}
/* permission-mode menu: one row per mode, name over one-line description */
.dshx-modepop{width:min(240px,calc(100vw - 32px))}
.dshx-modeitem{align-items:center}
.dshx-modeitem-text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;text-align:left}
.dshx-modeitem-text .dshx-menuitem-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#171717);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshx-modeitem-desc{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#aaa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* slash-command candidate menu: floats above the textarea inside the input
   wrap; overrides .dshx-pop--up's chip-bar offset with a tight anchor gap and
   caps the sheet smaller than the chip popovers (command rows are short). */
.dshx-inputwrap{position:relative}
.dshx-slashpop{left:0;right:auto;bottom:calc(100% + 2px);width:min(340px,calc(100vw - 24px));max-height:min(240px,48vh)}
/* menu rows: mono command name + ellipsized description */
.dshx-slashitem-name{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#171717);white-space:nowrap}
.dshx-slashitem-desc{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-slashitem.is-active{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.07))}
@media (max-width: 560px){
  /* the hint text is the first sacrifice: pure decoration */
  .dshx-hint{display:none}
}
@media (max-width: 430px){
  /* compact bar: drop the segment keyword; truncate chip labels harder */
  .dshx-seg-kw{display:none}
  .dshx-chip{max-width:118px}
  .dshx-chiplabel{max-width:84px}
  .dshx-cbar{gap:3px;padding:6px}
}
@media (max-width: 360px){
  /* last-resort floor: model badge goes icon-only (identity lives in the
     popover), so the send/stop button can never be pushed off-card */
  .dshx-cbar .dshx-menuwrap:first-child .dshx-chiplabel,
  .dshx-cbar .dshx-menuwrap:first-child svg:last-child{display:none}
  .dshx-cbar .dshx-menuwrap:first-child .dshx-chip{padding:0 7px}
  .dshx-chiplabel{max-width:64px}
}
`
