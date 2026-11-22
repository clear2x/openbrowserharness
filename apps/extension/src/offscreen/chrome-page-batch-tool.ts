/**
 * `chrome-page-batch-tool`: the `page_batch_actions` tool (batch 278) — the
 * plan-then-execute batch lane. The model submits a whole sequence of
 * selector-addressed page actions (click/type/press/scroll/wait/navigate)
 * in ONE call; this module validates the plan up front, runs it in order
 * over the browser seam, and stops at the first failing step with a
 * structured progress report. One round-trip replaces several
 * page_click/page_type round-trips, which is the wall-clock win: cloud
 * round-trips dominate agent browsing latency, not per-action cost.
 *
 * Execution reuses the provider's own action primitives (humanized clicks,
 * hit-test verified) — no in-page expression of its own. Between mutating
 * steps it re-checks `document.readyState` (a click may navigate; the
 * provider settles navigations only on `navigate` itself).
 *
 * @module chrome-page-batch-tool
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { BrowserProvider } from '@deepseek-ai/dsh-browser'
import { parseTabId } from '@deepseek-ai/dsh-tool-browser'

/** This module carries no config today. */
export interface Config {}

/** The module reads the browser seam; every action goes through the provider. */
export const inject = ['tools', 'browser'] as const

/** The per-call deadline (a full plan including wait steps and settles). */
const TOOL_TIMEOUT_MS = 180_000

/** Maximum steps one batch call accepts. */
export const MAX_BATCH_ACTIONS = 12

/** The budget one post-mutation readiness settle waits for `complete`. */
export const NAV_SETTLE_BUDGET_MS = 10_000

/** The readiness-settle poll interval. */
export const NAV_SETTLE_POLL_MS = 250

/** Upper bound for one wait step's budget (matches page_wait_for). */
export const BATCH_WAIT_MAX_MS = 30_000

/** The wait step's default budget. */
const BATCH_WAIT_DEFAULT_MS = 5_000

/** The batch ops the model may submit, as the schema-facing string set. */
export const BATCH_OPS = ['click', 'type', 'press', 'scroll', 'wait', 'navigate'] as const

/** One op name. */
export type BatchOp = (typeof BATCH_OPS)[number]

/** Whether one raw value is one of the batch ops. */
function isBatchOp(value: unknown): value is BatchOp {
  return typeof value === 'string' && (BATCH_OPS as readonly string[]).includes(value)
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
}

/** Truncate one value's render presence to keep step lines short. */
function present(text: string, cap = 40): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text
}

/** Build one step's detail line from its validated fields. */
function detailOf(action: ParsedBatchAction): string {
  switch (action.op) {
    case 'click': return `click 「${action.selector ?? ''}」`
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
  const parsed: ParsedBatchAction = { op, detail: '' }
  switch (op) {
    case 'click':
      parsed.selector = selectorOf()
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

/**
 * Wait for the tab's document to settle after a mutating step: poll
 * `document.readyState` until `complete` (or the budget runs out).
 * Evaluate failures during a navigation (execution context destroyed) are
 * retried; a budget timeout is reported, not thrown — the next step's own
 * action fails loudly if the page is genuinely unusable.
 * @param provider - the browser provider.
 * @param tabId - the target tab.
 * @param budgetMs - the total settle budget.
 * @param pollMs - the poll interval.
 * @returns whether the page reached `complete` within the budget.
 */
export async function settlePageReady(provider: BrowserProvider, tabId: number, budgetMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    try {
      const state = await provider.evaluate<string>(tabId, 'document.readyState')
      if (state === 'complete') return true
    } catch {
      // Navigation in flight (execution context destroyed) — keep polling.
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  return false
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
 * failing step. Mutating ops settle page readiness before the next step so
 * a click-triggered navigation does not race the follow-up action.
 * @param provider - the browser provider.
 * @param tabId - the target tab.
 * @param plan - the validated plan.
 * @param timing - the settle knobs (tests inject small budgets; defaults
 *   serve production).
 * @returns the canonical value with per-step records.
 */
export async function executeBatchPlan(
  provider: BrowserProvider,
  tabId: number,
  plan: ParsedBatchAction[],
  timing?: { settleBudgetMs?: number; settlePollMs?: number },
): Promise<PageBatchValue> {
  const settleBudgetMs = timing?.settleBudgetMs ?? NAV_SETTLE_BUDGET_MS
  const settlePollMs = timing?.settlePollMs ?? NAV_SETTLE_POLL_MS
  const steps: BatchStepRecord[] = []
  for (const [position, action] of plan.entries()) {
    const record: BatchStepRecord = { step: position + 1, op: action.op, ok: true, detail: action.detail }
    try {
      switch (action.op) {
        // 任何一步失败（含点击命中校验未过的遮挡/视口外原因）都原样进
        // record.error 并停止计划：批量 lane 不做坐标回退，把原因交给模型
        // 重新规划。
        case 'click':
          await provider.clickSelector(tabId, action.selector ?? '')
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
          await provider.waitFor(tabId, action.selector ?? '', action.timeoutMs ?? BATCH_WAIT_DEFAULT_MS)
          break
        case 'navigate':
          await provider.navigate(tabId, action.url ?? '')
          break
      }
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
    // Click/type/press may navigate; wait/navigate settle themselves
    // (waitFor returns on the target; navigate settles in the provider).
    if (action.op === 'click' || action.op === 'type' || action.op === 'press') {
      await settlePageReady(provider, tabId, settleBudgetMs, settlePollMs)
    }
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
  try {
    const url = await provider.evaluate<string>(tabId, 'location.href')
    if (typeof url === 'string' && url.length > 0) return { ...value, finalUrl: url }
  } catch {
    // Mid-navigation read failure — report without the URL.
  }
  return value
}

/** The model-facing find value's step line prefix. */
function stepLine(record: BatchStepRecord): string {
  const mark = record.ok ? '✓' : '✗'
  const error = record.error === undefined ? '' : ` — ${record.error}`
  return ` ${String(record.step)}. ${mark} ${record.detail}${error}`
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
    tail.push(` 尚未执行第 ${String(value.executed + 1)} 步起的 ${String(value.total - value.executed)} 步；修正失败步骤后可重新发起剩余步骤。`)
  }
  if (value.finalUrl !== undefined) tail.push(` 当前 URL：${value.finalUrl}`)
  tail.push(' 页面可能已变化；继续操作前请重新 page_snapshot 或 page_find_related 获取新定位。')
  return [header, ...lines, ...tail.map(line => line.trimStart())].join('\n')
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
 * @param _config - unused config.
 */
export function apply(ctx: Context, _config: Config): void {
  void _config
  ctx.tools.register(defineTool({
    name: 'page_batch_actions',
    description: [
      '把多步页面操作合并为一次调用（计划-批量执行）：按顺序执行 click/type/press/scroll/wait/navigate 步骤，任一步失败即停止并回报已完成进度。',
      'actions 每步一个对象：{op:"click", selector}；{op:"type", selector, text, submit?}（整体替换输入，可选回车提交）；{op:"press", key}（如 Enter、Ctrl+A）；{op:"scroll", direction:"up"|"down", amount_px?}；{op:"wait", selector, timeout_ms?}（等待元素出现）；{op:"navigate", url}。',
      '适合目标明确的连续操作（登录、搜索、翻页、多级表单）：一次调用替代多轮 page_click/page_type 往返，显著更快。',
      'selector 可先由 page_find_related 或 page_snapshot 获取；点击/提交可能引起跳转，跳转后的新内容请插入 wait 步骤锚定；步骤之间不做坐标回退（遮挡时该步失败并回报原因）。',
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
      return executeBatchPlan(ctx.browser.provider, tabId, plan)
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: `批量执行 ${String(args.actions.length)} 步`,
      kind: 'execute',
      rawInput: args.actions.map(opOf).slice(0, 8).join('→'),
    }),
  }))
}
