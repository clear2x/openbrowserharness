/**
 * The model-facing `tabs_*` tools: list, switch, open, and close browser tabs
 * over `ctx.browser`. Schemas and presentation live here; the provider owns
 * every environment interaction.
 * @module @deepseek-ai/dsh-tool-browser/tabs
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { parseTabId, parseUrl } from './args.ts'

/** Shared output schema of one {@link TabInfo}-shaped record. */
const tabInfoSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tabId: { type: 'integer', required: true },
    title: { type: 'string', required: true },
    url: { type: 'string', required: true },
    active: { type: 'boolean', required: true },
    windowId: { type: 'integer', required: true },
    index: { type: 'integer', required: true },
  },
} as const

/** Render one tab row for the `tabs_list` summary. */
function tabLine(tab: { tabId: number; title: string; url: string; active: boolean }): string {
  const marker = tab.active ? '*' : ' '
  const title = tab.title.length > 0 ? tab.title : '(无标题)'
  return `[${tab.tabId}] ${marker} ${title} — ${tab.url}`
}

/**
 * Register the four `tabs_*` tools on `ctx.tools`.
 * @param ctx - context whose `tools` registry receives the registrations.
 */
export function applyTabsTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'tabs_list',
    description: '列出浏览器当前打开的所有标签页（id、标题、URL、是否活动）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabs: { type: 'array', required: true, items: tabInfoSchema },
          activeTabId: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.tabs.length === 0
          ? '浏览器当前没有打开任何标签页。'
          : `浏览器共 ${value.tabs.length} 个标签页（* 为活动标签页）：\n${value.tabs.map(tabLine).join('\n')}`,
      }],
    },
    // Listing tabs mutates nothing; sibling tool calls may overlap it.
    isConcurrencySafe: () => true,
    async execute() {
      const tabs = await ctx.browser.provider.tabs()
      const active = tabs.find(tab => tab.active)
      return { tabs, activeTabId: active === undefined ? -1 : active.tabId }
    },
    presentCall: (): GenericCallView => ({ card: 'generic', title: '列出浏览器标签页', kind: 'search' }),
  }))

  ctx.tools.register(defineTool({
    name: 'tabs_switch',
    description: '把某个标签页切换为浏览器的活动标签页。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id（来自 tabs_list 或 page_snapshot）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已切换到标签页 ${value.tabId}。` }],
    },
    async execute(args) {
      const tabId = parseTabId(args.tab_id)
      await ctx.browser.provider.switchTab(tabId)
      return { tabId }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `切换到标签页 ${args.tab_id}`, kind: 'other', rawInput: args.tab_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'tabs_open',
    description: '在浏览器中打开一个新标签页并跳转到指定 URL。',
    parameters: {
      url: { type: 'string', required: true, description: '要打开的 URL。' },
      active: { type: 'boolean', description: '是否把新标签页设为活动标签页，默认 true。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tab: { ...tabInfoSchema, required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `已打开标签页 ${value.tab.tabId}：${value.tab.url}` }],
    },
    async execute(args) {
      const url = parseUrl(args.url)
      const tab = await ctx.browser.provider.openTab(url, { active: args.active ?? true })
      return { tab }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `打开 ${args.url}`, kind: 'fetch', rawInput: args.url }),
  }))

  ctx.tools.register(defineTool({
    name: 'tabs_close',
    description: '关闭指定的浏览器标签页。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '要关闭的标签页 id。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closedTabId: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已关闭标签页 ${value.closedTabId}。` }],
    },
    async execute(args) {
      const tabId = parseTabId(args.tab_id)
      await ctx.browser.provider.closeTab(tabId)
      return { closedTabId: tabId }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `关闭标签页 ${args.tab_id}`, kind: 'delete', rawInput: args.tab_id }),
  }))
}
