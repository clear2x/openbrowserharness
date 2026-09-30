/**
 * The model-facing `page_network` tool: start/stop CDP network capture on a
 * tab and read the buffered exchanges, so the agent can discover a site's
 * data endpoints (XHR/fetch) instead of reverse-engineering every interaction
 * through the DOM — the discovery half of site distillation.
 * @module @deepseek-ai/dsh-tool-browser/network
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { NetworkExchange } from '@deepseek-ai/dsh-browser'
import { parseTabId } from './args.ts'

/** Maximum exchanges one `page_network` read returns to the model. */
export const PAGE_NETWORK_MAX_ENTRIES = 120

/** Maximum characters of one POST body echoed per exchange. */
const POST_DATA_MAX_CHARS = 400

/** One model-facing exchange record (the seam type, POST body trimmed). */
type ExchangeValue = Omit<NetworkExchange, 'postData'> & { postData?: string }

/** The `page_network` output value. */
interface NetworkValue {
  tabId: number
  action: 'start' | 'read'
  active: boolean
  total: number
  dropped: number
  truncated: boolean
  exchanges: ExchangeValue[]
}

/** Require one of the two explicit actions; there is no implicit default. */
function parseAction(value: unknown): 'start' | 'read' {
  if (value === 'start' || value === 'read') return value
  throw new Error('非法参数：action（应为 "start" 或 "read"）')
}

/** Compact one-line rendering of one exchange. */
function renderExchange(exchange: ExchangeValue, index: number): string {
  const status = exchange.error !== undefined
    ? `ERR(${exchange.error})`
    : exchange.status === undefined
      ? '…'
      : String(exchange.status)
  const flags = [
    exchange.fromCache === true ? 'cache' : '',
    exchange.postData !== undefined ? `body=${exchange.postData.length}B` : '',
    exchange.responseBytes !== undefined ? `${exchange.responseBytes}B` : '',
  ].filter(Boolean).join(',')
  const flagText = flags === '' ? '' : ` [${flags}]`
  const bodyText = exchange.postData !== undefined ? `\n    body: ${exchange.postData}` : ''
  return `[${index}] ${exchange.method} ${status} ${exchange.resourceType} ${exchange.url}${flagText}${bodyText}`
}

function formatOutput(value: NetworkValue): string {
  if (value.action === 'start') {
    return `标签页 ${value.tabId} 网络捕获已开始（缓冲已清空）。现在正常操作页面（点击、翻页、提交），之后用 action="read" 读取捕获到的请求。`
  }
  const head = `标签页 ${value.tabId} 网络捕获：共 ${value.total} 条${value.truncated ? `（只渲染前 ${value.exchanges.length} 条）` : ''}${value.dropped > 0 ? `，缓冲溢出丢弃 ${value.dropped} 条` : ''}，捕获${value.active ? '仍在进行' : '已停止'}。`
  if (value.exchanges.length === 0) {
    return `${head}\n（没有匹配的请求：捕获尚未开始时先 action="start"；刚操作完页面可稍候再读；也可放宽 filter / resource_type。）`
  }
  return `${head}\n${value.exchanges.map(renderExchange).join('\n')}`
}

/**
 * Register the `page_network` tool. Registered with the other page tools; the
 * Network-domain plumbing lives provider-side, so this tool is provider-free
 * until execution.
 * @param ctx - context carrying `tools` and `browser`.
 */
export function applyNetworkTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'page_network',
    description: '捕获并读取指定标签页的网络请求（CDP Network 域），用于发现网站的数据端点：action="start" 开始捕获（清空缓冲，导航不清除），随后正常操作页面（点击、翻页、提交）；action="read" 读取已捕获的请求清单（可用 filter 按 URL 子串、resource_type 按资源类型过滤，stop=true 读完即停止捕获）。典型用法（「炼化」一个网站）：start 后像用户一样操作一遍目标功能，read&resource_type=XHR 找出数据端点与参数，之后同类任务可直接用 page_evaluate 在页面里 fetch 这些端点，省去逐页 DOM 操作。',
    parameters: {
      action: { type: 'string', required: true, description: '"start"（开始捕获）或 "read"（读取捕获结果）。' },
      tab_id: { type: 'integer', required: true, description: '目标标签页 id（来自 tabs_list 或 page_snapshot）。' },
      filter: { type: 'string', description: 'action=read 时可选：URL 需包含的子串（大小写不敏感）。' },
      resource_type: { type: 'string', description: 'action=read 时可选：资源类型子串过滤（如 XHR、Fetch、Document）。' },
      stop: { type: 'boolean', description: 'action=read 时可选：true=读取后停止捕获。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          action: { type: 'string', required: true },
          active: { type: 'boolean', required: true },
          total: { type: 'integer', required: true },
          dropped: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          exchanges: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                method: { type: 'string', required: true },
                resourceType: { type: 'string', required: true },
                status: { type: 'integer' },
                mimeType: { type: 'string' },
                error: { type: 'string' },
                fromCache: { type: 'boolean' },
                postData: { type: 'string' },
                responseBytes: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatOutput(value as unknown as NetworkValue) }],
    },
    // A capture read is a pure read of recorder state; page traffic is not changed.
    isConcurrencySafe: () => true,
    async execute(args) {
      const tabId = parseTabId(args.tab_id)
      const action = parseAction(args.action)
      const browser = ctx.browser.provider
      if (action === 'start') {
        await browser.startNetworkCapture(tabId)
        const value: NetworkValue = { tabId, action, active: true, total: 0, dropped: 0, truncated: false, exchanges: [] }
        return value
      }
      const capture = await browser.readNetworkCapture(tabId, {
        ...(args.stop === true ? { stop: true } : {}),
        ...(typeof args.filter === 'string' && args.filter !== '' ? { filter: args.filter } : {}),
        ...(typeof args.resource_type === 'string' && args.resource_type !== '' ? { resourceType: args.resource_type } : {}),
      })
      const exchanges = capture.exchanges.slice(0, PAGE_NETWORK_MAX_ENTRIES)
      const value: NetworkValue = {
        tabId,
        action,
        active: capture.active,
        total: capture.exchanges.length,
        dropped: capture.dropped,
        truncated: capture.exchanges.length > exchanges.length,
        exchanges: exchanges.map(exchange => ({
          ...exchange,
          ...(exchange.postData === undefined ? {} : { postData: exchange.postData.slice(0, POST_DATA_MAX_CHARS) }),
        })),
      }
      return value
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: `网络捕获 ${args.action === 'read' ? '读取' : '开始'} · 标签页 ${args.tab_id}`,
      kind: 'read',
      rawInput: args.tab_id,
    }),
  }))
}
