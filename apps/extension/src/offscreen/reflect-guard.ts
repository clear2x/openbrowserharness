/**
 * `chrome-reflect-guard`: the extension engine's reflection guard. Three
 * model-visible nudges keep autonomous browser work honest:
 *
 * ① Consecutive tool failures — counted per agent + tool through
 *    `tools/post-execute` (the seam `repeat-tool-reminder` enriches; denied
 *    calls flow through it too). At a configured threshold the guard attaches
 *    a notice naming the tool, the run length, the latest error code, and a
 *    deterministic route change: selector miss → re-snapshot; permission
 *    deny → read-only path or ask_user; navigation/timeout → check tab state
 *    instead of retrying. Beyond the thresholds nothing is injected.
 * ② Goal-round wrap-up completeness — while an active+armed goal's exact
 *    current round owns the open turn (the same source match as tool-goal's
 *    authority check), a turn that closes with errored tool results, or with
 *    change-class calls (`CHANGE_TOOLS`, the shared word list) but zero
 *    successful ones, is steered back for one more step. Each goal round has
 *    a steer budget; exhaustion lets the turn close with a console warning.
 * ③ Talk-only wrap-up — a completed turn with zero tool calls is nudged for
 *    every goal round, and for plain action sessions only when
 *    `nudgeIdleActionTurns` opts that evidence surface in (default off).
 *    While plan mode is in force every steering nudge is exempt: research
 *    turns legitimately close without actions, and the guard reads that
 *    state through the `planMode` service, never the gate's private state.
 *
 * Every injected message is minted by `reflectNotice` and carries the
 * `{kind:'plugin', plugin:'chrome-reflect-guard', form:'notice'}` source, so
 * model-visible ⟺ logged holds: steering and `additionalContexts` both route
 * the labeled message through the durable log. The fold of the open turn's
 * events is maintained incrementally from delivered `session/event`s (no
 * synchronous history reads). Assembly is this first-class composition row —
 * the user-plugin lane evaluates in the manifest-sandboxed iframe and has no
 * injection capability — ordered after the session-projection, goal, and
 * chrome-tool-gate rows the injected services come from.
 *
 * @module chrome-reflect-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { CHANGE_TOOLS } from '../shared/danger-tools.ts'

export const name = 'chrome-reflect-guard'

/**
 * Engine services this row's activation depends on: the tool pipeline whose
 * post-execute seam it enriches, the agent registry the listeners route
 * through, the goal service consulted at the wrap-up boundary, the session
 * projection registry the ordering promise points at, and the plan-mode
 * service whose committed state exempts the nudges.
 */
export const inject = ['tools', 'agents', 'goals', 'sessionProjections', 'planMode']

/**
 * Plugin config, schema-validated with defaults. Fail-loud re-checks run in
 * `apply`: an empty or duplicate `failThresholds`, a non-integer or sub-2
 * threshold, or a `steerBudget` below 1 throws at plugin load.
 */
export interface Config {
  /** Consecutive-failure counts that trigger a reflection notice (default `[2, 4]`). */
  failThresholds?: number[]
  /** Steers this guard may spend per goal round before letting the turn close (default 2). */
  steerBudget?: number
  /**
   * Zero-action detection over plain action sessions — turns outside any goal
   * round (default false; goal rounds are always covered).
   */
  nudgeIdleActionTurns?: boolean
}

/** Schemastery config with the loaded defaults. */
export const Config: z<Config> = z.object({
  failThresholds: z.array(z.number()).default([2, 4]),
  steerBudget: z.number().default(2),
  nudgeIdleActionTurns: z.boolean().default(false),
})

/** Canonical abort codes: a cancelled call is not a tool failure and stays transparent to the chain. */
const ABORT_CODES: ReadonlySet<string> = new Set(['ABORTED', 'ABORTED_BEFORE_DISPATCH'])

/**
 * The `{kind:'plugin'}` provenance every notice of this guard carries — the
 * label is load-bearing (an unlabeled context would render as a user prompt
 * in derived history). `reflectNotice` inlines it so the source literal hits
 * the plugin member of `MessageSourceMap` directly.
 */
const GUARD_PLUGIN = 'chrome-reflect-guard'

/**
 * Mint one guard notice. The single construction point for every
 * model-visible message this plugin injects: the `notice` form and summary
 * ride the source, so a missing label cannot reach a request.
 * @param summary - one-line account shown on the collapsed transcript row.
 * @param text - the model-facing notice body.
 * @returns a fresh user message labeled `chrome-reflect-guard`.
 */
export function reflectNotice(summary: string, text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: GUARD_PLUGIN,
      form: 'notice',
      summary: boundContextSummary(summary),
    },
  })
}

/** Route change for a selector/index that no longer matches the page. */
const SELECTOR_ADVICE
  = '不要原样重试同一选择器：先重新 page_snapshot 获取当前页面结构，再换用新的元素 index 或 selector。'

/** Route change for a permission or approval denial. */
const PERMISSION_ADVICE
  = '该路径被权限或审批拦下：改走只读路径取证，或通过 ask_user_question 向用户说明并征询，而不是重复同一调用。'

/** Route change for a navigation failure or wait timeout. */
const NAVIGATION_ADVICE
  = '先检查标签页与页面状态（tabs_list / page_snapshot 确认是否仍在加载或已跳转），而不是原样重试导航或等待。'

/** Route change when the failure family is unclassified. */
const GENERAL_ADVICE = '换一条路径推进：先用只读工具核实现场，再选择不同的工具或参数。'

/**
 * Deterministic route change for one tool failure, classified from its
 * canonical error surface (code when present, else stable message markers —
 * the browser tools throw plain `Error`s whose text is the only signal).
 * @param code - the failure's structured code, when the pipeline carried one.
 * @param message - the failure's model-facing message.
 * @returns the advice sentence for the notice.
 */
export function failureAdvice(code: string | undefined, message: string): string {
  if (code === 'UNKNOWN_TOOL') return PERMISSION_ADVICE
  if (/(?:需要用户审批|用户拒绝|审批请求已被取消|没有可用的审批通道|已被阻止|the user rejected tool)/u.test(message)) {
    return PERMISSION_ADVICE
  }
  if (message.includes('快照已过期') || (message.includes('selector') && /(?:未匹配|找不到)/u.test(message))) {
    return SELECTOR_ADVICE
  }
  if (/(?:超时|timeout)/iu.test(message)) return NAVIGATION_ADVICE
  return GENERAL_ADVICE
}

/**
 * Assemble the consecutive-failure notice body: tool name, run length,
 * latest error code, and the deterministic route change.
 * @param toolName - the tool whose failure run is being reflected on.
 * @param count - the consecutive-failure count that hit the threshold.
 * @param code - the latest failure's structured code (or its stand-in).
 * @param advice - the route change from {@link failureAdvice}.
 * @returns the model-facing notice text.
 */
export function consecutiveFailureNotice(toolName: string, count: number, code: string, advice: string): string {
  return `工具 "${toolName}" 已连续失败 ${String(count)} 次（最近错误 code: ${code}）。${advice}`
}

/** The round identity a goal-source message carries (tool-goal's authority shape). */
export interface GoalRoundSource {
  /** Exact goal identity. */
  readonly goalId: string
  /** Exact goal revision. */
  readonly revision: number
  /** The admitted round the message opens. */
  readonly round: number
}

/** The fields of a current goal view the round match reads. */
export interface CurrentGoalRef {
  /** Exact goal identity. */
  readonly id: string
  /** Exact goal revision. */
  readonly revision: number
  /** Highest admitted round number. */
  readonly roundsStarted: number
}

/**
 * Whether one goal-source message opens the current goal's exact round — the
 * source match of `tool-goal/src/authority.ts`'s `isMatchingGoalRound`.
 * @param source - the goal-source identity from the turn's user/message event.
 * @param goal - the live goal view at the check point.
 * @returns whether the turn is the goal's current round.
 */
export function matchesCurrentGoalRound(source: GoalRoundSource, goal: CurrentGoalRef): boolean {
  return source.goalId === goal.id
    && source.revision === goal.revision
    && source.round === goal.roundsStarted
}

/**
 * Incremental fold of one open turn's events, fed from delivered
 * `session/event`s and read at the turn-stopping boundary. `turn/start`
 * resets it, so the fold always holds exactly the open turn's evidence;
 * resume replays self-correct through the same reset.
 */
export class TurnFold {
  private goalRoundSources: GoalRoundSource[] = []
  private sawAssistantMessage = false
  private toolCallCount = 0
  private erroredResultCount = 0
  private latestErrorCode: string | undefined
  private readonly changeCallIds = new Set<string>()
  private changeSuccessCount = 0

  /** Fold one delivered event; merge-extensible event kinds fall through untouched. */
  onEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start':
        this.goalRoundSources = []
        this.sawAssistantMessage = false
        this.toolCallCount = 0
        this.erroredResultCount = 0
        this.latestErrorCode = undefined
        this.changeCallIds.clear()
        this.changeSuccessCount = 0
        break
      case 'user/message':
        if (event.data.source.kind === 'goal') {
          this.goalRoundSources.push({
            goalId: event.data.source.goalId,
            revision: event.data.source.revision,
            round: event.data.source.round,
          })
        }
        break
      case 'assistant/message':
        this.sawAssistantMessage = true
        break
      case 'tool/call':
        this.toolCallCount += 1
        if (CHANGE_TOOLS.has(event.data.name)) this.changeCallIds.add(event.data.callId)
        break
      case 'tool/result': {
        const block = event.data.message.content[0]
        if (block === undefined) break
        if (block.isError === true) {
          this.erroredResultCount += 1
          this.latestErrorCode = event.data.error?.code
        } else if (this.changeCallIds.has(block.toolCallId)) {
          this.changeSuccessCount += 1
        }
        break
      }
      default:
        break
    }
  }

  /** Whether the open turn is the goal's exact current round (any of its goal-source messages). */
  matchesCurrentGoalRound(goal: CurrentGoalRef): boolean {
    return this.goalRoundSources.some(source => matchesCurrentGoalRound(source, goal))
  }

  /** Whether any tool result in the open turn errored. */
  hasErroredResults(): boolean {
    return this.erroredResultCount > 0
  }

  /** How many tool results in the open turn errored. */
  erroredResults(): number {
    return this.erroredResultCount
  }

  /** The latest errored result's structured code, when the pipeline carried one. */
  latestResultErrorCode(): string | undefined {
    return this.latestErrorCode
  }

  /**
   * Whether the open turn called change-class tools without a single one
   * succeeding — the change class is the shared `CHANGE_TOOLS` vocabulary.
   */
  changedWithoutSuccess(): boolean {
    return this.changeCallIds.size > 0 && this.changeSuccessCount === 0
  }

  /** Whether the model spoke through the open turn without calling any tool. */
  isZeroAction(): boolean {
    return this.toolCallCount === 0 && this.sawAssistantMessage
  }
}

/**
 * Per-agent consecutive-failure chains keyed by tool name. Any successful
 * tool result resets the agent's whole chain; a user interjection resets it
 * through {@link reset}. Cancellation results (the canonical abort codes)
 * are transparent: they neither count nor reset. Threshold hits mint the
 * reflection notice through {@link reflectNotice}.
 */
export class FailureChains {
  private readonly chains = new WeakMap<Agent, Map<string, number>>()

  /**
   * Advance one agent's chain for a settled call and mint the threshold
   * notice when the run length hits one.
   * @param agent - the calling agent (agent-less calls are ignored).
   * @param toolName - the called tool's name.
   * @param isError - whether the call settled as an error.
   * @param code - the failure's structured code, when carried.
   * @param message - the failure's model-facing message, for classification.
   * @param thresholds - the counts that trigger a notice.
   * @returns the notice for this attempt, or undefined outside thresholds.
   */
  observe(
    agent: Agent | undefined,
    toolName: string,
    isError: boolean,
    code: string | undefined,
    message: string,
    thresholds: ReadonlySet<number>,
  ): UserMessage | undefined {
    if (agent === undefined) return undefined
    if (code !== undefined && ABORT_CODES.has(code)) return undefined
    if (!isError) {
      this.chains.delete(agent)
      return undefined
    }
    let perTool = this.chains.get(agent)
    if (perTool === undefined) {
      perTool = new Map<string, number>()
      this.chains.set(agent, perTool)
    }
    const count = (perTool.get(toolName) ?? 0) + 1
    perTool.set(toolName, count)
    if (!thresholds.has(count)) return undefined
    const text = consecutiveFailureNotice(toolName, count, code ?? 'UNKNOWN', failureAdvice(code, message))
    return reflectNotice(`${toolName} 连续失败 ${String(count)} 次`, text)
  }

  /** Reset one agent's whole chain (a user interjection changed the context). */
  reset(agent: Agent): void {
    this.chains.delete(agent)
  }
}

/** Round keys the spend ledger retains before pruning the oldest — a bound, not a policy. */
const MAX_TRACKED_ROUND_KEYS = 16

/**
 * Steer spend ledger keyed by goal round. Each key admits at most `budget`
 * spends; further spends report exhaustion so the caller lets the turn close.
 */
export class SteerBudgets {
  private readonly spent = new Map<string, number>()

  /**
   * Spend one steer against a round's budget.
   * @param key - the goal-round key.
   * @param budget - the round's steer budget.
   * @returns whether the spend was admitted.
   */
  trySpend(key: string, budget: number): boolean {
    const used = this.spent.get(key) ?? 0
    if (used >= budget) return false
    this.spent.set(key, used + 1)
    if (this.spent.size > MAX_TRACKED_ROUND_KEYS) {
      const oldest = this.spent.keys().next().value
      if (oldest !== undefined) this.spent.delete(oldest)
    }
    return true
  }
}

/** Wrap-up text: errored tool results contradict the goal's completion claim. */
function incompleteErrorText(count: number, code: string): string {
  return `本回合存在 ${String(count)} 个失败的工具调用（最近错误 code: ${code}）。`
    + '对照当前目标，先修复或换路重试失败的部分，再收尾汇报。'
}

/** Wrap-up text: change-class calls without one success cannot complete the goal. */
const CHANGE_WITHOUT_SUCCESS_TEXT
  = '本回合执行了变更类操作但没有任何成功结果，尚不能宣告目标完成。'
    + '请完成一次成功的变更，或如实报告当前进度与阻碍。'

/** Wrap-up text: the turn acted on nothing and still closed. */
const ZERO_ACTION_TEXT
  = '本回合没有调用任何工具就准备收尾。请先用工具核实或推进（如 page_snapshot 查看现场、执行下一步操作），'
    + '或如实说明剩余阻碍，再做总结。'

/**
 * The wrap-up notice one matched goal round earns, if any: errored results
 * first, then the change-without-success completion, then the zero-action
 * nudge. At most one notice per closing — the loop re-runs the boundary after
 * a steer, so the next closing re-evaluates against fresh evidence.
 * @param fold - the open turn's evidence fold.
 * @returns the notice to steer, or undefined when the turn may close.
 */
export function goalRoundSteer(fold: TurnFold): UserMessage | undefined {
  if (fold.hasErroredResults()) {
    const parts = [incompleteErrorText(fold.erroredResults(), fold.latestResultErrorCode() ?? 'UNKNOWN')]
    if (fold.changedWithoutSuccess()) parts.push(CHANGE_WITHOUT_SUCCESS_TEXT)
    return reflectNotice('goal 回合收尾前发现失败的工具结果', parts.join('\n'))
  }
  if (fold.changedWithoutSuccess()) {
    return reflectNotice('goal 回合变更类调用零成功结果', CHANGE_WITHOUT_SUCCESS_TEXT)
  }
  if (fold.isZeroAction()) {
    return reflectNotice('goal 回合零行动就收尾', ZERO_ACTION_TEXT)
  }
  return undefined
}

/**
 * Budget key of one goal round.
 * @param goal - the live goal view the round runs under.
 * @returns the ledger key naming the exact goal revision round.
 */
export function goalRoundBudgetKey(goal: CurrentGoalRef): string {
  return `${goal.id}:${String(goal.revision)}:${String(goal.roundsStarted)}`
}

/**
 * Validate `failThresholds` per the fail-loud contract (non-empty, integer,
 * ≥ 2, duplicate-free).
 * @param values - the configured thresholds.
 * @returns the validated list.
 */
function validateFailThresholds(values: number[]): number[] {
  if (values.length === 0) {
    throw new Error('chrome-reflect-guard: `failThresholds` must not be empty')
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(`chrome-reflect-guard: invalid threshold ${String(value)} — every threshold must be an integer >= 2`)
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error('chrome-reflect-guard: `failThresholds` must not contain duplicates')
  }
  return values
}

/**
 * Whether plan mode is in force for one agent: the committed `plan/mode`
 * state, or a pending selection awaiting the next accepted pre-step (the
 * same read chrome-tool-gate makes, through the planMode service).
 * @param ctx - the composed engine context carrying the plan-mode service.
 * @param agent - the agent whose session state applies.
 * @returns whether steering nudges are exempt right now.
 */
function planModeInForce(ctx: Context, agent: Agent): boolean {
  const state = ctx.planMode.get(agent)
  return state.active || state.pending === true
}

/** Prepend the guard's notice while preserving every downstream context's source and metadata. */
function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
  return [ours, ...theirs ?? []]
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - schema-validated {@link Config}; thresholds and budget are
 *   re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const failThresholds = validateFailThresholds(config.failThresholds as number[])
  const thresholdSet = new Set(failThresholds)
  const steerBudget = config.steerBudget as number
  if (!Number.isInteger(steerBudget) || steerBudget < 1) {
    throw new Error(`chrome-reflect-guard: invalid steerBudget ${String(steerBudget)} — must be an integer >= 1`)
  }
  const nudgeIdleActionTurns = config.nudgeIdleActionTurns as boolean

  const folds = new WeakMap<Session, TurnFold>()
  const failChains = new FailureChains()
  const budgets = new SteerBudgets()
  const idleStreaks = new WeakMap<Agent, number>()

  /** Get-or-create the open turn's fold for one session. */
  function foldFor(session: Session): TurnFold {
    let fold = folds.get(session)
    if (fold === undefined) {
      fold = new TurnFold()
      folds.set(session, fold)
    }
    return fold
  }

  // Maintain every open turn's evidence incrementally from delivered events;
  // the turn-stopping checks read this fold instead of scanning history.
  ctx.on('session/event', (session, event) => {
    foldFor(session).onEvent(event)
  })

  // ① Observe-and-enrich, never veto: the failure chain advances, the
  // decision DELEGATES, and the threshold notice folds onto whatever came
  // back — additionalContexts rides both decision variants, so a blocked
  // call still carries the reflection.
  ctx.on('tools/post-execute', async (exec: ToolExecution, result: ToolExecutionResult, next): Promise<PostToolDecision> => {
    const error = result.isError ? result.error : undefined
    const notice = failChains.observe(
      exec.agent,
      exec.name,
      result.isError,
      error?.info?.code,
      error?.message ?? '',
      thresholdSet,
    )
    const downstream = await next()
    if (!notice) return downstream
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: prependContext(notice, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(notice, downstream.additionalContexts),
    }
  })

  // A user interjection changes the context: failure chains and idle streaks
  // reset. Pure reset hook — always delegates.
  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) {
      failChains.reset(agent)
      idleStreaks.delete(agent)
    }
    return next()
  })

  // ②③ Wrap-up boundary: completeness against the matched goal round, then
  // the zero-action faces. Plan mode exempts every steering nudge; an
  // aborted turn steers nothing.
  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    if (signal.aborted) return
    if (planModeInForce(ctx, agent)) return
    const fold = folds.get(agent.session)
    if (fold === undefined) return
    const goal: GoalView | undefined = ctx.goals.get(agent)
    if (goal !== undefined && goal.phase === 'active' && goal.activation === 'armed'
      && fold.matchesCurrentGoalRound(goal)) {
      const notice = goalRoundSteer(fold)
      if (notice === undefined) return
      const key = goalRoundBudgetKey(goal)
      if (budgets.trySpend(key, steerBudget)) {
        agent.steer(notice)
      } else {
        console.warn(`[chrome-reflect-guard] goal 轮次 steer 预算（${String(steerBudget)}）已用尽，放行收尾：${key}`)
      }
      return
    }
    // Action-session face: explicit opt-in, bounded by the same budget as a
    // consecutive streak per agent; tool use or user interjection resets it.
    if (!nudgeIdleActionTurns) return
    if (!fold.isZeroAction()) {
      idleStreaks.delete(agent)
      return
    }
    const spent = idleStreaks.get(agent) ?? 0
    if (spent >= steerBudget) {
      console.warn(`[chrome-reflect-guard] 行动会话零行动提示预算（${String(steerBudget)}）已用尽，放行收尾：agent ${agent.id}`)
      return
    }
    idleStreaks.set(agent, spent + 1)
    agent.steer(reflectNotice('回合零行动就收尾', ZERO_ACTION_TEXT))
  })
}
