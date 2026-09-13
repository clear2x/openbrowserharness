/**
 * Anthropic adapter: endpoint joining, harness→wire message conversion, and
 * the SSE event → StreamChunk translation (ordering contract: deltas as they
 * arrive; block-end/usage before the terminal finish; nothing after).
 */

import { describe, expect, it } from 'vitest'
import {
  AnthropicAdapter,
  resolveAnthropicEndpoint,
  toAnthropicRequestMessages,
} from '../src/chrome/anthropic-adapter.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

const msg = (role: Message['role'], content: Message['content']): Message =>
  ({ id: 'm' as never, role, content, source: { kind: 'user' } as never })

describe('resolveAnthropicEndpoint', () => {
  it('joins version segments and full endpoints', () => {
    expect(resolveAnthropicEndpoint('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages')
    expect(resolveAnthropicEndpoint('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/messages')
    expect(resolveAnthropicEndpoint('https://proxy.example/v1/')).toBe('https://proxy.example/v1/messages')
    expect(resolveAnthropicEndpoint('https://x.example/v1/messages')).toBe('https://x.example/v1/messages')
  })
})

describe('toAnthropicRequestMessages', () => {
  it('extracts system, converts tool_use/tool_result, keeps tool_result first', () => {
    const { system, messages } = toAnthropicRequestMessages([
      msg('system', [{ type: 'text', text: 'SYS' }]),
      msg('user', [{ type: 'text', text: '任务' }]),
      msg('assistant', [
        { type: 'text', text: '我来处理' },
        { type: 'tool-call', id: 'c1' as never, name: 'page_snapshot', arguments: '{}' },
        { type: 'tool-call', id: 'c2' as never, name: 'page_click', arguments: '{"index":3}' },
      ]),
      msg('user', [{ type: 'tool-result', toolCallId: 'c1' as never, content: [{ type: 'text', text: 'R1' }] }]),
      msg('user', [{ type: 'tool-result', toolCallId: 'c2' as never, content: [{ type: 'text', text: 'R2' }] }]),
      msg('user', [{ type: 'text', text: 'OBS' }]),
    ])
    expect(system).toBe('SYS')
    expect(messages).toHaveLength(3)
    expect(messages[0]).toEqual({ role: 'user', content: '任务' })
    const assistant = messages[1]!.content as Array<Record<string, unknown>>
    expect(assistant[0]).toEqual({ type: 'text', text: '我来处理' })
    expect(assistant[1]).toEqual({ type: 'tool_use', id: 'c1', name: 'page_snapshot', input: {} })
    expect(assistant[2]).toEqual({ type: 'tool_use', id: 'c2', name: 'page_click', input: { index: 3 } })
    const merged = messages[2]!.content as Array<Record<string, unknown>>
    expect(merged).toHaveLength(3)
    expect(merged[0]).toEqual({ type: 'tool_result', tool_use_id: 'c1', content: 'R1' })
    expect(merged[1]).toEqual({ type: 'tool_result', tool_use_id: 'c2', content: 'R2' })
    expect(merged[2]).toEqual({ type: 'text', text: 'OBS' })
  })

  it('pads a leading assistant message and drops reasoning blocks', () => {
    const { messages } = toAnthropicRequestMessages([
      msg('assistant', [
        { type: 'reasoning', text: '思考' },
        { type: 'text', text: '答案' },
      ]),
    ])
    expect(messages[0]).toEqual({ role: 'user', content: '(start)' })
    expect(messages[1]).toEqual({ role: 'assistant', content: '答案' })
  })

  it('emits base64 image source parts after tool results, before text', () => {
    const { messages } = toAnthropicRequestMessages([
      msg('assistant', [{ type: 'tool-call', id: 'c1' as never, name: 'page_screenshot', arguments: '{}' }]),
      msg('user', [
        { type: 'tool-result', toolCallId: 'c1' as never, content: [{ type: 'text', text: 'R1' }] },
        { type: 'image', attachment: { attachmentId: 'sha256:ab', mediaType: 'image/png' } as never },
        { type: 'text', text: '这张截图里有什么？' },
      ]),
    ], new Map([['sha256:ab', { mediaType: 'image/png', data: 'aW1n' }]]))
    // The leading assistant turn pads a '(start)' user message at index 0.
    const merged = messages[2]!.content as Array<Record<string, unknown>>
    expect(merged).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'R1' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1n' } },
      { type: 'text', text: '这张截图里有什么？' },
    ])
  })

  it('lifts an image nested inside a tool-result content into an image part', () => {
    // page_screenshot returns [text envelope, image] as the tool-result
    // content; dropping the nested block would flatten the capture to its
    // text envelope and the model would never see the evidence.
    const { messages } = toAnthropicRequestMessages([
      msg('assistant', [{ type: 'tool-call', id: 'c1' as never, name: 'page_screenshot', arguments: '{}' }]),
      msg('user', [
        {
          type: 'tool-result',
          toolCallId: 'c1' as never,
          content: [
            { type: 'text', text: 'PNG screenshot (viewport), 800x600 px' },
            { type: 'image', attachment: { attachmentId: 'sha256:n1', mediaType: 'image/png' } as never },
          ],
        },
        { type: 'text', text: '描述截图' },
      ]),
    ], new Map([['sha256:n1', { mediaType: 'image/png', data: 'aW1nMg==' }]]))
    const merged = messages[2]!.content as Array<Record<string, unknown>>
    expect(merged).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'PNG screenshot (viewport), 800x600 px' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1nMg==' } },
      { type: 'text', text: '描述截图' },
    ])
  })

  it('refuses a tool-result-nested image missing from the resolved table', () => {
    expect(() => toAnthropicRequestMessages([
      msg('user', [{
        type: 'tool-result',
        toolCallId: 'c1' as never,
        content: [{ type: 'image', attachment: { attachmentId: 'sha256:gone' } as never }],
      }]),
    ])).toThrow(/not resolved/)
  })

  it('refuses an image block missing from the resolved table (wiring failure)', () => {
    expect(() => toAnthropicRequestMessages([
      msg('user', [{ type: 'image', attachment: { attachmentId: 'sha256:cd' } as never }]),
    ])).toThrow(/not resolved/)
  })
})

/** Encode one SSE body from event payloads. */
const sse = (events: unknown[]): ReadableStream<Uint8Array> => {
  const text = events.map(event => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('')
  const encoder = new TextEncoder()
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= text.length) {
        controller.close()
        return
      }
      const chunk = text.slice(offset, offset + 7)
      offset += 7
      controller.enqueue(encoder.encode(chunk))
    },
  })
}

describe('AnthropicAdapter.stream translation', () => {
  /**
   * @param body - the scripted SSE reply.
   * @param connectHeaders - extra connection-facts headers the adapter should
   *   merge beneath its own controlled fields.
   * @param wire - when given, records each request's headers as sent.
   */
  const makeAdapter = (
    body: ReadableStream<Uint8Array>,
    connectHeaders?: Record<string, string>,
    wire?: Array<Record<string, string>>,
  ): AnthropicAdapter => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: unknown, init?: { headers?: Record<string, string> }) => {
      if (wire !== undefined) wire.push(Object.fromEntries(new Headers(init?.headers)))
      return new Response(body, { status: 200 })
    }) as typeof fetch
    const adapter = new AnthropicAdapter({
      options: () => ({
        baseURL: 'https://api.anthropic.com',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
        maxTokens: 1024,
        defaultContextWindow: 200_000,
        streamIdleTimeoutMs: 300_000,
        ...(connectHeaders === undefined ? {} : { headers: connectHeaders }),
      }),
      resolveApiKey: async () => 'sk-test',
    })
    void originalFetch
    return adapter
  }

  it('translates text + tool_use + usage into ordered StreamChunks', async () => {
    const adapter = makeAdapter(sse([
      { type: 'message_start', message: { usage: { input_tokens: 12 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'page_click' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"ind' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ex":1}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ]))

    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'anthropic', model: 'claude-sonnet-4-5', messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    })) {
      chunks.push(chunk)
    }

    expect(chunks.filter(chunk => (chunk as { type: string }).type === 'block-start')).toHaveLength(2)
    const deltas = chunks.filter(chunk => (chunk as { type: string }).type === 'text-delta') as Array<{ text: string }>
    expect(deltas.map(delta => delta.text).join('')).toBe('你好')
    const argDeltas = chunks.filter(chunk => (chunk as { type: string }).type === 'tool-call-delta') as Array<{ argumentsDelta: string }>
    expect(argDeltas.map(delta => delta.argumentsDelta).join('')).toBe('{"index":1}')
    const ends = chunks.filter(chunk => (chunk as { type: string }).type === 'block-end') as Array<{ index: number; block: Record<string, unknown> }>
    expect(ends[0]!.block).toEqual({ type: 'text', text: '你好' })
    expect(ends[1]!.block).toEqual({ type: 'tool-call', id: 't1', name: 'page_click', arguments: '{"index":1}' })
    const finishIndex = chunks.findIndex(chunk => (chunk as { type: string }).type === 'finish')
    const usageIndex = chunks.findIndex(chunk => (chunk as { type: string }).type === 'usage')
    expect(usageIndex).toBeGreaterThan(-1)
    expect(usageIndex).toBeLessThan(finishIndex)
    expect(finishIndex).toBe(chunks.length - 1)
    const finish = chunks[finishIndex] as { reason: { kind: string } }
    expect(finish.reason.kind).toBe('tool-calls')
  })

  it('maps end_turn to stop and empty content to an EMPTY_RESPONSE error finish', async () => {
    const adapter = makeAdapter(sse([
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
      { type: 'message_stop' },
    ]))
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'anthropic', model: 'claude-sonnet-4-5', messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    })) {
      chunks.push(chunk)
    }
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe('EMPTY_RESPONSE')
  })

  it('sends connection headers beneath the controlled ones', async () => {
    // A declared route's deployment headers ride along; the credential and the
    // wire-format fields they may never own stay authoritative.
    const wire: Array<Record<string, string>> = []
    const adapter = makeAdapter(
      sse([
        { type: 'message_start', message: { usage: { input_tokens: 1 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]),
      { 'x-tenant': 'acme', 'x-api-key': 'forged' },
      wire,
    )
    for await (const _chunk of adapter.stream({
      provider: 'anthropic', model: 'claude-sonnet-4-5', messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    })) {
      void _chunk
    }

    expect(wire[0]?.['x-tenant']).toBe('acme')
    expect(wire[0]?.['x-api-key']).toBe('sk-test')
    expect(wire[0]?.['anthropic-version']).toBe('2023-06-01')
    expect(wire[0]?.['content-type']).toBe('application/json')
  })
})
