/**
 * `user-plugin-tools`: exposes the user-plugin lane to the MODEL as real
 * tools. The `plugin.*` RPC surface on the api bridge only serves the
 * SidePanel; without these registrations the model has no way to author,
 * list, or toggle plugins — the "user asks, agent installs" loop silently
 * dead-ends. Handlers delegate to the same {@link UserPluginHost} singleton
 * the bridge resolves, so both lanes share storage and sandbox lifecycle.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { userPluginHost } from '../chrome/user-plugins.ts'

/** Required host accessor at apply time; the offscreen entry sets it right before loader.create. */
function requireHost() {
  const host = userPluginHost()
  if (host === undefined) {
    throw new Error('用户插件宿主未初始化（引擎装配顺序错误）')
  }
  return host
}

/** Tools carry no config today; the seam exists for a future size cap policy. */
export interface Config {}

/** Accessing ctx.tools requires the dependency to be declared (cordis gate). */
export const inject = ['tools']

/**
 * Register the four `user_plugin_*` tools on ctx.tools. Registered AFTER the
 * host singleton is set by the entry, so `requireHost()` never fires in
 * practice — the guard keeps the failure loud if assembly order ever changes.
 */
export function apply(ctx: Context, _config: Config): void {
  void _config

  ctx.tools.register(defineTool({
    name: 'user_plugin_list',
    description: '列出当前已安装的用户插件（你自己或用户此前写入的可热加载插件）。返回名称、标题、描述、启用状态与监听的事件；激活失败被自动停用的插件带 lastError 字段（失败原因）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                name: { type: 'string', required: true },
                title: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                lastError: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.items.length === 0
          ? '当前没有任何用户插件。'
          : `共 ${value.items.length} 个用户插件：${value.items.map((item) => {
            if (item.enabled) return item.name
            return typeof item.lastError === 'string' && item.lastError !== ''
              ? `${item.name}（停用：上次激活失败）`
              : `${item.name}（停用）`
          }).join('、')}。`,
      }],
    },
    async execute() {
      // Plain-object projection: the tool output schema requires a string
      // index signature the storage record interface doesn't declare.
      const items = await requireHost().list(false)
      return {
        items: items.map(item => ({
          name: item.name,
          title: item.title,
          enabled: item.enabled,
          ...(item.lastError === undefined ? {} : { lastError: item.lastError }),
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: '列出用户插件', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'user_plugin_write',
    description: [
      '编写并热加载一个用户插件：代码运行在受限沙箱中，通过返回对象的 `events` 数组声明要监听的事件、`on(eventName, payload)` 回调响应、可选 `remove()` 清理。',
      '回调内可用宿主提供的 ctx.log(...) / ctx.warn(...) 输出。事件载荷为只读快照。',
      '同名插件会被整体替换。适合让 Agent 为用户定制自动化行为（例如在特定页面事件上提醒、记录）。',
      'name 必须是 kebab-case 短标识；title/description 面向用户展示。',
      '若激活失败（如代码语法错误或未按约定 return 对象），插件会以停用状态保存并记录失败原因；修正代码后重新写入本工具即可。',
    ].join('\n'),
    parameters: {
      name: { type: 'string', required: true, description: '插件唯一名，kebab-case，如 hello-notifier。' },
      title: { type: 'string', required: true, description: '展示标题，简短中文。' },
      description: { type: 'string', description: '面向用户的功能说明，一两句话。' },
      code: {
        type: 'string',
        required: true,
        description: '插件工厂函数体。收到的形参名为 ctx；必须 return 一个对象：{ events: string[], on(name,payload), remove?() }。例：return { events:["turn/end"], on(){ ctx.log("done") } }',
      },
      enabled: { type: 'boolean', description: '写入后是否立即启用，默认 true。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          name: { type: 'string', required: true },
          registeredEvents: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `插件 ${value.name} 已写入并热加载，监听事件：${Array.isArray(value.registeredEvents) && value.registeredEvents.length > 0 ? value.registeredEvents.join('、') : '（无）'}。`,
      }],
    },
    async execute(args) {
      const record: Record<string, unknown> = {
        name: args.name,
        title: typeof args.title === 'string' ? args.title : (args.name),
        description: typeof args.description === 'string' ? args.description : '',
        code: args.code,
      }
      if (typeof args.enabled === 'boolean') record['enabled'] = args.enabled
      return await requireHost().write(record as unknown as Parameters<ReturnType<typeof requireHost>['write']>[0])
    },
    presentCall: args => ({
      card: 'generic',
      title: `编写用户插件 · ${typeof args.name === 'string' ? args.name : '?'}`,
      kind: 'other',
      rawInput: { name: args.name, title: args.title },
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'user_plugin_remove',
    description: '删除一个用户插件并立即卸载其监听。',
    parameters: {
      name: { type: 'string', required: true, description: '要删除的插件名。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { removed: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.removed ? '已删除。' : '删除失败。' }],
    },
    async execute(args) {
      await requireHost().remove(args.name)
      return { removed: true }
    },
    presentCall: args => ({
      card: 'generic',
      title: `删除用户插件 · ${typeof args.name === 'string' ? args.name : '?'}`,
      kind: 'other',
      rawInput: undefined,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'user_plugin_toggle',
    description: '启用或停用一个已安装的用户插件（停用会解绑全部监听，保留代码）。启用时激活失败（代码损坏）会保持停用并记录失败原因，错误信息返回给你。',
    parameters: {
      name: { type: 'string', required: true, description: '插件名。' },
      enabled: { type: 'boolean', required: true, description: 'true=启用，false=停用。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          name: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `插件 ${value.name} 已${value.enabled ? '启用' : '停用'}。`,
      }],
    },
    async execute(args) {
      const enabled = args.enabled
      return await requireHost().toggle(args.name, enabled)
    },
    presentCall: args => ({
      card: 'generic',
      title: `切换用户插件 · ${typeof args.name === 'string' ? args.name : '?'}`,
      kind: 'other',
      rawInput: undefined,
    }),
  }))
}
