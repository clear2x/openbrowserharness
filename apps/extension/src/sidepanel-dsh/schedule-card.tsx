/**
 * `ScheduleCard`: the 用户插件 panel's timed-tasks section — the panel-side
 * consumer of the engine's `schedule.*` RPC family (chrome/api-bridge driving
 * the offscreen schedule composition row).
 *
 * Layout: a roster of task rows (title, status chip, timing summary, next
 * due time) with per-row 立即运行/暂停恢复/删除 actions and a quick-create
 * form (title + instruction + delay in seconds, an `after` timing).
 *
 * Data flow: `schedule.catalog` is polled every 5 s while mounted (the
 * manager's `watch` typert stream has no extension transport bridge);
 * mutations post `schedule.edit`/`schedule.run` and refresh from the poll.
 * Deliveries of a task targeting the current session arrive as a reminder
 * message in the conversation, which drives a fresh model turn on its own —
 * no panel wiring needed for the automation half.
 *
 * @module schedule-card
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Switch } from '@appica/ui-react/switch'
import { rpc } from './rpc-client.ts'

/** One row of `schedule.catalog` (the ScheduleCatalogEntry wire shape). */
interface ScheduleEntry {
  /** The task identity (a branded string on the engine side). */
  id: string
  /** Task name shown on the row. */
  title: string
  /** The instruction delivered at each occurrence. */
  prompt: string
  /** active (timer obligation) / paused / ended. */
  status: 'active' | 'paused' | 'ended'
  /** Canonical UTC time of the next occurrence. */
  scheduledAt: string
  /** Canonical UTC time of the latest stored change (edit concurrency). */
  updatedAt?: string
  /** Timing rule, projected for the row's summary text. */
  timing?: { kind?: string; after_seconds?: number; every_seconds?: number } & Record<string, unknown>
}

/** The quick-create form fields (an `after` timing, target reuses defaults). */
interface ScheduleForm {
  title: string
  prompt: string
  delaySeconds: string
}

const EMPTY_FORM: ScheduleForm = { title: '', prompt: '', delaySeconds: '300' }

/** Human summary of one entry's timing rule. */
function timingText(entry: ScheduleEntry): string {
  const kind = entry.timing?.kind ?? ''
  if (kind === 'after') return `${entry.timing?.after_seconds ?? 0} 秒后一次`
  if (kind === 'every') return `每 ${entry.timing?.every_seconds ?? 0} 秒`
  if (kind === 'daily') return '每天'
  if (kind === 'weekly') return '每周'
  if (kind === 'cron') return 'cron'
  if (kind === 'at') return '单次定时'
  return kind || '未知'
}

/** Local clock text of a canonical UTC stamp, or the raw value on failure. */
function localTime(stamp: string | undefined): string {
  if (stamp === undefined) return ''
  const parsed = Date.parse(stamp)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString() : stamp
}

/**
 * Render the timed-tasks section.
 * @returns the section body.
 */
export function ScheduleCard(): JSX.Element {
  const [entries, setEntries] = useState<ScheduleEntry[] | null>(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState<ScheduleForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  /** Read the catalog once; polling re-calls this. Errors surface inline. */
  const refresh = useCallback(async (): Promise<void> => {
    const outcome = await rpc('schedule.catalog', {}, 15_000)
    if (!mounted.current) return
    if (outcome.ok) {
      const records = outcome.value
      setEntries(Array.isArray(records) ? records as ScheduleEntry[] : [])
      setError('')
    } else {
      setError(outcome.error?.message ?? '读取定时任务失败')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5_000)
    return () => { clearInterval(timer) }
  }, [refresh])

  /** One edit against an entry's read revision; refreshes from the poll. */
  const edit = useCallback(async (request: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    const outcome = await rpc('schedule.edit', request, 30_000)
    setBusy(false)
    if (!mounted.current) return false
    if (!outcome.ok) {
      setError(outcome.error?.message ?? '修改定时任务失败')
      return false
    }
    void refresh()
    return true
  }, [refresh])

  /** Quick-create: an `after` timing one-shot to the default destination. */
  const createTask = useCallback(async (): Promise<void> => {
    const title = form.title.trim()
    const prompt = form.prompt.trim()
    const seconds = Number(form.delaySeconds)
    if (title === '' || prompt === '') {
      setError('标题与提示词不能为空')
      return
    }
    if (!Number.isFinite(seconds) || seconds < 5) {
      setError('延迟至少 5 秒')
      return
    }
    setBusy(true)
    const outcome = await rpc('schedule.create', {
      title,
      prompt,
      timing: { kind: 'after', after_seconds: seconds },
    }, 30_000)
    setBusy(false)
    if (!mounted.current) return
    if (!outcome.ok) {
      setError(outcome.error?.message ?? '创建定时任务失败')
      return
    }
    setForm(EMPTY_FORM)
    void refresh()
  }, [form, refresh])

  /** Toggle one task between paused and active. */
  const toggleTask = useCallback(async (entry: ScheduleEntry): Promise<void> => {
    await edit({ id: entry.id, action: 'update', patch: { active: entry.status !== 'paused' }, expectedUpdatedAt: entry.updatedAt ?? null })
  }, [edit])

  /** Delete one task outright. */
  const removeTask = useCallback(async (entry: ScheduleEntry): Promise<void> => {
    await edit({ id: entry.id, action: 'delete', expectedUpdatedAt: entry.updatedAt ?? null })
  }, [edit])

  /** Deliver one occurrence immediately. */
  const runTask = useCallback(async (entry: ScheduleEntry): Promise<void> => {
    setBusy(true)
    const outcome = await rpc('schedule.run', { id: entry.id }, 60_000)
    setBusy(false)
    if (mounted.current && !outcome.ok) setError(outcome.error?.message ?? '立即运行失败')
  }, [])

  return (
    <div className="dshx-sched">
      <div className="dshx-sched-head">
        <span className="dshx-sched-title">定时任务</span>
        <span className="dshx-sched-sub">到期自动投递进会话</span>
      </div>
      {error !== '' && <div className="dshx-sched-error">{error}</div>}
      {entries === null
        ? <div className="dshx-sched-empty">读取中…</div>
        : (
          entries.length === 0
            ? <div className="dshx-sched-empty">还没有定时任务——模型也可以经 schedule_create 自己建。</div>
            : (
              <div className="dshx-sched-rows">
                {entries.map(entry => (
                  <div className="dshx-sched-row" key={entry.id}>
                    <div className="dshx-sched-rowmain">
                      <span className="dshx-sched-name" title={entry.prompt}>{entry.title}</span>
                      <Badge variant="soft" size="sm" className={`dshx-sched-chip is-${entry.status}`}>
                        {entry.status === 'active' ? '进行中' : entry.status === 'paused' ? '已暂停' : '已结束'}
                      </Badge>
                    </div>
                    <div className="dshx-sched-meta">
                      {timingText(entry)} · 下次 {localTime(entry.scheduledAt)}
                    </div>
                    <div className="dshx-sched-rowops">
                      <Button size="sm" variant="ghost" disabled={busy || entry.status !== 'active'} onClick={() => { void runTask(entry) }}>立即运行</Button>
                      <Button size="sm" variant="ghost" disabled={busy || entry.status === 'ended'} onClick={() => { void removeTask(entry) }}>删除</Button>
                      <Switch
                        checked={entry.status === 'active'}
                        disabled={busy || entry.status === 'ended'}
                        onCheckedChange={() => { void toggleTask(entry) }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )
        )}
      <div className="dshx-sched-form">
        <input
          className="dshx-sched-input"
          placeholder="任务标题（如 每日标签页总结）"
          value={form.title}
          onChange={(event) => { setForm({ ...form, title: event.target.value }) }}
        />
        <input
          className="dshx-sched-input"
          placeholder="到点投递的提示词（如 总结当前打开的标签页）"
          value={form.prompt}
          onChange={(event) => { setForm({ ...form, prompt: event.target.value }) }}
        />
        <div className="dshx-sched-delay">
          <input
            className="dshx-sched-input"
            placeholder="延迟秒数"
            value={form.delaySeconds}
            onChange={(event) => { setForm({ ...form, delaySeconds: event.target.value }) }}
          />
          <Button size="sm" disabled={busy || form.title.trim() === '' || form.prompt.trim() === ''} onClick={() => { void createTask() }}>
            创建任务
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Section styles, injected by the shell's stylesheet bundle. */
export const SCHEDULE_CARD_CSS = `
.dshx-sched { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px dashed var(--dshx-line, #2a2a2a); }
.dshx-sched-head { display: flex; align-items: baseline; gap: 8px; }
.dshx-sched-title { font-weight: 600; font-size: 13px; }
.dshx-sched-sub { font-size: 11px; opacity: 0.55; }
.dshx-sched-error { font-size: 12px; color: #f87171; }
.dshx-sched-empty { font-size: 12px; opacity: 0.6; }
.dshx-sched-rows { display: flex; flex-direction: column; gap: 6px; }
.dshx-sched-row { border: 1px solid var(--dshx-line, #2a2a2a); border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
.dshx-sched-rowmain { display: flex; align-items: center; gap: 8px; }
.dshx-sched-name { font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshx-sched-meta { font-size: 11px; opacity: 0.6; }
.dshx-sched-rowops { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
.dshx-sched-chip.is-active { color: #4ade80; }
.dshx-sched-chip.is-paused { color: #fbbf24; }
.dshx-sched-chip.is-ended { opacity: 0.6; }
.dshx-sched-form { display: flex; flex-direction: column; gap: 6px; }
.dshx-sched-input { background: transparent; border: 1px solid var(--dshx-line, #2a2a2a); border-radius: 6px; padding: 6px 8px; font-size: 12px; color: inherit; width: 100%; box-sizing: border-box; }
.dshx-sched-input:focus { outline: none; border-color: #7c5cfc; }
.dshx-sched-delay { display: flex; gap: 6px; align-items: center; }
`
