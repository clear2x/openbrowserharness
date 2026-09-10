/**
 * Child route inheritance tracks the parent's EFFECTIVE model route, not its
 * static creation options.
 *
 * Hosts fix every parent request up through the `agent/request` waterfall (the
 * extension bridge's `installModelSelection`, the desktop gateway's model
 * switch), so a parent created on route A can be running on route B by the time
 * it delegates. A spawned child must resolve the route the parent actually
 * runs — its logged request header — or it inherits a dormant route whose
 * credential the host never stored, and its one model turn fails
 * (`stopReason: 'error'`, surfaced to the model as "subagent run failed").
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startInProcessRun } from '../../subagent-in-process-driver/src/index.ts'
import * as Spawn from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

/**
 * The extension bridge's keyless preset route: registered and selectable at
 * boot, but the host never stored a credential for it, so every dispatch fails
 * the way the bridge's `resolveStoredApiKey` does — before any request leaves
 * the process.
 */
class MissingCredentialAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    throw new LlmError(
      'provider 路由 "dormant-route" 没有可用的 API key；请在「设置」中保存 DORMANT_API_KEY',
      'MISSING_CREDENTIAL',
    )
  }
}

interface Mounted {
  ctx: Context
  live: MockAdapter
  dormant: MissingCredentialAdapter
}

async function mount(script: Script): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { persona: 'You are a coding agent.' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(ToolSubagent, { provider: 'spawn' })
  const dormant = new MissingCredentialAdapter()
  const live = new MockAdapter(script)
  ctx.llm.registerAdapter(['dormant-route'], dormant)
  ctx.llm.registerAdapter(['live-route'], live)
  return { ctx, live, dormant }
}

/** Read every committed tool-result text from one agent's log. */
function toolResultTexts(agent: Agent): string[] {
  return agent.session.events
    .filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    .map(event => event.data.message.content
      .flatMap(block => block.content)
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join(''))
}

describe('child route inheritance', () => {
  it('resolves a spawned child onto the route the parent actually runs, whose key the host can resolve', async () => {
    const { ctx, live, dormant } = await mount([
      toolCallResponse('call-1', 'subagent', { description: 'research', prompt: 'standalone task' }),
      textResponse('child done'),
      textResponse('parent done'),
    ])
    // The boot composition creates the parent on the stale route...
    const parent = ctx.agentLoop.create(
      SessionId('parent'),
      { provider: 'dormant-route', model: 'stale-model' },
    )
    // ...and the host then installs the user's live selection over every
    // parent request (api-bridge `ensureSelection`; the desktop gateway's model
    // switch rides the same waterfall). The parent has no key for the stale
    // route — the user picked the live one precisely because it works.
    installModelSelection(parent.ctx, {
      current: { provider: 'live-route', model: 'live-model' },
      assembled: undefined,
    })

    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'delegate please' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()

    // The delegation succeeded end to end: the parent received the child's
    // foreground output instead of the stop-reason error.
    const results = toolResultTexts(parent).join('\n')
    expect(results).toContain('child done')
    expect(results).not.toContain('subagent run failed')

    // The child's one model call resolved to the live route: the route whose
    // key the host can resolve served it, and the dormant route — the parent's
    // static creation options — dispatched nothing.
    expect(live.requests).toHaveLength(3)
    const childRequest = live.requests[1]
    expect(childRequest?.sessionId).toBeDefined()
    expect(childRequest?.sessionId).not.toBe(parent.session.id)
    expect(childRequest?.provider).toBe('live-route')
    expect(childRequest?.model).toBe('live-model')
    expect(dormant.requests).toHaveLength(0)
  })

  it('falls back to the parent creation options when no request header is logged yet', async () => {
    const { ctx, live, dormant } = await mount([textResponse('child done')])
    // A programmatic delegation from a parent that has not run a model call
    // yet has no logged header: the static creation options stay the only
    // inherited route.
    const parent = ctx.agentLoop.create(
      SessionId('parent'),
      { provider: 'live-route', model: 'live-model' },
    )

    const run = await startInProcessRun({
      label: 'child task',
      prompt: [{ type: 'text', text: 'standalone task' }],
      parent,
      signal: new AbortController().signal,
      descriptor: snapshotSubagentDescriptor({
        mode: 'one-shot',
        provider: 'spawn',
        label: 'child task',
      }),
    }, {})
    try {
      const result = await run.result
      expect(result.stopReason).toBe('completed')
      expect(parent.session.requestHeader()).toBeUndefined()
      expect(dormant.requests).toHaveLength(0)
      expect(live.requests).toHaveLength(1)
      expect(live.requests[0]?.provider).toBe('live-route')
      const child = run.localAgent as Agent
      expect(child.session.requestHeader()?.config).toMatchObject({
        provider: 'live-route',
        model: 'live-model',
      })
    } finally {
      await run.dispose()
    }
  })
})
