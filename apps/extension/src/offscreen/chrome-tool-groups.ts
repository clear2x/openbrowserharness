/**
 * `chrome-tool-groups`: on-demand tool groups (批280). The extension host
 * composes one static tool set for every session — 69 tools, ~40K characters
 * of schema riding along on EVERY model request, about half of it suites a
 * browser task rarely touches (team orchestration, scheduling, the file
 * workspace, background jobs). This row hides those groups per agent and
 * exposes one small `load_tools` tool in their place; a group becomes
 * available for the rest of the session the moment the model asks for it, so
 * nothing is lost and the default request roughly halves.
 *
 * Three paths make a deferred tool reachable:
 * - the model calls `load_tools({ group })` up front (the catalog is in that
 *   tool's description);
 * - the model calls a deferred tool by name anyway: the `UNKNOWN_TOOL`
 *   failure loads the owning group on the spot and attaches a notice telling
 *   the model to call it again — one wasted step at most, never a dead end;
 * - the capability switch `dsh-capability-tool-groups` (default on) turns
 *   the whole mechanism off, and PTC mode composes without it (a program
 *   cannot ask for a group mid-run).
 *
 * Model-visible ⟺ logged holds throughout: every request's tool list is in
 * its `request/header`, the load is an ordinary logged tool call, and the
 * self-heal notice rides `additionalContexts` through the durable log.
 *
 * @module chrome-tool-groups
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { isCapabilityEnabled } from '../chrome/browser-provider.ts'
import { PTC_MODE_CAPABILITY_KEY, TOOL_GROUPS_CAPABILITY_KEY } from '../shared/capability-keys.ts'

// The row's own model-visible source kind (the per-plugin kind convention);
// `form`/`summary` ride ContextFormed like every other notice.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tool-groups': { kind: 'tool-groups' } & ContextFormed
  }
}

export const name = 'chrome-tool-groups'

/** Engine services the row depends on: the tool registry it restricts and the agent registry whose creation it hooks. */
export const inject = ['tools', 'agents'] as const

/** One on-demand group: a set of global tools hidden until loaded. */
export interface ToolGroup {
  readonly id: string
  /** The label the model and the loader text use. */
  readonly label: string
  /** One line on what the group is for — the model chooses groups by it. */
  readonly description: string
  /** Global tool names (only the ones currently visible are ever restricted). */
  readonly tools: readonly string[]
}

/** The groups deferred by default, in catalog order. */
export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    id: 'team',
    label: '团队协作与子代理',
    description: '把任务委派给子代理、团队任务板（创建/更新/查询任务）、代理间消息、等待与中断',
    tools: [
      'subagent', 'subagent_fork', 'team_task_create', 'team_task_update', 'team_task_list', 'team_task_get',
      'list_agents', 'send_message', 'wait_agent', 'interrupt_agent',
    ],
  },
  {
    id: 'schedule',
    label: '定时任务',
    description: '创建、查看、修改定时或周期任务（用户要求「每天/每周/几点提醒」时使用）',
    tools: ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit'],
  },
  {
    id: 'files',
    label: '文件工作区',
    description: '读取、写入、修改文件，glob/grep 搜索与切换工作目录（扩展工作区或已挂载的本地文件夹）',
    tools: ['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'working_directory'],
  },
  {
    id: 'jobs',
    label: '后台任务',
    description: '列出、读取、终止后台任务（job_*）',
    tools: ['job_list', 'job_output', 'job_kill'],
  },
]

/** Every group id, in catalog order. */
export const TOOL_GROUP_IDS: readonly string[] = TOOL_GROUPS.map(group => group.id)

/** Plugin config: which groups stay hidden until loaded. */
export interface Config {
  /** Group ids hidden until the model loads them (default: every group). */
  deferredGroups?: string[]
}

/** Schemastery config with the loaded defaults. */
export const Config: z<Config> = z.object({
  deferredGroups: z.array(z.string()).default([...TOOL_GROUP_IDS]),
})

/** Per-agent deferral state. */
interface AgentGroups {
  /** Group ids loaded for this session. */
  readonly loaded: Set<string>
  /** Lifts the agent's current restriction; absent when nothing is hidden. */
  lift?: () => void
}

/** The loader tool's model-facing value. */
export interface LoadToolsValue {
  group: string
  label: string
  /** The group's tools that are actually available after the load. */
  loaded: string[]
  alreadyLoaded: boolean
}

/**
 * The group a tool name belongs to.
 * @param toolName - a global tool name.
 * @returns the owning group, or undefined for an always-visible tool.
 */
export function groupOfTool(toolName: string): ToolGroup | undefined {
  return TOOL_GROUPS.find(group => group.tools.includes(toolName))
}

/**
 * The one-line catalog the loader tool's description carries.
 * @returns the catalog text.
 */
export function catalogText(): string {
  return TOOL_GROUPS.map(group => `${group.id}=${group.label}（${group.description}）`).join('；')
}

/**
 * Mint one notice. The single construction point for every model-visible
 * message this plugin injects.
 * @param summary - one-line account shown on the collapsed transcript row.
 * @param text - the model-facing notice body.
 * @returns a fresh user message labeled `tool-groups`.
 */
export function toolGroupsNotice(summary: string, text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'tool-groups', form: 'notice', summary: boundContextSummary(summary) },
  })
}

/**
 * Validate the configured deferral list at plugin load: an unknown group id
 * is a misconfiguration and fails loud.
 * @param deferredGroups - the configured group ids.
 * @returns the deduplicated ids in catalog order.
 */
export function resolveDeferredGroups(deferredGroups: readonly string[]): string[] {
  const unknown = deferredGroups.filter(id => !TOOL_GROUP_IDS.includes(id))
  if (unknown.length > 0) {
    throw new Error(`chrome-tool-groups：未知的工具组 ${unknown.map(id => `"${id}"`).join('、')}（可选：${TOOL_GROUP_IDS.join('、')}）`)
  }
  return TOOL_GROUP_IDS.filter(id => deferredGroups.includes(id))
}

/**
 * Render the loader outcome.
 * @param value - the tool outcome.
 * @returns the model-facing text.
 */
export function formatLoadOutput(value: LoadToolsValue): string {
  const head = value.alreadyLoaded
    ? `工具组「${value.label}」此前已加载，继续使用即可。`
    : `已加载工具组「${value.label}」，本会话内持续可用。`
  return `${head} 现在可以直接调用：${value.loaded.join('、')}。`
}

/**
 * Install the row: the global loader tool, the per-agent restriction at
 * agent creation, and the `UNKNOWN_TOOL` self-heal.
 * @param ctx - plugin context; registrations and listeners are scoped to it.
 * @param config - the loaded plugin config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const deferredGroups = new Set(resolveDeferredGroups(config.deferredGroups ?? TOOL_GROUP_IDS))
  const states = new WeakMap<Agent, AgentGroups>()

  /** This agent's state (absent until `agent/created` set it up). */
  const stateOf = (agent: Agent): AgentGroups | undefined => states.get(agent)

  /**
   * Re-apply the agent's restriction from its loaded set: lift the previous
   * one, then hide every deferred group's currently visible tools.
   */
  const applyRestriction = (agent: Agent): void => {
    const state = stateOf(agent)
    if (state === undefined) return
    state.lift?.()
    delete state.lift
    const deny = TOOL_GROUPS
      .filter(group => deferredGroups.has(group.id) && !state.loaded.has(group.id))
      .flatMap(group => group.tools)
      .filter(toolName => ctx.tools.get(toolName, agent) !== undefined)
    if (deny.length === 0) return
    state.lift = agent.ctx.tools.restrict({ deny })
  }

  /**
   * Load one group for an agent.
   * @param agent - the calling agent.
   * @param group - the group to load.
   * @returns the loader value.
   */
  const loadGroup = (agent: Agent, group: ToolGroup): LoadToolsValue => {
    const state = stateOf(agent)
    if (state === undefined) {
      // Deferral is off for this agent (capability off / PTC mode): nothing to load.
      return { group: group.id, label: group.label, loaded: [], alreadyLoaded: false }
    }
    const alreadyLoaded = state.loaded.has(group.id)
    state.loaded.add(group.id)
    applyRestriction(agent)
    const loaded = group.tools.filter(toolName => ctx.tools.get(toolName, agent) !== undefined)
    return { group: group.id, label: group.label, loaded, alreadyLoaded }
  }

  ctx.tools.register(defineTool({
    name: 'load_tools',
    description: '按需加载工具组。为了给每次请求瘦身，下列工具组默认不出现在你的工具列表里——需要时先调用 load_tools 加载（一次加载，本会话持续可用）：'
      + `${catalogText()}。用户要求委派/多代理协作、定时提醒、读写文件、查后台任务时，先调用 load_tools 加载对应工具组，再调用其中的工具。`,
    parameters: {
      group: { type: 'string', required: true, enum: [...TOOL_GROUP_IDS], description: '要加载的工具组 id。' },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: { type: 'string', required: true },
          label: { type: 'string', required: true },
          loaded: { type: 'array', required: true, items: { type: 'string' } },
          alreadyLoaded: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatLoadOutput(value) }],
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `加载工具组：${args.group}`, kind: 'read', rawInput: args.group }),
    // The load only rewrites the agent's restriction (synchronous registry work).
    execute: (args, exec): Promise<LoadToolsValue> => {
      const group = TOOL_GROUPS.find(candidate => candidate.id === args.group)
      const agent = exec.agent
      if (group === undefined || agent === undefined) {
        return Promise.resolve({ group: args.group, label: args.group, loaded: [], alreadyLoaded: false })
      }
      return Promise.resolve(loadGroup(agent, group))
    },
  }))

  /**
   * Start deferring for one agent (subject to the two opt-outs): record its
   * empty loaded set and hide the deferred groups' visible tools.
   * @param agent - the agent to set up.
   */
  const deferFor = async (agent: Agent): Promise<void> => {
    if (states.has(agent)) return
    if (!(await isCapabilityEnabled(TOOL_GROUPS_CAPABILITY_KEY, true))) return
    // A program cannot ask for a group mid-run: PTC mode composes with every tool present.
    if (await isCapabilityEnabled(PTC_MODE_CAPABILITY_KEY, false)) return
    states.set(agent, { loaded: new Set<string>() })
    applyRestriction(agent)
  }

  ctx.on('agent/created', async ({ agent }) => {
    await deferFor(agent)
  })

  // Agents that already exist when this row mounts (the loop's pre-configured
  // `main` agent, created earlier in the composition) never announce their
  // creation to it: sweep them once so every agent gets the same deferral.
  for (const agent of ctx.agents.list()) void deferFor(agent)

  ctx.on('tools/post-execute', async (exec: ToolExecution, result: ToolExecutionResult, next): Promise<PostToolDecision> => {
    const downstream = await next()
    const error = result.isError ? result.error : undefined
    if (error?.info?.code !== 'UNKNOWN_TOOL') return downstream
    const group = groupOfTool(exec.name)
    const agent = exec.agent
    const state = agent === undefined ? undefined : stateOf(agent)
    if (group === undefined || agent === undefined || state === undefined || !deferredGroups.has(group.id)) return downstream
    const loaded = loadGroup(agent, group)
    if (loaded.loaded.length === 0) return downstream
    const remaining = TOOL_GROUPS.filter(candidate => deferredGroups.has(candidate.id) && !state.loaded.has(candidate.id))
    const notice = toolGroupsNotice(
      `已按需加载工具组「${group.label}」`,
      `你调用的工具「${exec.name}」属于按需加载的工具组「${group.label}」，现已加载（同时可用：${loaded.loaded.join('、')}）。`
        + `请直接重新调用「${exec.name}」继续任务。`
        + (remaining.length === 0 ? '' : `其他按需工具组（${remaining.map(candidate => candidate.label).join('、')}）需要时先调用 load_tools。`),
    )
    const additionalContexts = downstream.additionalContexts ?? []
    return { ...downstream, additionalContexts: [notice, ...additionalContexts] }
  })
}
