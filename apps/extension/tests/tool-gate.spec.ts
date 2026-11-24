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
 *
 * The 危险操作确认 cases stub the browser provider instead of a real page: the
 * gate's probe (deep resolver serialized into an evaluate expression, run on
 * the click's own tab) is asserted through what the stub recorded.
 *
 * The 直接请求站点接口 cases pin the website-task rule: a call that would
 * request a site's API directly — agent-authored code (a `page_evaluate`
 * expression, a `run_code` program), a tool pointed at an API address, a
 * `video_index` index — is refused under every permission mode unless the
 * switch is on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BrowserProvider } from '@deepseek-ai/dsh-browser'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
// Package-internal single-call fixture (upstream's own batch wrapper); the
// twin reaches the source directly, by extensionful relative specifier.
import { executeModelToolFixture } from '../../../packages/test-support/tool-testkit/src/index.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import BrowserRuntimeService from '@deepseek-ai/dsh-browser'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import * as chromeToolGate from '../src/offscreen/chrome-tool-gate.ts'

/** The 危险操作确认 capability flag, pinned per test through the gate's module. */
const safeClickState = vi.hoisted(() => ({ enabled: false }))
/** The 直接请求站点接口 capability flag (default OFF), pinned per test the same way. */
const siteApiState = vi.hoisted(() => ({ enabled: false }))

vi.mock('../src/background/capability-gate.ts', async importOriginal => ({
  ...(await importOriginal<object>()),
  safeClickEnabled: async (): Promise<boolean> => safeClickState.enabled,
  directSiteApiEnabled: async (): Promise<boolean> => siteApiState.enabled,
}))

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
const bodyRuns = { evaluate: 0, snapshot: 0, write: 0, click: 0, address: 0 }

/** The tools whose argument sends the browser or the extension to an address, or calls Bilibili's API. */
const ADDRESS_TOOLS = ['tabs_open', 'page_navigate', 'web_fetch', 'page_batch_actions', 'video_index'] as const

async function bootGate(): Promise<Context> {
  bodyRuns.evaluate = 0
  bodyRuns.snapshot = 0
  bodyRuns.write = 0
  bodyRuns.click = 0
  bodyRuns.address = 0
  const ctx = new Context()
  // The 危险操作确认 cases register a scripted provider; mounting the seam
  // early keeps the boot order the composition uses (services before gates).
  await ctx.plugin(BrowserRuntimeService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
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
  // The gate mounts ONCE: apply(ctx) + plugin(chromeToolGate) would register
  // the pre-execute listener twice, and the danger probe's evaluate calls
  // would double.
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
  for (const name of ADDRESS_TOOLS) {
    // A stub that only counts its run; the test's arguments reach the gate as given.
    ctx.tools.register(defineTool({
      name,
      description: `stub: ${name}`,
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ran: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: value.ran }],
      },
      async execute() {
        bodyRuns.address += 1
        return { ran: name }
      },
    }))
  }
  return ctx
}

function execute(
  ctx: Context,
  agent: Agent | undefined,
  name: string,
  args: unknown,
): Promise<ToolExecutionResult> {
  // Upstream's single-call batch fixture: correlated id, one result back.
  return executeModelToolFixture(ctx, {
    callId: ToolCallId(['call-', name].join('')),
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
    // The ask path needs a mode that asks; the composition default is full.
    setMode(agent, 'ask-change')
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
    // The ask path needs a mode that asks; the composition default is full.
    setMode(agent, 'ask-change')

    // The payload never runs (the deny path fires first); a constant keeps
    // the probe free of any page-value shape the deny does not need.
    const result = await execute(ctx, agent, 'page_evaluate', { function: '1 + 1' })

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
    // The ask path needs a mode that asks; the composition default is full.
    setMode(agent, 'ask-change')
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
    // The ask path needs a mode that asks; the composition default is full.
    setMode(agent, 'ask-change')
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

  it('lets browsing run free under ask-change, still asking for changes', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-change')
    setMode(agent, 'ask-change')
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

  it('asks for change-class file writes under ask-change, regardless of class defaults', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-change-write')
    setMode(agent, 'ask-change')
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

  it('folds to full access before the first permission-mode event', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-default-full')
    // No knob event logged: the composition default IS full. A rejecting
    // answerer would fail every ask; the fold must never reach it.
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => Promise.resolve('rejected'))

    await execute(ctx, agent, 'write', { path: '/workspace/a.txt' })
    await execute(ctx, agent, 'page_evaluate', { function: '1+1' })
    await execute(ctx, agent, 'page_click', { selector: 'a.link' })

    expect(bodyRuns.write).toBe(1)
    expect(bodyRuns.evaluate).toBe(1)
    expect(bodyRuns.click).toBe(1)
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

// ── 危险操作确认 (safe-click): danger-text clicks ask even under full access ──

/**
 * Provider stub whose every method answers; the danger probe only touches
 * `tabs` and `evaluate`, which the cases override and record.
 */
function stubBrowserProvider(overrides: Record<string, unknown>): BrowserProvider {
  const base: Record<string, unknown> = { id: 'gate-stub' }
  return new Proxy(base as unknown as BrowserProvider, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'id') return 'gate-stub'
      if (prop in overrides) return overrides[prop]
      if (prop in base) return base[prop]
      return (): Promise<void> => Promise.resolve()
    },
  })
}

describe('chrome-tool-gate 危险操作确认', () => {
  /** Boot with the browser service + the scripted provider and the switch ON. */
  async function bootWithProvider(provider: BrowserProvider): Promise<Context> {
    const ctx = await bootGate()
    safeClickState.enabled = true
    ctx.browser.register(provider)
    return ctx
  }

  /** Evaluate spy recording [tabId, expression] pairs and answering `text`. */
  function spyEvaluate(provider: BrowserProvider, text: string): Array<[number, string]> {
    const calls: Array<[number, string]> = []
    ;(provider as unknown as { evaluate: (tabId: number, expression: string) => Promise<string> }).evaluate =
      async (tabId: number, expression: string) => {
        calls.push([tabId, expression])
        return text
      }
    return calls
  }

  const TABS = [
    { tabId: 7, title: '前台', url: 'https://front.example', active: true, windowId: 1, index: 0 },
    { tabId: 9, title: '后台', url: 'https://back.example', active: false, windowId: 1, index: 1 },
  ]

  it('probes the tab named by tab_id (cross-tab click) and asks on danger text', async () => {
    const provider = stubBrowserProvider({ tabs: async (): Promise<unknown[]> => TABS })
    const ctx = await bootWithProvider(provider)
    const evaluateCalls = spyEvaluate(provider, '确认支付')
    const agent = mountedAgent(ctx, 'gate-danger-cross-tab')
    // A rejecting answerer proves the ask actually fired.
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => Promise.resolve('rejected'))

    const result = await execute(ctx, agent, 'page_click', { tab_id: 9, selector: '#pay' })

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable: danger click must be denied')
    // The ask fired and the human answered "no"; the danger headline lives
    // on the asked audit record below.
    expect(result.error.message).toContain('用户拒绝')
    // The probe ran on the click's OWN tab (9), not the active tab (7).
    expect(evaluateCalls).toEqual([[9, expect.stringContaining('deepQuery')]])
    expect(bodyRuns.click).toBe(0)
    const asked = auditOf(agent)[0] as SessionEvent<'approval/asked'>
    expect(asked.data.reason).toContain('危险操作确认')
    expect(asked.data.reason).toContain('确认支付')
  })

  it('resolves pierce selectors through the serialized deep resolver (shadow DOM)', async () => {
    const provider = stubBrowserProvider({ tabs: async (): Promise<unknown[]> => TABS })
    const ctx = await bootWithProvider(provider)
    const evaluateCalls = spyEvaluate(provider, '永久删除账号')
    const agent = mountedAgent(ctx, 'gate-danger-pierce')

    const result = await execute(ctx, agent, 'page_click', { selector: 'pay-panel >>> #confirm' })

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable: pierce danger click must ask')
    const [, expression] = evaluateCalls[0] ?? [0, '']
    // The deep resolver source is embedded, and the pierce selector travels
    // verbatim — document.querySelector would have thrown (and been
    // swallowed) on the `>>>` chain, leaving the click ungated.
    expect(expression).toContain('shadowRoot')
    expect(expression).toContain(JSON.stringify('pay-panel >>> #confirm'))
    const asked = auditOf(agent)[0] as SessionEvent<'approval/asked'>
    expect(asked.data.reason).toContain('永久删除账号')
    expect(bodyRuns.click).toBe(0)
  })

  it('falls back to the active tab only when the call carries no tab_id', async () => {
    const provider = stubBrowserProvider({ tabs: async (): Promise<unknown[]> => TABS })
    const ctx = await bootWithProvider(provider)
    const evaluateCalls = spyEvaluate(provider, '清空所有数据')
    const agent = mountedAgent(ctx, 'gate-danger-active-fallback')
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => Promise.resolve('rejected'))

    await execute(ctx, agent, 'page_click', { selector: '#wipe' })

    expect(evaluateCalls).toEqual([[7, expect.anything()]])
  })

  it('leaves an unreadable element ungated (empty probe answer runs the click)', async () => {
    const provider = stubBrowserProvider({ tabs: async (): Promise<unknown[]> => TABS })
    const ctx = await bootWithProvider(provider)
    const evaluateCalls = spyEvaluate(provider, '')
    const agent = mountedAgent(ctx, 'gate-danger-unreadable')
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => {
      throw new Error('an unreadable element must not reach the approval seam')
    })

    const result = await execute(ctx, agent, 'page_click', { selector: '#icon-only' })

    expect(result.isError).toBe(false)
    expect(bodyRuns.click).toBe(1)
    expect(evaluateCalls).toHaveLength(1)
    expect(auditOf(agent)).toEqual([])
  })
})

describe('chrome-tool-gate 直接请求站点接口', () => {
  beforeEach(() => {
    siteApiState.enabled = false
  })

  /** Put the session in one permission mode (the composition default is full). */
  function mode(agent: Agent, value: string): void {
    agent.session.append('permission/mode', { mode: value as never })
  }

  const API_CALL = "fetch('/api/now').then(r => r.json())"
  /** A PTC program that calls an interface itself instead of driving the page tools. */
  const PROGRAM_CALL = "const r = await fetch('/api/x'); return r.status"
  /** A PTC program that only drives the page tools through its bindings. */
  const PROGRAM_TOOLS = [
    'const snap = await tools.page_snapshot({ tab_id: 1 })',
    "await tools.page_click({ selector: '.more' })",
    'return snap',
  ].join('; ')

  /** One `run_code` call through the pipeline; no stub is registered under that reserved name. */
  function programCall(ctx: Context, agent: Agent, code: string): Promise<ToolExecutionResult> {
    return executeModelToolFixture(ctx, {
      callId: ToolCallId('call-run_code'),
      name: 'run_code',
      arguments: { code },
      agent,
      signal: new AbortController().signal,
    })
  }

  /** The tool names the pre-execute listeners registered after the gate receive: a refusal stops the chain before them. */
  function callsAfterGate(ctx: Context): string[] {
    const seen: string[] = []
    ctx.on('tools/pre-execute', async (exec, next) => {
      seen.push(exec.name)
      return next()
    })
    return seen
  }

  it('refuses a page script that calls an interface under full access, before any body runs', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-script-network-full')

    const result = await execute(ctx, agent, 'page_evaluate', { function: API_CALL, expression: API_CALL })

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable: an interface call must be refused')
    expect(result.error.message).toContain('page_evaluate 脚本禁止请求接口')
    expect(result.error.message).toContain('检测到 fetch')
    expect(result.error.message).toContain('真实页面操作')
    expect(bodyRuns.evaluate).toBe(0)
    // A rule refusal is not an approval: nothing reaches the approval seam.
    expect(auditOf(agent)).toEqual([])
  })

  it('refuses a page script that navigates to an API address itself, before any body runs', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-site-api-script-address')
    const navigation = "location.href = 'https://api.bilibili.com/x/web-interface/view?bvid=1'"

    const result = await execute(ctx, agent, 'page_evaluate', { function: navigation, expression: navigation })

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable: a script navigation to an API address must be refused')
    expect(result.error.message).toContain('检测到 接口地址')
    expect(bodyRuns.evaluate).toBe(0)
  })

  // `run_code` is the engine's reserved transport name (only the PTC executor
  // mounts it), so these two read the chain itself: the gate refuses before
  // the listeners registered after it see the call, and otherwise delegates.
  it('refuses a run_code program that calls an interface itself, before the program starts', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-script-network-program')
    const seenAfterGate = callsAfterGate(ctx)

    const result = await programCall(ctx, agent, PROGRAM_CALL)

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable: a program that calls an interface must be refused')
    expect(result.error.message).toContain('run_code 程序禁止请求接口')
    expect(result.error.message).toContain('检测到 fetch')
    expect(seenAfterGate).toEqual([])
    expect(auditOf(agent)).toEqual([])
  })

  it('passes a run_code program that only drives the page tools on down the chain', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-script-network-program-tools')
    const seenAfterGate = callsAfterGate(ctx)

    await programCall(ctx, agent, PROGRAM_TOOLS)

    expect(seenAfterGate).toEqual(['run_code'])
  })

  it.each(['ask-always', 'ask-change'])('refuses the same script under %s without asking', async (permission) => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, `gate-script-network-${permission}`)
    mode(agent, permission)
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => {
      throw new Error('a refused interface call must not reach the approval seam')
    })

    const result = await execute(ctx, agent, 'page_evaluate', { function: API_CALL, expression: API_CALL })

    expect(result.isError).toBe(true)
    expect(bodyRuns.evaluate).toBe(0)
    expect(auditOf(agent)).toEqual([])
  })

  it('lets a page-state read run untouched under full access', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-script-network-read')
    const read = '(() => { const v = window.__INITIAL_STATE__?.videoData ?? {}; return { title: v.title } })()'

    const result = await execute(ctx, agent, 'page_evaluate', { function: read, expression: read })

    expect(result.isError).toBe(false)
    expect(bodyRuns.evaluate).toBe(1)
    expect(auditOf(agent)).toEqual([])
  })

  it('runs the interface call only while the switch is on', async () => {
    siteApiState.enabled = true
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-script-network-opt-in')

    const result = await execute(ctx, agent, 'page_evaluate', { function: API_CALL, expression: API_CALL })

    expect(result.isError).toBe(false)
    expect(bodyRuns.evaluate).toBe(1)
  })

  it('keeps the approval matrix in charge once the switch is on', async () => {
    siteApiState.enabled = true
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-script-network-opt-in-ask')
    mode(agent, 'ask-change')
    ctx.on('approval/request', (): Promise<ApprovalOutcome> => Promise.resolve('rejected'))

    const result = await execute(ctx, agent, 'page_evaluate', { function: API_CALL, expression: API_CALL })

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable: rejection must deny')
    expect(result.error.message).toContain('用户拒绝')
    expect(bodyRuns.evaluate).toBe(0)
    expect(auditOf(agent).map(event => event.type)).toEqual(['approval/asked', 'approval/decided'])
  })

  it.each([
    ['tabs_open', { url: 'https://api.bilibili.com/x/web-interface/view?bvid=1' }, 'tabs_open 禁止直接请求站点接口'],
    ['page_navigate', { tab_id: 4, url: 'https://www.bilibili.com/x/web-interface/nav' }, 'page_navigate 禁止直接请求站点接口'],
    ['web_fetch', { url: 'https://api.github.com/repos/nodejs/node' }, 'web_fetch 禁止直接请求站点接口'],
  ])('refuses a %s call that opens or fetches an API address, before any body runs', async (tool, args, refusal) => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, `gate-site-api-${tool}`)

    const result = await execute(ctx, agent, tool, args)

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable: an API address must be refused')
    expect(result.error.message).toContain(refusal)
    expect(result.error.message).toContain('封号')
    expect(bodyRuns.address).toBe(0)
    // A rule refusal is not an approval: nothing reaches the approval seam.
    expect(auditOf(agent)).toEqual([])
  })

  it('refuses a batch plan whose navigate step targets an API address', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-site-api-batch')
    const plan = {
      tab_id: 4,
      actions: [{ op: 'click', selector: '#more' }, { op: 'navigate', url: 'https://www.bilibili.com/x/web-interface/view?bvid=1' }],
    }

    const result = await execute(ctx, agent, 'page_batch_actions', plan)

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable: a plan that opens an API address must be refused')
    expect(result.error.message).toContain('page_batch_actions 禁止直接请求站点接口')
    expect(bodyRuns.address).toBe(0)
  })

  it('refuses a video_index index, which requests Bilibili\'s API with the login state', async () => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-site-api-video-index')

    const result = await execute(ctx, agent, 'video_index', { action: 'index', url: 'https://www.bilibili.com/video/BV1GJ411x7h7' })

    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('unreachable: an index build must be refused')
    expect(result.error.message).toContain('video_index 的 index 动作禁止执行')
    expect(result.error.message).toContain('zoom')
    expect(bodyRuns.address).toBe(0)
  })

  it.each([
    ['a page address', 'tabs_open', { url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }],
    ['a documentation site served from an api host', 'tabs_open', { url: 'https://api.flutter.dev/flutter/material/Colors-class.html' }],
    ['a batch plan of page steps', 'page_batch_actions', { actions: [{ op: 'navigate', url: 'https://search.bilibili.com/all?keyword=x' }] }],
    ['a zoom that drives the video page', 'video_index', { action: 'zoom', url: 'https://www.bilibili.com/video/BV1GJ411x7h7', timestampMs: 60_000 }],
    ['a query over an existing index', 'video_index', { action: 'query', videoKey: 'bilibili:BV1GJ411x7h7:p1', question: '开头' }],
  ])('lets %s through to the rest of the chain', async (_label, tool, args) => {
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-site-api-pass')

    const result = await execute(ctx, agent, tool, args)

    expect(result.isError).toBe(false)
    expect(bodyRuns.address).toBe(1)
  })

  it('lifts the address rule with the switch', async () => {
    siteApiState.enabled = true
    const ctx = await bootGate()
    const agent = mountedAgent(ctx, 'gate-site-api-opt-in')

    const result = await execute(ctx, agent, 'tabs_open', { url: 'https://api.bilibili.com/x/web-interface/view?bvid=1' })

    expect(result.isError).toBe(false)
    expect(bodyRuns.address).toBe(1)
  })
})
