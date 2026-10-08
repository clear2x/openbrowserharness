/**
 * Native 轨迹 (trajectory) view for the SidePanel, built straight from
 * `session.history` — the same durable event log the conversation transcript
 * reads. The desktop ui-trajectory plugin path is not mountable here (its
 * ledger needs the runtime session window, whose live channel cannot connect
 * from an extension origin), so the view derives its rows locally and draws
 * the dsh trajectory design language: a left timeline spine with node dots,
 * white bordered cards hanging off it (用户/助手/工具 colored pills, mono
 * `参数 → 结果` lines with the paired duration), and a compact 输入/模型/工具
 * swimlane strip folded from the same event timings.
 *
 * The host owns the fresh-session start semantics: the sentinel session has
 * no history by definition, so the view renders an explicit empty state
 * instead of spinning.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { rpc } from './rpc-client.ts'

/** Sentinel id of the boot-time fresh session: the shell imports this constant. */
export const NEW_SESSION_ID = 'session-new'

/** One card of the trajectory timeline. */
export interface TrajectoryRow {
  readonly seq: number
  readonly time: number
  readonly kind: 'turn' | 'user' | 'assistant' | 'tool' | 'system' | 'skill'
  /** Chip label（用户/助手/工具名/系统/技能名/第 N 轮）. */
  readonly label: string
  /** Main one-line text (truncated for display). */
  readonly text: string
  /** Paired tool-result outcome: false colors the card as a failure. */
  readonly ok?: boolean
  /** Paired tool-result summary rendered after the → arrow. */
  readonly result?: string
  /** Paired call→result duration in ms. */
  readonly durationMs?: number
  /** Assistant message that carried only tool calls (de-emphasized card). */
  readonly subdued?: boolean
}

interface HistoryEvent {
  type: string
  seq: number
  time: number
  data?: Record<string, unknown>
}

/** Concatenate the text blocks of one harness message content array. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text'])
    // A tool-result block nests the readable text one level down.
    if (record['type'] === 'tool-result') parts.push(contentText(record['content']))
  }
  return parts.join(' ')
}

/** Whether one content array carries any tool-use block. */
function hasToolUse(content: unknown): boolean {
  return Array.isArray(content) && content.some(block =>
    typeof block === 'object' && block !== null && (block as Record<string, unknown>)['type'] === 'tool-use')
}

/** First-line + ellipsis view of a long single-line text. */
function clip(text: string, max = 160): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** The tool-result block of one `tool/result` event, when it carries one. */
function toolResultBlock(data: Record<string, unknown>): { toolCallId?: string; isError?: boolean; text: string } | undefined {
  const content = (data['message'] as { content?: unknown } | undefined)?.['content']
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record['type'] !== 'tool-result') continue
    return {
      ...(typeof record['toolCallId'] === 'string' ? { toolCallId: record['toolCallId'] } : {}),
      ...(record['isError'] === true ? { isError: true } : {}),
      text: clip(contentText(record['content']), 120),
    }
  }
  return undefined
}

/**
 * Fold the durable event log into timeline cards, in log order. A
 * `tool/result` merges into its paired `tool/call` card (callId when the
 * wire carries it, otherwise the most recent unresolved call): the card
 * reads `工具名 参数 → 结果摘要` with the pair's duration and outcome. An
 * assistant message that carried only tool calls keeps its place as a
 * de-emphasized card instead of vanishing. Unknown event types are skipped
 * (the conversation view remains the complete transcript).
 */
export function buildTrajectoryRows(events: readonly HistoryEvent[]): TrajectoryRow[] {
  const rows: TrajectoryRow[] = []
  /** Mutable working copies until the fold settles (the export freezes nothing; callers treat rows as values). */
  const byCallId = new Map<string, TrajectoryRow[]>()
  const unresolved: TrajectoryRow[] = []

  const completeToolRow = (row: TrajectoryRow, result: { isError?: boolean; text: string; error?: boolean }, time: number): void => {
    const patch: TrajectoryRow = {
      ...row,
      ok: result.error !== true && result.isError !== true,
      result: result.text === '' ? '(no output)' : result.text,
      durationMs: Math.max(0, time - row.time),
    }
    Object.assign(row, patch)
  }

  for (const event of events) {
    const data = typeof event.data === 'object' && event.data !== null
      ? event.data
      : {}
    switch (event.type) {
      case 'turn/start': {
        const turn = typeof data['turn'] === 'number' ? data['turn'] : '?'
        rows.push({ seq: event.seq, time: event.time, kind: 'turn', label: `第 ${String(turn)} 轮`, text: '' })
        break
      }
      case 'user/message': {
        // A loaded skill's instruction body is machine input: the card names
        // the skill, never the raw <skill_content> text. (The skill-catalog
        // reminder never reaches this view — the api-bridge history face
        // drops it.)
        const source = data['source'] as { kind?: unknown; name?: unknown } | undefined
        if (source?.['kind'] === 'skill-invocation') {
          const name = typeof source['name'] === 'string' && source['name'] !== '' ? source['name'] : 'skill'
          rows.push({ seq: event.seq, time: event.time, kind: 'skill', label: '技能', text: name })
          break
        }
        const text = clip(contentText(data['content']))
        if (text === '') break
        rows.push({ seq: event.seq, time: event.time, kind: 'user', label: '用户', text })
        break
      }
      case 'assistant/message': {
        const message = data['message'] as { content?: unknown } | undefined
        const text = clip(contentText(message?.['content']))
        if (text === '') {
          // A tool-call-only step still happened — keep its slot, dimmed.
          if (hasToolUse(message?.['content'])) {
            rows.push({ seq: event.seq, time: event.time, kind: 'assistant', label: '助手', text: '（仅工具调用）', subdued: true })
          }
          break
        }
        rows.push({ seq: event.seq, time: event.time, kind: 'assistant', label: '助手', text })
        break
      }
      case 'tool/call': {
        const name = typeof data['name'] === 'string' ? data['name'] : 'tool'
        const args = clip(typeof data['arguments'] === 'string' ? data['arguments'] : JSON.stringify(data['arguments'] ?? ''), 80)
        // The paired tool/result completes this card in place (see the fold's
        // pending maps below), so the binding stays const while the row value
        // gains result/ok/durationMs.
        const row: TrajectoryRow = { seq: event.seq, time: event.time, kind: 'tool', label: name, text: args }
        rows.push(row)
        const callId = typeof data['callId'] === 'string' ? data['callId'] : undefined
        if (callId !== undefined) {
          const bucket = byCallId.get(callId) ?? []
          bucket.push(row)
          byCallId.set(callId, bucket)
        }
        unresolved.push(row)
        break
      }
      case 'tool/result': {
        const block = toolResultBlock(data)
        const errored = data['error'] !== undefined
        if (block === undefined && !errored) break
        const text = block?.text ?? clip(contentText((data['message'] as { content?: unknown } | undefined)?.['content']), 120)
        const outcome = { error: errored, text, ...(block?.isError === true ? { isError: true } : {}) }
        let target: TrajectoryRow | undefined
        if (block?.toolCallId !== undefined) {
          const bucket = byCallId.get(block.toolCallId)
          target = bucket?.shift()
          if (bucket !== undefined && bucket.length === 0) byCallId.delete(block.toolCallId)
        }
        if (target === undefined) target = unresolved.find(row => row.result === undefined)
        if (target === undefined) {
          // Result without its call on this page: still show the outcome.
          rows.push({
            seq: event.seq, time: event.time, kind: 'tool', label: '工具',
            text: text === '' ? '(no output)' : text,
            ok: !outcome.error && outcome.isError !== true,
          })
          break
        }
        completeToolRow(target, outcome, event.time)
        break
      }
      case 'system/message': {
        const text = clip(contentText(data['content']), 120)
        if (text === '') break
        rows.push({ seq: event.seq, time: event.time, kind: 'system', label: '系统', text })
        break
      }
      default:
        break
    }
  }
  return rows
}

// ───────────────────────── swimlane strip ─────────────────────────

/** One lane block's [start, end] window in epoch ms. */
export interface TrajectoryLaneSpan {
  readonly start: number
  readonly end: number
}

/** The three-lane timing strip: normalized windows plus the session span. */
export interface TrajectoryLanes {
  readonly t0: number
  readonly total: number
  readonly input: readonly TrajectoryLaneSpan[]
  readonly model: readonly TrajectoryLaneSpan[]
  readonly tool: readonly TrajectoryLaneSpan[]
}

/** Minimum visual width for instantaneous events (input points). */
const POINT_SPAN_MS = 400

/**
 * Fold the timeline rows plus the raw event tail into the three-lane strip:
 * 输入 = user cards, 模型 = assistant cards (span to the next row, a floor
 * for instantaneous messages), 工具 = paired call durations (exact). Returns
 * null when the session has no measurable span or fewer than two windows —
 * a single event paints lanes that carry no information.
 */
export function buildTrajectoryLanes(rows: readonly TrajectoryRow[], lastEventTime: number): TrajectoryLanes | null {
  const first = rows[0]
  if (first === undefined) return null
  const t0 = first.time
  const total = Math.max(0, lastEventTime - t0)
  if (total <= 0) return null
  const input: TrajectoryLaneSpan[] = []
  const model: TrajectoryLaneSpan[] = []
  const tool: TrajectoryLaneSpan[] = []
  rows.forEach((row, index) => {
    const next = rows[index + 1]?.time ?? lastEventTime
    if (row.kind === 'user') input.push({ start: row.time, end: row.time + POINT_SPAN_MS })
    else if (row.kind === 'assistant') model.push({ start: row.time, end: Math.max(row.time + POINT_SPAN_MS, next) })
    else if (row.kind === 'tool') {
      const end = row.durationMs !== undefined ? row.time + row.durationMs : row.time + POINT_SPAN_MS
      tool.push({ start: row.time, end })
    }
  })
  if (input.length + model.length + tool.length < 2) return null
  return { t0, total, input, model, tool }
}

/** `1.2s` / `650ms` / `2分18秒` — the duration formats the strip and cards use. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds === 0 ? `${String(minutes)}分` : `${String(minutes)}分${String(seconds)}秒`
}

/** Lane rendering order with the strip's labels. */
const LANES: ReadonlyArray<{ key: 'input' | 'model' | 'tool'; label: string }> = [
  { key: 'input', label: '输入' },
  { key: 'model', label: '模型' },
  { key: 'tool', label: '工具' },
]

/**
 * The SidePanel 轨迹 surface: chip toolbar (轮次/调用/时长 + text filter) over
 * the 输入/模型/工具 swimlane strip and the timeline cards. Refreshes with
 * the same cadence as the transcript.
 */
export function TrajectoryHost({ sessionId, refreshSeq }: {
  sessionId: string
  refreshSeq: number
}): JSX.Element {
  const [events, setEvents] = useState<HistoryEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const fetchEvents = useCallback(async (): Promise<void> => {
    if (sessionId === NEW_SESSION_ID) {
      setEvents([])
      setLoading(false)
      return
    }
    const result = await rpc('session.history', { sessionId })
    if (result.ok) {
      // The wire wraps every row: { events: [{ event: {...} }] }.
      const value = result.value as { events?: Array<{ event?: HistoryEvent }> } | undefined
      setEvents((value?.events ?? []).map(row => row.event).filter((event): event is HistoryEvent => event !== undefined))
    }
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    setLoading(true)
    void fetchEvents()
  }, [fetchEvents, refreshSeq])

  useEffect(() => {
    const timer = setInterval(() => { void fetchEvents() }, 3000)
    return () => { clearInterval(timer) }
  }, [fetchEvents])

  const rows = useMemo(() => buildTrajectoryRows(events), [events])
  const lanes = useMemo(
    () => buildTrajectoryLanes(rows, events.at(-1)?.time ?? 0),
    [rows, events],
  )
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    if (q === '') return rows
    return rows.filter(row => row.text.toLocaleLowerCase().includes(q)
      || row.label.includes(q)
      || (row.result ?? '').toLocaleLowerCase().includes(q))
  }, [rows, query])

  const turns = useMemo(() => rows.filter(row => row.kind === 'turn').length, [rows])
  const calls = useMemo(() => rows.filter(row => row.kind === 'tool').length, [rows])
  const spanLabel = useMemo(
    () => lanes === null ? null : formatDuration(lanes.total),
    [lanes],
  )

  // The fresh-session start has no session to read — the explicit empty state
  // replaces the whole surface.
  if (sessionId === NEW_SESSION_ID) {
    return (
      <div className="dshx-trajectory dshx-trajectory--loading">
        新会话还没有轨迹。发送第一条消息后，这里会展示完整的执行轨迹。
      </div>
    )
  }

  return (
    <div className="dshx-trajectory">
      <div className="dshx-trj-toolbar">
        <span className="dshx-trj-chip">轮次 <b>{turns}</b></span>
        <span className="dshx-trj-chip">调用 <b>{calls}</b></span>
        {spanLabel !== null && <span className="dshx-trj-chip">时长 <b>{spanLabel}</b></span>}
        <input
          className="dshx-trj-search"
          value={query}
          placeholder="搜索轨迹"
          aria-label="搜索轨迹"
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </div>
      {lanes !== null && (
        <div className="dshx-trj-lanes" aria-hidden="true">
          {LANES.map(({ key, label }) => (
            <Fragment key={key}>
              <span className="dshx-trj-lane-label">{label}</span>
              <div className={`dshx-trj-lane is-${key}`}>
                {lanes[key].map((span, index) => (
                  <i
                    key={index}
                    style={{
                      left: `${((span.start - lanes.t0) / lanes.total) * 100}%`,
                      width: `max(3px, ${((span.end - span.start) / lanes.total) * 100}%)`,
                    }}
                  />
                ))}
              </div>
            </Fragment>
          ))}
        </div>
      )}
      <div className="dshx-trj-list" ref={listRef}>
        {loading && rows.length === 0 && <div className="dshx-trj-empty">轨迹加载中…</div>}
        {!loading && filtered.length === 0 && (
          <div className="dshx-trj-empty">{query === '' ? '暂无轨迹' : '没有匹配的轨迹行'}</div>
        )}
        <div className="dshx-trj-items">
          {filtered.map((row) => {
            if (row.kind === 'turn') {
              return <div key={row.seq} className="dshx-trj-turn">{row.label}</div>
            }
            return (
              <div
                key={row.seq}
                className={`dshx-trj-row is-${row.kind}${row.ok === false ? ' is-failed' : ''}${row.subdued === true ? ' is-subdued' : ''}`}
              >
                <span className={`dshx-trj-tag is-${row.kind}`}>{row.label}</span>
                <span className="dshx-trj-text">{row.text}</span>
                {row.result !== undefined && (
                  <>
                    <span className="dshx-trj-arrow">→</span>
                    <span className="dshx-trj-result">{row.result}</span>
                  </>
                )}
                {row.durationMs !== undefined && row.durationMs > 0 && (
                  <span className="dshx-trj-dur">{formatDuration(row.durationMs)}</span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
