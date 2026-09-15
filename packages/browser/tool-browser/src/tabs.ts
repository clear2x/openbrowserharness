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
    pinned: { type: 'boolean' },
    muted: { type: 'boolean' },
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

  ctx.tools.register(defineTool({
    name: 'tabs_reload',
    description: '刷新标签页。默认使用缓存；bypass_cache 为 true 时强制从网络重新获取全部资源。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '要刷新的标签页 id，缺省为当前活动标签页。' },
      bypass_cache: { type: 'boolean', description: '为 true 时绕过缓存强制刷新。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tabId: { type: 'integer', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `已刷新标签页 ${value.tabId}。` }],
    },
    async execute(args) {
      const tabId = parseTabId(args.tab_id)
      await ctx.browser.provider.reloadTab(tabId, { bypassCache: args.bypass_cache === true })
      return { tabId }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `刷新标签页 ${args.tab_id}`, kind: 'other', rawInput: args.tab_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'tabs_duplicate',
    description: '复制一个标签页（新标签页加载同一 URL），返回新标签页信息。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '要复制的标签页 id。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tab: { ...tabInfoSchema, required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `已复制为新标签页 ${value.tab.tabId}：${value.tab.url}` }],
    },
    async execute(args) {
      const tabId = parseTabId(args.tab_id)
      const tab = await ctx.browser.provider.duplicateTab(tabId)
      return { tab }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `复制标签页 ${args.tab_id}`, kind: 'other', rawInput: args.tab_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'tabs_pin',
    description: '固定或取消固定标签页（固定的标签页缩小为图标并固定在左侧）。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      pinned: { type: 'boolean', required: true, description: 'true=固定，false=取消固定。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          pinned: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `标签页 ${value.tabId} 已${value.pinned ? '固定' : '取消固定'}。` }],
    },
    async execute(args) {
      const tabId = parseTabId(args.tab_id)
      const pinned = args.pinned
      await ctx.browser.provider.updateTabPinned(tabId, pinned)
      return { tabId, pinned }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `${args.pinned ? '固定' : '取消固定'}标签页 ${args.tab_id}`, kind: 'other', rawInput: args.tab_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'tabs_mute',
    description: '静音或取消静音标签页的声音。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      muted: { type: 'boolean', required: true, description: 'true=静音，false=取消静音。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          muted: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `标签页 ${value.tabId} 已${value.muted ? '静音' : '取消静音'}。` }],
    },
    async execute(args) {
      const tabId = parseTabId(args.tab_id)
      const muted = args.muted
      await ctx.browser.provider.updateTabMuted(tabId, muted)
      return { tabId, muted }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `${args.muted ? '静音' : '取消静音'}标签页 ${args.tab_id}`, kind: 'other', rawInput: args.tab_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'tabs_move',
    description: '把标签页移动到其窗口内的指定位置（0 = 最左）。',
    parameters: {
      tab_id: { type: 'integer', required: true, description: '目标标签页 id。' },
      index: { type: 'integer', required: true, description: '目标位置（0 起）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer', required: true },
          index: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `标签页 ${value.tabId} 已移动到位置 ${value.index}。` }],
    },
    async execute(args) {
      const tabId = parseTabId(args.tab_id)
      const index = typeof args.index === 'number' ? args.index : Number.NaN
      if (!Number.isInteger(index) || index < 0) {
        throw new Error('index 必须是非负整数（0 = 最左）')
      }
      await ctx.browser.provider.moveTab(tabId, index)
      return { tabId, index }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `移动标签页 ${args.tab_id}`, kind: 'other', rawInput: args.index }),
  }))

  ctx.tools.register(defineTool({
    name: 'tabs_close_others',
    description: '关闭同一窗口内除指定标签页外的全部标签页（不可撤销，慎用）。',
    parameters: {
      keep_tab_id: { type: 'integer', required: true, description: '要保留的标签页 id。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          keepTabId: { type: 'integer', required: true },
          closed: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已关闭其余 ${value.closed} 个标签页，保留 ${value.keepTabId}。` }],
    },
    async execute(args) {
      const keepTabId = parseTabId(args.keep_tab_id)
      const closed = await ctx.browser.provider.closeOtherTabs(keepTabId)
      return { keepTabId, closed }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `关闭除 ${args.keep_tab_id} 外的标签页`, kind: 'delete', rawInput: args.keep_tab_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'tabs_reopen',
    description: '重新打开最近关闭的标签页（撤销上一次关闭）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tab: { ...tabInfoSchema, required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `已重新打开标签页 ${value.tab.tabId}：${value.tab.url}` }],
    },
    async execute() {
      const tab = await ctx.browser.provider.reopenClosedTab()
      if (tab === undefined) {
        throw new Error('没有可重新打开的已关闭标签页。')
      }
      return { tab }
    },
    presentCall: (): GenericCallView => ({ card: 'generic', title: '重新打开最近关闭的标签页', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'windows_list',
    description: '列出浏览器当前打开的所有窗口（id、是否聚焦、标签页数）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          windows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                windowId: { type: 'integer', required: true },
                focused: { type: 'boolean', required: true },
                tabCount: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `共 ${value.windows.length} 个窗口：${value.windows
          .map(window => `#${window.windowId}（${window.tabCount} 个标签页${window.focused ? '，当前聚焦' : ''}）`)
          .join('；')}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      return { windows: await ctx.browser.provider.listWindows() }
    },
    presentCall: (): GenericCallView => ({ card: 'generic', title: '列出浏览器窗口', kind: 'search' }),
  }))

  ctx.tools.register(defineTool({
    name: 'windows_focus',
    description: '把某个浏览器窗口带到前台。',
    parameters: {
      window_id: { type: 'integer', required: true, description: '目标窗口 id（来自 windows_list）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { windowId: { type: 'integer', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `已聚焦窗口 ${value.windowId}。` }],
    },
    async execute(args) {
      const windowId = typeof args.window_id === 'number' ? args.window_id : Number.NaN
      if (!Number.isInteger(windowId) || windowId <= 0) {
        throw new Error('window_id 必须是正整数')
      }
      await ctx.browser.provider.focusWindow(windowId)
      return { windowId }
    },
    presentCall: (args): GenericCallView => ({ card: 'generic', title: `聚焦窗口 ${args.window_id}`, kind: 'other', rawInput: args.window_id }),
  }))
}
