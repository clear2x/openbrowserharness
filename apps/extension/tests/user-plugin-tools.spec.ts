// @vitest-environment jsdom
/**
 * `user_plugin_*` model-tool spec: the four registrations, their delegation
 * to the live {@link UserPluginHost}, the list projection (code stripped,
 * lastError surfaced), the render copy (empty roster / disabled-with-failure
 * phrasing), and the loud assembly-order guard when no host is booted.
 * @module @deepseek-ai/dsh-extension/tests/user-plugin-tools
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { setUserPluginHost } from '../src/chrome/user-plugins.ts'
import type { UserPluginHost, UserPluginListItem } from '../src/chrome/user-plugins.ts'
import { apply as applyUserPluginTools } from '../src/offscreen/user-plugin-tools.ts'

/** A cordis context double that only captures ctx.tools.register calls. */
function fakeCtx(): { ctx: Context; tools: Array<{ name: string }> } {
  const tools: Array<{ name: string }> = []
  const ctx = {
    tools: {
      register: (tool: { name: string }): void => {
        tools.push(tool)
      },
    },
  } as unknown as Context
  return { ctx, tools }
}

afterEach(() => {
  setUserPluginHost(undefined as unknown as UserPluginHost)
  vi.restoreAllMocks()
})

/** A host double with scripted answers; every method is a spy. */
function fakeHost(overrides: Partial<UserPluginHost> = {}): UserPluginHost & Record<string, ReturnType<typeof vi.fn>> {
  const base = {
    list: vi.fn(async () => []),
    write: vi.fn(async () => ({ name: 'written', registeredEvents: [] as string[] })),
    remove: vi.fn(async () => {}),
    toggle: vi.fn(async (_name: string, _enabled: boolean) => ({ name: 'toggled', enabled: true, registeredEvents: [] as string[] })),
    start: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  }
  return { ...base, ...overrides } as unknown as UserPluginHost & Record<string, ReturnType<typeof vi.fn>>
}

function itemOf(partial: Partial<UserPluginListItem>): UserPluginListItem {
  return {
    name: 'p',
    title: 'P',
    description: '',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    registeredEvents: [],
    ...partial,
  }
}

describe('user_plugin_* model tools', () => {
  it('registers exactly the four plugin tools', () => {
    const { ctx, tools } = fakeCtx()
    applyUserPluginTools(ctx, {})
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'user_plugin_list',
      'user_plugin_remove',
      'user_plugin_toggle',
      'user_plugin_write',
    ])
  })

  it('user_plugin_list projects host rows without code and renders the failure phrasing', async () => {
    const listSpy = vi.fn(async () => [
      itemOf({ name: 'alpha', title: 'Alpha', enabled: true, registeredEvents: ['turn/end'] }),
      itemOf({ name: 'beta', title: 'Beta', enabled: false, lastError: '激活失败：语法错误' }),
    ])
    const host = fakeHost({ list: listSpy })
    setUserPluginHost(host)
    const { ctx, tools } = fakeCtx()
    applyUserPluginTools(ctx, {})
    const list = tools.find(tool => tool.name === 'user_plugin_list') as unknown as {
      execute: (args: Record<string, never>) => Promise<{ items: Array<{ name: string; enabled: boolean; lastError?: string }> }>
      output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
    }
    const out = await list.execute({})
    expect(out.items).toEqual([
      { name: 'alpha', title: 'Alpha', enabled: true },
      { name: 'beta', title: 'Beta', enabled: false, lastError: '激活失败：语法错误' },
    ])
    expect(listSpy).toHaveBeenCalledWith(false)
    // render: disabled-with-failure phrasing rides lastError
    const rendered = list.output.render({}, out)[0]?.text ?? ''
    expect(rendered).toContain('2 个用户插件')
    expect(rendered).toContain('alpha')
    expect(rendered).toContain('（停用：上次激活失败）')
  })

  it('user_plugin_list renders the empty-roster sentence', () => {
    setUserPluginHost(fakeHost())
    const { ctx, tools } = fakeCtx()
    applyUserPluginTools(ctx, {})
    const list = tools.find(tool => tool.name === 'user_plugin_list') as unknown as {
      output: { render: (args: unknown, value: { items: unknown[] }) => Array<{ text: string }> }
    }
    expect(list.output.render({}, { items: [] })[0]?.text).toBe('当前没有任何用户插件。')
  })

  it('user_plugin_write delegates the record (title falls back to name, enabled rides) to the host', async () => {
    const writeSpy = vi.fn(async () => ({ name: 'notifier', registeredEvents: ['turn/end'] as string[] }))
    const host = fakeHost({ write: writeSpy })
    setUserPluginHost(host)
    const { ctx, tools } = fakeCtx()
    applyUserPluginTools(ctx, {})
    const writeTool = tools.find(tool => tool.name === 'user_plugin_write') as unknown as {
      execute: (args: Record<string, unknown>) => Promise<unknown>
    }
    await writeTool.execute({ name: 'notifier', title: '通知器', code: 'return { events: [] }', enabled: false })
    expect(writeSpy).toHaveBeenCalledWith({
      name: 'notifier',
      title: '通知器',
      description: '',
      code: 'return { events: [] }',
      enabled: false,
    })
  })

  it('user_plugin_write requires title at the schema edge (the model must label its work)', async () => {
    const writeSpy = vi.fn(async () => ({ name: 'x', registeredEvents: [] as string[] }))
    const host = fakeHost({ write: writeSpy })
    setUserPluginHost(host)
    const { ctx, tools } = fakeCtx()
    applyUserPluginTools(ctx, {})
    const writeTool = tools.find(tool => tool.name === 'user_plugin_write') as unknown as {
      execute: (args: Record<string, unknown>) => Promise<unknown>
    }
    await expect(writeTool.execute({ name: 'notifier', code: 'return { events: [] }' })).rejects.toThrow(/title/)
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('user_plugin_remove and user_plugin_toggle delegate to the host', async () => {
    const removeSpy = vi.fn(async () => {})
    const toggleSpy = vi.fn(async (_name: string, _enabled: boolean) => ({ name: 'p', enabled: false, registeredEvents: [] as string[] }))
    const host = fakeHost({ remove: removeSpy, toggle: toggleSpy })
    setUserPluginHost(host)
    const { ctx, tools } = fakeCtx()
    applyUserPluginTools(ctx, {})
    const remove = tools.find(tool => tool.name === 'user_plugin_remove') as unknown as {
      execute: (args: { name: string }) => Promise<{ removed: boolean }>
    }
    expect((await remove.execute({ name: 'p' })).removed).toBe(true)
    expect(removeSpy).toHaveBeenCalledWith('p')
    const toggle = tools.find(tool => tool.name === 'user_plugin_toggle') as unknown as {
      execute: (args: { name: string; enabled: boolean }) => Promise<{ name: string; enabled: boolean; registeredEvents: string[] }>
    }
    const toggleResult = await toggle.execute({ name: 'p', enabled: false })
    expect(toggleResult.enabled).toBe(false)
    expect(toggleSpy).toHaveBeenCalledWith('p', false)
  })

  it('fails loud when no host is booted (assembly-order guard)', async () => {
    const { ctx, tools } = fakeCtx()
    applyUserPluginTools(ctx, {})
    const list = tools.find(tool => tool.name === 'user_plugin_list') as unknown as {
      execute: (args: Record<string, never>) => Promise<unknown>
    }
    await expect(list.execute({})).rejects.toThrow('用户插件宿主未初始化')
  })
})
