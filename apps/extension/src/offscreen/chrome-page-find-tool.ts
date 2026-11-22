/**
 * `chrome-page-find-tool`: the `page_find_related` tool (batch 277) — the
 * DOM-candidate semantic pre-filter. Given the user's task, it embeds the
 * page's snapshot elements against the task with the local e5 embedding and
 * returns the top-k matches with their snapshot indices, so the agent can
 * address large pages by relevance instead of paging through capped
 * snapshot lists. Inference runs in the AI worker (batch 276 contract).
 *
 * @module chrome-page-find-tool
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-browser'
import { embedInWorker } from './ai-runtime/worker-bridge.ts'

/** The usage-ledger recorder face (aiLocal.recordUsage, structurally). */
interface UsageRecorder {
  recordUsage(entry: { capability: 'embed'; model: string; durationMs: number; detail: string }): Promise<void>
}

/** This module carries no config today. */
export interface Config {}

/** The module reads the browser seam; the embedding lives in the worker. */
export const inject = ['tools', 'browser'] as const

/** The per-call deadline (snapshot + embed + rank). */
const TOOL_TIMEOUT_MS = 60_000

/** One ranked candidate the tool returns. */
export interface RelatedElement {
  index: number
  tag: string
  role?: string
  text: string
  selector: string
  score: number
}

/**
 * The element's embedding text: the visible text with the accessible name
 * and placeholder folded in — the three signals a task actually matches.
 * @param element - the collected element record.
 */
export function elementEmbedText(element: CollectedElement): string {
  return [element.text, element.ariaLabel, element.placeholder].filter(part => part !== undefined && part.length > 0).join(' ')
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
    return { element, score: dot, position }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.map(({ element, score, position }) => ({
    index: position + 1,
    tag: element.tag,
    ...(element.role === undefined ? {} : { role: element.role }),
    text: elementEmbedText(element).slice(0, 120),
    selector: element.selector,
    score: Math.round(score * 1000) / 1000,
  }))
}

/** One interactive element collected in-page (plain JSON, self-contained). */
export interface CollectedElement {
  tag: string
  role?: string
  text: string
  ariaLabel?: string
  placeholder?: string
  selector: string
}

/**
 * The in-page collector: ONE fixed expression template (the model never
 * authors it), deliberately self-contained — no function-source injection,
 * so minification of the host bundle cannot break it (the snapshot
 * pipeline's toString()-injected functions reference renamed bundle
 * symbols and crash on pages; this collector cannot).
 * @returns the page's interactive elements with best-effort selectors.
 */
export const COLLECT_EXPRESSION = `(() => {
  var INTERACTIVE = { A: 1, BUTTON: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, SUMMARY: 1 };
  var ROLES = { a: 'link', button: 'button', textarea: 'textbox', select: 'combobox', input: 'textbox', summary: 'summary' };
  function selectorOf(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var aria = el.getAttribute('aria-label');
    if (aria) return el.tagName.toLowerCase() + '[aria-label=' + JSON.stringify(aria) + ']';
    var ph = el.getAttribute('placeholder');
    if (ph) return el.tagName.toLowerCase() + '[placeholder=' + JSON.stringify(ph) + ']';
    var name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
    return '';
  }
  function textOf(el) {
    var label = el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? '' : (el.textContent || '');
    return label.replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  var out = [];
  var nodes = document.querySelectorAll('a, button, input, select, textarea, summary, [role=button], [role=link], [role=tab]');
  for (var i = 0; i < nodes.length && out.length < 120; i++) {
    var el = nodes[i];
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    var style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    var tag = el.tagName;
    if (!INTERACTIVE[tag] && !el.getAttribute('role')) continue;
    var text = textOf(el);
    var aria = el.getAttribute('aria-label') || '';
    var ph = el.getAttribute('placeholder') || '';
    if (!text && !aria && !ph) continue;
    var record = { tag: tag.toLowerCase(), text: text };
    var role = el.getAttribute('role') || ROLES[tag.toLowerCase()] || '';
    if (role) record.role = role;
    if (aria) record.ariaLabel = aria;
    if (ph) record.placeholder = ph;
    record.selector = selectorOf(el);
    out.push(record);
  }
  return JSON.stringify(out);
})()`

/** The model-facing argument record. */
export interface PageFindRelatedArgs {
  tab_id: number
  task: string
  top_k?: number
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
    description: '在页面元素中做语义搜索：按任务描述对当前页快照的可交互元素排序，返回最相关的 top-k（含 snapshot index，可直接用于 page_click/page_type）。适合元素很多、快照被截断的大页面——先语义定位再操作，比逐页翻快照快得多。需要先在服务面板安装本地嵌入模型。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      task: { type: 'string', required: true, description: '要完成的任务描述（自然语言，与页面元素的语义做匹配）。' },
      top_k: { type: 'integer', description: '返回条数（默认 8，最大 20）。' },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    // Snapshot + embed read page state only.
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
                index: { type: 'integer', required: true },
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
        text: formatFindOutput(value as PageFindRelatedValue),
      }],
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `语义定位：${args.task.slice(0, 40)}`, kind: 'read', rawInput: args.task }),
    async execute(args, _exec): Promise<PageFindRelatedValue> {
      const usageRecorder = ctx.get('aiLocal') as UsageRecorder | undefined
      const tabId = args.tab_id
      const task = args.task
      const topK = Math.max(1, Math.min(20, args.top_k ?? 8))
      const raw = await ctx.browser.provider.evaluate<string>(tabId, COLLECT_EXPRESSION)
      let elements: CollectedElement[] = []
      try {
        elements = JSON.parse(raw) as CollectedElement[]
      } catch {
        return { tabId, task, candidates: [], error: '页面元素收集失败（返回了非 JSON 数据）' }
      }
      if (elements.length === 0) {
        return { tabId, task, candidates: [], error: '页面上没有可交互元素（快照为空）' }
      }
      const embedStartedAt = Date.now()
      const ranked = await rankElementsByTask(task, elements)
      await usageRecorder?.recordUsage({
        capability: 'embed',
        model: 'e5-small',
        durationMs: Date.now() - embedStartedAt,
        detail: `top${String(Math.min(topK, ranked.length))}/${String(elements.length)} 元素`,
      })
      const candidates = ranked.slice(0, topK).map((candidate, position) => ({
        index: position + 1,
        tag: candidate.tag,
        ...(candidate.role === undefined ? {} : { role: candidate.role }),
        text: candidate.text,
        selector: candidate.selector ?? '',
        score: candidate.score,
      }))
      return { tabId, task, candidates }
    },
  }))
}

/** The model-facing find value. */
export interface PageFindRelatedValue {
  tabId: number
  task: string
  candidates: RelatedElement[]
  error?: string
}

/**
 * Render the find result: candidates in rank order with their snapshot
 * index first (the field the model acts on).
 * @param value - the tool outcome.
 */
export function formatFindOutput(value: PageFindRelatedValue): string {
  if (value.error !== undefined) return `语义定位失败：${value.error}`
  if (value.candidates.length === 0) return '没有匹配的页面元素。'
  const lines = value.candidates.map((candidate, position) =>
    `${String(position + 1)}. [index=${String(candidate.index)}] <${candidate.tag}${candidate.role === undefined ? '' : ` role=${candidate.role}`}> 「${candidate.text}」(相关度 ${candidate.score.toFixed(3)}${candidate.selector === '' ? ',shadow/iframe 内用坐标' : `，selector: ${candidate.selector}`})`,
  )
  return `[本地AI·嵌入] 与「${value.task}」最相关的 ${String(value.candidates.length)} 个页面元素（本地 e5-small 排序；index 可直接用于 page_click/page_type）：\n${lines.join('\n')}`
}
