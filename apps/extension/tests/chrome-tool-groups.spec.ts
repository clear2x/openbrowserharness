/**
 * chrome-tool-groups (批280): on-demand tool groups against the REAL tool
 * registry and REAL agents. Pins the three reachability paths — deferral at
 * agent creation, `load_tools`, and the `UNKNOWN_TOOL` self-heal with its
 * notice — plus the two opt-outs (the capability switch, PTC mode) and the
 * pure helpers.
 * @module @deepseek-ai/dsh-extension/tests/chrome-tool-groups
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { defineContentToolFixture, executeModelToolFixture } from '../../../packages/test-support/tool-testkit/src/index.ts'
import * as chromeToolGroups from '../src/offscreen/chrome-tool-groups.ts'
import { PTC_MODE_CAPABILITY_KEY, TOOL_GROUPS_CAPABILITY_KEY } from '../src/shared/capability-keys.ts'

/** Per-test capability flags; a missing key reads its fallback. */
const caps = vi.hoisted((): Record<string, boolean> => ({}))

vi.mock('../src/chrome/browser-provider.ts', () => ({
  isCapabilityEnabled: async (key: string, fallback: boolean): Promise<boolean> => caps[key] ?? fallback,
}))

const DEFERRED_TOOL_NAMES: readonly string[] = chromeToolGroups.TOOL_GROUPS.flatMap(group => [...group.tools])
const FILES_TOOLS: readonly string[] = chromeToolGroups.TOOL_GROUPS.find(group => group.id === 'files')?.tools ?? []
const contexts: Context[] = []

beforeEach(() => {
  for (const key of Object.keys(caps)) Reflect.deleteProperty(caps, key)
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/**
 * Boot the real loop stack the way the composition does (the same
 * package-name imports the tool-gate spec uses), the stub tools, and the row.
 * @returns the context.
 */
async function boot(mountRow = true): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  for (const name of [...DEFERRED_TOOL_NAMES, 'page_snapshot']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `stub ${name}`,
      parameters: {},
      async execute() { return [{ type: 'text', text: `ran ${name}` }] },
    }))
  }
  if (mountRow) await ctx.plugin(chromeToolGroups)
  return ctx
}

/** Create a real agent with an open turn (tools execute inside a turn). */
async function createAgent(ctx: Context, id: string): Promise<Agent> {
  await ctx.agents.create({ sessionId: brandString<SessionId>(id) })
  const agent = ctx.agents.get(brandString<SessionId>(id))
  if (agent === undefined) throw new Error(`agent ${id} was not registered`)
  agent.session.append('turn/start', { turn: 1 })
  return agent
}

const visibleNames = (ctx: Context, agent?: Agent): string[] => ctx.tools.schemas(agent).map(schema => schema.name)

/** Run one tool call the way the loop does. */
const call = (ctx: Context, agent: Agent, name: string, args: Record<string, unknown> = {}): Promise<ToolExecutionResult> =>
  executeModelToolFixture(ctx, {
    callId: ToolCallId(`call-${name}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent,
  })

/** `ok` for a success, the failure's message and code otherwise — the readable form for assertions. */
function outcomeOf(result: ToolExecutionResult): string {
  return result.isError ? `${result.error.message} [${result.error.info?.code ?? 'no-code'}]` : 'ok'
}

describe('deferral at agent creation', () => {
  it('hides every deferred tool from the agent while the global registry keeps them', async () => {
    const ctx = await boot()
    expect(visibleNames(ctx)).toEqual(expect.arrayContaining(['read', 'schedule_create', 'team_task_create', 'job_list']))

    const agent = await createAgent(ctx, 'session-deferred')

    const names = visibleNames(ctx, agent)
    expect(names).toContain('load_tools')
    expect(names).toContain('page_snapshot')
    for (const deferred of DEFERRED_TOOL_NAMES) expect(names).not.toContain(deferred)
  })

  it('keeps every tool visible when the capability switch is off', async () => {
    caps[TOOL_GROUPS_CAPABILITY_KEY] = false
    const ctx = await boot()

    const names = visibleNames(ctx, await createAgent(ctx, 'session-off'))

    expect(names).toEqual(expect.arrayContaining(['read', 'schedule_create', 'page_snapshot']))
  })

  it('keeps every tool visible under PTC mode (a program cannot load a group mid-run)', async () => {
    caps[PTC_MODE_CAPABILITY_KEY] = true
    const ctx = await boot()

    const names = visibleNames(ctx, await createAgent(ctx, 'session-ptc'))

    expect(names).toEqual(expect.arrayContaining(['read', 'schedule_create']))
  })

  it('is per agent: one agent loading a group leaves another agent untouched', async () => {
    const ctx = await boot()
    const first = await createAgent(ctx, 'session-a')
    const second = await createAgent(ctx, 'session-b')

    const outcome = await call(ctx, first, 'load_tools', { group: 'files' })

    expect(outcomeOf(outcome)).toBe('ok')
    expect(visibleNames(ctx, first)).toContain('read')
    expect(visibleNames(ctx, second)).not.toContain('read')
  })
})

describe('agents that predate the row', () => {
  it('sweeps existing agents at mount: an agent created before the row gets the same deferral', async () => {
    // The loop's pre-configured `main` agent is created earlier in the
    // composition and never announces its creation to this row.
    const ctx = await boot(false)
    const early = await createAgent(ctx, 'session-early')
    expect(visibleNames(ctx, early)).toContain('read')

    await ctx.plugin(chromeToolGroups)
    await vi.waitFor(() => { expect(visibleNames(ctx, early)).not.toContain('read') })

    expect(visibleNames(ctx, early)).toContain('load_tools')
    expect(outcomeOf(await call(ctx, early, 'schedule_create'))).toContain('[UNKNOWN_TOOL]')
    expect(outcomeOf(await call(ctx, early, 'schedule_create'))).toBe('ok')
  })
})

describe('load_tools', () => {
  it('loads exactly the requested group and reports its available tools', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'session-load')

    const outcome = await call(ctx, agent, 'load_tools', { group: 'files' })

    expect(outcomeOf(outcome)).toBe('ok')
    if (outcome.isError) throw new Error('unreachable')
    expect(outcome.value).toMatchObject({ group: 'files', label: '文件工作区', alreadyLoaded: false })
    expect([...(outcome.value as { loaded: string[] }).loaded].sort()).toEqual([...FILES_TOOLS].sort())
    const names = visibleNames(ctx, agent)
    expect(names).toEqual(expect.arrayContaining(['read', 'write', 'glob']))
    expect(names).not.toContain('schedule_create')
    expect(names).not.toContain('team_task_create')
  })

  it('is idempotent and the second load says so', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'session-twice')
    await call(ctx, agent, 'load_tools', { group: 'schedule' })

    const again = await call(ctx, agent, 'load_tools', { group: 'schedule' })

    expect(outcomeOf(again)).toBe('ok')
    if (again.isError) throw new Error('unreachable')
    expect((again.value as { alreadyLoaded: boolean }).alreadyLoaded).toBe(true)
    expect(visibleNames(ctx, agent)).toContain('schedule_edit')
  })

  it('lists the whole catalog in its own description', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'session-catalog')
    const loader = ctx.tools.get('load_tools', agent)
    expect(loader?.description).toContain('load_tools')
    for (const group of chromeToolGroups.TOOL_GROUPS) expect(loader?.description).toContain(group.id)
  })
})

describe('UNKNOWN_TOOL self-heal', () => {
  it('loads the owning group when the model calls a deferred tool by name, with a notice to call it again', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'session-heal')

    const failed = await call(ctx, agent, 'read', { file_path: '/x' })

    expect(outcomeOf(failed)).toContain('[UNKNOWN_TOOL]')
    if (!failed.isError) throw new Error('unreachable')
    expect(failed.additionalContexts?.some((message) => {
      const text = JSON.stringify(message.content)
      return text.includes('属于按需加载的工具组「文件工作区」') && text.includes('请直接重新调用「read」')
    })).toBe(true)
    // The group is now loaded: the very same call succeeds.
    const retried = await call(ctx, agent, 'read', { file_path: '/x' })
    expect(outcomeOf(retried)).toBe('ok')
  })

  it('leaves a genuinely unknown tool alone (no group owns it)', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'session-unknown')

    const failed = await call(ctx, agent, 'no_such_tool')

    expect(outcomeOf(failed)).toContain('[UNKNOWN_TOOL]')
    if (!failed.isError) throw new Error('unreachable')
    expect(failed.additionalContexts ?? []).toHaveLength(0)
  })

  it('does nothing for a deferred tool when deferral is off for the agent', async () => {
    caps[TOOL_GROUPS_CAPABILITY_KEY] = false
    const ctx = await boot()
    const agent = await createAgent(ctx, 'session-off-heal')

    const outcome = await call(ctx, agent, 'job_list')

    expect(outcomeOf(outcome)).toBe('ok')
    expect(visibleNames(ctx, agent)).toContain('job_list')
  })
})

describe('pure helpers', () => {
  it('resolves the deferral list in catalog order and fails loud on an unknown id', () => {
    expect(chromeToolGroups.resolveDeferredGroups(['jobs', 'files', 'jobs'])).toEqual(['files', 'jobs'])
    expect(() => chromeToolGroups.resolveDeferredGroups(['team', 'nope'])).toThrow('未知的工具组 "nope"')
  })

  it('maps tools to their group and renders the catalog and the loader outcome', () => {
    expect(chromeToolGroups.groupOfTool('schedule_edit')?.id).toBe('schedule')
    expect(chromeToolGroups.groupOfTool('page_snapshot')).toBeUndefined()
    expect(chromeToolGroups.catalogText()).toContain('team=团队协作与子代理')
    expect(chromeToolGroups.formatLoadOutput({ group: 'files', label: '文件工作区', loaded: ['read', 'write'], alreadyLoaded: false }))
      .toBe('已加载工具组「文件工作区」，本会话内持续可用。 现在可以直接调用：read、write。')
    expect(chromeToolGroups.formatLoadOutput({ group: 'files', label: '文件工作区', loaded: ['read'], alreadyLoaded: true }))
      .toContain('此前已加载')
  })

  it('names every deferred tool exactly once across groups', () => {
    expect(new Set(DEFERRED_TOOL_NAMES).size).toBe(DEFERRED_TOOL_NAMES.length)
  })
})
