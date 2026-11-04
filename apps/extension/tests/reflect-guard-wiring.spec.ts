/**
 * Wiring spec for `chrome-reflect-guard`: the composed behavior the pure
 * spec (reflect-guard.spec.ts) cannot pin. Boots the guard's real `apply`
 * over a minimal production composition — session store, projection
 * registry, agent registry, goal service, plan-mode controller, and the
 * tool runtime (the guard's whole `inject` list) — then drives a
 * registry-registered fake agent through the production seams:
 *
 * - `tools/post-execute` fires through the same Cordis waterfall the tool
 *   registry dispatches, with faithful exec/result pairs (the registry's
 *   decision contract, `next` defaulting to `accept`). Driving the full
 *   `tools.execute` pipeline end-to-end stays composition-level work; this
 *   spec pins the guard's listener behavior on the seam it subscribes to.
 * - `agent/pre-step` and `agent/turn-stopping` fire through `agentEvents`,
 *   the same fused dispatcher the loop driver uses.
 * - The turn fold is fed the way production feeds it: real published session
 *   appends (the loop writes exactly these shapes for claimed steers, tool
 *   calls, and tool results), so the projection registry advances honestly.
 *
 * No browser host and no LLM: the model-driven steps are replaced by direct
 * evidence.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, PreStepDecision } from '@deepseek-ai/dsh-agent'
// Type-only package export; the value reaches the source directly, by
// extensionful relative specifier.
import { turnBoundaryProjectionDefinition } from '../../../packages/core/agent/src/projection.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import GoalService from '@deepseek-ai/dsh-goal'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import * as reflectGuard from '../src/offscreen/reflect-guard.ts'

/** One shared never-aborted signal for tool dispatches. */
const SIGNAL = new AbortController().signal

/** Monotone call-id suffix so every appended failing call is distinct. */
let callSeq = 0

/** Contexts created by the current test's harness(es), disposed in afterEach. */
const liveContexts: Context[] = []

/** The registry's own default post-execute decision: accept unchanged. */
const acceptUnchanged = (): Promise<PostToolDecision> => Promise.resolve<PostToolDecision>({ kind: 'accept' })

/** A faithful failed result, shaped as the registry materializes tool errors. */
function failedResult(code: string, message: string): ToolExecutionResult {
  const content: ContentBlock[] = [{ type: 'text', text: message }]
  const failure = { isError: true as const, content, error: { message, info: { name: 'Error', code } } }
  return failure
}

/** A faithful successful result with a null canonical value. */
function okResult(): ToolExecutionResult {
  const content: ContentBlock[] = [{ type: 'text', text: 'ok' }]
  return { isError: false, content, value: null }
}

/**
 * Append the model-ordered failing call/result pair exactly as the loop
 * writes it for one failed browser call (matching callId, cited call seq,
 * the structured error info as the event's `error` field).
 */
function deliverErroredResult(session: Session, code: string): void {
  callSeq += 1
  const callId = ToolCallId('wiring-call-' + String(callSeq))
  const call = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name: 'page_click',
    arguments: '{}',
  })
  const message = createToolResultMessage({
    callId,
    content: [{ type: 'text', text: 'failed with ' + code }],
    isError: true,
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message,
    error: { name: 'Error', code },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}

/** Fire the post-execute waterfall with the dispatch shape the registry uses. */
async function postExecute(
  ctx: Context,
  agent: Agent,
  toolName: string,
  callId: string,
  result: ToolExecutionResult,
  inner: () => Promise<PostToolDecision> = acceptUnchanged,
): Promise<PostToolDecision> {
  const exec = {
    name: toolName,
    callId: ToolCallId(callId),
    rootCallId: ToolCallId(callId),
    arguments: {},
    signal: SIGNAL,
    agent,
    token: 'wiring-token',
  } as unknown as ToolExecution
  return await ctx.waterfall('tools/post-execute', exec, result, inner)
}

/** Fire the turn-stopping boundary the loop drives at every closing. */
async function turnStopping(ctx: Context, agent: Agent, signal: AbortSignal = SIGNAL): Promise<void> {
  await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal })
}

/** Fire the pre-step waterfall with `messages` and an enter-through default. */
async function preStep(ctx: Context, agent: Agent, messages: UserMessage[]): Promise<void> {
  const fallthrough = (): Promise<PreStepDecision> =>
    Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] })
  await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    // agentEvents binds the agent; modelSelection rides the payload. The spec
    // agent always names provider+model, so the controller's current route is
    // defined; the assertion keeps the payload type exact.
    { messages, turn: 1, step: 1, signal: SIGNAL, modelSelection: agent.model.current() as Readonly<ModelSelection> },
    fallthrough,
  )
}

/** The first text block of a notice, for content assertions. */
function noticeText(notice: UserMessage | undefined): string {
  const block = notice?.content[0]
  return block !== undefined && block.type === 'text' ? block.text : ''
}

/**
 * A registry-compatible agent stand-in: the exact fields the guard's
 * listeners read (id, session, steer) over no-op driver surface, mirroring
 * the domain-test stub shape goal.spec.ts registers.
 */
function fakeAgent(ctx: Context, session: Session, steer: (message: UserMessage) => void): Agent {
  const agent = {
    id: session.id,
    options: {},
    model: { current: (): Readonly<ModelSelection> => ({ provider: 'fixture', model: 'fixture-model' }) },
    session,
    inbox: {
      nextTurn: [],
      nextStep: [],
      add: (): void => {},
      push_front: (): void => {},
    },
    ctx,
    status: 'idle',
    cancel: (): void => {},
    whenIdle: (): Promise<void> => Promise.resolve(),
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(new AbortController().signal),
    send: (): void => {},
    followup: (): void => {},
    steer,
    inject: (): void => {},
  }
  return agent as unknown as Agent
}

/**
 * Boot the minimal real composition, load the guard row through its real
 * `apply`, and register one fake agent around a fresh published session.
 * Every test gets its own Context (own session store), so one literal id
 * stays unique. The context joins `liveContexts` for afterEach disposal.
 */
async function harness(): Promise<{
  ctx: Context
  agent: Agent
  session: Session
  steer: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  await ctx.plugin(PlanModeController, { section: 'wiring-spec plan-mode section' })
  // The row under test, loaded exactly as the offscreen composition loads it.
  await ctx.plugin(reflectGuard, { failThresholds: [2, 4], steerBudget: 2 })
  // The loop registers the turn-boundary projection in production; plan-mode's
  // open-turn read needs it for the pending path under test.
  void ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  const sessionId = SessionId('reflect-guard-wiring')
  const session = ctx.sessions.create(sessionId)
  const steer = vi.fn()
  await ctx.agents.register(fakeAgent(ctx, session, steer))
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('fake agent did not register')
  liveContexts.push(ctx)
  return { ctx, agent, session, steer }
}

/** Deliver the goal-source round opener and its open turn the way the loop writes a round. */
function armedGoalRound(ctx: Context, agent: Agent, session: Session): GoalView {
  const goal = ctx.goals.create(agent, { objective: 'wiring objective' })
  const roundSource = {
    kind: 'goal',
    goalId: goal.id,
    revision: goal.revision,
    round: 1,
  } as const
  const roundMessage = createUserMessage({
    content: [{ type: 'text', text: 'round' }],
    source: roundSource,
  })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', roundMessage, { surfaceOp: 'append' })
  return goal
}

/** Close the open turn so the plan-mode selection path commits immediately. */
function closeTurn(session: Session): void {
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

afterEach(async () => {
  for (const ctx of liveContexts.splice(0)) await ctx.fiber.dispose()
})

describe('chrome-reflect-guard 连败链（post-execute seam）', () => {
  it('失败-快照-失败：见证成功不清链，[2,4] 阈值触发 notice 并落 additionalContexts', async () => {
    const { ctx, agent } = await harness()
    const miss = 'page_click：selector "a" 未匹配到任何元素'

    const first = await postExecute(ctx, agent, 'page_click', 'c1', failedResult('E_NOEL', miss))
    expect(first.kind).toBe('accept')
    expect(first.additionalContexts).toBeUndefined()

    const snapshot = await postExecute(ctx, agent, 'page_snapshot', 'c2', okResult())
    expect(snapshot.additionalContexts).toBeUndefined()

    const second = await postExecute(ctx, agent, 'page_click', 'c3', failedResult('E_NOEL', miss))
    const notice = second.additionalContexts?.[0]
    expect(notice?.source).toMatchObject({ kind: 'reflect-guard', form: 'notice' })
    expect(noticeText(notice)).toContain('page_click')
    expect(noticeText(notice)).toContain('已连续失败 2 次')
    expect(noticeText(notice)).toContain('page_snapshot')
  })

  it('downstream 为 block 时，notice 前插到 block 决策的 additionalContexts，feedback 原样保留', async () => {
    const { ctx, agent } = await harness()
    const miss = 'page_click：selector "a" 未匹配到任何元素'
    const feedback: ContentBlock[] = [{ type: 'text', text: '拦截：现场已变化' }]
    const blockHere = (): Promise<PostToolDecision> =>
      Promise.resolve<PostToolDecision>({ kind: 'block', feedback })

    await postExecute(ctx, agent, 'page_click', 'b1', failedResult('E_NOEL', miss))
    const second = await postExecute(ctx, agent, 'page_click', 'b2', failedResult('E_NOEL', miss), blockHere)
    if (second.kind !== 'block') throw new Error('expected a block decision')
    expect(second.feedback).toEqual(feedback)
    expect(second.additionalContexts?.[0]?.source).toMatchObject({ kind: 'reflect-guard' })
  })

  it('agent/pre-step 只按 kind=user 的消息重置连败链', async () => {
    const { ctx, agent } = await harness()
    const miss = 'page_click：selector "a" 未匹配到任何元素'

    await postExecute(ctx, agent, 'page_click', 'p1', failedResult('E_NOEL', miss))
    // A plugin-source message (this guard's own notice shape) must NOT reset.
    await preStep(ctx, agent, [reflectGuard.reflectNotice('概要', '正文')])
    const second = await postExecute(ctx, agent, 'page_click', 'p2', failedResult('E_NOEL', miss))
    expect(second.additionalContexts?.[0]?.source).toMatchObject({ kind: 'reflect-guard' })

    // A user interjection resets the whole chain.
    await preStep(ctx, agent, [createUserMessage({
      content: [{ type: 'text', text: '换任务' }],
      source: { kind: 'user' },
    })])
    const third = await postExecute(ctx, agent, 'page_click', 'p3', failedResult('E_NOEL', miss))
    expect(third.additionalContexts).toBeUndefined()
  })
})

describe('chrome-reflect-guard 收尾边界（真实 turn-stopping seam）', () => {
  it('plan mode active：收尾豁免，不 steer', async () => {
    const { ctx, agent, session, steer } = await harness()
    armedGoalRound(ctx, agent, session)
    deliverErroredResult(session, 'E_CLICK')
    closeTurn(session)
    expect(ctx.planMode.set(agent, true)).toBe('committed')
    expect(ctx.planMode.get(agent)).toMatchObject({ active: true })

    await turnStopping(ctx, agent)
    expect(steer).not.toHaveBeenCalled()
  })

  it('plan mode pending（等待下一步生效）：同样豁免', async () => {
    const { ctx, agent, session, steer } = await harness()
    armedGoalRound(ctx, agent, session)
    deliverErroredResult(session, 'E_CLICK')
    // The turn delivered by armedGoalRound is still open, so the selection parks.
    expect(ctx.planMode.set(agent, true)).toBe('queued')
    expect(ctx.planMode.get(agent)).toMatchObject({ active: false, pending: true })

    await turnStopping(ctx, agent)
    expect(steer).not.toHaveBeenCalled()
  })

  it('signal.aborted：收尾短路，不 steer；信号健康后同证据照常 steer', async () => {
    const { ctx, agent, session, steer } = await harness()
    armedGoalRound(ctx, agent, session)
    deliverErroredResult(session, 'E_CLICK')

    const aborted = new AbortController()
    aborted.abort()
    await turnStopping(ctx, agent, aborted.signal)
    expect(steer).not.toHaveBeenCalled()

    await turnStopping(ctx, agent)
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it('同一错误证据只 steer 一次：回灌的 notice 抑制重复，预算留给新证据', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, agent, session, steer } = await harness()
    armedGoalRound(ctx, agent, session)

    deliverErroredResult(session, 'E_CLICK')
    await turnStopping(ctx, agent)
    expect(steer).toHaveBeenCalledTimes(1)
    const notice = steer.mock.calls[0]?.[0] as UserMessage

    // The loop claims the steer back into the log as a plugin-source message;
    // replaying it into the fold is exactly what the next boundary reads.
    session.append('user/message', notice, { surfaceOp: 'append' })
    await turnStopping(ctx, agent)
    expect(steer).toHaveBeenCalledTimes(1)

    // A different error code is new evidence: its steer succeeds because the
    // duplicate attempt did not burn budget.
    deliverErroredResult(session, 'E_TIMEOUT')
    await turnStopping(ctx, agent)
    expect(steer).toHaveBeenCalledTimes(2)
    expect(noticeText(steer.mock.calls[1]?.[0] as UserMessage | undefined)).toContain('E_TIMEOUT')

    // With the budget now genuinely exhausted, the next distinct evidence warns.
    deliverErroredResult(session, 'E_DENY')
    await turnStopping(ctx, agent)
    expect(steer).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it('预算耗尽的第 3 次收尾仅 console.warn 放行', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, agent, session, steer } = await harness()
    armedGoalRound(ctx, agent, session)

    for (const code of ['E_ONE', 'E_TWO', 'E_THREE']) {
      deliverErroredResult(session, code)
      await turnStopping(ctx, agent)
    }
    expect(steer).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('预算')
    warnSpy.mockRestore()
  })
})

describe('SteerBudgets 回合键剪枝', () => {
  it('MAX_TRACKED_ROUND_KEYS=16：第 17 个 key 挤掉最旧的账目', () => {
    const budgets = new reflectGuard.SteerBudgets()
    const keyOf = (index: number): string => String(index).padStart(2, '0')
    for (let index = 1; index <= 16; index += 1) {
      expect(budgets.trySpend(keyOf(index), 1)).toBe(true)
    }
    // Insertion succeeds and evicts the oldest entry ('01').
    expect(budgets.trySpend(keyOf(17), 1)).toBe(true)
    // '01' is no longer tracked: a fresh spend is admitted...
    expect(budgets.trySpend(keyOf(1), 1)).toBe(true)
    // ...while the still-tracked '17' stays exhausted.
    expect(budgets.trySpend(keyOf(17), 1)).toBe(false)
  })
})
