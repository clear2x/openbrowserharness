/**
 * `chrome-page-find-tool`: the `page_find_related` tool (batch 277, hardened
 * in batch 280) — the DOM-candidate semantic pre-filter. Given the user's
 * task, it embeds the page's interactive elements against the task with the
 * local e5 embedding and returns the top-k matches. Every returned element
 * carries a UNIQUE marker selector (`data-dsh-find="<n>"`), so `page_click`
 * / `page_type` / `page_batch_actions` address the exact element regardless
 * of whether the page gave it an id, aria-label, or name. Inference runs in
 * the AI worker (batch 276 contract).
 *
 * The result deliberately carries NO snapshot index: snapshot indexes come
 * from the provider's own snapshot walk, and a rank position passed off as
 * one resolves to whatever element the last `page_snapshot` listed first —
 * a wrong-element click (批280).
 *
 * @module chrome-page-find-tool
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-browser'
import { embedInWorker } from './ai-runtime/worker-bridge.ts'
import {
  COLLECT_EXPRESSION,
  elementEmbedText,
  parseCollectedElements,
  type CollectedElement,
} from './page-find-collector.ts'

/** The usage-ledger recorder face (aiLocal.recordUsage, structurally). */
interface UsageRecorder {
  recordUsage(entry: { capability: 'embed'; model: string; durationMs: number; detail: string }): Promise<void>
}

/** This module carries no config today. */
export interface Config {}

/** The module reads the browser seam; the embedding lives in the worker. */
export const inject = ['tools', 'browser'] as const

/** The per-call deadline (collect + embed + rank). */
const TOOL_TIMEOUT_MS = 60_000

/** One ranked candidate the tool returns. */
export interface RelatedElement {
  tag: string
  role?: string
  text: string
  /** The unique marker selector; usable by every selector-addressed tool. */
  selector: string
  score: number
}

/**
 * Rank elements against the task: one worker call embeds query + passages
 * together, then cosine similarity (both sides normalized → dot product)
 * orders the candidates.
 * @param task - the user's task description.
 * @param elements - the page's collected interactive elements.
 * @returns elements sorted by descending similarity.
 */
export async function rankElementsByTask(task: string, elements: CollectedElement[]): Promise<RelatedElement[]> {
  const passages = elements.map(element => elementEmbedText(element))
  const outcome = await embedInWorker(task, passages) as { query: Float32Array; passages: Float32Array; dim: number }
  const { query, passages: vectors, dim } = outcome
  const scored = elements.map((element, position) => {
    const vector = vectors.slice(position * dim, (position + 1) * dim)
    let dot = 0
    for (let index = 0; index < dim; index += 1) dot += (query[index] ?? 0) * (vector[index] ?? 0)
    return { element, score: dot }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.map(({ element, score }) => ({
    tag: element.tag,
    ...(element.role === undefined ? {} : { role: element.role }),
    text: elementEmbedText(element).slice(0, 120),
    selector: element.selector,
    score: Math.round(score * 1000) / 1000,
  }))
}

/** The model-facing argument record. */
export interface PageFindRelatedArgs {
  tab_id: number
  task: string
  top_k?: number
}

/** The model-facing find value. */
export interface PageFindRelatedValue {
  tabId: number
  task: string
  candidates: RelatedElement[]
  error?: string
}

/**
 * Register the `page_find_related` tool.
 * @param ctx - the cordis context.
 * @param _config - unused config.
 */
export function apply(ctx: Context, _config: Config): void {
  void _config
  ctx.tools.register(defineTool({
    name: 'page_find_related',
    description: '在页面元素中做语义搜索：按任务描述对当前页的可交互元素排序，返回最相关的 top-k 及每个元素的唯一 selector——selector 可直接用于 page_click / page_type / page_batch_actions（在页面跳转或下一次 page_find_related 之前有效）。适合元素很多、快照被截断的大页面：先语义定位再操作，比逐页翻快照快得多。需要先在服务面板「本地 AI」安装嵌入模型。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      task: { type: 'string', required: true, description: '要完成的任务描述（自然语言，与页面元素的语义做匹配）。' },
      top_k: { type: 'integer', description: '返回条数（默认 8，最大 20）。' },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    // Reads page state and tags candidates with a benign marker attribute.
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          task: { type: 'string', required: true },
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tag: { type: 'string', required: true },
                role: { type: 'string' },
                text: { type: 'string', required: true },
                selector: { type: 'string', required: true },
                score: { type: 'number', required: true },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: formatFindOutput(value),
      }],
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `语义定位：${args.task.slice(0, 40)}`, kind: 'read', rawInput: args.task }),
    async execute(args, _exec): Promise<PageFindRelatedValue> {
      const usageRecorder = ctx.get('aiLocal') as UsageRecorder | undefined
      const tabId = args.tab_id
      const task = args.task
      const topK = Math.max(1, Math.min(20, args.top_k ?? 8))
      const elements = parseCollectedElements(await ctx.browser.provider.evaluate(tabId, COLLECT_EXPRESSION))
      if (elements.length === 0) {
        return { tabId, task, candidates: [], error: '页面上没有可交互元素（页面可能未加载完成）' }
      }
      const embedStartedAt = Date.now()
      let ranked: RelatedElement[]
      try {
        ranked = await rankElementsByTask(task, elements)
      } catch (error) {
        // An uninstalled / failed embedding model must not surface as a raw
        // worker stack: name the lane and the remedy the user can act on.
        const reason = error instanceof Error ? error.message : String(error)
        return {
          tabId,
          task,
          candidates: [],
          error: `本地嵌入模型未就绪，无法做语义定位（${reason}）。请在「服务 → 本地 AI」安装「multilingual-e5-small」后重试，或改用 page_snapshot 按快照定位。`,
        }
      }
      await usageRecorder?.recordUsage({
        capability: 'embed',
        model: 'e5-small',
        durationMs: Date.now() - embedStartedAt,
        detail: `top${String(Math.min(topK, ranked.length))}/${String(elements.length)} 元素`,
      })
      return { tabId, task, candidates: ranked.slice(0, topK) }
    },
  }))
}

/**
 * Render the find result: candidates in rank order, the marker selector
 * first-class (the field every selector-addressed tool consumes).
 * @param value - the tool outcome.
 */
export function formatFindOutput(value: PageFindRelatedValue): string {
  if (value.error !== undefined) return `语义定位失败：${value.error}`
  if (value.candidates.length === 0) return '没有匹配的页面元素。'
  const lines = value.candidates.map((candidate, position) =>
    `${String(position + 1)}. <${candidate.tag}${candidate.role === undefined ? '' : ` role=${candidate.role}`}> 「${candidate.text}」(相关度 ${candidate.score.toFixed(3)}，selector: ${candidate.selector})`,
  )
  return `[本地AI·嵌入] 与「${value.task}」最相关的 ${String(value.candidates.length)} 个页面元素（本地 e5-small 排序；selector 可直接用于 page_click / page_type / page_batch_actions，页面跳转或下一次 page_find_related 后失效）：\n${lines.join('\n')}`
}
