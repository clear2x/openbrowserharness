/**
 * `chrome-page-batch-tool`: the `page_batch_actions` tool (batch 278,
 * hardened in batch 280) — the plan-then-execute batch lane. The model
 * submits a whole sequence of page actions (click / click_at / type / press
 * / scroll / wait / navigate) in ONE call; this module validates the plan up
 * front, runs it in order over the browser seam, and stops at the first
 * failing step with a structured progress report. One round-trip replaces
 * several page_click/page_type round-trips: cloud round-trips, not
 * per-action cost, dominate agent browsing latency.
 *
 * The lane supplies the actionability the single-step flow gets from the
 * model's observation cadence:
 * - a click / type target is waited for (bounded) and scrolled into view
 *   before the step acts — the provider's own click does neither;
 * - every mutating step arms a navigation mark and settles afterwards, so
 *   a step-triggered navigation cannot race the next step
 *   (`document.readyState` alone still reads `complete` for the OLD
 *   document until the navigation commits — the mark tells the documents
 *   apart);
 * - `wait` polls from this side with short synchronous page reads, so a
 *   navigation in the middle of the wait no longer strands an in-page poll.
 * Execution reuses the provider's own action primitives (humanized clicks,
 * hit-test verified) — no in-page expression of its own beyond the fixed
 * probes in `page-batch-page.ts`.
 *
 * @module chrome-page-batch-tool
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { BrowserProvider } from '@deepseek-ai/dsh-browser'
import { parseTabId } from '@deepseek-ai/dsh-tool-browser'
import {
  BATCH_NAV_MARKER,
  armNavigationMarkExpression,
  documentStateExpression,
  parseDocumentState,
  targetProbeExpression,
} from './page-batch-page.ts'

/** Default auto-wait budget for a click / type target before its step acts. */
export const DEFAULT_ACTION_WAIT_MS = 5_000
/** Default budget for a step-triggered navigation to reach an interactive document. */
export const DEFAULT_SETTLE_BUDGET_MS = 10_000
/** Default quiet window after a mutation before the lane concludes no navigation started. */
export const DEFAULT_SETTLE_QUIET_MS = 350
/** Default poll interval of the waits and the settle. */
export const DEFAULT_POLL_MS = 150

/** Deployment-varying timing of the batch lane; every field has a documented default. */
export interface Config {
  /** Auto-wait budget for a click / type target before its step acts (default 5000). */
  actionWaitMs?: number
  /** Budget for a step-triggered navigation to reach an interactive document (default 10000). */
  settleBudgetMs?: number
  /** Quiet window after a mutation before the lane concludes no navigation started (default 350). */
  settleQuietMs?: number
  /** Poll interval of the waits and the settle (default 150). */
  pollMs?: number
}

/** Schemastery config with the loaded defaults. */
export const Config: z<Config> = z.object({
  actionWaitMs: z.number().step(1).min(0).default(DEFAULT_ACTION_WAIT_MS),
  settleBudgetMs: z.number().step(1).min(0).default(DEFAULT_SETTLE_BUDGET_MS),
  settleQuietMs: z.number().step(1).min(0).default(DEFAULT_SETTLE_QUIET_MS),
  pollMs: z.number().step(1).min(10).default(DEFAULT_POLL_MS),
})

/** The resolved timing every execution path reads; no field is optional by then. */
export interface BatchTiming {
  actionWaitMs: number
  settleBudgetMs: number
  settleQuietMs: number
  pollMs: number
}

/**
 * Resolve the lane's timing from (possibly partial) config — the one place
 * the defaults are applied.
 * @param config - the loaded plugin config.
 * @returns the complete timing.
 */
export function resolveBatchTiming(config: Config): BatchTiming {
  return {
    actionWaitMs: config.actionWaitMs ?? DEFAULT_ACTION_WAIT_MS,
    settleBudgetMs: config.settleBudgetMs ?? DEFAULT_SETTLE_BUDGET_MS,
    settleQuietMs: config.settleQuietMs ?? DEFAULT_SETTLE_QUIET_MS,
    pollMs: config.pollMs ?? DEFAULT_POLL_MS,
  }
}

/** The module reads the browser seam; every action goes through the provider. */
export const inject = ['tools', 'browser'] as const

/** The per-call deadline (a full 12-step plan at its worst-case waits, plus the actions). */
const TOOL_TIMEOUT_MS = 240_000

/** Maximum steps one batch call accepts. */
export const MAX_BATCH_ACTIONS = 12

/** Upper bound for one wait step's budget (matches page_wait_for). */
export const BATCH_WAIT_MAX_MS = 30_000

/** The wait step's default budget. */
const BATCH_WAIT_DEFAULT_MS = 5_000

/** The batch ops the model may submit. */
export const BATCH_OPS = ['click', 'click_at', 'type', 'press', 'scroll', 'wait', 'navigate'] as const

/** One op name. */
export type BatchOp = (typeof BATCH_OPS)[number]

/** Whether one raw value is one of the batch ops. */
function isBatchOp(value: unknown): value is BatchOp {
  return typeof value === 'string' && (BATCH_OPS as readonly string[]).includes(value)
}

/** Whether an op changes page state in ways that may navigate. */
function isMutating(op: BatchOp): boolean {
  return op === 'click' || op === 'click_at' || op === 'type' || op === 'press'
}

/** The model-facing shape of one plan step (all fields optional at parse). */
export interface BatchActionInput {
  op?: string
  selector?: string
  text?: string
  submit?: boolean
  key?: string
  direction?: string
  amount_px?: number
  timeout_ms?: number
  url?: string
  x?: number
  y?: number
}

/** One validated plan step, ready to execute. */
export interface ParsedBatchAction {
  op: BatchOp
  /** The render/record line describing the step (stable marker surface). */
  detail: string
  selector?: string
  text?: string
  submit?: boolean
  key?: string
  direction?: 'up' | 'down'
  amountPx?: number
  timeoutMs?: number
  url?: string
  x?: number
  y?: number
}

/** Truncate one value's render presence to keep step lines short. */
function present(text: string, cap = 40): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text
}

/** Build one step's detail line from its validated fields. */
function detailOf(action: ParsedBatchAction): string {
  switch (action.op) {
    case 'click': return `click 「${action.selector ?? ''}」`
    case 'click_at': return `click_at (${String(action.x ?? 0)}, ${String(action.y ?? 0)})`
    case 'type': return `type 「${action.selector ?? ''}」←「${present(action.text ?? '')}」${action.submit === true ? '（回车提交）' : ''}`
    case 'press': return `press ${action.key ?? ''}`
    case 'scroll': return `scroll ${action.direction ?? ''}${action.amountPx === undefined ? '' : ` ${String(action.amountPx)}px`}`
    case 'wait': return `wait 「${action.selector ?? ''}」（${String(action.timeoutMs ?? BATCH_WAIT_DEFAULT_MS)}ms）`
    case 'navigate': return `navigate ${present(action.url ?? '', 80)}`
  }
}

/**
 * Validate one raw plan step. The JSON-schema layer enforces the array's
 * existence only — the item contract is enforced HERE, per step, with the
 * step number in every message, so a malformed plan fails loud before any
 * action runs.
 * @param raw - the model-supplied step object.
 * @param position - zero-based position (used in error messages).
 * @returns the validated step.
 */
export function parseBatchAction(raw: unknown, position: number): ParsedBatchAction {
  const label = `actions[${String(position)}]（第 ${String(position + 1)} 步）`
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${label} 必须是对象`)
  }
  const step = raw as Record<string, unknown>
  const op = step['op']
  if (!isBatchOp(op)) {
    throw new Error(`${label} 的 op 非法：${JSON.stringify(op ?? null)}（允许：${BATCH_OPS.join('/')}）`)
  }
  const selectorOf = (): string => {
    const value = step['selector']
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${label} 的 selector 必须是非空字符串`)
    }
    return value
  }
  const positiveOf = (field: string, max?: number): number | undefined => {
    const value = step[field]
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${label} 的 ${field} 必须是正整数（收到 ${JSON.stringify(value)}）`)
    }
    if (max !== undefined && value > max) {
      throw new Error(`${label} 的 ${field} 不能超过 ${String(max)}（收到 ${JSON.stringify(value)}）`)
    }
    return value
  }
  const coordinateOf = (field: 'x' | 'y'): number => {
    const value = step[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${label} 的 ${field} 必须是非负有限数值（视口 CSS 像素）`)
    }
    return value
  }
  const parsed: ParsedBatchAction = { op, detail: '' }
  switch (op) {
    case 'click':
      parsed.selector = selectorOf()
      break
    case 'click_at':
      parsed.x = coordinateOf('x')
      parsed.y = coordinateOf('y')
      break
    case 'type': {
      parsed.selector = selectorOf()
      const text = step['text']
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error(`${label} 的 text 必须是非空字符串`)
      }
      parsed.text = text
      if (step['submit'] === true) parsed.submit = true
      break
    }
    case 'press': {
      const key = step['key']
      if (typeof key !== 'string' || key.trim().length === 0) {
        throw new Error(`${label} 的 key 必须是非空字符串`)
      }
      parsed.key = key
      break
    }
    case 'scroll': {
      const direction = step['direction']
      if (direction !== 'up' && direction !== 'down') {
        throw new Error(`${label} 的 direction 必须是 "up" 或 "down"（收到 ${JSON.stringify(direction ?? null)}）`)
      }
      parsed.direction = direction
      const amountPx = positiveOf('amount_px', 100_000)
      if (amountPx !== undefined) parsed.amountPx = amountPx
      break
    }
    case 'wait':
      parsed.selector = selectorOf()
      {
        const timeoutMs = positiveOf('timeout_ms', BATCH_WAIT_MAX_MS)
        if (timeoutMs !== undefined) parsed.timeoutMs = timeoutMs
      }
      break
    case 'navigate': {
      const url = step['url']
      if (typeof url !== 'string' || url.trim().length === 0) {
        throw new Error(`${label} 的 url 必须是非空字符串`)
      }
      parsed.url = url
      break
    }
  }
  parsed.detail = detailOf(parsed)
  return parsed
}

/**
 * Validate a whole plan up front: non-empty, within the step cap, every
 * step well-formed. Nothing executes until this passes, so the model never
 * gets a half-run plan caused by a malformed tail step.
 * @param actions - the model-supplied steps (schema-typed, item-shape-free).
 * @returns the validated plan.
 */
export function parseBatchActions(actions: readonly unknown[]): ParsedBatchAction[] {
  if (!Array.isArray(actions)) {
    throw new Error('page_batch_actions 的 actions 必须是数组')
  }
  if (actions.length === 0) {
    throw new Error('page_batch_actions 的 actions 不能为空')
  }
  if (actions.length > MAX_BATCH_ACTIONS) {
    throw new Error(`page_batch_actions 的 actions 不能超过 ${String(MAX_BATCH_ACTIONS)} 步（收到 ${String(actions.length)} 步）`)
  }
  return actions.map((action, position) => parseBatchAction(action, position))
}

/** One page read; a navigation tearing the context down surfaces as `undefined`, never a throw. */
async function readPage(provider: BrowserProvider, tabId: number, expression: string): Promise<unknown> {
  try {
    return await provider.evaluate(tabId, expression)
  } catch {
    return undefined
  }
}

/**
 * Wait until a selector's target is present with a rendered box. Polls
 * from this side with short synchronous page reads, so a navigation in
 * flight (which fails the read) keeps the wait alive instead of failing
 * the step.
 * @param provider - the browser provider.
 * @param tabId - the target tab.
 * @param selector - the CSS or pierce selector.
 * @param budgetMs - how long the target may take to appear.
 * @param scrollIntoView - whether a found target is scrolled into view
 *   (click / type targets) or merely observed (a `wait` step).
 * @param timing - the lane's timing (the poll interval).
 * @param sleep - the wait primitive.
 * @throws with the selector's syntax error or the wait timeout.
 */
export async function waitUntilTargetReady(
  provider: BrowserProvider,
  tabId: number,
  selector: string,
  budgetMs: number,
  scrollIntoView: boolean,
  timing: BatchTiming,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const state = await readPage(provider, tabId, targetProbeExpression(selector, scrollIntoView))
    if (state === 'invalid') throw new Error(`选择器语法无效：${selector}`)
    if (state === 'found') return
    if (Date.now() >= deadline) {
      throw new Error(
        state === 'missing'
          ? `等待元素超时（${String(budgetMs)}ms）：${selector}`
          : `等待元素失败（${String(budgetMs)}ms 内页面不可读，可能正在跳转）：${selector}`,
      )
    }
    await sleep(timing.pollMs)
  }
}

/**
 * Arm the navigation mark on the current document before a mutating step.
 * @param provider - the browser provider.
 * @param tabId - the target tab.
 * @returns whether the mark was armed (false when the page was unreadable;
 *   the settle then falls back to its quiet-window rule).
 */
export async function armNavigationMark(provider: BrowserProvider, tabId: number): Promise<boolean> {
  return await readPage(provider, tabId, armNavigationMarkExpression(BATCH_NAV_MARKER)) !== undefined
}

/**
 * Settle after a mutating step. A NEW document (the mark is gone) is
 * awaited until it is interactive or complete; the SAME document is
 * released once the quiet window passed without a navigation committing.
 * Never throws: an exhausted budget releases the lane, and the next step's
 * own wait reports a genuinely unusable page.
 * @param provider - the browser provider.
 * @param tabId - the target tab.
 * @param timing - the lane's timing.
 * @param sleep - the wait primitive.
 * @param armed - whether the navigation mark was armed before the step.
 */
export async function settleAfterMutation(
  provider: BrowserProvider,
  tabId: number,
  timing: BatchTiming,
  sleep: (ms: number) => Promise<void>,
  armed: boolean,
): Promise<void> {
  const startedAt = Date.now()
  for (;;) {
    const elapsed = Date.now() - startedAt
    const state = parseDocumentState(await readPage(provider, tabId, documentStateExpression(BATCH_NAV_MARKER)))
    if (state !== undefined) {
      if (state.document === 'new') {
        if (state.readyState === 'interactive' || state.readyState === 'complete') return
      } else if (elapsed >= timing.settleQuietMs) {
        return
      }
    } else if (!armed && elapsed >= timing.settleQuietMs) {
      return
    }
    if (elapsed >= timing.settleBudgetMs) return
    await sleep(timing.pollMs)
  }
}

/** One executed step's record in the tool value. */
export interface BatchStepRecord {
  /** 1-based step number. */
  step: number
  op: BatchOp
  ok: boolean
  detail: string
  error?: string
}

/** The `page_batch_actions` canonical value. */
export interface PageBatchValue {
  tabId: number
  /** Total steps in the submitted plan. */
  total: number
  /** Steps attempted, including the failed one. */
  executed: number
  /** Whether every attempted step succeeded (plan ran to the end). */
  ok: boolean
  /** 1-based number of the step that failed; absent on full success. */
  stoppedAt?: number
  steps: BatchStepRecord[]
  /** The tab's URL after the plan; absent when unreadable (mid-navigation). */
  finalUrl?: string
}

/**
 * Run one validated plan in order over the provider, stopping at the first
 * failing step. Click / type targets are waited for and scrolled into view
 * first; mutating steps arm the navigation mark and settle afterwards.
 * @param provider - the browser provider.
 * @param tabId - the target tab.
 * @param plan - the validated plan.
 * @param timing - the lane's timing.
 * @param sleep - the wait primitive (tests inject; production uses timers).
 * @returns the canonical value with per-step records.
 */
export async function executeBatchPlan(
  provider: BrowserProvider,
  tabId: number,
  plan: ParsedBatchAction[],
  timing: BatchTiming,
  sleep: (ms: number) => Promise<void>,
): Promise<PageBatchValue> {
  const steps: BatchStepRecord[] = []
  for (const [position, action] of plan.entries()) {
    const record: BatchStepRecord = { step: position + 1, op: action.op, ok: true, detail: action.detail }
    try {
      if ((action.op === 'click' || action.op === 'type') && action.selector !== undefined) {
        await waitUntilTargetReady(provider, tabId, action.selector, timing.actionWaitMs, true, timing, sleep)
      }
      // 任何一步失败（含点击命中校验未过的遮挡/视口外原因）都原样进
      // record.error 并停止计划：批量 lane 不做坐标回退，把原因交给模型
      // 重新规划。
      const mutating = isMutating(action.op)
      const armed = mutating ? await armNavigationMark(provider, tabId) : false
      switch (action.op) {
        case 'click':
          await provider.clickSelector(tabId, action.selector ?? '')
          break
        case 'click_at':
          await provider.clickPoint(tabId, { x: action.x ?? 0, y: action.y ?? 0 })
          break
        case 'type':
          await provider.typeText(tabId, action.selector ?? '', action.text ?? '', { submit: action.submit === true })
          break
        case 'press':
          await provider.pressKey(tabId, action.key ?? '')
          break
        case 'scroll':
          await provider.scroll(tabId, action.direction === 'up' ? 'up' : 'down', action.amountPx)
          break
        case 'wait':
          // A wait step only observes: no scrolling, the step's own budget.
          await waitUntilTargetReady(
            provider,
            tabId,
            action.selector ?? '',
            action.timeoutMs ?? BATCH_WAIT_DEFAULT_MS,
            false,
            timing,
            sleep,
          )
          break
        case 'navigate':
          await provider.navigate(tabId, action.url ?? '')
          break
      }
      if (mutating) await settleAfterMutation(provider, tabId, timing, sleep, armed)
    } catch (error) {
      record.ok = false
      record.error = error instanceof Error ? error.message : String(error)
      steps.push(record)
      return withFinalUrl(provider, tabId, {
        tabId,
        total: plan.length,
        executed: steps.length,
        ok: false,
        stoppedAt: steps.length,
        steps,
      })
    }
    steps.push(record)
  }
  return withFinalUrl(provider, tabId, {
    tabId,
    total: plan.length,
    executed: steps.length,
    ok: true,
    steps,
  })
}

/**
 * Attach the best-effort final URL to a batch value; an unreadable URL
 * (mid-navigation) leaves the field absent rather than failing the report.
 * @param provider - the browser provider.
 * @param tabId - the target tab.
 * @param value - the value to decorate.
 * @returns the same value with `finalUrl` when readable.
 */
async function withFinalUrl(provider: BrowserProvider, tabId: number, value: PageBatchValue): Promise<PageBatchValue> {
  const url = await readPage(provider, tabId, 'location.href')
  if (typeof url === 'string' && url.length > 0) return { ...value, finalUrl: url }
  return value
}

/** The model-facing find value's step line prefix. */
function stepLine(record: BatchStepRecord): string {
  const mark = record.ok ? '✓' : '✗'
  const error = record.error === undefined ? '' : ` — ${record.error}`
  return `${String(record.step)}. ${mark} ${record.detail}${error}`
}

/**
 * Render the batch outcome: per-step progress, the stop point on failure,
 * the final URL, and the re-snapshot guidance — the model acts on this text.
 * @param value - the tool outcome.
 * @returns the complete render text.
 */
export function formatBatchOutput(value: PageBatchValue): string {
  const header = value.ok
    ? `[批量执行] 标签页 ${String(value.tabId)}：${String(value.executed)}/${String(value.total)} 步全部成功。`
    : `[批量执行] 标签页 ${String(value.tabId)}：${String(value.executed - 1)}/${String(value.total)} 步成功，第 ${String(value.stoppedAt ?? value.executed)} 步失败，已停止。`
  const lines = value.steps.map(stepLine)
  const tail: string[] = []
  if (!value.ok && value.executed < value.total) {
    tail.push(`尚未执行第 ${String(value.executed + 1)} 步起的 ${String(value.total - value.executed)} 步；修正失败步骤后可重新发起剩余步骤。`)
  }
  if (value.finalUrl !== undefined) tail.push(`当前 URL：${value.finalUrl}`)
  tail.push('页面可能已变化；继续操作前请重新 page_snapshot 或 page_find_related 获取新定位。')
  return [header, ...lines, ...tail].join('\n')
}

/** Read one raw plan step's op for the call-card summary ('?' when absent). */
function opOf(action: unknown): string {
  if (typeof action === 'object' && action !== null && 'op' in action && typeof action.op === 'string') {
    return action.op
  }
  return '?'
}

/** The model-facing argument record. */
export interface PageBatchArgs {
  tab_id: number
  /** The schema layer types items loosely; item contracts live in the parser. */
  actions: readonly unknown[]
}

/**
 * Register the `page_batch_actions` tool.
 * @param ctx - the cordis context.
 * @param config - the lane's timing config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const timing = resolveBatchTiming(config)
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
  ctx.tools.register(defineTool({
    name: 'page_batch_actions',
    description: [
      '把多步页面操作合并为一次调用（计划-批量执行）：按顺序执行 click/click_at/type/press/scroll/wait/navigate 步骤，任一步失败即停止并回报已完成进度。',
      'actions 每步一个对象：{op:"click", selector}；{op:"click_at", x, y}（视口坐标点击，用于画布/滑块等无法用 selector 寻址的目标，坐标取自 page_snapshot 的 center）；{op:"type", selector, text, submit?}（整体替换输入，可选回车提交）；{op:"press", key}（如 Enter、Ctrl+A）；{op:"scroll", direction:"up"|"down", amount_px?}；{op:"wait", selector, timeout_ms?}（等待元素出现，默认 5000ms）；{op:"navigate", url}。',
      'click/type 的目标会先自动等待出现（最多 5 秒）并滚动到视口内；每一步之后自动等待页面跳转完成，因此连续操作不必在中间插 wait（只在目标需要更久才出现时才加 wait 步骤并给足 timeout_ms）。点击不做坐标回退（目标被遮挡时该步失败并回报原因）。',
      '适合目标明确的连续操作（登录、搜索、翻页、多级表单）：一次调用替代多轮 page_click/page_type 往返，显著更快。selector 可先由 page_find_related 或 page_snapshot 获取。',
    ].join(''),
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      actions: {
        type: 'array',
        required: true,
        description: `按顺序执行的步骤对象数组（1-${String(MAX_BATCH_ACTIONS)} 步），每步形状见工具说明；任一步格式非法时整个计划不执行（先校验后运行）。`,
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          total: { type: 'integer', required: true },
          executed: { type: 'integer', required: true },
          ok: { type: 'boolean', required: true },
          stoppedAt: { type: 'integer' },
          steps: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                step: { type: 'integer', required: true },
                op: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                detail: { type: 'string', required: true },
                error: { type: 'string' },
              },
            },
          },
          finalUrl: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatBatchOutput(value as PageBatchValue) }],
    },
    async execute(args, _exec): Promise<PageBatchValue> {
      const tabId = parseTabId(args.tab_id)
      const plan = parseBatchActions(args.actions)
      return executeBatchPlan(ctx.browser.provider, tabId, plan, timing, sleep)
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: `批量执行 ${String(args.actions.length)} 步`,
      kind: 'execute',
      rawInput: args.actions.map(opOf).slice(0, 8).join('→'),
    }),
  }))
}
