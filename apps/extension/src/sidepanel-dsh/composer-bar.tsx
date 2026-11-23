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
 *   - Reasoning-effort dropdown maps 关/低/中/高 labels onto the same
 *     `session.selectModel` call's `reasoningEffort` ('' clears to the model
 *     default). The menu offers exactly the current model's declared
 *     `reasoning.efforts` (the runtime refuses anything else); a catalogued
 *     model without reasoning metadata disables the chip, and an uncatalogued
 *     one falls back to the historic fixed set.
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
import { NEW_SESSION_ID } from './trajectory-host.tsx'
import { usePopoverDismiss } from './popover.tsx'
import { shellT, useShellT } from './locales/index.ts'
import type { ShellLocaleKey, ShellTranslate } from './locales/index.ts'
import { agentPresetDescription, agentPresetName } from './locales/preset-labels.ts'
import {
  ArrowUpIcon, BoltIcon, CheckIcon, ChevronDownIcon, CpuIcon, DocIcon, DownloadIcon,
  GaugeIcon, GlobeIcon, LightbulbIcon, PuzzleIcon, RetryIcon, SendIcon, ShieldIcon, TargetIcon,
} from './icons.tsx'
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

/** Switcher dictionary keys per wire value; the table is exhaustive over `PermissionMode`. */
const MODE_ITEM_KEYS: Readonly<Record<PermissionMode, { label: ShellLocaleKey; description: ShellLocaleKey }>> = {
  'ask-always': { label: 'composer.permission.askAlways', description: 'composer.permission.askAlwaysDescription' },
  'ask-change': { label: 'composer.permission.askChange', description: 'composer.permission.askChangeDescription' },
  full: { label: 'composer.permission.full', description: 'composer.permission.fullDescription' },
}

/** One switcher entry, resolved for the active locale. */
export interface ModeItem {
  value: PermissionMode
  label: string
  description: string
}

/**
 * Switcher entries in wire order, in the active locale (shared with the
 * automation panel's form).
 * @param t - the shell translate.
 * @returns one entry per permission mode.
 */
export function modeItems(t: ShellTranslate): ReadonlyArray<ModeItem> {
  return PERMISSION_MODES.map(value => ({
    value,
    label: t(MODE_ITEM_KEYS[value].label),
    description: t(MODE_ITEM_KEYS[value].description),
  }))
}

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
    reasoning?: { efforts?: Array<{ id?: unknown; name?: string }>; defaultEffort?: string }
  }>
}

/**
 * The effort ids one catalogued model row declares selectable. The wire rows
 * carry `{id, name}` objects (ModelReasoningView), so unwrap by `id`.
 */
const declaredEffortIds = (
  row: NonNullable<ModelGroup['models']>[number] | undefined,
): string[] =>
  (row?.reasoning?.efforts ?? [])
    .filter((entry): entry is { id: string } =>
      typeof entry === 'object' && entry !== null && typeof entry.id === 'string')
    .map(entry => entry.id)

/** `session.models` ok value (wire view) — the boot source for chip state. */
interface SessionModelsValue {
  current?: { provider?: string; model?: string; reasoningEffort?: string }
  groups?: ModelGroup[]
}

/** `agentPreset.list` ok value (wire view) — the authorable roster. */
interface PresetListValue {
  presets?: PresetRow[]
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

/** One agentPreset.list row (wire view): the authorable preset roster. */
interface PresetRow {
  id: string
  trust: 'system' | 'user'
  isDefault: boolean
  name: string
  description?: string | undefined
  broken?: string | undefined
}

export interface ComposerBarProps {
  sessionId: string
  running: boolean
  canSend: boolean
  /** Catalog from the parent's 15 s `llm.models` poll (configured groups only). */
  groups: ModelGroup[]
  /**
   * Learned sites whose cheat sheet is being injected right now (the active
   * tab's host matched an enabled site-knowledge record). Absent or empty
   * renders no chip.
   */
  siteKnowledge?: readonly { readonly host: string; readonly bytes: number }[]
  onSend: () => void
  onInterrupt: () => void
  /**
   * Running-state send: while a turn is live the primary button turns into a
   * stop control; this companion keeps a send affordance whose click queues
   * (or steers, per the busy-enter preference) instead — the dsh desktop
   * composer behaves the same way. Undefined hides the companion.
   */
  runSend?: { label: string; send: () => void } | undefined
  /**
   * Reports a preset pick made while the session is still the fresh-session
   * sentinel: there is no agent to select on, so the shell holds the id and
   * composes it into the mint's session.create payload.
   */
  onPendingPreset?: (agentPreset: string) => void
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
   * Materialize the command's target session when the composer still sits on
   * the fresh-session start (`session-new`): resolves the real session id
   * (minting and adopting one when needed). Absent = the caller must use the
   * passed session id as-is. A rejection aborts the command dispatch and
   * falls back to a normal send with a notice.
   */
  ensureSession?(): Promise<string>
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
  const message = raw !== '' ? raw : shellT()('composer.notice.unknownReason')
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
 * notice. A LOCAL rpc timeout is the exception: the command handler keeps
 * running to settlement server-side, so the composer reports a background
 * execution instead of re-sending the line to the model. A line addressed
 * `@名字 正文` goes to `subagent.prompt` (payload
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
        const t = shellT()
        actions.notice(t('composer.notice.subagentDeliveryFailed', { name: matched.label, reason: refusalSummary(result) }))
        actions.prompt(line)
      })
      return
    }
    // Mention-SHAPED but unresolved (a hand-typed name the cache does not
    // know); a bare `@` or `@ word` is just text and sends silently.
    const stray = /^@([^\s@]+)/.exec(line)?.[1]
    if (stray !== undefined && MENTION_SHAPE.test(line)) {
      actions.notice(shellT()('composer.notice.subagentNotFound', { name: stray }))
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
  // A command line needs a real session to execute against (its lifecycle
  // logs into that session); on the fresh-session start the shell's
  // ensureSession mints and adopts one first. 120s execution budget: command
  // handlers run to settlement by design (/learn-site's site crawl runs
  // minutes-scale), and the 10s default would misread a live handler as a
  // failed service and send the command line to the model as plain text.
  const executeCommand = async (): Promise<void> => {
    let agentId = sessionId
    if (actions.ensureSession !== undefined) {
      try {
        agentId = await actions.ensureSession()
      } catch (err) {
        const t = shellT()
        actions.notice(t('composer.notice.sessionCreateFailed', { reason: err instanceof Error ? err.message : String(err) }))
        actions.prompt(line)
        return
      }
    }
    const result = await rpc('commands/execute', { args: { agentId, line } }, 120_000)
    if (result.ok && result.value !== undefined) {
      actions.onCommandAdmitted()
      return
    }
    // A LOCAL timeout is not a refusal: the command handler keeps running to
    // settlement server-side (its durable command flow nodes land in the
    // session either way), so re-sending the line would execute it twice and
    // feeding it to the model would be worse. Report the background execution
    // and stop; only a genuine refusal or an unknown token falls back.
    const t = shellT()
    if (!result.ok && result.error?.timedOut === true) {
      actions.notice(t('composer.notice.commandStillRunning'))
      return
    }
    actions.notice(result.ok
      ? t('composer.notice.unknownCommand', { line })
      : t('composer.notice.commandServiceUnavailable'))
    actions.prompt(line)
  }
  void executeCommand()
}

// ── slash-command candidate menu ──

/** One candidate row of the composer's `/` menu (engine command or shell-local). */
interface SlashCandidate {
  /** Command name without the leading slash (`export`, `plan`, `plan:policy`). */
  readonly name: string
  /** Human-readable summary rendered beside the name: the wire's own wording, or empty when `descriptionKey` is set. */
  readonly description: string
  /** A shell-local row's summary, resolved through the locale seat at render. */
  readonly descriptionKey?: ShellLocaleKey
  /** `plugin` rows render under the plugins section head (skills ride commands/list). */
  readonly group?: 'plugin'
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
  description: '',
  descriptionKey: 'composer.slash.exportDescription',
}

/**
 * Menu presentation per command name — icon plus the localized label shown
 * beside the english name (the engine wire carries only name+description, so
 * the label table lives here with the rest of the shell chrome copy). Rows
 * outside the table keep the generic puzzle icon and fall back to
 * `/name` + description.
 */
const SLASH_PRESENTATION: Readonly<Record<string, { labelKey: ShellLocaleKey; Icon: (props: { size?: number }) => JSX.Element }>> = {
  export: { labelKey: 'composer.slash.export', Icon: DownloadIcon },
  compact: { labelKey: 'composer.slash.compact', Icon: RetryIcon },
  feedback: { labelKey: 'composer.slash.feedback', Icon: SendIcon },
  goal: { labelKey: 'composer.slash.goal', Icon: TargetIcon },
  plan: { labelKey: 'composer.slash.plan', Icon: DocIcon },
  'learn-site': { labelKey: 'composer.slash.learnSite', Icon: GlobeIcon },
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
        .map(row => row as { name?: unknown; description?: unknown; group?: unknown })
        .filter(row => typeof row.name === 'string' && row.name.length > 0)
        .map(row => ({
          name: row.name as string,
          description: typeof row.description === 'string' ? row.description : '',
          ...(row.group === 'plugin' ? { group: 'plugin' as const } : {}),
        }))
      setCommands([LOCAL_EXPORT, ...wire.filter(row => row.name !== LOCAL_EXPORT.name)])
    }).catch(() => {})
    return () => {
      alive = false
    }
  }, [sessionId])
  return commands
}

/** One skill candidate row of the composer's `/` menu (user-invocable roster). */
export interface SlashSkill {
  /** Skill name without the leading slash (the invocation token). */
  readonly name: string
  /** Human-readable summary rendered beside the name. */
  readonly description: string
}

/**
 * One-shot `skill.list` per session (the roster is host-global; the id only
 * keys the read): the user-invocable skills the menu lists under 技能. A
 * refused or failed read degrades to an empty list — the 技能 group simply
 * never renders.
 *
 * @param sessionId - session scoping the catalog read (any id is tolerated).
 * @returns the skill rows in wire order; empty until the first success.
 */
export function useSlashSkills(sessionId: string): SlashSkill[] {
  const [skills, setSkills] = useState<SlashSkill[]>([])
  useEffect(() => {
    let alive = true
    void rpc('skill.list', { sessionId }).then((result) => {
      if (!alive || !result.ok) return
      const rows = (result.value as { skills?: unknown } | undefined)?.skills
      if (!Array.isArray(rows)) return
      const wire = rows
        .map(row => row as { name?: unknown; description?: unknown })
        .filter(row => typeof row.name === 'string' && row.name.length > 0)
        .map(row => ({
          name: row.name as string,
          description: typeof row.description === 'string' ? row.description : '',
        }))
      setSkills(wire)
    }).catch(() => {})
    return () => {
      alive = false
    }
  }, [sessionId])
  return skills
}

/**
 * Candidates for the query being typed: name-prefix matches first (wire
 * order across commands then skills), then description/summary substring
 * matches; case-insensitive. The two tiers are disjoint per row, so no dedup
 * is needed. Skills tagged `skill: true` render in the 技能 group.
 *
 * @param rows  merged candidate source rows (commands, then skills).
 * @param query text after the leading `/` ('' lists everything).
 * @returns rows in menu order (name matches, then description matches).
 */
function filterSlashRows<T extends { name: string; description: string }>(rows: readonly T[], query: string): T[] {
  if (query === '') return [...rows]
  const needle = query.toLowerCase()
  const byName: T[] = []
  const byDesc: T[] = []
  for (const row of rows) {
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
  onChange: (text: string) => void
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
  const t = useShellT()
  // A shell-local row's summary follows the active locale; wire rows carry their own wording.
  const commands = useSlashCommands(sessionId)
    .map(row => (row.descriptionKey === undefined ? row : { ...row, description: t(row.descriptionKey) }))
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const dismiss = useCallback((): void => { setDismissed(true) }, [])
  const popRef = useRef<HTMLDivElement>(null)
  const activeRowRef = useRef<HTMLButtonElement | null>(null)

  const query = SLASH_SHAPE.exec(text)?.[1] ?? null
  const candidates = useMemo(
    () => (query === null ? [] : filterSlashRows(commands, query)),
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
    <div ref={popRef} className="dshx-pop dshx-pop--up dshx-slashpop" role="listbox" aria-label={t('composer.slash.menuLabel')}>
      <div className="dshx-slashhead" aria-hidden="true">{t('composer.slash.commandsHeading')}</div>
      {candidates.map((row, index) => {
        const isActive = row === activeRow
        const presentation = SLASH_PRESENTATION[row.name]
        const Icon = presentation?.Icon ?? PuzzleIcon
        const pluginHead = row.group === 'plugin' && candidates[index - 1]?.group !== 'plugin'
          ? <div className="dshx-slashhead" aria-hidden="true">{t('composer.slash.pluginsHeading')}</div>
          : null
        return (
          <>
            {pluginHead}
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
              <span className="dshx-slashitem-icon" aria-hidden="true"><Icon size={14} /></span>
              {presentation !== undefined ? (
                <>
                  <span className="dshx-slashitem-label">{t(presentation.labelKey)}</span>
                  <span className="dshx-slashitem-en">{row.name}</span>
                </>
              ) : (
                <>
                  <span className="dshx-slashitem-name">/{row.name}</span>
                  <span className="dshx-slashitem-desc">{row.description}</span>
                </>
              )}
            </button>
          </>
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
  refresh: () => void
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
  onChange: (text: string) => void
  /** The composer textarea the menu floats above and listens to for keys. */
  textareaRef: RefObject<HTMLTextAreaElement>
  /**
   * Fired when a mention query becomes active (an `@token` appears): the hook
   * re-reads `subagent.list` so children spawned mid-session join the menu
   * instead of waiting for a session switch.
   */
  onMentionActive?: () => void
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
  const t = useShellT()
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
    <div ref={popRef} className="dshx-pop dshx-pop--up dshx-slashpop" role="listbox" aria-label={t('composer.mention.menuLabel')}>
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
            <span className="dshx-menuitem-badge">{row.activity === 'running' ? t('composer.mention.running') : t('composer.mention.idle')}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── reasoning-effort choices ──

/** Dictionary keys for catalogued effort levels. */
const EFFORT_LABEL_KEYS: Readonly<Record<string, ShellLocaleKey>> = {
  off: 'composer.effort.off',
  low: 'composer.effort.low',
  medium: 'composer.effort.medium',
  high: 'composer.effort.high',
  max: 'composer.effort.max',
}

/**
 * The dictionary key of one catalogued effort level.
 * @param value - the wire effort level.
 * @returns the key, or undefined when the level has no catalogued label.
 */
export function effortLabelKey(value: string): ShellLocaleKey | undefined {
  return EFFORT_LABEL_KEYS[value]
}

/**
 * The label of one effort level in the active locale; an unmapped wire value
 * renders raw. Shared with the automation run-config chips.
 * @param t - the shell translate.
 * @param value - the wire effort level.
 * @returns the localized label, or the wire value when no label is catalogued.
 */
export function effortLabel(t: ShellTranslate, value: string): string {
  const key = effortLabelKey(value)
  return key === undefined ? value : t(key)
}

/** Menu for a model whose wire row does not disclose its effort set (uncatalogued rows): the historic fixed set. */
const FALLBACK_EFFORT_LEVELS: ReadonlyArray<string> = ['off', 'low', 'medium', 'high']

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

export function ComposerBar({
  sessionId, running, canSend, groups, siteKnowledge,
  onSend, onInterrupt, runSend, onPendingPreset,
}: ComposerBarProps): JSX.Element {
  const t = useShellT()
  const [selection, setSelection] = useState<Selection>({})
  const [usage, setUsage] = useState<Required<Pick<UsageValue, 'totalTokens'>> & UsageValue | null>(null)
  const [permission, setPermission] = useState<PermissionMode | null>(null)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [effortMenuOpen, setEffortMenuOpen] = useState(false)
  const [meterPopOpen, setMeterPopOpen] = useState(false)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [presetMenuOpen, setPresetMenuOpen] = useState(false)
  const [presets, setPresets] = useState<PresetRow[]>([])
  const [presetId, setPresetId] = useState<string>('standard')
  const [presetError, setPresetError] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const modelWrapRef = useRef<HTMLDivElement>(null)
  const effortWrapRef = useRef<HTMLDivElement>(null)
  const meterWrapRef = useRef<HTMLDivElement>(null)
  const modeWrapRef = useRef<HTMLDivElement>(null)
  const presetWrapRef = useRef<HTMLDivElement>(null)

  usePopoverDismiss(modelMenuOpen, () => { setModelMenuOpen(false) }, modelWrapRef)
  usePopoverDismiss(effortMenuOpen, () => { setEffortMenuOpen(false) }, effortWrapRef)
  usePopoverDismiss(meterPopOpen, () => { setMeterPopOpen(false) }, meterWrapRef)
  usePopoverDismiss(modeMenuOpen, () => { setModeMenuOpen(false) }, modeWrapRef)
  usePopoverDismiss(presetMenuOpen, () => { setPresetMenuOpen(false) }, presetWrapRef)

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
      // Self-heal a pairing persisted before its guard: an effort level the
      // target model refuses (no reasoning metadata, or the level is outside
      // its declared set) bricks every request (UNSUPPORTED_REASONING_EFFORT).
      // The catalog comes from THIS response — the `groups` prop still holds
      // the mount-time empty array here.
      const bootEntry = (result.value as SessionModelsValue | undefined)?.groups
        ?.find(candidate => candidate.id === bootProvider)?.models
        ?.find(candidate => candidate.id === bootModel)
      const declared = declaredEffortIds(bootEntry)
      const refused = bootEffort !== undefined && bootEntry !== undefined
        && (bootEntry.reasoning === undefined || (declared.length > 0 && !declared.includes(bootEffort)))
      if (refused && bootProvider !== undefined && bootModel !== undefined) {
        setSelection({ provider: bootProvider, model: bootModel, effort: undefined })
        // reasoningEffort '' is the explicit clear: the bridge drops the
        // persisted level instead of keeping it for the next session.
        void rpc('session.selectModel', { sessionId, provider: bootProvider, model: bootModel, reasoningEffort: '' }, 60_000).catch(() => {})
      }
      // 未设置＝最高：a boot pairing with no persisted effort and a model that
      // declares levels reads as the model's TOP level (the user's default
      // posture), persisted so requests and the next boot agree. Models that
      // declare nothing keep the model-default behavior.
      if (bootEffort === undefined && declared.length > 0 && bootProvider !== undefined && bootModel !== undefined) {
        const highest = declared[declared.length - 1]
        setSelection({ provider: bootProvider, model: bootModel, effort: highest })
        void rpc('session.selectModel', { sessionId, provider: bootProvider, model: bootModel, reasoningEffort: highest }, 60_000).catch(() => {})
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

  // ── agent-preset switcher ──

  /**
   * Boot the preset roster (agentPreset.list) and the session's live preset
   * (the newest durable `agent-preset/selected` event in its log — a session
   * that never switched reads the implicit 默认). Per-session state: switching
   * sessions re-reads both.
   */
  useEffect(() => {
    let alive = true
    setPresetId('default')
    setPresetError(null)
    void rpc('agentPreset.list', {}).then((result) => {
      if (!alive || !result.ok) return
      const v = result.value as PresetListValue | undefined
      setPresets(v?.presets ?? [])
      // A session whose log names no switch (a fresh session above all) rides
      // the ROSTER default, whatever row that is — the chip shows the preset
      // that actually applies. The roster baseline is 标准模式.
      setPresetId(current => current === 'default'
        ? (v?.presets ?? []).find(preset => preset.isDefault)?.id ?? 'standard'
        : current)
    }).catch(() => {})
    void rpc('session.list', {}).then((result) => {
      if (!alive || !result.ok) return
      // The summary carries the SERVER-RESOLVED current preset (the newest
      // agent-preset/selected event, however deep the log grew). A paginated
      // history scan here would miss it once later turns push the event past
      // the tail page.
      const items = (result.value as { items?: Array<{ sessionId?: string; agentPreset?: string }> })?.items ?? []
      const mine = items.find(item => item.sessionId === sessionId)
      if (mine?.agentPreset !== undefined && mine.agentPreset !== 'default') setPresetId(mine.agentPreset)
    }).catch(() => {})
    return () => {
      alive = false
    }
  }, [sessionId])

  /**
   * Switch the session's agent preset. A started conversation refuses the
   * switch (`agent-preset-locked` — its history was produced under the old
   * composition); the error surfaces inline in the preset menu instead of
   * silently closing it.
   */
  const pickPreset = (id: string): void => {
    // A fresh-session sentinel has no agent to select on: the pick is held
    // and composed at the mint (the first send's session.create). Calling
    // the RPC here would fail with 会话不存在.
    if (sessionId === NEW_SESSION_ID) {
      setPresetId(id)
      setPresetMenuOpen(false)
      setPresetError(null)
      onPendingPreset?.(id)
      return
    }
    void rpc('agentPreset.select', { sessionId, agentPreset: id }).then((result) => {
      if (result.ok) {
        setPresetId(id)
        setPresetMenuOpen(false)
        setPresetError(null)
        return
      }
      setPresetError(result.error?.message ?? t('composer.preset.switchFailed'))
    }).catch(() => {
      setPresetError(t('composer.preset.switchFailedBridge'))
    })
  }

  const presetLabel = (() => {
    const found = presets.find(candidate => candidate.id === presetId)
    return found === undefined ? t('composer.preset.standardName') : agentPresetName(t, found)
  })()


  /**
   * Install {provider, model[, effort]}: optimistic local update, then the RPC
   * (which also persists the host default). reasoningEffort rides as a string
   * always — '' is the explicit clear, so the bridge drops a stale level
   * instead of keeping it for the next session. A refusal or a failed send
   * rolls the optimistic state back and surfaces why; silence here is how a
   * dead switch read as "切换不了".
   */
  const applySelection = (next: Selection): void => {
    const previous = selection
    setSelection(current => ({ ...current, ...next }))
    const payload = { sessionId, provider: next.provider, model: next.model, reasoningEffort: next.effort ?? '' }
    // The repair-sized budget covers a switch that pays the session's cold
    // resume (selectModel ensures the agent) inside this RPC.
    void rpc('session.selectModel', payload, 60_000).then((result) => {
      if (result.ok) {
        setApplyError(null)
        return
      }
      setSelection(previous)
      setApplyError(result.error?.message ?? t('composer.apply.modelNotApplied'))
    }).catch(() => {
      setSelection(previous)
      setApplyError(t('composer.apply.modelSendFailed'))
    })
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
    // The picked effort rides along ONLY when the target model declares it
    // selectable: the runtime hard-refuses a reasoningEffort outside the
    // target's declared set (UNSUPPORTED_REASONING_EFFORT), so carrying a
    // stale level across a switch bricks every later request. An
    // uncatalogued target stays unknowable — the level rides and the user
    // corrects from the full fallback menu.
    const target = group?.models?.find(candidate => candidate.id === resolved)
    const declared = declaredEffortIds(target)
    const carry = target === undefined || (selection.effort !== undefined && declared.includes(selection.effort))
    // 未设置＝最高: a carried-undefined effort lands on the target model's top
    // declared level when it declares any (the same default posture the boot
    // applies); models without reasoning metadata keep model-default behavior.
    const defaulted = !carry && declared.length > 0 ? declared[declared.length - 1] : undefined
    applySelection({ provider, model: resolved, effort: carry ? selection.effort : defaulted })
  }

  /** Install one effort level; undefined is the explicit "follow the model default". */
  const pickEffort = (effort: string | undefined): void => {
    const provider = selection.provider ?? groups[0]?.id
    const model = selection.model ?? groups[0]?.models?.[0]?.id
    // No catalog yet and nothing logged: there is no pairing to re-send, so
    // the level records locally and waits for a real pairing.
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
    return found?.name ?? found?.id ?? selection.model ?? t('composer.model.defaultName')
  })()

  // The effort control is ALWAYS rendered (user requirement): thinking is a
  // per-call posture the user owns. The current catalog row then shapes it —
  // a catalogued model without reasoning metadata DISABLES the control (every
  // level would be refused, and a silently dead control is how this read as
  // "切换不了"), a declared effort set IS the menu (the runtime refuses
  // anything else, e.g. DeepSeek has no medium), and an uncatalogued model
  // keeps the historic fixed set for the user to try.
  const currentModelRow = groups
    .find(candidate => candidate.id === selection.provider)
    ?.models?.find(candidate => candidate.id === selection.model)
  const effortDisabled = currentModelRow !== undefined && currentModelRow.reasoning === undefined
  const effortChoices: ReadonlyArray<{ value: string; label: string }> = (() => {
    const declared = declaredEffortIds(currentModelRow)
    return (declared.length > 0 ? declared : FALLBACK_EFFORT_LEVELS)
      .map(value => ({ value, label: effortLabel(t, value) }))
  })()

  const windowFactsValue = windowFacts(selection.provider, selection.model, groups)
  const windowTokens = windowFactsValue.window
  const windowSource = windowFactsValue.source

  const meterChipLabel = (() => {
    if (usage === null) return ''
    if (windowTokens === undefined || windowTokens <= 0) return fmtTokens(usage.totalTokens)
    const pct = Math.min(999, Math.round((usage.totalTokens / windowTokens) * 100))
    return `${pct}% · ${fmtTokens(usage.totalTokens)}/${fmtTokens(windowTokens)}`
  })()

  const modes = modeItems(t)
  const currentMode = permission === null ? undefined : modes.find(item => item.value === permission)

  return (
    <>
      <div className="dshx-cbar">
        {applyError !== null && <div className="dshx-applyerror" role="alert">{applyError}</div>}
        {/* model badge */}
        <div className="dshx-menuwrap" ref={modelWrapRef}>
          <button
            type="button"
            className="dshx-chip"
            aria-haspopup="menu"
            aria-expanded={modelMenuOpen}
            aria-label={t('composer.model.pickerLabel', { name: `${selection.provider === undefined ? t('composer.model.defaultProvider') : `${selection.provider} · `}${modelLabel}` })}
            title={t('composer.model.chipTitle', { name: `${selection.provider === undefined ? t('composer.model.defaultProvider') : `${selection.provider} · `}${modelLabel}` })}
            onClick={() => { setModelMenuOpen(open => !open) }}
          >
            <CpuIcon size={12} />
            <span className="dshx-chiplabel">{modelLabel}</span>
            <ChevronDownIcon size={10} />
          </button>
          {modelMenuOpen && (
            <div className="dshx-pop dshx-pop--up dshx-pop--left" role="menu" aria-label={t('composer.model.menuLabel')}>
              <div className="dshx-menuhead">{t('composer.model.menuLabel')}</div>
              {groups.length === 0 && <div className="dshx-menuempty">{t('composer.model.empty')}</div>}
              {groups.map(group => (
                <div key={group.id ?? group.name ?? ''}>
                  {/* Provider-group header: clicking it switches the provider and
                      lands on the group's default model (first catalogued row). */}
                  <button
                    type="button"
                    className="dshx-menuhead dshx-menugroup"
                    title={t('composer.model.groupTitle', { name: group.name ?? group.id ?? '' })}
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
                          <span className="dshx-menuitem-badge">{t('composer.model.visionBadge')}</span>
                        )}
                        {model.reasoning !== undefined && (
                          <span className="dshx-menuitem-badge">{t('composer.model.reasoningBadge')}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* reasoning-effort dropdown (always rendered; unset follows the model default) */}
        <div className="dshx-menuwrap" ref={effortWrapRef}>
          <button
            type="button"
            className={`dshx-chip${selection.effort === undefined || effortDisabled ? ' is-unset' : ''}`}
            aria-haspopup="menu"
            aria-expanded={effortMenuOpen}
            aria-label={t('composer.effort.chipLabel')}
            disabled={effortDisabled}
            title={effortDisabled
              ? t('composer.effort.unsupportedTitle')
              : selection.effort === undefined
                ? t('composer.effort.unsetTitle')
                : t('composer.effort.chipLabel')}
            onClick={() => { setEffortMenuOpen(open => !open) }}
          >
            <LightbulbIcon size={12} />
            <span className="dshx-chiplabel">
              {effortDisabled
                ? t('composer.effort.unsupportedChip')
                : selection.effort === undefined
                  ? t('composer.effort.defaultChip')
                  : t('composer.effort.chipValue', { label: effortLabel(t, selection.effort) })}
            </span>
            <ChevronDownIcon size={10} />
          </button>
          {effortMenuOpen && (
            <div className="dshx-pop dshx-pop--up dshx-pop--left" role="menu" aria-label={t('composer.effort.chipLabel')}>
              <div className="dshx-menuhead">{t('composer.effort.chipLabel')}</div>
              <button
                type="button"
                role="menuitem"
                className={`dshx-menuitem${selection.effort === undefined ? ' is-current' : ''}`}
                title={t('composer.effort.followModelTitle')}
                onClick={() => {
                  setEffortMenuOpen(false)
                  pickEffort(undefined)
                }}
              >
                {selection.effort === undefined && <span className="dshx-menuitem-check"><CheckIcon size={12} /></span>}
                <span className="dshx-menuitem-name">{t('composer.effort.followModelName')}</span>
                <span className="dshx-menuitem-badge">{t('composer.effort.followModelBadge')}</span>
              </button>
              {effortChoices.map((choice) => {
                const current = selection.effort === choice.value
                return (
                  <button
                    key={choice.value}
                    type="button"
                    role="menuitem"
                    className={`dshx-menuitem${current ? ' is-current' : ''}`}
                    title={t('composer.effort.choiceTitle', { label: choice.label })}
                    onClick={() => {
                      setEffortMenuOpen(false)
                      pickEffort(choice.value)
                    }}
                  >
                    {current && <span className="dshx-menuitem-check"><CheckIcon size={12} /></span>}
                    <span className="dshx-menuitem-name">{choice.label}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* site-knowledge status: the active tab's learned cheat sheet is in
            the model context right now — make the injection visible so the
            feature explains itself (status, not a control). */}
        {siteKnowledge !== undefined && siteKnowledge.length > 0 && (
          <span
            className="dshx-chip is-sitek"
            title={t('composer.siteKnowledge.title', {
              sites: siteKnowledge
                .map(site => t('composer.siteKnowledge.entry', { host: site.host, bytes: String(site.bytes) }))
                .join(t('composer.siteKnowledge.separator')),
            })}
          >
            <BoltIcon size={12} />
            <span className="dshx-chiplabel">{siteKnowledge[0]?.host}{siteKnowledge.length > 1 ? ` +${String(siteKnowledge.length - 1)}` : ''}</span>
          </span>
        )}

        {/* context meter */}
        {usage !== null && (
          <div className="dshx-menuwrap" ref={meterWrapRef}>
            <button
              type="button"
              className="dshx-chip"
              aria-haspopup="dialog"
              aria-label={t('composer.context.chipLabel')}
              aria-expanded={meterPopOpen}
              title={t('composer.context.chipTitle', { label: meterChipLabel })}
              onClick={() => { setMeterPopOpen(open => !open) }}
            >
              <GaugeIcon size={12} />
              <span className="dshx-chiplabel">{meterChipLabel}</span>
            </button>
            {meterPopOpen && (
              <div className="dshx-pop dshx-pop--up dshx-pop--left dshx-meterpop" role="dialog" aria-label={t('composer.context.detailLabel')}>
                <div className="dshx-menuhead">{t('composer.context.heading')}</div>
                <div className="dshx-meterrow">
                  <span>{t('composer.context.total')}</span>
                  <b>{fmtExact(usage.totalTokens)}</b>
                </div>
                <div className="dshx-meterrow">
                  <span>{t('composer.context.baseline')}</span>
                  <b>{usage.baselineKind ?? '—'}</b>
                </div>
                <div className="dshx-meterrow">
                  <span>{t('composer.context.surface')}</span>
                  <b>{usage.surfaceTokens === undefined ? '—' : fmtExact(usage.surfaceTokens)}</b>
                </div>
                {windowTokens !== undefined && (
                  <div className="dshx-meternote">
                    {t('composer.context.windowNote', {
                      window: fmtTokens(windowTokens),
                      source: windowSource === 'local' ? t('composer.context.windowSourceLocal') : t('composer.context.windowSourceCatalog'),
                    })}
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
              aria-label={t('composer.permission.chipLabel')}
              title={t('composer.permission.chipTitle', { label: currentMode?.label ?? '' })}
              onClick={() => { setModeMenuOpen(open => !open) }}
            >
              <ShieldIcon size={12} />
              <span className="dshx-chiplabel">{currentMode?.label}</span>
              <ChevronDownIcon size={10} />
            </button>
            {modeMenuOpen && (
              // The mode chip is the footer's rightmost control: the default
              // right-edge anchor (no `--left`) keeps the sheet inside the panel.
              <div className="dshx-pop dshx-pop--up dshx-modepop" role="menu" aria-label={t('composer.permission.chipLabel')}>
                <div className="dshx-menuhead">{t('composer.permission.chipLabel')}</div>
                {modes.map((item) => {
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

        {/* agent-preset switcher: the roster from agentPreset.list; picking
            one recomposes a BLANK session (started sessions refuse with
            agent-preset-locked, surfaced inline in the menu). */}
        <div className="dshx-menuwrap" ref={presetWrapRef}>
          <button
            type="button"
            className="dshx-chip"
            aria-haspopup="menu"
            aria-expanded={presetMenuOpen}
            aria-label={t('composer.preset.chipLabel')}
            title={t('composer.preset.chipTitle', { name: presetLabel })}
            onClick={() => { setPresetMenuOpen(open => !open) }}
          >
            <PuzzleIcon size={12} />
            <span className="dshx-chiplabel">{presetLabel}</span>
            <ChevronDownIcon size={10} />
          </button>
          {presetMenuOpen && (
            <div className="dshx-pop dshx-pop--up dshx-pop--left" role="menu" aria-label={t('composer.preset.chipLabel')}>
              <div className="dshx-menuhead">{t('composer.preset.chipLabel')}</div>
              {presets.length === 0 && <div className="dshx-menuempty">{t('composer.preset.empty')}</div>}
              {presets.map(item => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  disabled={item.broken !== undefined}
                  title={item.broken !== undefined ? item.broken : agentPresetDescription(t, item)}
                  className={`dshx-menuitem${item.id === presetId ? ' is-current' : ''}`}
                  onClick={() => { pickPreset(item.id) }}
                >
                  {item.id === presetId && <span className="dshx-menuitem-check"><CheckIcon size={12} /></span>}
                  <span className="dshx-menuitem-name">{agentPresetName(t, item)}</span>
                </button>
              ))}
              {presetError !== null && <div className="dshx-menuempty" role="alert">{presetError}</div>}
            </div>
          )}
        </div>

        <span className="dshx-csp" />

        {running && <span className="dshx-hint">{t('composer.action.runningHint')}</span>}

        {running ? (
          <>
            {runSend !== undefined && (
              <button
                type="button"
                className={`dshx-send${canSend ? '' : ' dshx-send-idle'}`}
                aria-label={runSend.label}
                title={runSend.label}
                disabled={!canSend}
                onClick={runSend.send}
              >
                <ArrowUpIcon size={16} />
              </button>
            )}
            <button
              type="button"
              className="dshx-stop"
              aria-label={t('composer.action.interruptLabel')}
              title={t('composer.action.interruptTitle')}
              onClick={onInterrupt}
            >
              <span className="dshx-stop-square" />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="dshx-send"
            onClick={onSend}
            disabled={!canSend}
            aria-label={t('composer.action.sendLabel')}
            title={t('composer.action.sendTitle')}
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
.dshx-cbar{position:relative;display:flex;align-items:center;gap:4px;min-width:0;padding:6px 8px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06))}
.dshx-cbar .dshx-menuwrap{position:static;flex:0 1 auto;min-width:0}
/* Chip-row dropdowns span the composer capsule's inner width (panel width
   minus its side gutters) instead of hugging the chip: every composer
   popover shares one alignment, so they read as one surface family. The
   popovers therefore position against the chip ROW (the nearest positioned
   ancestor), not their menuwrap. */
.dshx-cbar .dshx-pop{left:0;right:0;width:auto}
.dshx-cbar .dshx-pop--up{bottom:calc(100% + 6px)}
.dshx-cbar .dshx-chip{max-width:100%}
/* site-knowledge status chip: dashed border + green marks "injected now" */
.dshx-chip.is-sitek{cursor:default;color:#2c8a52}
.dshx-chip.is-sitek:hover{background:transparent}
.dshx-csp{flex:1 1 auto;min-width:0}
.dshx-hint{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#aaa);white-space:nowrap}
/* chip base */
.dshx-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 7px;max-width:150px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#888);cursor:pointer;font-size:11px;line-height:24px;transition:background .15s ease,color .15s ease}
.dshx-chip:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.07));color:var(--dsw-alias-label-primary,#333)}
.dshx-chiplabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px}
/* reasoning-effort segmented control */
.dshx-chip.is-unset{opacity:.55}
.dshx-chip:disabled{cursor:default;opacity:.4}
.dshx-applyerror{margin:0 0 4px;padding:4px 8px;border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 10%,transparent);color:var(--dsw-alias-state-error-primary,#dc2626);font-size:11px;line-height:1.5}
/* capability badges inside model-menu rows (思考/视觉) */
.dshx-menuitem-badge{flex:none;height:14px;padding:0 5px;border-radius:7px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.07));color:var(--dsw-alias-label-tertiary,#999);font-size:10px;line-height:14px;white-space:nowrap}
/* provider-group header rows: clickable switch-to-group-default */
.dshx-menugroup{display:flex;width:100%;align-items:center;border:none;background:transparent;color:inherit;cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color .15s ease}
.dshx-menugroup:hover{color:var(--dsw-alias-label-primary,#333)}
/* usage details popover rows */
.dshx-meterrow{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:6px 8px;border-radius:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#888)}
.dshx-meterrow b{font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#171717)}
.dshx-meternote{padding:4px 8px 2px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#aaa)}
/* permission-mode menu: one row per mode, name over one-line description */
.dshx-modeitem{align-items:center}
.dshx-modeitem-text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;text-align:left}
.dshx-modeitem-text .dshx-menuitem-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#171717);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshx-modeitem-desc{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#aaa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* slash-command candidate menu: floats above the textarea inside the input
   wrap; overrides .dshx-pop--up's chip-bar offset with a tight anchor gap and
   caps the sheet smaller than the chip popovers (command rows are short). */
.dshx-inputwrap{position:relative}
.dshx-slashpop{left:0;right:auto;bottom:calc(100% + 2px);width:min(340px,calc(100vw - 24px));max-height:min(240px,48vh);padding-top:4px}
/* 指令 section header (the desktop harness's grouped-menu look) */
.dshx-slashhead{padding:4px 10px 2px;font-size:11px;letter-spacing:.4px;color:var(--dsw-alias-label-tertiary,#aaa)}
/* menu rows: icon slot + the 中文 label beside the english name (mapped
   commands), or the mono command name + ellipsized description (unmapped) */
.dshx-slashitem{gap:8px}
.dshx-slashitem-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;color:var(--dsw-alias-label-secondary,#888)}
.dshx-slashitem-label{flex:none;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#171717);white-space:nowrap}
.dshx-slashitem-en{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-tertiary,#aaa)}
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
