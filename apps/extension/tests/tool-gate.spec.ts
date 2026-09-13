/**
 * chrome-tool-gate spec: boots the REAL dsh-tools registry, the REAL
 * dsh-user-approval service, and the gate plugin (`chrome-tool-gate`), then
 * drives tool executions exactly the way the agent loop's scheduler does —
 * `ctx.tools.execute` with an agent-owned session inside an open turn.
 *
 * Asserts the gate's two behaviors at the seam: a gated `page_evaluate` call
 * appends the `approval/asked` + `approval/decided` audit pair to the calling
 * session before any body runs, and the closed outcome maps onto the pre-execute
 * decision (`rejected`/`unavailable` deny fail-closed, `allowed-once` runs the
 * body once); non-gated tools and agent-less gated calls never reach the
 * approval seam. The answerer is a stub on the `approval/request` waterfall —
 * the SidePanel bridge's role — so no UI is under test here.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import * as chromeToolGate from '../src/offscreen/chrome-tool-gate.ts'

/**
 * The minimal agent stand-in the seam actually touches: `agent.session`.
 * `permission/mode` events ride the plugin-merged event map (declared by the
 * gate's `permission-mode` module, pulled into this program by the import).
 */
function mountedAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return { session } as unknown as Agent
}

/** Body-run counters the assertions read to prove denial happens before dispatch. */
const bodyRuns = { evaluate: 0, snapshot: 0, write: 0, click: 0 }

async function bootGate(): Promise<Context> {
  bodyRuns.evaluate = 0
  bodyRuns.snapshot = 0
  bodyRuns.write = 0
  bodyRuns.click = 0
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService)
  // The agent loop registers the turnBoundary projection plan mode reads; it
  // needs the llm runtime and the agent registry beside it.
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(AgentLoop, { agents: [] })
  // The gate reads plan state through the plan-mode service (committed fold +
  // pending selections), so the service must be composed before the gate.
  await ctx.plugin(PlanMode, { section: '计划模式测试指导' })
  chromeToolGate.apply(ctx)
  await ctx.plugin(chromeToolGate)
  ctx.tools.register(defineTool({
    name: 'page_evaluate',
    description: 'stub: 在页面上下文中执行脚本',
    parameters: { function: { type: 'string', required: true, description: '脚本源码' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ran: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.ran }],
    },
    async execute() {
      bodyRuns.evaluate += 1
      return { ran: 'page_evaluate' }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'page_snapshot',
    description: 'stub: 非受闸工具',
    parameters: { tab_id: { type: 'integer', required: true, description: '标签页 id' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ran: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.ran }],
    },
    async execute() {
      bodyRuns.snapshot += 1
      return { ran: 'page_snapshot' }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'write',
    description: 'stub: 创建或覆盖文件',
    parameters: { path: { type: 'string', required: true, description: '路径' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ran: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.ran }],
    },
    async execute() {
      bodyRuns.write += 1
      return { ran: 'write' }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'page_click',
    description: 'stub: 点击页面元素',
    parameters: { selector: { type: 'string', required: true, description: '元素选择器' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ran: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.ran }],
    },
    async execute() {
      bodyRuns.click += 1
      return { ran: 'page_click' }
    },
  }))
  return ctx
}

function execute(
  ctx: Context,
  agent: Agent | undefined,
  name: string,
  args: unknown,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: ToolCallId(`call-${name}`),
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    signal: new AbortController().signal,
  })
}

/** The session's approval audit pair (each event type present at most once here). */
function auditOf(agent: Agent): SessionEvent[] {
  return agent.session.snapshotEvents().filter(event => event.type.startsWith('approval/'))
}

describe('chrome-tool-gate', () => {
  it('audits asked/decided and denies when the answerer rejects', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-reject')
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => Promise.resolve('rejected'))

    const result = await execute(ctx, agent, 'page_evaluate', { function: '1+1' })

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable: rejection must deny')
    expect(result.error.message).toContain('用户拒绝')
    expect(bodyRuns.evaluate).toBe(0)
    const audit = auditOf(agent)
    expect(audit.map(event => event.type)).toEqual(['approval/asked', 'approval/decided'])
    const asked = audit[0] as SessionEvent<'approval/asked'>
    const decided = audit[1] as SessionEvent<'approval/decided'>
    expect(decided.data.id).toBe(asked.data.id)
    expect(decided.data.outcome).toBe('rejected')
    expect(asked.data.toolName).toBe('page_evaluate')
    expect(asked.data.callId).toBe('call-page_evaluate')
    // 面板 headline 文案：动作说明 + 关键参数摘要。
    expect(asked.data.reason).toContain('执行脚本')
    expect(asked.data.reason).toContain('{"function":"1+1"}')
  })

  it('fails closed to a deny when no answerer is available, still auditing the pair', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-unavailable')

    const result = await execute(ctx, agent, 'page_evaluate', { function: 'location.href' })

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable: unavailable must deny')
    expect(result.error.message).toContain('没有可用的审批通道')
    expect(bodyRuns.evaluate).toBe(0)
    const audit = auditOf(agent)
    const decided = audit[1] as SessionEvent<'approval/decided'>
    expect(decided.data.outcome).toBe('unavailable')
  })

  it('lets exactly the granted call run when the answerer allows once', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-allow')
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => Promise.resolve('allowed-once'))

    const result = await execute(ctx, agent, 'page_evaluate', { function: 'document.title' })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unreachable: allowed-once must run the body')
    expect(result.value).toEqual({ ran: 'page_evaluate' })
    expect(bodyRuns.evaluate).toBe(1)
    const audit = auditOf(agent)
    const decided = audit[1] as SessionEvent<'approval/decided'>
    expect(decided.data.outcome).toBe('allowed-once')
  })

  it('never asks for non-gated tools', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-skip')
    // Even a rejecting answerer must not be consulted for non-gated tools.
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => Promise.resolve('rejected'))

    const result = await execute(ctx, agent, 'page_snapshot', { tab_id: 1 })

    expect(result.isError).toBe(false)
    expect(bodyRuns.snapshot).toBe(1)
    expect(bodyRuns.evaluate).toBe(0)
    expect(auditOf(agent)).toEqual([])
  })

  it('denies a gated call without asking when no agent is attached', async () => {
    const ctx = await bootGate()
    const bystander = mountedAgent(ctx, 'gate-agentless-bystander')
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => Promise.resolve('allowed-once'))

    const result = await execute(ctx, undefined, 'page_evaluate', { function: '1+1' })

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable: agent-less must deny')
    expect(result.error.message).toContain('没有可路由审批的 agent')
    expect(bodyRuns.evaluate).toBe(0)
    // No session may receive the audit pair: there was nowhere to ask.
    expect(auditOf(bystander)).toEqual([])
  })

  it('pairs parallel asks with their own audit records under one rejecting answerer', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-parallel')
    const answererCalls: Array<string | undefined> = []
    ctx.on('approval/request', (req): Promise<ApprovalOutcome> => {
      answererCalls.push(req.callId)
      return Promise.resolve('rejected')
    })

    const [first, second] = await Promise.all([
      execute(ctx, agent, 'page_evaluate', { function: 'first' }),
      execute(ctx, agent, 'page_evaluate', { function: 'second' }),
    ])

    expect(first.isError).toBe(true)
    expect(second.isError).toBe(true)
    expect(answererCalls.sort()).toEqual(['call-page_evaluate', 'call-page_evaluate'])
    const audit = auditOf(agent)
    // Parallel asks interleave their audit appends (several asked before any
    // answerer runs is exactly the case the bridge's pairing scan exists for),
    // so assert the multiset and the one-to-one id pairing, not the order.
    expect(audit.map(event => event.type).sort()).toEqual(['approval/asked', 'approval/asked', 'approval/decided', 'approval/decided'])
    const askedIds = audit
      .filter((event): event is SessionEvent<'approval/asked'> => event.type === 'approval/asked')
      .map(event => event.data.id)
      .sort()
    const decidedIds = audit
      .filter((event): event is SessionEvent<'approval/decided'> => event.type === 'approval/decided')
      .map(event => event.data.id)
      .sort()
    expect(decidedIds).toEqual(askedIds)
    const askedReasons = audit
      .filter((event): event is SessionEvent<'approval/asked'> => event.type === 'approval/asked')
      .map(event => event.data.reason)
    expect(askedReasons.some(reason => reason?.includes('"first"'))).toBe(true)
    expect(askedReasons.some(reason => reason?.includes('"second"'))).toBe(true)
    expect(bodyRuns.evaluate).toBe(0)
  })

  // ── the permission-mode matrix (ask-always / ask-change / full) ──

  /** Append the durable mode knob to the agent's session (the RPC's write path). */
  function setMode(agent: Agent, mode: string): void {
    agent.session.append('permission/mode', { mode: mode as never })
  }

  it('asks for every interaction under ask-always', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-always')
    setMode(agent, 'ask-always')
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => Promise.resolve('rejected'))

    for (const [name, args] of [
      ['write', { path: '/workspace/a.txt' }],
      ['page_evaluate', { function: '1+1' }],
    ] as const) {
      const result = await execute(ctx, agent, name, args)
      expect(result.isError).toBe(true)
      if (!result.isError) throw new Error('unreachable: ask-always must ask')
      expect(result.error.message).toContain('用户拒绝')
    }
    expect(bodyRuns.write).toBe(0)
    expect(bodyRuns.evaluate).toBe(0)
  })

  it('lets browsing run free under the default ask-change, still asking for changes', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-change')
    // No knob event logged: the composition default IS ask-change.
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => Promise.resolve('rejected'))

    // Browse-class (click) runs without consulting the answerer.
    const click = await execute(ctx, agent, 'page_click', { selector: 'a.link' })
    expect(click.isError).toBe(false)
    expect(bodyRuns.click).toBe(1)
    expect(auditOf(agent)).toEqual([])

    // Change-class (script) asks and, with the rejecting answerer, denies.
    const evaluate = await execute(ctx, agent, 'page_evaluate', { function: '1+1' })
    expect(evaluate.isError).toBe(true)
    expect(bodyRuns.evaluate).toBe(0)
    const asked = auditOf(agent)[0] as SessionEvent<'approval/asked'>
    expect(asked.data.reason).toContain('执行脚本')
  })

  it('asks for change-class file writes under the default, regardless of class defaults', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-change-write')
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => Promise.resolve('allowed-once'))

    const result = await execute(ctx, agent, 'write', { path: '/workspace/a.txt' })

    expect(result.isError).toBe(false)
    expect(bodyRuns.write).toBe(1)
    const decided = auditOf(agent)[1] as SessionEvent<'approval/decided'>
    expect(decided.data.outcome).toBe('allowed-once')
  })

  it('runs every gated tool without asking under full access', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-full')
    setMode(agent, 'full')
    // A rejecting answerer would fail every ask; full access must never consult it.
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => Promise.resolve('rejected'))

    await execute(ctx, agent, 'write', { path: '/workspace/a.txt' })
    await execute(ctx, agent, 'page_evaluate', { function: '1+1' })

    expect(bodyRuns.write).toBe(1)
    expect(bodyRuns.evaluate).toBe(1)
    expect(auditOf(agent)).toEqual([])
  })

  it('denies file writes while plan mode is committed but keeps browsing free', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-plan-committed')
    agent.session.append('plan/mode', { active: true })
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => {
      throw new Error('plan mode must deny the file write without asking')
    })

    const write = await execute(ctx, agent, 'write', { path: '/workspace/a.txt' })
    expect(write.isError).toBe(true)
    if (!write.isError) throw new Error('unreachable: plan must deny')
    expect(write.error.message).toContain('计划模式')
    expect(write.error.message).toContain('exit_plan_mode')
    expect(bodyRuns.write).toBe(0)

    // Research stays available: a click does not consult the gate's ask path.
    const click = await execute(ctx, agent, 'page_click', { selector: 'a' })
    expect(click.isError).toBe(false)
    expect(bodyRuns.click).toBe(1)
    expect(auditOf(agent)).toEqual([])
  })

  it('blocks file writes on a pending plan selection before the commit lands', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-plan-pending')
    // An open turn + a user selection mid-turn: the selection stays pending
    // until the next accepted pre-step, and the gate must honor it now.
    ctx.planMode.set(agent, true)
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => Promise.resolve('allowed-once'))

    const result = await execute(ctx, agent, 'write', { path: '/workspace/a.txt' })

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable: pending plan must block')
    expect(result.error.message).toContain('计划模式')
    expect(bodyRuns.write).toBe(0)
    expect(auditOf(agent)).toEqual([])
  })
})
