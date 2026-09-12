/**
 * Anthropic Messages API adapter for the extension host.
 *
 * Implements the dsh {@link LlmAdapter} contract natively (no Node-only
 * peers): system slot extraction, tool_use/tool_result content blocks,
 * `using`-free streaming over the raw SSE body, and the harness StreamChunk
 * protocol (block-start/delta/block-end/usage/finish ordering).
 *
 * Endpoint joining: `${base}/v1/messages`, tolerating bases that already end
 * in a version segment or the full method path.
 */

import {
  ToolCallId,
  LlmAdapter,
  LlmError,
  attributionHeaders,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { collectImageRefs, resolveWireImages, wireImageOf } from './image-parts.ts'
import type { WireImageTable } from './image-parts.ts'

/** One advisory catalog model. */
export interface AnthropicCatalogModel {
  id: string
  name: string
  description?: string
  contextWindow?: number
  /** Per-request output cap; omission falls back to the connection's maxTokens. */
  maxTokens?: number
  /** Input modalities the declaring layer records; absence stays the text-only floor. */
  input?: ReadonlyArray<'text' | 'image'>
}

/** Per-request connection facts (mirrors the deepseek adapter's shape). */
interface AnthropicConnectionOptions {
  baseURL: string
  /** Credential reference name, resolved per request by the owner. */
  apiKeyEnv: string
  models: AnthropicCatalogModel[]
  maxTokens: number
  defaultContextWindow: number
  /**
   * Deployment-owned request headers merged beneath this adapter's controlled
   * fields: content-type, x-api-key, anthropic-version, and attribution are
   * written after them, so those names always win. Reserved names are refused
   * where the declaring layer accepts the header text.
   */
  headers?: Record<string, string>
  /**
   * Deployment-derived auth headers computed from the resolved API key — the
   * key is per-request state the static `headers` cannot see. Compat
   * gateways that authenticate with `Authorization: Bearer` (Zhipu's
   * Anthropic endpoint) declare it here; the controlled `x-api-key` still
   * rides along and harmless extra auth on a dual-accepting endpoint.
   */
  authHeaders?: (apiKey: string) => Record<string, string>
  streamIdleTimeoutMs: number
}

export interface AnthropicAdapterOptions {
  options: () => AnthropicConnectionOptions
  resolveApiKey: (connection: AnthropicConnectionOptions) => Promise<string>
  /**
   * Durable byte resolver for an image reference (see
   * `attachmentResolverOf`). Omission turns the adapter text-only: an image
   * block in derived history refuses with `UNSUPPORTED_CONTENT` before any
   * bytes are requested.
   */
  resolveImage?: (ref: ImageAttachmentRef) => Promise<StoredImageAttachment>
}

/** Join a base URL with the Messages API method path. */
export function resolveAnthropicEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base.endsWith('/messages')) return base
  if (/\/v\d+$/.test(base)) return `${base}/messages`
  return `${base}/v1/messages`
}

// ── request-body conversion ──

type WireBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: true }

interface WireMessage {
  role: 'user' | 'assistant'
  content: string | WireBlock[]
}

function parseToolInput(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // Malformed arguments degrade to an empty input; the harness keeps the
    // raw string in the durable log either way.
  }
  return {}
}

/**
 * Convert the harness conversation into Anthropic Messages wire messages.
 * @param messages - the harness conversation, in order.
 * @param images - resolved base64 bytes for the request's image references
 *   (see {@link resolveWireImages}); an image block with no table entry is an
 *   internal wiring failure and refuses instead of flattening.
 * @returns the system slot text and the wire messages.
 */
export function toAnthropicRequestMessages(
  messages: readonly Message[],
  images: WireImageTable = new Map(),
): { system: string | undefined; messages: WireMessage[] } {
  const systemParts: string[] = []
  const wire: WireMessage[] = []

  const pushUserBlocks = (blocks: WireBlock[], text: string): void => {
    if (blocks.length === 0 && text === '') return
    const last = wire[wire.length - 1]
    if (last !== undefined && last.role === 'user' && Array.isArray(last.content)) {
      const toolResults = last.content.filter(block => block.type === 'tool_result')
      const others = last.content.filter(block => block.type !== 'tool_result')
      last.content = [...toolResults, ...blocks, ...others]
      if (text !== '') last.content.push({ type: 'text', text })
      return
    }
    if (blocks.length === 0) {
      wire.push({ role: 'user', content: text })
      return
    }
    const content = [...blocks]
    if (text !== '') content.push({ type: 'text', text })
    wire.push({ role: 'user', content })
  }

  for (const message of messages) {
    if (message.role === 'system') {
      const text = message.content
        .filter(block => block.type === 'text')
        .map(block => (block as { text: string }).text)
        .join('\n')
      if (text !== '') systemParts.push(text)
      continue
    }
    if (message.role === 'assistant') {
      const blocks: WireBlock[] = []
      let text = ''
      for (const block of message.content) {
        if (block.type === 'text' && block.text !== '') {
          text = text === '' ? block.text : `${text}\n\n${block.text}`
        } else if (block.type === 'tool-call') {
          blocks.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: parseToolInput(block.arguments),
          })
        }
        // reasoning blocks are provider-private; Anthropic has no passback slot.
      }
      if (blocks.length === 0 && text === '') continue
      if (blocks.length === 0) {
        const last = wire[wire.length - 1]
        if (last !== undefined && last.role === 'assistant' && typeof last.content === 'string') {
          last.content = `${last.content}\n\n${text}`
        } else {
          wire.push({ role: 'assistant', content: text })
        }
        continue
      }
      const content: WireBlock[] = []
      if (text !== '') content.push({ type: 'text', text })
      content.push(...blocks)
      const last = wire[wire.length - 1]
      if (last !== undefined && last.role === 'assistant' && Array.isArray(last.content)) {
        last.content = [...last.content, ...content]
      } else {
        wire.push({ role: 'assistant', content })
      }
      continue
    }
    // user role: text blocks join; image blocks become base64 source parts;
    // tool-result blocks become tool_result (kept first — Anthropic requires
    // them at the head of the message that answers the tool_calls turn).
    // Images nested inside a tool result (e.g. page_screenshot) ride the same
    // image-parts lane — dropping them would flatten the capture to its text
    // envelope and the model would never see the evidence.
    const toolResults: WireBlock[] = []
    const imageParts: WireBlock[] = []
    const texts: string[] = []
    for (const block of message.content) {
      if (block.type === 'tool-result') {
        const inner = block.content
          .filter(inner => inner.type === 'text')
          .map(inner => (inner as { text: string }).text)
          .join('\n')
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: inner === '' ? '(空结果)' : inner,
          ...(block.isError === true ? { is_error: true as const } : {}),
        })
        for (const innerBlock of block.content) {
          if (innerBlock.type !== 'image') continue
          const image = wireImageOf(images, innerBlock.attachment)
          imageParts.push({
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.data },
          })
        }
      } else if (block.type === 'text' && block.text !== '') {
        texts.push(block.text)
      } else if (block.type === 'image') {
        const image = wireImageOf(images, block.attachment)
        imageParts.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.data },
        })
      }
    }
    pushUserBlocks([...toolResults, ...imageParts], texts.join('\n\n'))
  }

  if (wire.length > 0 && (wire[0] as { role?: string }).role === 'assistant') {
    wire.unshift({ role: 'user', content: '(start)' })
  }
  return {
    system: systemParts.length > 0 ? systemParts.join('\n') : undefined,
    messages: wire,
  }
}

// ── wire types (stream events) ──

interface StreamEvent {
  type?: string
  message?: { usage?: { input_tokens?: unknown } }
  index?: unknown
  content_block?: { type?: string; id?: unknown; name?: unknown }
  delta?: { type?: string; text?: unknown; partial_json?: unknown; thinking?: unknown; stop_reason?: unknown }
  usage?: { output_tokens?: unknown }
  error?: { message?: unknown }
}

function mapStopReason(reason: unknown): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return { kind: 'stop' }
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${String(reason)}`, code: String(reason ?? 'UNKNOWN').toUpperCase() },
      }
  }
}

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId: string
  name: string
}

function closeBlock(block: OpenBlock): StreamChunk {
  switch (block.kind) {
    case 'text':
      return { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
    case 'reasoning':
      return { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
    case 'tool-call':
      return {
        type: 'block-end',
        index: block.index,
        block: {
          type: 'tool-call',
          id: ToolCallId(block.callId),
          name: block.name,
          arguments: block.text.trim() === '' ? '{}' : block.text,
        },
      }
  }
}

/** Minimal SSE line reader over a fetch body (no external dependency). */
async function* ssePayloads(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []
  try {
    for (;;) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const nl = buffer.indexOf('\n')
        if (nl === -1) break
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line === '') {
          if (dataLines.length > 0) {
            yield dataLines.join('\n')
            dataLines = []
          }
          continue
        }
        if (line.startsWith(':')) continue
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, ''))
    if (dataLines.length > 0) yield dataLines.join('\n')
  } finally {
    reader.releaseLock()
  }
}

/** HTTP status → LlmError code (deepseek-adapter parity). */
function httpError(status: number, body: string): LlmError {
  const detail = body.slice(0, 300)
  if (status === 401 || status === 403) {
    return new LlmError(`Anthropic API 拒绝了凭据（HTTP ${status}）：${detail}`, 'AUTH')
  }
  if (status === 429) {
    return new LlmError(`Anthropic API 限流（HTTP 429）：${detail}`, 'RATE_LIMIT')
  }
  if (status === 400) {
    return new LlmError(`Anthropic API 请求被拒绝（HTTP 400）：${detail}`, 'BAD_REQUEST')
  }
  return new LlmError(`Anthropic API 请求失败（HTTP ${status}）：${detail}`, 'TRANSPORT')
}

/** Extract the provider error message from a non-2xx body when present. */
async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text()
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } }
      if (typeof parsed.error?.message === 'string' && parsed.error.message !== '') {
        return parsed.error.message
      }
    } catch {
      // non-JSON body
    }
    return text
  } catch {
    return ''
  }
}

/** The declared modality list, or the text-only floor every protocol carries. */
function inputModalitiesOf(model: AnthropicCatalogModel): ReadonlyArray<'text' | 'image'> {
  return model.input === undefined || model.input.length === 0 ? ['text'] : model.input
}

export class AnthropicAdapter extends LlmAdapter {
  constructor(private readonly config: AnthropicAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Anthropic' }
  }

  override providerRetryPolicy(_provider: string) {
    return resolveRetryPolicy(undefined, 'chrome-anthropic: retryPolicy')
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(
      this.config.options().models.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        inputModalities: [...inputModalitiesOf(model)],
        outputModalities: ['text' as const],
      })),
    )
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: configured?.name ?? model,
      contextWindow: configured?.contextWindow ?? connection.defaultContextWindow,
      inputModalities: [...(configured === undefined ? (['text'] as const) : inputModalitiesOf(configured))],
      outputModalities: ['text'],
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey(connection)
    const images = await resolveWireImages(collectImageRefs(options.messages), this.config.resolveImage)
    const { system, messages } = toAnthropicRequestMessages(options.messages, images)
    const configured = connection.models.find(entry => entry.id === options.model)

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens ?? configured?.maxTokens ?? connection.maxTokens,
      stream: true,
      messages,
    }
    if (system !== undefined) body.system = system
    if (options.temperature !== undefined) body.temperature = Math.min(1, Math.max(0, options.temperature))
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }))
    }

    let response: Response
    try {
      response = await fetch(resolveAnthropicEndpoint(connection.baseURL), {
        method: 'POST',
        headers: {
          ...connection.headers,
          ...connection.authHeaders?.(apiKey),
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new LlmError(`Anthropic API 网络请求失败（${connection.baseURL}）：${error instanceof Error ? error.message : String(error)}`, 'TRANSPORT')
    }

    if (!response.ok) {
      throw httpError(response.status, await readErrorBody(response))
    }
    if (response.body === null) {
      throw new LlmError('Anthropic API 返回了空响应体', 'BAD_RESPONSE')
    }

    const blocks = new Map<number, OpenBlock>()
    const order: OpenBlock[] = []
    let usage: TokenUsage | undefined
    let finish: FinishReason | undefined
    let sawContent = false

    for await (const payload of ssePayloads(response.body, options.signal)) {
      if (payload === '[DONE]' || payload === '') continue
      let parsed: StreamEvent
      try {
        parsed = JSON.parse(payload) as StreamEvent
      } catch {
        continue
      }
      switch (parsed.type) {
        case 'message_start': {
          const input = parsed.message?.usage?.input_tokens
          if (typeof input === 'number') {
            usage = { inputTokens: input, outputTokens: 0 }
          }
          break
        }
        case 'content_block_start': {
          if (typeof parsed.index !== 'number') break
          const blockType = parsed.content_block?.type
          const kind: OpenBlock['kind'] =
            blockType === 'tool_use' ? 'tool-call' : blockType === 'thinking' ? 'reasoning' : 'text'
          const block: OpenBlock = {
            index: parsed.index,
            kind,
            text: '',
            callId: typeof parsed.content_block?.id === 'string' ? (parsed.content_block.id as string) : '',
            name: typeof parsed.content_block?.name === 'string' ? (parsed.content_block.name as string) : '',
          }
          blocks.set(parsed.index, block)
          order.push(block)
          sawContent = true
          yield {
            type: 'block-start',
            index: block.index,
            blockType: kind === 'tool-call' ? 'tool-call' : kind === 'reasoning' ? 'reasoning' : 'text',
          }
          break
        }
        case 'content_block_delta': {
          if (typeof parsed.index !== 'number') break
          const block = blocks.get(parsed.index)
          if (block === undefined) break
          const delta = parsed.delta
          if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
            block.text += delta.text
            yield { type: 'text-delta', index: block.index, text: delta.text }
          } else if (delta?.type === 'thinking_delta') {
            const text = typeof delta.thinking === 'string' ? delta.thinking : typeof delta.text === 'string' ? delta.text : ''
            if (text !== '') {
              block.text += text
              yield { type: 'reasoning-delta', index: block.index, text }
            }
          } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            block.text += delta.partial_json
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: ToolCallId(block.callId),
              ...(block.name !== '' && block.text === delta.partial_json ? { name: block.name } : {}),
              argumentsDelta: delta.partial_json,
            }
          }
          break
        }
        case 'content_block_stop': {
          if (typeof parsed.index !== 'number') break
          const block = blocks.get(parsed.index)
          if (block !== undefined) {
            blocks.delete(parsed.index)
            yield closeBlock(block)
          }
          break
        }
        case 'message_delta': {
          if (parsed.delta?.stop_reason !== undefined && parsed.delta.stop_reason !== null) {
            finish = mapStopReason(parsed.delta.stop_reason)
          }
          const output = parsed.usage?.output_tokens
          if (typeof output === 'number') {
            usage = { inputTokens: usage?.inputTokens ?? 0, outputTokens: output }
          }
          break
        }
        case 'message_stop': {
          for (const block of [...blocks.values()].sort((a, b) => a.index - b.index)) {
            yield closeBlock(block)
          }
          blocks.clear()
          if (usage !== undefined) yield { type: 'usage', usage }
          const reason = finish ?? { kind: 'stop' as const }
          yield {
            type: 'finish',
            reason: reason.kind === 'stop' && !sawContent
              ? {
                kind: 'error',
                failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' },
              }
              : reason,
          }
          return
        }
        case 'error': {
          throw new LlmError(`Anthropic API 流式错误：${String(parsed.error?.message ?? '未知错误')}`, 'TRANSPORT')
        }
        default:
          // ping / content_block related noise
          break
      }
    }

    // Stream ended without message_stop: close what is open and finish.
    for (const block of order) {
      if (blocks.has(block.index)) {
        blocks.delete(block.index)
        yield closeBlock(block)
      }
    }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: finish ?? { kind: 'stop' } }
  }
}
