import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime, {
  STRUCTURED_OUTPUT_TOOL,
  SubagentDepthError,
  SubagentError,
} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations } from '../../subagent/tests/local-activation.ts'
import { startInProcessRun } from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

function text(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * The shipped in-process spawn backend shape: a continuable-creation provider
 * whose creation contribution is empty. The manager owns every other operation.
 */
async function setup(script: Script) {
  const ctx = new Context()
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider({
    name: 'spawn',
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    inheritsParentContext: false,
    prepareContinuable: () => Promise.resolve({}),
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

describe('startInProcessRun', () => {
  it('starts a managed child, reads its settled result, and disposes it', async () => {
    const { ctx, parent } = await setup([textResponse('driver answer')])
    const run = await startInProcessRun({
      label: 'child task',
      prompt: [{ type: 'text', text: 'child task' }],
      parent,
      signal: new AbortController().signal,
    })
    // The manager published the child before the start resolved.
    expect(ctx.agents.get(run.id)).toBe(run.localAgent)
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('driver answer')
    // Settlement includes release: the manager disposed the child before the
    // result resolved, and a later dispose is a shared no-op.
    expect(ctx.agents.get(run.id)).toBeUndefined()
    await expect(run.dispose()).resolves.toBeUndefined()
  })

  it('captures a requested structured result through the manager runtime', async () => {
    const { ctx, parent } = await setup([
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 42, note: 'done' }),
    ])
    const run = await startInProcessRun({
      label: 'produce the answer',
      prompt: [{ type: 'text', text: 'produce the answer' }],
      parent,
      signal: new AbortController().signal,
      outputSchema: {
        type: 'object',
        properties: { answer: { type: 'number' }, note: { type: 'string' } },
        required: ['answer'],
      },
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.structured).toEqual({ answer: 42, note: 'done' })
    await run.dispose()
    expect(ctx.agents.get(run.id)).toBeUndefined()
  })

  it('passes explicit child model options through to the published child', async () => {
    const { ctx } = await setup([textResponse('driver answer')])
    const parent = await ctx.agentLoop.create(SessionId('bare-parent'), {}, { cwd: '/workspace' })
    const run = await startInProcessRun({
      label: 'child task',
      prompt: [{ type: 'text', text: 'child task' }],
      parent,
      cwd: '/workspace',
      signal: new AbortController().signal,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const child = run.localAgent
    expect(child.options).toMatchObject({ provider: 'mock', model: 'mock' })
    expect(child.session.header.cwd).toBe('/workspace')
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    await run.dispose()
  })

  it('rejects an already-aborted request without publishing a child', async () => {
    const { ctx, parent } = await setup([])
    const beforeAgents = ctx.agents.list().length
    const beforeSessions = ctx.sessions.list().length
    const controller = new AbortController()
    controller.abort('too late')
    await expect(startInProcessRun({
      label: 'child task',
      prompt: [{ type: 'text', text: 'child task' }],
      parent,
      signal: controller.signal,
    })).rejects.toThrow()
    expect(ctx.agents.list()).toHaveLength(beforeAgents)
    expect(ctx.sessions.list()).toHaveLength(beforeSessions)
  })

  it('propagates the seam depth rejection without publishing a child', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const beforeAgents = ctx.agents.list().length
    await expect(startInProcessRun({
      label: 'child task',
      prompt: [{ type: 'text', text: 'child task' }],
      parent,
      signal: new AbortController().signal,
      maxDepth: 0,
    })).rejects.toBeInstanceOf(SubagentDepthError)
    expect(ctx.agents.list()).toHaveLength(beforeAgents)
  })

  it('fails loud when the parent context carries no subagent runtime', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    await expect(startInProcessRun({
      label: 'child task',
      prompt: [{ type: 'text', text: 'child task' }],
      parent,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ name: SubagentError.name })
    await ctx.fiber.dispose()
  })
})
