/**
 * Responses adapter: endpoint joining, harness→wire item conversion, and the
 * SSE event → StreamChunk translation (ordering contract: deltas as they
 * arrive; block-end/usage before the terminal finish; nothing after).
 */

import { describe, expect, it } from 'vitest'
import {
  ResponsesAdapter,
  resolveResponsesEndpoint,
  toResponsesRequestItems,
} from '../src/chrome/responses-adapter.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

const msg = (role: Message['role'], content: Message['content']): Message =>
  ({ id: 'm' as never, role, content, source: { kind: 'user' } as never })

describe('resolveResponsesEndpoint', () => {
  it('appends the method path, tolerating trailing slashes and full endpoints', () => {
    expect(resolveResponsesEndpoint('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/responses')
    expect(resolveResponsesEndpoint('https://proxy.example/v1/')).toBe('https://proxy.example/v1/responses')
    expect(resolveResponsesEndpoint('https://x.example/v1/responses')).toBe('https://x.example/v1/responses')
  })
})

describe('toResponsesRequestItems', () => {
  it('extracts instructions, converts tool calls/results, keeps arrival order', () => {
    const { instructions, items } = toResponsesRequestItems([
      msg('system', [{ type: 'text', text: 'SYS' }]),
      msg('user', [{ type: 'text', text: '任务' }]),
      msg('assistant', [
        { type: 'text', text: '我来处理' },
        { type: 'tool-call', id: 'c1' as never, name: 'page_snapshot', arguments: '{}' },
      ]),
      msg('user', [{ type: 'tool-result', toolCallId: 'c1' as never, content: [{ type: 'text', text: 'R1' }] }]),
      msg('user', [{ type: 'text', text: 'OBS' }]),
    ])
    expect(instructions).toBe('SYS')
    expect(items).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '任务' }] },
      { role: 'assistant', content: [{ type: 'input_text', text: '我来处理' }] },
      { type: 'function_call', call_id: 'c1', name: 'page_snapshot', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'R1' },
      { role: 'user', content: [{ type: 'input_text', text: 'OBS' }] },
    ])
  })

  it('normalizes empty tool arguments and empty tool results', () => {
    const { items } = toResponsesRequestItems([
      msg('assistant', [{ type: 'tool-call', id: 'c1' as never, name: 't', arguments: '  ' }]),
      msg('user', [{ type: 'tool-result', toolCallId: 'c1' as never, content: [] }]),
    ])
    expect(items[0]).toMatchObject({ type: 'function_call', arguments: '{}' })
    expect(items[1]).toMatchObject({ type: 'function_call_output', output: '(空结果)' })
  })

  it('emits input_image data-URL parts from the resolved byte table, in order', () => {
    const { items } = toResponsesRequestItems([
      msg('user', [
        { type: 'image', attachment: { attachmentId: 'sha256:aa', mediaType: 'image/png' } as never },
        { type: 'text', text: '这是什么？' },
        { type: 'image', attachment: { attachmentId: 'sha256:bb', mediaType: 'image/jpeg' } as never },
      ]),
    ], new Map([
      ['sha256:aa', { mediaType: 'image/png', data: 'QUFB' }],
      ['sha256:bb', { mediaType: 'image/jpeg', data: 'QkJC' }],
    ]))
    expect(items).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,QUFB' },
          { type: 'input_text', text: '这是什么？' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,QkJC' },
        ],
      },
    ])
  })

  it('refuses an image block missing from the resolved table (wiring failure)', () => {
    expect(() => toResponsesRequestItems([
      msg('user', [{ type: 'image', attachment: { attachmentId: 'sha256:cc' } as never }]),
    ])).toThrow(/not resolved/)
  })

  it('lifts an image nested inside a tool-result content into an input_image part', () => {
    // page_screenshot returns [text envelope, image] as the tool-result
    // content; dropping the nested block would flatten the capture to its
    // text envelope and the model would never see the evidence.
    const { items } = toResponsesRequestItems([
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
    expect(items).toEqual([
      { type: 'function_call', call_id: 'c1', name: 'page_screenshot', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'PNG screenshot (viewport), 800x600 px' },
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,aW1nMg==' },
          { type: 'input_text', text: '描述截图' },
        ],
      },
    ])
  })

  it('refuses a tool-result-nested image missing from the resolved table', () => {
    expect(() => toResponsesRequestItems([
      msg('user', [{
        type: 'tool-result',
        toolCallId: 'c1' as never,
        content: [{ type: 'image', attachment: { attachmentId: 'sha256:gone' } as never }],
      }]),
    ])).toThrow(/not resolved/)
  })
})

describe('ResponsesAdapter.stream translation', () => {
  /** @param body - the scripted SSE reply; @param wire - records each request as sent. */
  const makeAdapter = (
    body: ReadableStream<Uint8Array>,
    wire?: Array<{ url: string; headers: Record<string, string>; payload: Record<string, unknown> }>,
  ): ResponsesAdapter => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      if (wire !== undefined) {
        wire.push({
          url: String(input),
          headers: Object.fromEntries(new Headers(init?.headers)),
          payload: JSON.parse(init?.body ?? '{}') as Record<string, unknown>,
        })
      }
      return new Response(body, { status: 200 })
    }) as typeof fetch
    void originalFetch
    return new ResponsesAdapter({
      options: () => ({
        baseURL: 'https://gateway.example/v1',
        apiKeyEnv: 'ACME_API_KEY',
        models: [{ id: 'acme-large', name: 'Acme Large', maxTokens: 4096 }],
        maxTokens: 256,
        defaultContextWindow: 131_072,
        streamIdleTimeoutMs: 300_000,
      }),
      resolveApiKey: async () => 'sk-test',
    })
  }

  it('sends the Responses request shape with the per-model output cap', async () => {
    const wire: Array<{ url: string; headers: Record<string, string>; payload: Record<string, unknown> }> = []
    const adapter = makeAdapter(sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'ok' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } },
    ]), wire)
    for await (const chunk of adapter.stream({
      provider: 'acme', model: 'acme-large', system: 'SYS', messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    })) {
      void chunk
    }
    expect(wire[0]?.url).toBe('https://gateway.example/v1/responses')
    expect(wire[0]?.headers['authorization']).toBe('Bearer sk-test')
    expect(wire[0]?.payload).toMatchObject({
      model: 'acme-large',
      instructions: 'SYS',
      store: false,
      max_output_tokens: 4096,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    })
  })

  it('translates text + function calls + usage into ordered StreamChunks', async () => {
    const adapter = makeAdapter(sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: '你' },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: '好' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'page_click' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"ind' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: 'ex":1}' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'page_click' } },
      { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 8 } } },
    ]))

    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'acme', model: 'acme-large', messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    })) {
      chunks.push(chunk)
    }

    expect(chunks.filter(chunk => (chunk as { type: string }).type === 'block-start')).toHaveLength(2)
    const deltas = chunks.filter(chunk => (chunk as { type: string }).type === 'text-delta') as Array<{ text: string }>
    expect(deltas.map(delta => delta.text).join('')).toBe('你好')
    const argDeltas = chunks.filter(chunk => (chunk as { type: string }).type === 'tool-call-delta') as Array<{ argumentsDelta: string }>
    expect(argDeltas.map(delta => delta.argumentsDelta).join('')).toBe('{"index":1}')
    const ends = chunks.filter(chunk => (chunk as { type: string }).type === 'block-end') as Array<{ block: Record<string, unknown> }>
    expect(ends[0]!.block).toEqual({ type: 'text', text: '你好' })
    expect(ends[1]!.block).toEqual({ type: 'tool-call', id: 'c1', name: 'page_click', arguments: '{"index":1}' })
    const usageIndex = chunks.findIndex(chunk => (chunk as { type: string }).type === 'usage')
    const finishIndex = chunks.findIndex(chunk => (chunk as { type: string }).type === 'finish')
    expect(usageIndex).toBeGreaterThan(-1)
    expect(usageIndex).toBeLessThan(finishIndex)
    expect(finishIndex).toBe(chunks.length - 1)
    expect((chunks[finishIndex] as { reason: { kind: string } }).reason.kind).toBe('tool-calls')
  })

  it('maps an incomplete response to a max-tokens finish and reports stream failures', async () => {
    const adapter = makeAdapter(sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: '截断' },
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 3, output_tokens: 4096 } } },
    ]))
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'acme', model: 'acme-large', messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    })) {
      chunks.push(chunk)
    }
    const finish = chunks[chunks.length - 1] as { reason: { kind: string } }
    expect(finish.reason.kind).toBe('max-tokens')

    const failed = makeAdapter(sse([{ type: 'response.failed', response: { error: { message: 'upstream down' } } }]))
    await expect(async () => {
      for await (const _chunk of failed.stream({
        provider: 'acme', model: 'acme-large', messages: [msg('user', [{ type: 'text', text: 'hi' }])],
      })) {
        void _chunk
      }
    }).rejects.toThrow(/upstream down/)
  })

  it('reports declared input modalities from the catalog', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(sse([{ type: 'response.completed', response: {} }]), { status: 200 }))
    try {
      const adapter = new ResponsesAdapter({
        options: () => ({
          baseURL: 'https://gateway.example/v1',
          apiKeyEnv: 'ACME_API_KEY',
          models: [
            { id: 'text-only' },
            { id: 'vision', input: ['text', 'image'] },
          ],
          maxTokens: 256,
          defaultContextWindow: 131_072,
          streamIdleTimeoutMs: 300_000,
        }),
        resolveApiKey: async () => 'sk-test',
      })
      const models = await adapter.listModels('acme')
      expect(models.map(model => model.inputModalities)).toEqual([['text'], ['text', 'image']])
      const resolved = await adapter.resolveModel('acme', 'vision')
      expect(resolved.inputModalities).toEqual(['text', 'image'])
    } finally {
      void originalFetch
    }
  })

  it('classifies a mid-stream body failure as TRANSPORT for the retry executor', async () => {
    // The browser rejects a dropped response body with a bare TypeError
    // ("network error"); leaving it uncoded would bypass dsh-llm-retry's
    // retryable-code routing and end the turn on a manual-retry card.
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `event: x\ndata: ${JSON.stringify({ type: 'response.created', response: {} })}\n\n`,
        ))
        controller.error(new TypeError('network error'))
      },
    })
    const adapter = makeAdapter(broken)
    await expect(async () => {
      for await (const chunk of adapter.stream({
        provider: 'acme', model: 'acme-large', messages: [msg('user', [{ type: 'text', text: 'hi' }])],
      })) {
        void chunk
      }
    }).rejects.toMatchObject({ failure: { code: 'TRANSPORT', message: /流传输中断.*network error/ } })
  })
})

/** Build an SSE body from JSON payloads the way a provider would stream them. */
function sse(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const text = events.map(event => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('')
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}
