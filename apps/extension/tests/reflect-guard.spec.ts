/**
 * Pure-guard spec for `chrome-reflect-guard`: consecutive-failure chains,
 * goal-round wrap-up completeness, zero-action detection, and the notice
 * source shape. All exercised on the guard's pure pieces (`TurnFold`,
 * `FailureChains`, `SteerBudgets`, the advice table) without a composed
 * engine — the composed wiring is pinned by composition.spec.ts's activation
 * sweep over the chrome-reflect-guard row.
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CHANGE_TOOLS } from '../src/shared/danger-tools.ts'
import {
  FailureChains,
  SteerBudgets,
  TurnFold,
  consecutiveFailureNotice,
  failureAdvice,
  goalRoundBudgetKey,
  goalRoundSteer,
  matchesCurrentGoalRound,
  reflectNotice,
} from '../src/offscreen/reflect-guard.ts'

let seq = 0

/** Mint one synthetic delivered event for the fold (only type and data are read). */
function feed(fold: TurnFold, type: string, data: unknown): void {
  seq += 1
  fold.onEvent({ type, seq, time: 0, data } as unknown as SessionEvent)
}

/** One live agent stand-in (only a WeakMap key to the chains). */
const agent = { id: 'agent-1' } as unknown as Agent
const otherAgent = { id: 'agent-2' } as unknown as Agent

/** The armed active goal whose current round owns the tested turns. */
const GOAL = { id: 'goal-1', revision: 3, roundsStarted: 2 }

/** The goal-source message that opens GOAL's current round. */
const GOAL_ROUND_MESSAGE = {
  id: 'm1',
  role: 'user',
  content: [{ type: 'text', text: 'round' }],
  source: { kind: 'goal', goalId: GOAL.id, revision: GOAL.revision, round: GOAL.roundsStarted },
}

function newFold(): TurnFold {
  return new TurnFold()
}

describe('reflectNotice（注入来源形状）', () => {
  it('每条注入都带 plugin 来源与 notice 形态标记，正文为单个文本块', () => {
    const notice = reflectNotice('概要', '正文')
    expect(notice.role).toBe('user')
    expect(notice.source).toMatchObject({
      kind: 'plugin',
      plugin: 'chrome-reflect-guard',
      form: 'notice',
      summary: '概要',
    })
    expect(notice.content).toHaveLength(1)
    expect(notice.content[0]).toMatchObject({ type: 'text', text: '正文' })
  })

  it('超长概要被收敛到折叠行上限内', () => {
    const notice = reflectNotice('长'.repeat(200), '正文')
    expect((notice.source as { summary: string }).summary.length).toBeLessThanOrEqual(120)
  })
})

describe('failureAdvice（确定性换路建议）', () => {
  it('选择器/快照 miss → 重新 page_snapshot 换选择器', () => {
    const advice = failureAdvice(undefined, 'page_extract_text：selector "div.x" 未匹配到任何元素')
    expect(advice).toContain('page_snapshot')
    expect(advice).toContain('重试')
    const stale = failureAdvice(undefined, 'page_click：index 5 定位失败，快照已过期')
    expect(stale).toContain('page_snapshot')
    expect(stale).toBe(advice)
  })

  it('权限/审批 deny → 换只读路径或 ask_user', () => {
    for (const message of [
      '工具 "page_click" 需要用户审批，但当前没有可用的审批通道',
      '用户拒绝了工具 "page_click" 的本次执行',
      '计划模式：工具 "write" 会产生变更，已被阻止。请先用 exit_plan_mode 提交计划',
    ]) {
      const advice = failureAdvice(undefined, message)
      expect(advice).toContain('只读')
      expect(advice).toContain('ask_user_question')
    }
    expect(failureAdvice('UNKNOWN_TOOL', 'unknown tool "nope"')).toContain('只读')
  })

  it('导航/超时 → 检查标签页状态而非原样重试', () => {
    for (const message of [
      '浏览器操作超时（30 秒）：page_navigate',
      'page_wait_for：等待元素出现超时（timeout 5000ms）',
    ]) {
      const advice = failureAdvice(undefined, message)
      expect(advice).toContain('标签页')
      expect(advice).not.toContain('page_snapshot 获取当前页面结构，再换用')
    }
  })

  it('未归类失败走通用换路建议', () => {
    expect(failureAdvice(undefined, 'boom')).toContain('换一条路径')
  })
})

describe('consecutiveFailureNotice（连败反思文本）', () => {
  it('含工具名、连败次数、最近 error code 与换路建议', () => {
    const advice = failureAdvice('E_TIMEOUT', '浏览器操作超时（30 秒）：page_navigate')
    const text = consecutiveFailureNotice('page_navigate', 2, 'E_TIMEOUT', advice)
    expect(text).toContain('page_navigate')
    expect(text).toContain('2')
    expect(text).toContain('E_TIMEOUT')
    expect(text).toContain(advice)
  })
})

describe('FailureChains（连败链）', () => {
  const thresholds = new Set([2, 4])

  it('按 (agent, 工具名) 计数，[2,4] 触发，阈值外零注入', () => {
    const chains = new FailureChains()
    const first = chains.observe(agent, 'page_click', true, 'E_NOEL', 'selector "a" 未匹配到任何元素', thresholds)
    expect(first).toBeUndefined()
    const second = chains.observe(agent, 'page_click', true, 'E_NOEL', 'selector "a" 未匹配到任何元素', thresholds)
    expect(second).toBeDefined()
    expect(second?.content[0]).toMatchObject({ type: 'text' })
    const third = chains.observe(agent, 'page_click', true, 'E_NOEL', 'selector "a" 未匹配到任何元素', thresholds)
    expect(third).toBeUndefined()
    const fourth = chains.observe(agent, 'page_click', true, 'E_NOEL', 'selector "a" 未匹配到任何元素', thresholds)
    expect(fourth).toBeDefined()
    const fifth = chains.observe(agent, 'page_click', true, 'E_NOEL', 'selector "a" 未匹配到任何元素', thresholds)
    expect(fifth).toBeUndefined()
  })

  it('不同工具各自成链，互不合并', () => {
    const chains = new FailureChains()
    chains.observe(agent, 'page_click', true, 'E', 'e1', thresholds)
    const otherTool = chains.observe(agent, 'page_navigate', true, 'E', 'e2', thresholds)
    expect(otherTool).toBeUndefined()
  })

  it('不同 agent 各自成链，互不渗透', () => {
    const chains = new FailureChains()
    chains.observe(agent, 'page_click', true, 'E', 'e1', thresholds)
    const other = chains.observe(otherAgent, 'page_click', true, 'E', 'e1', thresholds)
    expect(other).toBeUndefined()
  })

  it('任一工具成功即重置该 agent 的整条链', () => {
    const chains = new FailureChains()
    chains.observe(agent, 'page_click', true, 'E', 'e1', thresholds)
    chains.observe(agent, 'page_navigate', true, 'E', 'e2', thresholds)
    expect(chains.observe(agent, 'read', false, undefined, '', thresholds)).toBeUndefined()
    expect(chains.observe(agent, 'page_click', true, 'E', 'e1', thresholds)).toBeUndefined()
  })

  it('用户插话重置（reset 后从 1 重新计数）', () => {
    const chains = new FailureChains()
    chains.observe(agent, 'page_click', true, 'E', 'e1', thresholds)
    chains.reset(agent)
    expect(chains.observe(agent, 'page_click', true, 'E', 'e1', thresholds)).toBeUndefined()
  })

  it('取消（ABORTED）不计入失败也不重置', () => {
    const chains = new FailureChains()
    expect(chains.observe(agent, 'page_click', true, 'ABORTED', 'aborted', thresholds)).toBeUndefined()
    expect(chains.observe(agent, 'page_click', true, 'ABORTED_BEFORE_DISPATCH', 'aborted', thresholds)).toBeUndefined()
    expect(chains.observe(agent, 'page_click', true, 'E', 'e1', thresholds)).toBeUndefined()
    const second = chains.observe(agent, 'page_click', true, 'E', 'e1', thresholds)
    expect(second).toBeDefined()
  })

  it('无 agent 的调用不参与计数', () => {
    const chains = new FailureChains()
    expect(chains.observe(undefined, 'page_click', true, 'E', 'e1', thresholds)).toBeUndefined()
  })

  it('无 code 的失败以 UNKNOWN 占位并按 message 分类', () => {
    const chains = new FailureChains()
    chains.observe(agent, 'page_click', true, undefined, 'e1', thresholds)
    const notice = chains.observe(agent, 'page_click', true, undefined, '工具 "page_click" 需要用户审批', thresholds)
    expect(notice).toBeDefined()
    const text = (notice!.content[0] as { type: string; text: string }).text
    expect(text).toContain('UNKNOWN')
    expect(text).toContain('只读')
  })
})

describe('matchesCurrentGoalRound（goal 轮次来源匹配）', () => {
  it('id+revision+round 与当前 goal 视图全等才算匹配', () => {
    expect(matchesCurrentGoalRound({ goalId: 'goal-1', revision: 3, round: 2 }, GOAL)).toBe(true)
    expect(matchesCurrentGoalRound({ goalId: 'goal-1', revision: 3, round: 3 }, GOAL)).toBe(false)
    expect(matchesCurrentGoalRound({ goalId: 'goal-1', revision: 4, round: 2 }, GOAL)).toBe(false)
    expect(matchesCurrentGoalRound({ goalId: 'goal-9', revision: 3, round: 2 }, GOAL)).toBe(false)
  })
})

describe('TurnFold（回合证据折叠）', () => {
  it('turn/start 重置折叠', () => {
    const fold = newFold()
    feed(fold, 'user/message', GOAL_ROUND_MESSAGE)
    feed(fold, 'assistant/message', { turn: 1, step: 1, message: {}, stream: [] })
    feed(fold, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{}' })
    feed(fold, 'tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true }] },
      error: { name: 'Error', code: 'E_WRITE' },
    })
    expect(fold.hasErroredResults()).toBe(true)
    feed(fold, 'turn/start', { turn: 2 })
    expect(fold.hasErroredResults()).toBe(false)
    expect(fold.erroredResults()).toBe(0)
    expect(fold.changedWithoutSuccess()).toBe(false)
    expect(fold.isZeroAction()).toBe(false)
    expect(fold.matchesCurrentGoalRound(GOAL)).toBe(false)
  })

  it('goal 来源消息命中当前轮次；非当前轮次不命中', () => {
    const fold = newFold()
    feed(fold, 'user/message', GOAL_ROUND_MESSAGE)
    expect(fold.matchesCurrentGoalRound(GOAL)).toBe(true)
    feed(fold, 'turn/start', { turn: 2 })
    feed(fold, 'user/message', {
      source: { kind: 'goal', goalId: GOAL.id, revision: GOAL.revision, round: GOAL.roundsStarted + 1 },
    })
    expect(fold.matchesCurrentGoalRound(GOAL)).toBe(false)
  })

  it('零行动 = 有模型发言且零 tool/call', () => {
    const fold = newFold()
    feed(fold, 'assistant/message', { turn: 1, step: 1, message: {}, stream: [] })
    expect(fold.isZeroAction()).toBe(true)
    feed(fold, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'page_snapshot', arguments: '{}' })
    expect(fold.isZeroAction()).toBe(false)
  })

  it('只记录失败的 tool/result（含最近 error code）', () => {
    const fold = newFold()
    feed(fold, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{}' })
    feed(fold, 'tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true }] },
      error: { name: 'Error', code: 'E_WRITE' },
    })
    feed(fold, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'page_scroll', arguments: '{}' })
    feed(fold, 'tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c2', isError: true }] },
    })
    expect(fold.erroredResults()).toBe(2)
    expect(fold.latestResultErrorCode()).toBeUndefined()
    expect(fold.hasErroredResults()).toBe(true)
  })

  it('变更类判定集合就是 danger-tools 的 CHANGE_TOOLS（无第二份词表）', () => {
    expect(CHANGE_TOOLS.has('write')).toBe(true)
    expect(CHANGE_TOOLS.has('page_navigate')).toBe(true)
    expect(CHANGE_TOOLS.has('read')).toBe(false)
    expect(CHANGE_TOOLS.has('page_snapshot')).toBe(false)

    const fold = newFold()
    feed(fold, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{}' })
    feed(fold, 'tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true }] },
    })
    expect(fold.changedWithoutSuccess()).toBe(true)
  })

  it('变更类调用按 callId 配对成功结果；只读调用成功不计入变更', () => {
    const fold = newFold()
    feed(fold, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{}' })
    feed(fold, 'tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true }] },
    })
    feed(fold, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'page_navigate', arguments: '{}' })
    feed(fold, 'tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c2', isError: false }] },
    })
    expect(fold.changedWithoutSuccess()).toBe(false)

    const readOnly = newFold()
    feed(readOnly, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' })
    feed(readOnly, 'tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true }] },
    })
    expect(readOnly.changedWithoutSuccess()).toBe(false)
  })
})

describe('goalRoundSteer（收尾完整性提示）', () => {
  it('回合内存在 isError 结果 → steer 一条 notice，文本含失败与 code', () => {
    const fold = newFold()
    feed(fold, 'user/message', GOAL_ROUND_MESSAGE)
    feed(fold, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'page_click', arguments: '{}' })
    feed(fold, 'tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true }] },
      error: { name: 'Error', code: 'E_CLICK' },
    })
    const notice = goalRoundSteer(fold)
    expect(notice).toBeDefined()
    const text = (notice!.content[0] as { type: string; text: string }).text
    expect(text).toContain('1')
    expect(text).toContain('E_CLICK')
  })

  it('失败 + 变更类零成功 → 单条 notice 同时覆盖两件事', () => {
    const fold = newFold()
    feed(fold, 'user/message', GOAL_ROUND_MESSAGE)
    feed(fold, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{}' })
    feed(fold, 'tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true }] },
    })
    const notice = goalRoundSteer(fold)
    expect(notice).toBeDefined()
    const text = (notice!.content[0] as { type: string; text: string }).text
    expect(text).toContain('失败的工具调用')
    expect(text).toContain('变更类')
  })

  it('变更类零成功并入完整性提示：失败文本 + 变更条款', () => {
    const fold = newFold()
    feed(fold, 'user/message', GOAL_ROUND_MESSAGE)
    feed(fold, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{}' })
    feed(fold, 'tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true }] },
    })
    const notice = goalRoundSteer(fold)
    expect(notice).toBeDefined()
    const text = (notice!.content[0] as { type: string; text: string }).text
    expect(text).toContain('失败的工具调用')
    expect(text).toContain('变更类')

    // 只读工具的失败只触发失败条款，不带变更条款。
    const readOnly = newFold()
    feed(readOnly, 'user/message', GOAL_ROUND_MESSAGE)
    feed(readOnly, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'page_click', arguments: '{}' })
    feed(readOnly, 'tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true }] },
    })
    const readOnlyNotice = goalRoundSteer(readOnly)
    expect(readOnlyNotice).toBeDefined()
    const readOnlyText = (readOnlyNotice!.content[0] as { type: string; text: string }).text
    expect(readOnlyText).toContain('失败的工具调用')
    expect(readOnlyText).not.toContain('变更类')
  })

  it('goal 轮次内零 tool/call → 必提示', () => {
    const fold = newFold()
    feed(fold, 'user/message', GOAL_ROUND_MESSAGE)
    feed(fold, 'assistant/message', { turn: 1, step: 1, message: {}, stream: [] })
    const notice = goalRoundSteer(fold)
    expect(notice).toBeDefined()
    const text = (notice!.content[0] as { type: string; text: string }).text
    expect(text).toContain('没有调用任何工具')
  })

  it('健康的回合（有成功推进、无失败）放行收尾', () => {
    const fold = newFold()
    feed(fold, 'user/message', GOAL_ROUND_MESSAGE)
    feed(fold, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'page_snapshot', arguments: '{}' })
    feed(fold, 'tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: false }] },
    })
    feed(fold, 'assistant/message', { turn: 1, step: 1, message: {}, stream: [] })
    expect(goalRoundSteer(fold)).toBeUndefined()
  })
})

describe('SteerBudgets（每 goal 轮次 steer 预算）', () => {
  it('预算内放行，耗尽后拒绝并放行收尾', () => {
    const budgets = new SteerBudgets()
    const key = goalRoundBudgetKey(GOAL)
    expect(budgets.trySpend(key, 2)).toBe(true)
    expect(budgets.trySpend(key, 2)).toBe(true)
    expect(budgets.trySpend(key, 2)).toBe(false)
  })

  it('不同 goal 轮次（id/revision/round 任一不同）预算独立', () => {
    const budgets = new SteerBudgets()
    expect(budgets.trySpend(goalRoundBudgetKey(GOAL), 1)).toBe(true)
    expect(budgets.trySpend(goalRoundBudgetKey(GOAL), 1)).toBe(false)
    expect(budgets.trySpend(goalRoundBudgetKey({ ...GOAL, roundsStarted: 3 }), 1)).toBe(true)
    expect(budgets.trySpend(goalRoundBudgetKey({ ...GOAL, revision: 4 }), 1)).toBe(true)
    expect(budgets.trySpend(goalRoundBudgetKey({ ...GOAL, id: 'goal-2' }), 1)).toBe(true)
  })
})
