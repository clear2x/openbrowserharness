/**
 * The model-facing `page_*` tools: navigation, snapshot-first element
 * addressing (index or CSS selector, with viewport-coordinate fallback),
 * typing, key presses, scrolling, waits, text extraction, and arbitrary
 * script evaluation over `ctx.browser`.
 * @module @deepseek-ai/dsh-tool-browser/page
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, JsonValue } from '@deepseek-ai/dsh-tools'
import type { BrowserProvider, PageElementInfo, PageSnapshot } from '@deepseek-ai/dsh-browser'
import { MAX_TIMEOUT_MS, parseExpression, parsePositiveInteger, parseSelector, parseTabId, parseUrl } from './args.ts'

/** Maximum element lines one `page_snapshot` output carries. */
export const PAGE_SNAPSHOT_MAX_ELEMENTS = 40

/** Maximum characters one `page_extract_text` output carries. */
export const PAGE_EXTRACT_TEXT_MAX_CHARS = 4000

/**
 * Maximum characters the `page_evaluate` render carries. The canonical value
 * keeps the full result; only the model-facing text is truncated.
 */
export const PAGE_EVALUATE_MAX_CHARS = 4000

/**
 * The task-persistence guidance: the agent's standing instruction to DRIVE
 * TASKS TO COMPLETION. Browser work fails in mundane ways (a selector misses,
 * a page loads slow, an ad overlay intercepts a click) — the failure mode to
 * design against is the agent treating the first obstacle as the answer and
 * asking the user instead of retrying with a different approach.
 */
export const TASK_PERSISTENCE_TEXT = [
  '任务执行准则（最高优先级）：',
  '(1) 把任务做完，而不是描述怎么做：用户下达的是可执行任务时，直接执行到产出结果为止；除非任务物理上不可能（需要登录凭据、付费、设备权限），不要把"怎么做"当作答案交回。',
  '(2) 遇障换路，不要请示：点击失败就换 selector、换坐标、换入口 URL；页面加载慢就 page_wait_for + 重试 snapshot；弹窗/广告挡住就先关掉它。连续失败 ≥3 次才考虑换目标路径，≥5 次才向用户汇报障碍点和你已尝试的所有路径。',
  '(3) 结果要可核验：完成任务后用 page_snapshot / page_extract_text 的真实读数证明结果（如视频标题、播放量、页面 URL），不要凭推测汇报。',
  '(4) 中途不要反问：任务里的模糊处按最合理的解释执行并在结果里注明你的取舍；反问会打断任务，只在会造成不可逆后果（发帖、支付、删除用户数据）时才先确认。',
  '(5) 完成即收尾：多步任务全部做完后给一段完整汇总（做了什么、关键读数、产物位置），不要做完一半就停。',
].join('\n')

/** System-prompt section name for the shared browser-operation guidance. */
export const BROWSER_GUIDANCE_SECTION_NAME = 'tool:browser'

/** Docs hint for the `key` argument — the accepted set is validated by the
 * provider (named keys + letters/digits + modifier combos like "Ctrl+A"),
 * not by a schema enum, so combo spellings stay open. */
const PRESSABLE_KEYS_HINT =
  '按键名或组合键：Enter/Tab/Escape/Backspace/Delete/Space/Arrow*/Home/End/PageUp/PageDown、单字母/数字，组合键写法为修饰键+基键（如 Ctrl+A、Ctrl+Shift+ArrowLeft、Alt+ArrowLeft）'

/**
 * The shared browser-operation guidance injected into the system prompt: when
 * to address an element by snapshot index vs CSS selector, when the tool falls
 * back to viewport coordinates, the snapshot-first discipline, and the
 * cross-page evidence workflow.
 */
export const BROWSER_GUIDANCE_TEXT = [
  '你可以通过 tabs_*/page_* 工具操作用户的浏览器。操作准则：',
  '(1) 快照优先：操作一个页面前先调用 page_snapshot 获取元素列表；导航、点击、输入等可能改变页面的操作之后，页面结构会变化，必须重新 page_snapshot 再继续，旧的 index/selector 不可再信。',
  '(2) 元素定位：page_click 优先使用最近一次快照中的 index；元素也可用 CSS selector 定位（page_type / page_wait_for 只接受 selector）。',
  '(3) 坐标回退：快照中 selector 为空（元素位于 shadow DOM 或 iframe 内）或 selector 点击失败时，page_click 会自动回退为按 center 视口坐标点击，无需你换工具。',
  '(4) 提取文本用 page_extract_text；等待动态内容出现用 page_wait_for（给一个合理的 timeout_ms，默认由实现决定）。',
  '(5) 跨页取证：需要到外部站点核实或搜集信息时（例如某名称不确定，要到 Google Maps 交叉核对），用 tabs_open 在新标签页打开来源站检索（可在 URL 中带搜索参数），用 page_snapshot / page_extract_text 提取候选结果（可能有多个，逐一记录名称、地址等关键字段），然后必须用 tabs_switch 切回原工作标签页继续任务，收尾用 tabs_close 关闭取证标签页。不要在取证标签页里遗留任务。',
  '(6) 留证截图：需要保留页面证据时用 page_screenshot 截图，图片会返回到你的上下文中，回答时注明它来自哪个页面（写明 URL）；跨页取证的关键结论配截图更有说服力。',
].join('\n')

/** One compact element record of the `page_snapshot` output. */
interface SnapshotElement {
  readonly index: number
  readonly tag: string
  readonly selector: string
  readonly text: string
  readonly center: { readonly x: number; readonly y: number }
}

/** Click addressing the model chose for one `page_click` call. */
export type PageClickTarget = { readonly kind: 'index'; readonly index: number } | { readonly kind: 'selector'; readonly selector: string }

/**
 * Validate `page_click` arguments beyond the schema layer: exactly one of
 * `index` / `selector` must be present, and it must be well-formed.
 * @param args - the schema-validated `page_click` arguments.
 * @returns the addressing mode the call resolves through.
 */
export function parsePageClickArgs(args: { index?: number; selector?: string }): PageClickTarget {
  const hasIndex = args.index !== undefined
  const hasSelector = args.selector !== undefined && args.selector.trim().length > 0
  if (hasIndex && hasSelector) {
    throw new Error('page_click 的 index 与 selector 只能提供一个')
  }
  if (!hasIndex && !hasSelector) {
    throw new Error('page_click 需要提供 index（来自最近一次 page_snapshot）或 selector 之一')
  }
  if (hasIndex) {
    const index = args.index as number
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new Error(`page_click 的 index 必须是非负整数（收到 ${JSON.stringify(args.index)}）`)
    }
    return { kind: 'index', index }
  }
  return { kind: 'selector', selector: parseSelector(args.selector as string) }
}

/** Project one snapshot element into the compact output record. */
function compactElement(element: PageElementInfo): SnapshotElement {
  return {
    index: element.index,
    tag: element.tag,
    selector: element.selector,
    text: element.text,
    center: { x: element.center.x, y: element.center.y },
  }
}

/** Render one element line: `[index] <tag> selector="..." text="..." center=(x,y)`. */
function elementLine(element: SnapshotElement): string {
  const addressing = element.selector.length > 0
    ? `selector="${element.selector}"`
    : '(shadow/iframe→用坐标)'
  return `[${element.index}] <${element.tag}> ${addressing} text="${element.text}" center=(${element.center.x},${element.center.y})`
}

/** The `page_snapshot` canonical value (also the render input type). */
export interface PageSnapshotValue {
  readonly tabId: number
  readonly url: string
  readonly title: string
  readonly viewport: { readonly width: number; readonly height: number; readonly scrollX: number; readonly scrollY: number }
  readonly elements: SnapshotElement[]
  readonly elementCount: number
  readonly truncated: boolean
}

/**
 * Format one `page_snapshot` output as the model-facing text: a header (tab,
 * title, URL, viewport) plus one line per element, capped at
 * {@link PAGE_SNAPSHOT_MAX_ELEMENTS} lines with an explicit truncation note.
 * @param value - the canonical snapshot value.
 * @returns the complete render text.
 */
export function formatSnapshotOutput(value: PageSnapshotValue): string {
  const header = [
    `标签页 ${value.tabId} 快照：${value.title.length > 0 ? value.title : '(无标题)'}`,
    `URL: ${value.url}`,
    `视口 ${value.viewport.width}x${value.viewport.height}，滚动位置 (${value.viewport.scrollX}, ${value.viewport.scrollY})`,
  ]
  const lines = value.elements.map(elementLine)
  if (value.truncated) {
    lines.push(`…（页面共 ${value.elementCount} 个元素，仅显示前 ${value.elements.length} 个；滚动或缩小范围后重新快照）`)
  }
  return [...header, ...lines].join('\n')
}

/**
 * Render one `page_evaluate` output as the model-facing text: a tab header
 * plus the result serialized as JSON, capped at {@link PAGE_EVALUATE_MAX_CHARS}
 * with an explicit truncation note.
 * @param tabId - the evaluated tab's id.
 * @param value - the validated canonical result.
 * @returns the complete render text.
 */
export function formatEvaluateOutput(tabId: number, value: JsonValue): string {
  const json = JSON.stringify(value)
  if (json.length <= PAGE_EVALUATE_MAX_CHARS) {
    return `标签页 ${tabId} 执行结果：${json}`
  }
  return `标签页 ${tabId} 执行结果：${json.slice(0, PAGE_EVALUATE_MAX_CHARS)}\n（结果超过 ${PAGE_EVALUATE_MAX_CHARS} 字符已被截断）`
}

/** The `page_click` canonical value. */
interface PageClickValue {
  readonly tabId: number
  readonly mode: 'selector' | 'coordinates'
  readonly x: number
  readonly y: number
  readonly selector?: string
  readonly index?: number
  readonly reason?: string
}

/** Click one resolved element: selector first, viewport coordinates as fallback. */
async function clickElement(provider: BrowserProvider, tabId: number, element: PageElementInfo): Promise<PageClickValue> {
  const base = { tabId, x: element.center.x, y: element.center.y, index: element.index } as const
  if (element.selector.length > 0) {
    try {
      await provider.clickSelector(tabId, element.selector)
      return { ...base, mode: 'selector', selector: element.selector }
    } catch {
      // selector 点击失败（元素可能已移动或不可寻址）→ 回退坐标点击。
      await provider.clickPoint(tabId, element.center)
      return { ...base, mode: 'coordinates', reason: 'selector 点击失败，已回退坐标点击' }
    }
  }
  await provider.clickPoint(tabId, element.center)
  return { ...base, mode: 'coordinates', reason: '元素位于 shadow DOM/iframe，selector 不可寻址，使用坐标点击' }
}

/**
 * Register the nine `page_*` tools and their shared prompt guidance.
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 */
export function applyPageTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'page_navigate',
    description: '让指定标签页导航到一个新 URL。导航后页面内容会变化，应重新 page_snapshot。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      url: { type: 'string', required: true, description: '要导航到的 URL。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          url: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `标签页 ${value.tabId} 已导航到 ${value.url}。页面已变化，继续操作前请重新 page_snapshot。` }],
    },
    async execute(args, _exec) {
      const tabId = parseTabId(args.tab_id)
      const url = parseUrl(args.url)
      await ctx.browser.provider.navigate(tabId, url)
      return { tabId, url }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `导航标签页 ${args.tab_id} 到 ${args.url}`, kind: 'fetch', rawInput: args.url }),
  }))

  ctx.tools.register(defineTool({
    name: 'page_snapshot',
    description: '获取指定标签页的元素快照：URL、标题、视口与每个元素的 index、tag、selector、文本和视口坐标中心点。元素集以可交互元素为主，另含带文本的非交互叶子（状态反馈文本）。点击元素前先调用它。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          viewport: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
              scrollX: { type: 'number', required: true },
              scrollY: { type: 'number', required: true },
            },
          },
          elements: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                tag: { type: 'string', required: true },
                selector: { type: 'string', required: true },
                text: { type: 'string', required: true },
                center: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    x: { type: 'number', required: true },
                    y: { type: 'number', required: true },
                  },
                },
              },
            },
          },
          elementCount: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSnapshotOutput(value) }],
    },
    // A snapshot is a pure read of current page state.
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const tabId = parseTabId(args.tab_id)
      const snapshot: PageSnapshot = await ctx.browser.provider.snapshot(tabId)
      const shown = snapshot.elements.slice(0, PAGE_SNAPSHOT_MAX_ELEMENTS)
      const value: PageSnapshotValue = {
        tabId: snapshot.tabId,
        url: snapshot.url,
        title: snapshot.title,
        viewport: { ...snapshot.viewport },
        elements: shown.map(compactElement),
        elementCount: snapshot.elements.length,
        truncated: snapshot.elements.length > shown.length,
      }
      return value
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `快照标签页 ${args.tab_id}`, kind: 'read', rawInput: args.tab_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'page_click',
    description: '点击页面上一个元素：优先按最近一次 page_snapshot 的 index 定位，也可给 CSS selector。selector 为空（shadow DOM/iframe）或点击失败时自动回退为按坐标点击。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      index: { type: 'integer', description: '元素在最近一次 page_snapshot 中的 index。' },
      selector: { type: 'string', description: '元素的 CSS selector（与 index 二选一）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          mode: { type: 'string', required: true, enum: ['selector', 'coordinates'] },
          x: { type: 'number', required: true },
          y: { type: 'number', required: true },
          selector: { type: 'string' },
          index: { type: 'integer' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.mode === 'selector'
          ? `已通过 selector "${value.selector}" 点击标签页 ${value.tabId} 的元素。`
          : `已按坐标 (${value.x}, ${value.y}) 点击标签页 ${value.tabId} 的元素${value.reason === undefined ? '' : `（${value.reason}）`}。`,
      }],
    },
    async execute(args, _exec) {
      const tabId = parseTabId(args.tab_id)
      const target = parsePageClickArgs(args)
      const provider = ctx.browser.provider
      if (target.kind === 'index') {
        const snapshot = await provider.snapshot(tabId)
        const element = snapshot.elements[target.index]
        if (element === undefined) {
          throw new Error(`page_click：快照中没有 index 为 ${target.index} 的元素（共 ${snapshot.elements.length} 个）——页面可能已变化，请重新 page_snapshot`)
        }
        return clickElement(provider, tabId, element)
      }
      try {
        await provider.clickSelector(tabId, target.selector)
        return { tabId, mode: 'selector' as const, selector: target.selector, x: 0, y: 0 }
      } catch (error) {
        // selector 直接点击失败：从快照解析坐标回退（不再重试同一个已失败的
        // selector，直接按 center 坐标点击）。
        const snapshot = await provider.snapshot(tabId)
        const element = snapshot.elements.find(candidate => candidate.selector === target.selector)
        if (element === undefined) {
          throw new Error(`page_click：selector "${target.selector}" 点击失败且快照中找不到该元素（${String(error)}）`)
        }
        await provider.clickPoint(tabId, element.center)
        return {
          tabId,
          mode: 'coordinates' as const,
          x: element.center.x,
          y: element.center.y,
          selector: target.selector,
          index: element.index,
          reason: 'selector 点击失败，已回退坐标点击',
        }
      }
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: args.selector !== undefined ? `点击 ${args.selector}` : `点击元素 ${args.index}`,
      kind: 'execute',
      rawInput: args.selector ?? args.index,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'page_type',
    description: '在页面的一个输入框中输入文本，可选在输入后按回车提交。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      selector: { type: 'string', required: true, description: '输入框的 CSS selector。' },
      text: { type: 'string', required: true, description: '要输入的文本（整体替换式输入）。' },
      submit: { type: 'boolean', description: '输入完成后是否按回车提交，默认 false。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          selector: { type: 'string', required: true },
          submitted: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已在标签页 ${value.tabId} 的 ${value.selector} 中输入文本${value.submitted ? '并按回车提交' : ''}。`,
      }],
    },
    async execute(args, _exec) {
      const tabId = parseTabId(args.tab_id)
      const selector = parseSelector(args.selector)
      if (args.text.length === 0) {
        throw new Error('page_type 的 text 必须是非空字符串')
      }
      const submit = args.submit ?? false
      await ctx.browser.provider.typeText(tabId, selector, args.text, { submit })
      return { tabId, selector, submitted: submit }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `在 ${args.selector} 中输入文本`, kind: 'edit', rawInput: args.text }),
  }))

  ctx.tools.register(defineTool({
    name: 'page_press_key',
    description: '在指定标签页按下并释放一个按键或组合键。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      key: { type: 'string', required: true, description: PRESSABLE_KEYS_HINT },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          key: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已在标签页 ${value.tabId} 按下 ${value.key}。` }],
    },
    async execute(args, _exec) {
      const tabId = parseTabId(args.tab_id)
      await ctx.browser.provider.pressKey(tabId, args.key)
      return { tabId, key: args.key }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `按下 ${args.key}`, kind: 'execute', rawInput: args.key }),
  }))

  ctx.tools.register(defineTool({
    name: 'page_scroll',
    description: '在指定标签页内向上或向下滚动页面。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      direction: { type: 'string', required: true, enum: ['up', 'down'], description: '滚动方向。' },
      amount_px: { type: 'integer', description: '滚动像素数（正整数，默认由实现决定）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          direction: { type: 'string', required: true, enum: ['up', 'down'] },
          amountPx: { type: 'integer' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已将标签页 ${value.tabId} 向${value.direction === 'down' ? '下' : '上'}滚动${value.amountPx === undefined ? '' : ` ${value.amountPx}px`}。`,
      }],
    },
    async execute(args, _exec) {
      const tabId = parseTabId(args.tab_id)
      const amountPx = parsePositiveInteger(args.amount_px, 'amount_px', 100_000)
      await ctx.browser.provider.scroll(tabId, args.direction, amountPx)
      return { tabId, direction: args.direction, ...(amountPx !== undefined ? { amountPx } : {}) }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `滚动页面（${args.direction === 'down' ? '向下' : '向上'}）`, kind: 'other', rawInput: args.amount_px }),
  }))

  ctx.tools.register(defineTool({
    name: 'page_wait_for',
    description: '等待页面上某个 CSS selector 匹配的元素出现，超时则失败。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      selector: { type: 'string', required: true, description: '等待出现的元素 CSS selector。' },
      timeout_ms: { type: 'integer', description: `等待超时（毫秒，正整数，最大 ${MAX_TIMEOUT_MS}）。` },
    },
    timeoutMs: MAX_TIMEOUT_MS + 15_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          selector: { type: 'string', required: true },
          waitedMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `元素 ${value.selector} 已在 ${value.waitedMs}ms 内出现。` }],
    },
    async execute(args, _exec) {
      const tabId = parseTabId(args.tab_id)
      const selector = parseSelector(args.selector)
      const timeoutMs = parsePositiveInteger(args.timeout_ms, 'timeout_ms', MAX_TIMEOUT_MS)
      const startedAt = Date.now()
      await ctx.browser.provider.waitFor(tabId, selector, timeoutMs)
      return { tabId, selector, waitedMs: Date.now() - startedAt }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `等待 ${args.selector} 出现`, kind: 'other', rawInput: args.selector }),
  }))

  ctx.tools.register(defineTool({
    name: 'page_extract_text',
    description: '提取页面的可见文本：默认整个 body，也可限定到一个 CSS selector 匹配的元素。输出最多 4000 字符。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      selector: { type: 'string', description: '限定提取范围的 CSS selector（省略则提取整个页面正文）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          selector: { type: 'string' },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.text + (value.truncated ? '\n（文本超过 4000 字符已被截断；需要后半部分时请用更窄的 selector。）' : ''),
      }],
    },
    async execute(args, _exec) {
      const tabId = parseTabId(args.tab_id)
      const selector = args.selector === undefined ? undefined : parseSelector(args.selector)
      const expression = selector === undefined
        ? 'document.body.innerText'
        : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.innerText; })()`
      const extracted = await ctx.browser.provider.evaluate<unknown>(tabId, expression)
      if (extracted === null || extracted === undefined) {
        throw new Error(`page_extract_text：selector ${JSON.stringify(selector)} 未匹配到任何元素`)
      }
      const full = typeof extracted === 'string' ? extracted : JSON.stringify(extracted)
      return {
        tabId,
        ...(selector !== undefined ? { selector } : {}),
        text: full.slice(0, PAGE_EXTRACT_TEXT_MAX_CHARS),
        truncated: full.length > PAGE_EXTRACT_TEXT_MAX_CHARS,
      }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `提取页面文本${args.selector === undefined ? '' : `（${args.selector}）`}`, kind: 'read', rawInput: args.selector }),
  }))

  ctx.tools.register(defineTool({
    name: 'page_evaluate',
    description: '在指定标签页的页面上下文中执行一段 JavaScript 并返回结果值（按值序列化）。可以读取页面状态，也可能修改或破坏页面；执行出错时返回页面错误信息。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      expression: { type: 'string', required: true, description: '要在页面上下文中求值的 JavaScript 表达式。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          expression: { type: 'string', required: true },
          value: { type: 'json', required: true, description: '表达式结果（按值序列化；无结果时为 null）。' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: formatEvaluateOutput(value.tabId, value.value),
      }],
    },
    // Arbitrary page script may mutate anything: never parallelize evaluates.
    async execute(args, _exec) {
      const tabId = parseTabId(args.tab_id)
      const expression = parseExpression(args.expression)
      const value = await ctx.browser.provider.evaluate<JsonValue>(tabId, expression)
      return { tabId, expression, value }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: '在页面中执行 JavaScript', kind: 'execute', rawInput: args.expression }),
  }))
}
