/**
 * `automation-panel`: the「自动化」panel — scheduled tasks as a first-class
 * sibling of 用户插件/服务 (promoted out of the services panel per the
 * desktop automation reference). Two tabs:
 *   - 设置: the create form — 任务标题, 调度 (the plan builder over the
 *     engine's timing kinds: 每天/每周/间隔/单次/延迟/cron), 指令 textarea,
 *     投递目标 (this session vs a new session), 创建定时任务;
 *   - 历史: the task roster (status chip, timing summary, next due) with
 *     立即运行/暂停恢复/删除 and a per-task 投递历史 expander
 *     (`schedule.history`).
 *
 * Data flow unchanged from the promoted card: `schedule.catalog` polled every
 * 5 s while mounted; mutations post `schedule.edit`/`schedule.run` and
 * refresh from the poll. Deliveries to the current session arrive as a
 * reminder message in the conversation on their own.
 *
 * Styling reuses the user-plugin panel skeleton (`dshx-up-*`) plus the
 * promoted card's `dshx-sched-*` roster styles and new `dshx-auto-*` form
 * styles (SCHEDULE_CARD_CSS, injected once by the shell).
 *
 * @module automation-panel
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Switch } from '@appica/ui-react/switch'
import { rpc } from './rpc-client.ts'
import { effortLabel, effortLabelKey, modeItems } from './composer-bar.tsx'
import type { ModelGroup } from './composer-bar.tsx'
import { shellT, useShellT } from './locales/index.ts'
import type { ShellLocaleKey } from './locales/index.ts'
import { agentPresetName } from './locales/preset-labels.ts'
import { CloseIcon, CpuIcon, GaugeIcon, PuzzleIcon, ShieldIcon } from './icons.tsx'

export interface AutomationPanelProps {
  /** Close the panel (the shell's overlay close). */
  onClose: () => void
  /** The session task deliveries ride to (the shell's current selection). */
  sessionId: string
  /** Resolve the fresh-session sentinel to a minted, adopted session id. */
  ensureSession: () => Promise<string>
}

/** One run-configuration choice; undefined = the target session keeps its own. */
interface RunConfig {
  provider?: string
  model?: string
  effort?: string
  preset?: string
  mode?: string
}

/** Drop the named run-config keys (the exactOptionalPropertyTypes-safe clear). */
function clearRunKeys(run: RunConfig, keys: Array<keyof RunConfig>): RunConfig {
  const blocked = new Set(keys)
  const next: RunConfig = {}
  for (const key of Object.keys(run) as Array<keyof RunConfig>) {
    // A union-keyed write cannot be correlated with its read; the computed-key
    // copy carries the exact optional property through unchanged.
    if (!blocked.has(key)) Object.assign(next, { [key]: run[key] })
  }
  return next
}

/** Bind the model route and clear the effort that belonged to the old one. */
function withModelRoute(run: RunConfig, provider: string | undefined, model: string | undefined): RunConfig {
  if (provider === undefined || model === undefined) return run
  return { ...clearRunKeys(run, ['effort', 'provider', 'model']), provider, model }
}

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

/** One saved delivery of a task (the history page's rows, wire view). */
interface DeliveryRecord {
  /** Canonical UTC time the delivery was dispatched. */
  readonly at?: string
  /** The delivered instruction excerpt. */
  readonly prompt?: string
  /** Delivery outcome the Host recorded (ok / refused reason). */
  readonly status?: string
}

/** The plan-builder's editable state; `undefined` = the 添加计划 stub shows. */
interface PlanDraft {
  kind: 'daily' | 'weekly' | 'every' | 'at' | 'after' | 'cron'
  /** HH:mm for daily/weekly/at. */
  time: string
  /** ISO date for the one-shot `at`. */
  date: string
  /** ISO weekdays 1..7 (Mon..Sun) for weekly. */
  weekdays: number[]
  /** Interval minutes for `every`. */
  minutes: string
  /** Delay seconds for `after`. */
  seconds: string
  /** Five-field expression for `cron`. */
  cron: string
}

/** Dictionary keys of the weekday toggles, Monday first (the builder's `weekdays` order). */
const WEEKDAY_LABEL_KEYS: ReadonlyArray<ShellLocaleKey> = [
  'automation.weekday.mon',
  'automation.weekday.tue',
  'automation.weekday.wed',
  'automation.weekday.thu',
  'automation.weekday.fri',
  'automation.weekday.sat',
  'automation.weekday.sun',
]

/** Plan kind + the dictionary key of its label (the builder's kind picker). */
const PLAN_KINDS: ReadonlyArray<{ kind: PlanDraft['kind']; labelKey: ShellLocaleKey }> = [
  { kind: 'daily', labelKey: 'automation.kind.daily' },
  { kind: 'weekly', labelKey: 'automation.kind.weekly' },
  { kind: 'every', labelKey: 'automation.kind.every' },
  { kind: 'after', labelKey: 'automation.kind.after' },
  { kind: 'at', labelKey: 'automation.kind.at' },
  { kind: 'cron', labelKey: 'automation.kind.cron' },
]

/** The local IANA zone the builder stamps into every timing rule. */
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const DEFAULT_PLAN: PlanDraft = {
  kind: 'daily',
  time: '09:00',
  date: new Date(Date.now() + 60_000).toISOString().slice(0, 10),
  weekdays: [1, 2, 3, 4, 5],
  minutes: '30',
  seconds: '300',
  cron: '0 9 * * *',
}

/** Human summary of one entry's timing rule. */
function timingText(entry: ScheduleEntry): string {
  const t = shellT()
  const kind = entry.timing?.kind ?? ''
  if (kind === 'after') return t('automation.timing.afterOnce', { count: entry.timing?.after_seconds ?? 0 })
  if (kind === 'every') return t('automation.timing.everySeconds', { count: entry.timing?.every_seconds ?? 0 })
  if (kind === 'daily') return t('automation.kind.daily')
  if (kind === 'weekly') return t('automation.kind.weekly')
  if (kind === 'cron') return 'cron'
  if (kind === 'at') return t('automation.kind.at')
  if (kind === 'rrule') return 'RRULE'
  return kind === '' ? t('automation.timing.scheduled') : kind
}

/** Local clock text of a canonical UTC stamp, or the raw value on failure. */
function localTime(stamp: string | undefined): string {
  if (stamp === undefined) return ''
  const parsed = Date.parse(stamp)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : stamp
}

/** Normalize HH:mm to the HH:mm:ss the timing inputs expect. */
function withSeconds(time: string): string {
  const parts = time.split(':')
  return parts.length === 2 ? `${time}:00` : time
}

/** Compile the plan draft into the engine's timing rule, or an error message. */
function planTiming(plan: PlanDraft): { timing?: Record<string, unknown>; error?: string } {
  const t = shellT()
  switch (plan.kind) {
    case 'daily':
      if (!/^\d{2}:\d{2}$/.test(plan.time)) return { error: t('automation.error.timeFormat') }
      return { timing: { kind: 'daily', daily: { time: withSeconds(plan.time), time_zone: LOCAL_ZONE } } }
    case 'weekly':
      if (!/^\d{2}:\d{2}$/.test(plan.time)) return { error: t('automation.error.timeFormat') }
      if (plan.weekdays.length === 0) return { error: t('automation.error.weekdayRequired') }
      return { timing: { kind: 'weekly', weekly: { time: withSeconds(plan.time), time_zone: LOCAL_ZONE, weekdays: [...plan.weekdays].sort() } } }
    case 'every': {
      const minutes = Number(plan.minutes)
      if (!Number.isFinite(minutes) || minutes < 1) return { error: t('automation.error.intervalMinimum') }
      return { timing: { kind: 'every', every_seconds: Math.round(minutes * 60) } }
    }
    case 'after': {
      const seconds = Number(plan.seconds)
      if (!Number.isFinite(seconds) || seconds < 5) return { error: t('automation.error.delayMinimum') }
      return { timing: { kind: 'after', after_seconds: Math.round(seconds) } }
    }
    case 'at':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.date)) return { error: t('automation.error.dateFormat') }
      if (!/^\d{2}:\d{2}$/.test(plan.time)) return { error: t('automation.error.timeFormat') }
      return { timing: { kind: 'at', at: { date: plan.date, time: withSeconds(plan.time), time_zone: LOCAL_ZONE } } }
    case 'cron':
      if (plan.cron.trim().split(/\s+/).length !== 5) return { error: t('automation.error.cronFields') }
      return { timing: { kind: 'cron', cron: { expression: plan.cron.trim(), time_zone: LOCAL_ZONE } } }
  }
}

/**
 * Render the automation panel body: the 设置/历史 tabs over the create form
 * and the task roster.
 */
export function AutomationPanel({ onClose, sessionId, ensureSession }: AutomationPanelProps): JSX.Element {
  const t = useShellT()
  const [tab, setTab] = useState<'setup' | 'history'>('setup')
  const [entries, setEntries] = useState<ScheduleEntry[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  // Create-form state.
  const [title, setTitle] = useState(() => shellT()('automation.form.untitled'))
  const [prompt, setPrompt] = useState('')
  const [plan, setPlan] = useState<PlanDraft | undefined>(undefined)
  const [formError, setFormError] = useState<string | null>(null)

  // History-tab per-row expander.
  const [historyId, setHistoryId] = useState<string | undefined>(undefined)
  const [historyRows, setHistoryRows] = useState<readonly DeliveryRecord[] | null>(null)

  // 运行方式：交付落位时应用到目标会话；未设置的维度跟随会话现状。
  const [run, setRun] = useState<RunConfig>({})
  const [groups, setGroups] = useState<readonly ModelGroup[]>([])
  const [presets, setPresets] = useState<readonly { id: string; name?: string }[]>([])
  const [menuOpen, setMenuOpen] = useState<'model' | 'effort' | 'preset' | 'mode' | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void rpc('session.models', { sessionId }).then((result) => {
      if (!alive || !result.ok) return
      setGroups((result.value as { groups?: ModelGroup[] }).groups ?? [])
    }).catch(() => {})
    void rpc('agentPreset.list', {}).then((result) => {
      if (!alive || !result.ok) return
      setPresets((result.value as { presets?: Array<{ id: string; name?: string }> }).presets ?? [])
    }).catch(() => {})
    return () => { alive = false }
  }, [sessionId])

  const effortOptions = ((): Array<{ id: string; name: string }> => {
    if (run.provider === undefined || run.model === undefined) return []
    const row = groups.find(group => group.id === run.provider)?.models?.find(candidate => candidate.id === run.model)
    return (row?.reasoning?.efforts ?? [])
      .filter((entry): entry is { id: string; name?: string } => typeof entry.id === 'string')
      // Catalogued levels share the composer's localized label; the adapter name is English.
      .map(entry => ({ id: entry.id, name: effortLabelKey(entry.id) === undefined ? entry.name ?? entry.id : effortLabel(t, entry.id) }))
  })()

  const labelFor = {
    model: run.model === undefined ? t('automation.followSession')
      : (groups.find(group => group.id === run.provider)?.models?.find(candidate => candidate.id === run.model)?.name ?? run.model),
    effort: run.effort === undefined || run.effort === ''
      ? t('automation.followDefault')
      : effortOptions.find(entry => entry.id === run.effort)?.name ?? run.effort,
    preset: run.preset === undefined ? t('automation.followSession')
      : agentPresetName(t, presets.find(candidate => candidate.id === run.preset) ?? { id: run.preset }),
    mode: run.mode === undefined ? t('automation.followSession')
      : modeItems(t).find(item => item.value === run.mode)?.label ?? run.mode,
  }

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
      setError(outcome.error?.message ?? shellT()('automation.error.readFailed'))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { clearInterval(timer) }
  }, [refresh])

  /** One edit against an entry's read revision; refreshes from the poll. */
  const edit = useCallback(async (request: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    const outcome = await rpc('schedule.edit', request, 30_000)
    setBusy(false)
    if (!mounted.current) return false
    if (!outcome.ok) {
      setError(outcome.error?.message ?? shellT()('automation.error.editFailed'))
      return false
    }
    void refresh()
    return true
  }, [refresh])

  /** Create from the 设置 form. */
  const createTask = useCallback(async (): Promise<void> => {
    const t = shellT()
    const cleanTitle = title.trim()
    const cleanPrompt = prompt.trim()
    if (cleanTitle === '' || cleanPrompt === '') {
      setFormError(t('automation.form.titlePromptRequired'))
      return
    }
    if (plan === undefined) {
      setFormError(t('automation.form.planRequired'))
      return
    }
    const built = planTiming(plan)
    if (built.timing === undefined) {
      setFormError(built.error ?? t('automation.form.planIncomplete'))
      return
    }

    setBusy(true)
    setFormError(null)
    // Deliveries land in the CURRENT session (this Host cannot mint schedule
    // sessions); the fresh-session sentinel resolves to a minted one first.
    let targetId = sessionId
    try {
      targetId = await ensureSession()
    } catch (err) {
      setBusy(false)
      setFormError(err instanceof Error ? err.message : t('shell.notice.sessionCreateFailed'))
      return
    }
    // 运行方式落位：模型/思考强度/预设/权限逐项写入目标会话（未设置的维度
    // 不动，跟随会话现状）。写失败如实上报，不打断任务创建。
    if (run.provider !== undefined && run.model !== undefined) {
      await rpc('session.selectModel', {
        sessionId: targetId,
        provider: run.provider,
        model: run.model,
        ...(run.effort !== undefined ? { reasoningEffort: run.effort } : {}),
      }, 30_000).catch(() => { setFormError(shellT()('automation.form.modelNotWritten')) })
    }
    if (run.preset !== undefined) {
      const outcome = await rpc('agentPreset.select', { sessionId: targetId, agentPreset: run.preset }, 30_000)
      if (!outcome.ok) {
        const reason = outcome.error?.message ?? shellT()('shell.common.unknownReason')
        setFormError(shellT()('automation.form.presetNotWritten', { reason }))
      }
    }
    if (run.mode !== undefined) {
      await rpc('session.permission.set', { sessionId: targetId, mode: run.mode }, 30_000).catch(() => {
        setFormError(shellT()('automation.form.permissionNotWritten'))
      })
    }
    const outcome = await rpc('schedule.create', {
      title: cleanTitle,
      prompt: cleanPrompt,
      timing: built.timing,
      target: { kind: 'session', sessionId: targetId },
    }, 30_000)
    setBusy(false)
    if (!mounted.current) return
    if (!outcome.ok) {
      setFormError(outcome.error?.message ?? shellT()('automation.error.createFailed'))
      return
    }
    setPrompt('')
    setPlan(undefined)
    void refresh()
  }, [title, prompt, plan, sessionId, ensureSession, run, refresh])

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
    if (mounted.current && !outcome.ok) setError(outcome.error?.message ?? shellT()('automation.error.runFailed'))
  }, [])

  /** Toggle one task's saved-delivery history expander (paged read, newest first). */
  const toggleHistory = useCallback(async (entry: ScheduleEntry): Promise<void> => {
    if (historyId === entry.id) {
      setHistoryId(undefined)
      setHistoryRows(null)
      return
    }
    setHistoryId(entry.id)
    setHistoryRows(null)
    const outcome = await rpc('schedule.history', { id: entry.id, limit: 20 }, 30_000)
    if (!mounted.current) return
    if (!outcome.ok) {
      setError(outcome.error?.message ?? shellT()('automation.error.historyFailed'))
      return
    }
    const value = outcome.value as { records?: unknown } | undefined
    const records = Array.isArray(value?.records) ? value.records as DeliveryRecord[] : []
    setHistoryRows(records)
  }, [historyId])

  return (
    <div className="dshx-up">
      <div className="dshx-up-head">
        <span className="dshx-up-title">{t('shell.rail.automation')}</span>
        <button type="button" className="dshx-iconbtn" aria-label={t('automation.closeLabel')} title={t('automation.close')} onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="dshx-up-body">
        <div className="dshx-up-inner">
          <p className="dshx-auto-intro">{t('automation.intro')}</p>
          <div className="dshx-auto-tabrow">
            <div className="dshx-auto-tabs" role="tablist" aria-label={t('automation.tabsLabel')}>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'setup'}
                className={`dshx-auto-tab${tab === 'setup' ? ' is-active' : ''}`}
                onClick={() => { setTab('setup') }}
              >{t('automation.tab.setup')}</button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'history'}
                className={`dshx-auto-tab${tab === 'history' ? ' is-active' : ''}`}
                onClick={() => { setTab('history') }}
              >{t('automation.tab.history')}</button>
            </div>
            <Button size="sm" disabled={busy || tab !== 'setup'} onClick={() => { void createTask() }}>
              {t('automation.create')}
            </Button>
          </div>
          {error !== '' && <div className="dshx-auto-error" role="alert">{error}</div>}

          {tab === 'setup' && (
            <div className="dshx-auto-form">
              <label className="dshx-auto-field">
                <span className="dshx-auto-fieldlabel">{t('automation.field.title')}</span>
                <input
                  className="dshx-auto-input"
                  value={title}
                  placeholder={t('automation.form.untitled')}
                  onChange={(event) => { setTitle(event.target.value) }}
                />
              </label>
              <div className="dshx-auto-field">
                <span className="dshx-auto-fieldlabel">{t('automation.field.schedule')}</span>
                {plan === undefined ? (
                  <button type="button" className="dshx-auto-planstub" onClick={() => { setPlan({ ...DEFAULT_PLAN }) }}>
                    {t('automation.form.addPlan')}
                  </button>
                ) : (
                  <div className="dshx-auto-plan">
                    <div className="dshx-auto-plankinds">
                      {PLAN_KINDS.map(item => (
                        <button
                          key={item.kind}
                          type="button"
                          className={`dshx-auto-plankind${plan.kind === item.kind ? ' is-active' : ''}`}
                          onClick={() => { setPlan({ ...plan, kind: item.kind }) }}
                        >{t(item.labelKey)}</button>
                      ))}
                    </div>
                    {plan.kind === 'weekly' && (
                      <div className="dshx-auto-planrow">
                        {WEEKDAY_LABEL_KEYS.map((labelKey, index) => {
                          const weekday = index + 1
                          const on = plan.weekdays.includes(weekday)
                          return (
                            <button
                              key={weekday}
                              type="button"
                              className={`dshx-auto-weekday${on ? ' is-on' : ''}`}
                              aria-pressed={on}
                              onClick={() => {
                                setPlan({
                                  ...plan,
                                  weekdays: on ? plan.weekdays.filter(d => d !== weekday) : [...plan.weekdays, weekday],
                                })
                              }}
                            >{t(labelKey)}</button>
                          )
                        })}
                      </div>
                    )}
                    <div className="dshx-auto-planrow">
                      {(plan.kind === 'daily' || plan.kind === 'weekly' || plan.kind === 'at') && (
                        <input
                          className="dshx-auto-input"
                          type="time"
                          value={plan.time}
                          onChange={(event) => { setPlan({ ...plan, time: event.target.value }) }}
                        />
                      )}
                      {plan.kind === 'at' && (
                        <input
                          className="dshx-auto-input"
                          type="date"
                          value={plan.date}
                          onChange={(event) => { setPlan({ ...plan, date: event.target.value }) }}
                        />
                      )}
                      {plan.kind === 'every' && (
                        <input
                          className="dshx-auto-input"
                          type="number"
                          min={1}
                          value={plan.minutes}
                          onChange={(event) => { setPlan({ ...plan, minutes: event.target.value }) }}
                        />
                      )}
                      {plan.kind === 'after' && (
                        <input
                          className="dshx-auto-input"
                          type="number"
                          min={5}
                          value={plan.seconds}
                          onChange={(event) => { setPlan({ ...plan, seconds: event.target.value }) }}
                        />
                      )}
                      {plan.kind === 'cron' && (
                        <input
                          className="dshx-auto-input"
                          value={plan.cron}
                          placeholder={t('automation.cronPlaceholder')}
                          onChange={(event) => { setPlan({ ...plan, cron: event.target.value }) }}
                        />
                      )}
                      <button
                        type="button"
                        className="dshx-auto-planremove"
                        onClick={() => { setPlan(undefined) }}
                      >{t('automation.removePlan')}</button>
                    </div>
                    <div className="dshx-auto-planzone">{t('automation.timezone', { zone: LOCAL_ZONE })}</div>
                  </div>
                )}
              </div>
              <label className="dshx-auto-field">
                <span className="dshx-auto-fieldlabel">{t('automation.field.prompt')}</span>
                <textarea
                  className="dshx-auto-text"
                  rows={5}
                  value={prompt}
                  placeholder={t('automation.promptPlaceholder')}
                  onChange={(event) => { setPrompt(event.target.value) }}
                />
              </label>
              <div className="dshx-auto-field">
                <span className="dshx-auto-fieldlabel">{t('automation.field.run')}</span>
                <div className="dshx-auto-runrow">
                  <div className="dshx-menuwrap">
                    <button type="button" className="dshx-auto-chip" aria-haspopup="menu" onClick={() => { setMenuOpen(current => current === 'model' ? undefined : 'model') }}>
                      <CpuIcon size={12} /><span>{t('automation.modelChip', { label: labelFor.model })}</span>
                    </button>
                    {menuOpen === 'model' && (
                      <div className="dshx-pop dshx-pop--up" role="menu">
                        <button type="button" role="menuitem" className="dshx-menuitem" onClick={() => { setRun(run => clearRunKeys(run, ['provider', 'model', 'effort'])); setMenuOpen(undefined) }}>{t('automation.followSession')}</button>
                        {groups.map(group => (group.models ?? []).map(model => (
                          <button
                            key={String(group.id) + '/' + String(model.id)}
                            type="button"
                            role="menuitem"
                            className={`dshx-menuitem${run.provider === group.id && run.model === model.id ? ' is-current' : ''}`}
                            onClick={() => { setRun(run => withModelRoute(run, group.id, model.id)); setMenuOpen(undefined) }}
                          >{model.name ?? model.id}</button>
                        )))}
                      </div>
                    )}
                  </div>
                  <div className="dshx-menuwrap">
                    <button type="button" className="dshx-auto-chip" aria-haspopup="menu" disabled={run.provider === undefined} onClick={() => { setMenuOpen(current => current === 'effort' ? undefined : 'effort') }}>
                      <GaugeIcon size={12} /><span>{t('composer.effort.chipValue', { label: labelFor.effort })}</span>
                    </button>
                    {menuOpen === 'effort' && (
                      <div className="dshx-pop dshx-pop--up" role="menu">
                        <button type="button" role="menuitem" className="dshx-menuitem" onClick={() => { setRun(run => clearRunKeys(run, ['effort'])); setMenuOpen(undefined) }}>{t('automation.followDefault')}</button>
                        {effortOptions.map(entry => (
                          <button
                            key={entry.id}
                            type="button"
                            role="menuitem"
                            className={`dshx-menuitem${run.effort === entry.id ? ' is-current' : ''}`}
                            onClick={() => { setRun(run => ({ ...run, effort: entry.id })); setMenuOpen(undefined) }}
                          >{entry.name}</button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="dshx-menuwrap">
                    <button type="button" className="dshx-auto-chip" aria-haspopup="menu" onClick={() => { setMenuOpen(current => current === 'preset' ? undefined : 'preset') }}>
                      <PuzzleIcon size={12} /><span>{t('automation.presetChip', { label: labelFor.preset })}</span>
                    </button>
                    {menuOpen === 'preset' && (
                      <div className="dshx-pop dshx-pop--up" role="menu">
                        <button type="button" role="menuitem" className="dshx-menuitem" onClick={() => { setRun(run => clearRunKeys(run, ['preset'])); setMenuOpen(undefined) }}>{t('automation.followSession')}</button>
                        {presets.map(preset => (
                          <button
                            key={preset.id}
                            type="button"
                            role="menuitem"
                            className={`dshx-menuitem${run.preset === preset.id ? ' is-current' : ''}`}
                            onClick={() => { setRun(run => ({ ...run, preset: preset.id })); setMenuOpen(undefined) }}
                          >{agentPresetName(t, preset)}</button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="dshx-menuwrap">
                    <button type="button" className="dshx-auto-chip" aria-haspopup="menu" onClick={() => { setMenuOpen(current => current === 'mode' ? undefined : 'mode') }}>
                      <ShieldIcon size={12} /><span>{t('automation.modeChip', { label: labelFor.mode })}</span>
                    </button>
                    {menuOpen === 'mode' && (
                      <div className="dshx-pop dshx-pop--up" role="menu">
                        <button type="button" role="menuitem" className="dshx-menuitem" onClick={() => { setRun(run => clearRunKeys(run, ['mode'])); setMenuOpen(undefined) }}>{t('automation.followSession')}</button>
                        {modeItems(t).map(item => (
                          <button
                            key={item.value}
                            type="button"
                            role="menuitem"
                            className={`dshx-menuitem${run.mode === item.value ? ' is-current' : ''}`}
                            title={item.description}
                            onClick={() => { setRun(run => ({ ...run, mode: item.value })); setMenuOpen(undefined) }}
                          >{item.label}</button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="dshx-auto-planzone">{t('automation.runNote')}</div>
              </div>
              <div className="dshx-auto-field">
                <span className="dshx-auto-fieldlabel">{t('automation.field.target')}</span>
                <div className="dshx-auto-planzone">{t('automation.targetNote')}</div>
              </div>
              {formError !== null && <div className="dshx-auto-error" role="alert">{formError}</div>}
            </div>
          )}

          {tab === 'history' && (
            <div className="dshx-auto-history">
              {entries === null
                ? <div className="dshx-sched-empty">{t('automation.reading')}</div>
                : (
                  entries.length === 0
                    ? <div className="dshx-sched-empty">{t('automation.emptyTasks')}</div>
                    : (
                      <div className="dshx-sched-rows">
                        {entries.map(entry => (
                          <div className="dshx-sched-row" key={entry.id}>
                            <div className="dshx-sched-rowmain">
                              <span className="dshx-sched-name" title={entry.prompt}>{entry.title}</span>
                              <Badge variant="soft" size="sm" className={`dshx-sched-chip is-${entry.status}`}>
                                {entry.status === 'active' ? t('automation.status.active') : entry.status === 'paused' ? t('automation.status.paused') : t('automation.status.ended')}
                              </Badge>
                            </div>
                            <div className="dshx-sched-meta">
                              {t('automation.nextRun', { timing: timingText(entry), time: localTime(entry.scheduledAt) })}
                            </div>
                            <div className="dshx-sched-rowops">
                              <Button size="sm" variant="ghost" disabled={busy || entry.status !== 'active'} onClick={() => { void runTask(entry) }}>{t('automation.runNow')}</Button>
                              <Button size="sm" variant="ghost" onClick={() => { void toggleHistory(entry) }}>
                                {historyId === entry.id ? t('automation.history.collapse') : t('automation.history.show')}
                              </Button>
                              <Button size="sm" variant="ghost" disabled={busy || entry.status === 'ended'} onClick={() => { void removeTask(entry) }}>{t('shell.rail.delete')}</Button>
                              <Switch
                                checked={entry.status === 'active'}
                                disabled={busy || entry.status === 'ended'}
                                onCheckedChange={() => { void toggleTask(entry) }}
                              />
                            </div>
                            {historyId === entry.id && (
                              <div className="dshx-auto-deliveries">
                                {historyRows === null
                                  ? <div className="dshx-sched-empty">{t('automation.reading')}</div>
                                  : historyRows.length === 0
                                    ? <div className="dshx-sched-empty">{t('automation.emptyDeliveries')}</div>
                                    : historyRows.map((record, index) => (
                                      <div className="dshx-auto-delivery" key={index}>
                                        <span className="dshx-auto-deliverytime">{localTime(record.at)}</span>
                                        <span className="dshx-auto-deliverytext">{(record.prompt ?? '').slice(0, 120) || t('automation.noContent')}</span>
                                      </div>
                                    ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )
                )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Panel + roster styles, injected once by the shell's stylesheet bundle. */
export const SCHEDULE_CARD_CSS = `
.dshx-auto-intro{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary,#666)}
.dshx-auto-tabrow{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dshx-auto-tabs{display:inline-flex;gap:2px;padding:2px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05))}
.dshx-auto-tab{border:0;border-radius:8px;padding:5px 14px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;font-size:12.5px;font-weight:500;transition:background .15s ease,color .15s ease}
.dshx-auto-tab.is-active{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#171717);box-shadow:0 1px 2px rgba(15,18,26,.08)}
.dshx-auto-form{display:flex;flex-direction:column;gap:14px}
.dshx-auto-field{display:flex;flex-direction:column;gap:6px}
.dshx-auto-fieldlabel{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#171717)}
.dshx-auto-input{width:100%;box-sizing:border-box;height:34px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;padding:0 10px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#171717);font:inherit;font-size:12.5px;outline:none;transition:border-color .15s ease,box-shadow .15s ease}
.dshx-auto-input::placeholder{color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-auto-input:focus{outline:none;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 22%,transparent)}
.dshx-auto-text{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;padding:9px 10px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#171717);font:inherit;font-size:12.5px;line-height:1.6;resize:vertical;outline:none;transition:border-color .15s ease,box-shadow .15s ease}
.dshx-auto-text:focus{outline:none;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 22%,transparent)}
.dshx-auto-planstub{width:100%;box-sizing:border-box;display:flex;align-items:center;gap:6px;height:38px;border:1px dashed var(--dsw-alias-border-l3,rgba(0,0,0,.2));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;font-size:12.5px;transition:background .15s ease}
.dshx-auto-planstub:hover{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04))}
.dshx-auto-plan{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;padding:10px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03))}
.dshx-auto-plankinds{display:flex;flex-wrap:wrap;gap:4px}
.dshx-auto-plankind{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:999px;padding:3px 10px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;font-size:11.5px;transition:background .15s ease,color .15s ease,border-color .15s ease}
.dshx-auto-plankind.is-active{background:var(--dsw-alias-label-primary,#171717);color:var(--dsw-alias-bg-base,#fff);border-color:transparent}
.dshx-auto-planrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.dshx-auto-weekday{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px;padding:4px 8px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;font-size:11.5px;transition:background .15s ease,color .15s ease}
.dshx-auto-weekday.is-on{background:var(--dsw-alias-label-primary,#171717);color:var(--dsw-alias-bg-base,#fff);border-color:transparent}
.dshx-auto-planremove{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#aaa);cursor:pointer;font-size:11.5px}
.dshx-auto-planremove:hover{color:var(--error,#dc2626)}
.dshx-auto-planzone{font-size:11px;color:var(--dsw-alias-label-tertiary,#aaa)}
/* 运行方式 chips（模型/思考/预设/权限）：菜单复用注入的 .dshx-pop/.dshx-menuitem */
.dshx-auto-runrow{display:flex;flex-wrap:wrap;gap:6px}
.dshx-auto-chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#171717);cursor:pointer;font-size:11.5px;white-space:nowrap;transition:background .15s ease}
.dshx-auto-chip:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05))}
.dshx-auto-chip:disabled{opacity:.45;cursor:default}
.dshx-auto-chip svg{color:var(--dsw-alias-label-tertiary,#999)}
.dshx-up .dshx-pop{z-index:20}
.dshx-up .dshx-menuitem{height:30px}
.dshx-auto-targets{display:flex;gap:6px}
.dshx-auto-target{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px;padding:6px 12px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;font-size:12px;transition:background .15s ease,color .15s ease}
.dshx-auto-target.is-active{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 10%,transparent);color:var(--dsw-alias-label-primary,#171717)}
.dshx-auto-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#dc2626)}
.dshx-auto-history{display:flex;flex-direction:column;gap:10px}
.dshx-auto-deliveries{display:flex;flex-direction:column;gap:4px;border-top:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.1));padding-top:8px}
.dshx-auto-delivery{display:flex;gap:8px;align-items:baseline;font-size:11.5px}
.dshx-auto-deliverytime{flex:none;color:var(--dsw-alias-label-tertiary,#aaa);font-variant-numeric:tabular-nums}
.dshx-auto-deliverytext{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#666)}
.dshx-sched { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.03)); }
.dshx-sched-head { display: flex; align-items: baseline; gap: 8px; }
.dshx-sched-title { font-weight: 600; font-size: 13px; }
.dshx-sched-sub { font-weight: 400; font-size: 11px; opacity: 0.55; }
.dshx-sched-error { font-size: 12px; color: #f87171; }
.dshx-sched-empty { font-size: 12px; opacity: 0.6; }
.dshx-sched-rows { display: flex; flex-direction: column; gap: 6px; }
.dshx-sched-row { border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.03)); }
.dshx-sched-rowmain { display: flex; align-items: center; gap: 8px; }
.dshx-sched-name { font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshx-sched-meta { font-size: 11px; opacity: 0.6; }
.dshx-sched-rowops { display: flex; align-items: center; gap: 4px; justify-content: flex-end; margin-left: auto; }
.dshx-sched-chip.is-active { color: #4ade80; }
.dshx-sched-chip.is-paused { color: #fbbf24; }
.dshx-sched-chip.is-ended { opacity: 0.6; }
.dshx-up .dshx-sched-rowops button { height: 24px; padding: 0 10px; font-size: 11.5px; }
`
