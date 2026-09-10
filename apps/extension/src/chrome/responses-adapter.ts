/**
 * OpenAI Responses API adapter for the extension host.
 *
 * Implements the dsh {@link LlmAdapter} contract natively (no Node-only
 * peers): system slot as `instructions`, tool calls/results as
 * `function_call` / `function_call_output` input items, `using`-free streaming
 * over the raw SSE body, and the harness StreamChunk protocol
 * (block-start/delta/block-end/usage/finish ordering). Durable image blocks
 * resolve through the attachment service before serialization and ride the
 * wire as `input_image` data-URL parts; a request whose references cannot
 * resolve fails loud instead of flattening.
 *
 * Endpoint joining: `${base}/responses`, tolerating bases that already end in
 * the method path.
 */

import {
  CallId,
  LlmAdapter,
  LlmError,
  attributionHeaders,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
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

/** One advisory catalog model a declared Responses route serves. */
export interface ResponsesCatalogModel {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  /** Per-request output cap; omission falls back to the connection's maxTokens. */
  maxTokens?: number
  /** Input modalities the declaring layer records; absence stays the text-only floor. */
  input?: ReadonlyArray<'text' | 'image'>
}

/** Per-request connection facts (mirrors the sibling adapters' shape). */
interface ResponsesConnectionOptions {
  baseURL: string
  /** Credential reference name, resolved per request by the owner. */
  apiKeyEnv: string
  models: ResponsesCatalogModel[]
  maxTokens: number
  defaultContextWindow: number
  /**
   * Deployment-owned request headers merged beneath this adapter's controlled
   * fields: content-type, authorization, and attribution are written after
   * them, so those names always win.
   */
  headers?: Record<string, string>
  streamIdleTimeoutMs: number
}

export interface ResponsesAdapterOptions {
  options: () => ResponsesConnectionOptions
  resolveApiKey: (connection: ResponsesConnectionOptions) => Promise<string>
  /**
   * Durable byte resolver for an image reference (see
   * `attachmentResolverOf`). Omission turns the adapter text-only: an image
   * block in derived history refuses with `UNSUPPORTED_CONTENT` before any
   * bytes are requested.
   */
  resolveImage?: (ref: ImageAttachmentRef) => Promise<StoredImageAttachment>
}

/** Responses requests refuse an output cap below this; the API rejects smaller values. */
const MIN_OUTPUT_TOKENS = 16

/** Join a base URL with the Responses API method path. */
export function resolveResponsesEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base.endsWith('/responses')) return base
  return `${base}/responses`
}

// ── request-body conversion ──

type InputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }

type InputItem =
  | { role: 'user' | 'assistant'; content: InputContent[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

/**
 * Convert the harness conversation into Responses API input items.
 * @param messages - the harness conversation, in order.
 * @param images - resolved base64 bytes for the request's image references
 *   (see {@link resolveWireImages}); an image block with no table entry is an
 *   internal wiring failure and refuses instead of flattening.
 * @returns the instructions text and the input items.
 */
export function toResponsesRequestItems(
  messages: readonly Message[],
  images: WireImageTable = new Map(),
): { instructions: string | undefined; items: InputItem[] } {
  const instructionParts: string[] = []
  const items: InputItem[] = []

  const pushText = (role: 'user' | 'assistant', text: string): void => {
    if (text === '') return
    const last = items[items.length - 1]
    if (last !== undefined && 'role' in last && last.role === role) {
      last.content.push({ type: 'input_text', text })
      return
    }
    items.push({ role, content: [{ type: 'input_text', text }] })
  }

  /** Append one content part into the open user item (opening one when absent). */
  const pushUserPart = (part: InputContent): void => {
    const last = items[items.length - 1]
    if (last !== undefined && 'role' in last && last.role === 'user') {
      last.content.push(part)
      return
    }
    items.push({ role: 'user', content: [part] })
  }

  for (const message of messages) {
    if (message.role === 'system') {
      const text = message.content
        .filter(block => block.type === 'text')
        .map(block => (block as { text: string }).text)
        .join('\n')
      if (text !== '') instructionParts.push(text)
      continue
    }
    if (message.role === 'assistant') {
      let text = ''
      for (const block of message.content) {
        if (block.type === 'text' && block.text !== '') {
          text = text === '' ? block.text : `${text}\n\n${block.text}`
        } else if (block.type === 'tool-call') {
          pushText('assistant', text)
          text = ''
          items.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: block.arguments.trim() === '' ? '{}' : block.arguments,
          })
        }
        // reasoning blocks are provider-private; the Responses passback this
        // adapter serves carries no reasoning replay.
      }
      pushText('assistant', text)
      continue
    }
    // user role: text joins the open user item; tool results become output
    // items in arrival order. Images nested inside a tool result
    // (e.g. page_screenshot) ride the input_image lane beside the output item
    // — dropping them would flatten the capture to its text envelope.
    for (const block of message.content) {
      if (block.type === 'tool-result') {
        const output = block.content
          .filter(inner => inner.type === 'text')
          .map(inner => (inner as { text: string }).text)
          .join('\n')
        items.push({ type: 'function_call_output', call_id: block.toolCallId, output: output === '' ? '(空结果)' : output })
        for (const innerBlock of block.content) {
          if (innerBlock.type !== 'image') continue
          const image = wireImageOf(images, innerBlock.attachment)
          pushUserPart({ type: 'input_image', image_url: `data:${image.mediaType};base64,${image.data}` })
        }
      } else if (block.type === 'text' && block.text !== '') {
        pushText('user', block.text)
      } else if (block.type === 'image') {
        // One data-URL `input_image` part per durable image, riding the same
        // user item as the message's own text.
        const image = wireImageOf(images, block.attachment)
        pushUserPart({ type: 'input_image', image_url: `data:${image.mediaType};base64,${image.data}` })
      }
    }
  }
  return {
    instructions: instructionParts.length > 0 ? instructionParts.join('\n') : undefined,
    items,
  }
}

// ── wire types (stream events) ──

interface StreamEvent {
  type?: string
  item?: { type?: string; id?: unknown; call_id?: unknown; name?: unknown }
  item_id?: unknown
  output_index?: unknown
  content_index?: unknown
  delta?: unknown
  response?: {
    usage?: {
      input_tokens?: unknown
      output_tokens?: unknown
    }
    incomplete_details?: { reason?: unknown }
    error?: { message?: unknown }
  }
  message?: unknown
  code?: unknown
  param?: unknown
}

interface OpenBlock {
  index: number
  kind: 'text' | 'tool-call'
  itemId: string
  callId: string
  name: string
  text: string
}

function closeBlock(block: OpenBlock): StreamChunk {
  if (block.kind === 'text') {
    return { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
  }
  return {
    type: 'block-end',
    index: block.index,
    block: {
      type: 'tool-call',
      id: CallId(block.callId),
      name: block.name,
      arguments: block.text.trim() === '' ? '{}' : block.text,
    },
  }
}

/** Minimal SSE line reader over a fetch body (anthropic-adapter parity). */
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

/** HTTP status → LlmError code (sibling-adapter parity). */
function httpError(status: number, body: string): LlmError {
  const detail = body.slice(0, 300)
  if (status === 401 || status === 403) {
    return new LlmError(`Responses API 拒绝了凭据（HTTP ${status}）：${detail}`, 'AUTH')
  }
  if (status === 429) {
    return new LlmError(`Responses API 限流（HTTP 429）：${detail}`, 'RATE_LIMIT')
  }
  if (status === 400) {
    return new LlmError(`Responses API 请求被拒绝（HTTP 400）：${detail}`, 'BAD_REQUEST')
  }
  return new LlmError(`Responses API 请求失败（HTTP ${status}）：${detail}`, 'TRANSPORT')
}

/** Extract the provider error message from a non-2xx body when present. */
async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text()
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown }
      if (typeof parsed.error?.message === 'string' && parsed.error.message !== '') {
        return parsed.error.message
      }
      if (typeof parsed.message === 'string' && parsed.message !== '') return parsed.message
    } catch {
      // non-JSON body
    }
    return text
  } catch {
    return ''
  }
}

/** The declared modality list, or the text-only floor every protocol carries. */
function inputModalitiesOf(model: ResponsesCatalogModel): ReadonlyArray<'text' | 'image'> {
  return model.input === undefined || model.input.length === 0 ? ['text'] : model.input
}

export class ResponsesAdapter extends LlmAdapter {
  constructor(private readonly config: ResponsesAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Responses' }
  }

  override providerRetryPolicy(_provider: string) {
    return resolveRetryPolicy(undefined, 'chrome-responses: retryPolicy')
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(
      this.config.options().models.map(model => ({
        provider,
        id: model.id,
        name: model.name ?? model.id,
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
    const { instructions, items } = toResponsesRequestItems(options.messages, images)
    const configured = connection.models.find(entry => entry.id === options.model)

    const body: Record<string, unknown> = {
      model: options.model,
      input: items,
      stream: true,
      store: false,
      max_output_tokens: Math.max(
        MIN_OUTPUT_TOKENS,
        options.maxTokens ?? configured?.maxTokens ?? connection.maxTokens,
      ),
    }
    // The loop passes the system slot beside the messages; a hand-built list
    // may instead carry system-role messages, which the conversion extracts.
    const systemText = options.system !== undefined && options.system.trim() !== ''
      ? options.system
      : instructions
    if (systemText !== undefined) body.instructions = systemText
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
    }

    let response: Response
    try {
      response = await fetch(resolveResponsesEndpoint(connection.baseURL), {
        method: 'POST',
        headers: {
          ...connection.headers,
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new LlmError(`Responses API 网络请求失败（${connection.baseURL}）：${error instanceof Error ? error.message : String(error)}`, 'TRANSPORT')
    }

    if (!response.ok) {
      throw httpError(response.status, await readErrorBody(response))
    }
    if (response.body === null) {
      throw new LlmError('Responses API 返回了空响应体', 'BAD_RESPONSE')
    }

    const blocks = new Map<string, OpenBlock>()
    const order: OpenBlock[] = []
    let usage: TokenUsage | undefined
    let sawToolCall = false
    let sawContent = false
    let finished = false

    for await (const payload of ssePayloads(response.body, options.signal)) {
      if (payload === '[DONE]' || payload === '') continue
      let parsed: StreamEvent
      try {
        parsed = JSON.parse(payload) as StreamEvent
      } catch {
        continue
      }
      switch (parsed.type) {
        case 'response.output_item.added': {
          if (typeof parsed.output_index !== 'number') break
          const itemType = parsed.item?.type
          if (itemType === 'message') {
            const block: OpenBlock = {
              index: parsed.output_index,
              kind: 'text',
              itemId: typeof parsed.item?.id === 'string' ? (parsed.item.id as string) : '',
              callId: '',
              name: '',
              text: '',
            }
            blocks.set(block.itemId, block)
            order.push(block)
            sawContent = true
            yield { type: 'block-start', index: block.index, blockType: 'text' }
          } else if (itemType === 'function_call') {
            const block: OpenBlock = {
              index: parsed.output_index,
              kind: 'tool-call',
              itemId: typeof parsed.item?.id === 'string' ? (parsed.item.id as string) : '',
              callId: typeof parsed.item?.call_id === 'string' ? (parsed.item.call_id as string) : '',
              name: typeof parsed.item?.name === 'string' ? (parsed.item.name as string) : '',
              text: '',
            }
            blocks.set(block.itemId, block)
            order.push(block)
            sawContent = true
            sawToolCall = true
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          }
          // reasoning / other item types have no harness passback here.
          break
        }
        case 'response.output_text.delta': {
          if (typeof parsed.delta !== 'string' || parsed.delta === '') break
          // Current protocol versions name the item; a payload without one
          // targets the open text block, the only item text deltas address.
          const itemId = typeof parsed.item_id === 'string' ? (parsed.item_id as string) : ''
          const block = itemId !== '' && blocks.has(itemId)
            ? blocks.get(itemId)
            : order.findLast(entry => entry.kind === 'text' && blocks.has(entry.itemId))
          if (block === undefined || block.kind !== 'text') break
          block.text += parsed.delta
          yield { type: 'text-delta', index: block.index, text: parsed.delta }
          break
        }
        case 'response.function_call_arguments.delta': {
          const itemId = typeof parsed.item_id === 'string' ? (parsed.item_id as string) : ''
          const block = blocks.get(itemId)
          if (block === undefined || block.kind !== 'tool-call') break
          if (typeof parsed.delta !== 'string' || parsed.delta === '') break
          block.text += parsed.delta
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: CallId(block.callId),
            ...(block.name !== '' && block.text === parsed.delta ? { name: block.name } : {}),
            argumentsDelta: parsed.delta,
          }
          break
        }
        case 'response.output_item.done': {
          const itemId = typeof parsed.item?.id === 'string' ? (parsed.item.id as string) : ''
          const block = blocks.get(itemId)
          if (block === undefined) break
          blocks.delete(itemId)
          yield closeBlock(block)
          break
        }
        case 'response.completed':
        case 'response.incomplete': {
          const input = parsed.response?.usage?.input_tokens
          const output = parsed.response?.usage?.output_tokens
          if (typeof input === 'number' || typeof output === 'number') {
            usage = {
              inputTokens: typeof input === 'number' ? input : 0,
              outputTokens: typeof output === 'number' ? output : 0,
            }
          }
          for (const block of order) {
            if (blocks.has(block.itemId)) {
              blocks.delete(block.itemId)
              yield closeBlock(block)
            }
          }
          if (usage !== undefined) yield { type: 'usage', usage }
          const reason = parsed.type === 'response.completed'
            ? (sawToolCall ? { kind: 'tool-calls' as const } : { kind: 'stop' as const })
            : parsed.response?.incomplete_details?.reason === 'max_output_tokens'
              ? ({ kind: 'max-tokens' as const })
              : ({ kind: 'stop' as const })
          yield {
            type: 'finish',
            reason: reason.kind === 'stop' && !sawContent
              ? {
                kind: 'error',
                failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' },
              }
              : reason,
          }
          finished = true
          return
        }
        case 'response.failed':
        case 'response.error': {
          const detail = parsed.response?.error?.message
          throw new LlmError(`Responses API 流式错误：${typeof detail === 'string' && detail !== '' ? detail : String(parsed.message ?? parsed.code ?? '未知错误')}`, 'TRANSPORT')
        }
        default:
          // response.created / heartbeats / event noise
          break
      }
    }

    if (!finished) {
      // Stream ended without a completion event: close what is open and finish.
      for (const block of order) {
        if (blocks.has(block.itemId)) {
          blocks.delete(block.itemId)
          yield closeBlock(block)
        }
      }
      if (usage !== undefined) yield { type: 'usage', usage }
      yield {
        type: 'finish',
        reason: sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' },
      }
    }
  }
}
