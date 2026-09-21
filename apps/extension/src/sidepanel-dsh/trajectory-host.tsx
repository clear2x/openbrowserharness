/**
 * Native 轨迹 (trajectory) view for the SidePanel, built straight from
 * `session.history` — the same durable event log the conversation transcript
 * reads. The desktop ui-trajectory plugin path is not mountable here (its
 * ledger needs the runtime session window, whose live channel cannot connect
 * from an extension origin), so the view derives its rows locally: turn
 * separators, user/assistant/tool/system rows, and a toolbar with turn/call
 * counts and a text filter.
 *
 * The host owns the fresh-session start semantics: the sentinel session has
 * no history by definition, so the view renders an explicit empty state
 * instead of spinning.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { rpc } from './rpc-client.ts'

/** Sentinel id of the boot-time fresh session: the shell imports this constant. */
export const NEW_SESSION_ID = 'session-new'

/** One event row of the trajectory view. */
interface TrajectoryRow {
  readonly seq: number
  readonly time: number
  readonly kind: 'turn' | 'user' | 'assistant' | 'tool' | 'tool-result' | 'system'
  /** Chip label（用户/助手/工具/工具结果/系统/第 N 轮）. */
  readonly label: string
  /** Main one-line text (truncated for display). */
  readonly text: string
  /** Tool-result outcome: false colors the row as a failure. */
  readonly ok?: boolean
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

/** First-line + ellipsis view of a long single-line text. */
function clip(text: string, max = 160): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Fold the durable event log into trajectory rows, in log order:
 * turn separators, user prompts, assistant texts, tool calls with their
 * results, and system rows. Unknown event types are skipped (the
 * conversation view remains the complete transcript).
 */
export function buildTrajectoryRows(events: readonly HistoryEvent[]): TrajectoryRow[] {
  const rows: TrajectoryRow[] = []
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
        const text = clip(contentText(data['content']))
        if (text === '') break
        rows.push({ seq: event.seq, time: event.time, kind: 'user', label: '用户', text })
        break
      }
      case 'assistant/message': {
        const message = data['message'] as { content?: unknown } | undefined
        const text = clip(contentText(message?.['content']))
        if (text === '') break
        rows.push({ seq: event.seq, time: event.time, kind: 'assistant', label: '助手', text })
        break
      }
      case 'tool/call': {
        const name = typeof data['name'] === 'string' ? data['name'] : 'tool'
        const args = clip(typeof data['arguments'] === 'string' ? data['arguments'] : JSON.stringify(data['arguments'] ?? ''), 80)
        rows.push({ seq: event.seq, time: event.time, kind: 'tool', label: '工具', text: `${name} ${args}` })
        break
      }
      case 'tool/result': {
        const message = data['message'] as Record<string, unknown> | undefined
        const content = message?.['content']
        const text = clip(contentText(content), 120)
        rows.push({
          seq: event.seq,
          time: event.time,
          kind: 'tool-result',
          label: '工具结果',
          text: text === '' ? '(no output)' : text,
          ok: !Array.isArray(content) || (content[0] as { isError?: unknown } | undefined)?.isError !== true,
        })
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

/**
 * The SidePanel 轨迹 surface: toolbar (轮次/调用 counts + text filter) over
 * the folded event rows. Refreshes with the same cadence as the transcript.
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
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    if (q === '') return rows
    return rows.filter(row => row.text.toLocaleLowerCase().includes(q) || row.label.includes(q))
  }, [rows, query])

  const turns = useMemo(() => rows.filter(row => row.kind === 'turn').length, [rows])
  const calls = useMemo(() => rows.filter(row => row.kind === 'tool').length, [rows])

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
        <span className="dshx-trj-stat">轮次 <b>{turns}</b></span>
        <span className="dshx-trj-stat">调用 <b>{calls}</b></span>
        <input
          className="dshx-trj-search"
          value={query}
          placeholder="搜索轨迹"
          aria-label="搜索轨迹"
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </div>
      <div className="dshx-trj-list" ref={listRef}>
        {loading && rows.length === 0 && <div className="dshx-trj-empty">轨迹加载中…</div>}
        {!loading && filtered.length === 0 && (
          <div className="dshx-trj-empty">{query === '' ? '暂无轨迹' : '没有匹配的轨迹行'}</div>
        )}
        {filtered.map((row) => {
          if (row.kind === 'turn') {
            return <div key={row.seq} className="dshx-trj-turn">{row.label}</div>
          }
          return (
            <div key={row.seq} className={`dshx-trj-row is-${row.kind}${row.ok === false ? ' is-failed' : ''}`}>
              <span className={`dshx-trj-tag is-${row.kind}`}>{row.label}</span>
              <span className="dshx-trj-text">{row.text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
