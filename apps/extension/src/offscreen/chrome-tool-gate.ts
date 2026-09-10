/**
 * `chrome-tool-gate`: the permission gate for the extension engine — the
 * consumer-side twin of the desktop pre-tool gate. It listens on the
 * `tools/pre-execute` waterfall and resolves every page-touching or file-
 * changing call through the permission-mode matrix (see
 * `shared/permission-mode`): `ask-always` asks for every interaction,
 * `ask-change` (the default) asks only for change-class operations and lets
 * browsing run free, `full` allows everything. The ask goes to the approval
 * seam (`ctx.approval`, composed by `@deepseek-ai/dsh-user-approval`):
 * `allowed-once` allows this one execution, every other outcome denies with a
 * distinct reason so the model can tell a human "no" from an absent approval
 * channel (`unavailable` fails closed). While the engine's plan mode is in
 * force the file-writing tools deny outright (a plan must be approved through
 * `exit_plan_mode` before the workspace changes) — browser research tools
 * stay available so the model can actually investigate. All other tools
 * delegate through `next()` untouched.
 *
 * The gate claims the decision itself instead of returning `{ kind: 'ask' }`:
 * the registry's own ask path would work identically, but doing the ask here
 * keeps the gate's Chinese reason text (a summary the panel renders verbatim)
 * owned next to the tool list it describes. Ordering note: the composition row
 * must come after `@deepseek-ai/dsh-tool-browser` — the gate is a dispatch
 * waterfall listener, not a registration-time participant, so it also applies
 * to tools registered before it mounts.
 *
 * @module chrome-tool-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import { effectivePermissionMode } from './permission-mode.ts'

export const name = 'chrome-tool-gate'

/**
 * Engine services the gate drives: the tool pipeline it gates, the approval
 * seam it asks, and the plan-mode service whose committed state blocks the
 * file-writing tools.
 */
export const inject = ['tools', 'approval', 'planMode']

/** This plugin has no config. */
export interface Config {}

/**
 * The gated tool classes. CHANGE tools add, modify, or delete content — typed
 * text, keypresses, scripts, navigation (typed URLs replace the page), tab
 * open/close, and the OPFS write/edit pair (the base fs suite is all this
 * composition mounts). BROWSE tools touch the page without changing its
 * content — clicking and scrolling — and additionally ask under
 * `ask-always`. Read-only tools (snapshot/extract/read/wait, tab listing and
 * switching) never consult this gate.
 */
const CHANGE_TOOLS: ReadonlySet<string> = new Set([
  'write', 'edit',
  'page_type', 'page_press_key', 'page_navigate', 'page_evaluate',
  'tabs_open', 'tabs_close',
])
const BROWSE_TOOLS: ReadonlySet<string> = new Set(['page_click', 'page_scroll'])
const GATED_TOOLS: ReadonlySet<string> = new Set([...CHANGE_TOOLS, ...BROWSE_TOOLS])

/** Human-readable action sentence per gated tool (the reason headline). */
const TOOL_ACTIONS: Readonly<Record<string, string>> = {
  page_evaluate: '请求在页面上下文中执行脚本',
  page_navigate: '请求将标签页导航到新的 URL',
  page_type: '请求在页面中输入文字',
  page_press_key: '请求向页面发送按键',
  page_click: '请求点击页面元素',
  page_scroll: '请求滚动页面',
  tabs_open: '请求打开新标签页',
  tabs_close: '请求关闭标签页',
  write: '请求创建或覆盖文件',
  edit: '请求编辑文件',
}

/** Fallback action headline for a gated tool without a dedicated sentence. */
const FALLBACK_ACTION = '执行需要确认的操作'

/** Argument summary cap: the reason is panel UI text, not an argument dump. */
const ARGS_SUMMARY_LIMIT = 200

/**
 * Lossless-JSON one-line argument summary for the approval reason. An
 * unserializable argument value degrades to a placeholder instead of throwing
 * out of the gate.
 * @param args - the call's parsed arguments.
 * @returns a short single-line summary.
 */
function argsSummary(args: unknown): string {
  let text: string
  try {
    text = String(JSON.stringify(args))
  } catch {
    return '<不可序列化参数>'
  }
  return text.length > ARGS_SUMMARY_LIMIT ? `${text.slice(0, ARGS_SUMMARY_LIMIT)}…` : text
}

/**
 * Ask the approval seam for one gated execution and map the closed outcome
 * onto the pre-execute decision. `exec.agent` is required because the approval
 * audit pair must land on the calling session; an agent-less call fails closed
 * without asking.
 * @param ctx - the plugin context carrying the approval service.
 * @param exec - the gated execution under decision.
 * @returns the pre-execute decision for this call.
 */
async function decide(ctx: Context, exec: ToolExecution): Promise<PreToolDecision> {
  if (exec.agent === undefined) {
    return {
      kind: 'deny',
      reason: `工具 "${exec.name}" 需要用户审批，但本次调用没有可路由审批的 agent`,
    }
  }
  const request: ApprovalRequest = {
    agent: exec.agent,
    toolName: exec.name,
    callId: exec.callId,
    reason: `${TOOL_ACTIONS[exec.name] ?? FALLBACK_ACTION}。参数：${argsSummary(exec.arguments)}`,
    signal: exec.signal,
  }
  const outcome: ApprovalOutcome = await ctx.approval.request(request)
  switch (outcome) {
    case 'allowed-once': return { kind: 'allow' }
    case 'rejected': return { kind: 'deny', reason: `用户拒绝了工具 "${exec.name}" 的本次执行` }
    case 'cancelled': return { kind: 'deny', reason: `工具 "${exec.name}" 的审批请求已被取消` }
    case 'unavailable': return {
      kind: 'deny',
      reason: `工具 "${exec.name}" 需要用户审批，但当前没有可用的审批通道`,
    }
  }
}

/**
 * Whether plan restrictions block a FILE change: the committed `plan/mode`
 * state, or a pending selection awaiting the next accepted pre-step (a user
 * who just entered plan mode mid-turn blocks immediately — waiting for the
 * commit would let one more file change slip through after the intent is
 * recorded). Browser tools stay free under plan mode: researching the web is
 * exactly what planning needs.
 * @param ctx - the composed engine context carrying the plan-mode service.
 * @param agent - the calling agent whose session state applies.
 * @returns whether file-writing tools are blocked right now.
 */
function planBlocksFileChange(ctx: Context, agent: Agent): boolean {
  const state = ctx.planMode.get(agent)
  return state.active || state.pending === true
}

/**
 * Register the pre-execute gate listener. Non-gated tools delegate through
 * `next()` untouched. A gated call resolves through the permission-mode
 * matrix: `full` allows; `ask-change` (the default) asks for the change-class
 * tools and lets browsing run free; `ask-always` asks for both classes. Plan
 * mode denies the file-writing tools outright regardless of mode (approve the
 * plan through `exit_plan_mode` first). The agent-less fail-closed deny comes
 * first so a call with nowhere to route an ask never runs.
 * @param ctx - the composed engine context.
 */
export function apply(ctx: Context): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!GATED_TOOLS.has(exec.name)) return next()
    if (exec.agent === undefined) {
      return {
        kind: 'deny',
        reason: `工具 "${exec.name}" 需要用户审批，但本次调用没有可路由审批的 agent`,
      }
    }
    if (CHANGE_TOOLS.has(exec.name) && planBlocksFileChange(ctx, exec.agent)) {
      return {
        kind: 'deny',
        reason: `计划模式：工具 "${exec.name}" 会产生变更，已被阻止。请先用 exit_plan_mode 提交计划，获批后再执行`,
      }
    }
    const mode = effectivePermissionMode(exec.agent.session.events)
    if (mode === 'full') return next()
    if (mode === 'ask-change' && BROWSE_TOOLS.has(exec.name)) return next()
    return decide(ctx, exec)
  })
}
