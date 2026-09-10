// @vitest-environment jsdom
/**
 * user-plugin-panel spec (SidePanel user-plugin management): the panel against
 * a scripted plugin rpc carrier — the module-level rpc() singleton is a Port
 * transport, so the panel's `rpc` prop is the injection seam — and a spy
 * sendPrompt. Covers the roster load (loading → list → empty guidance), the
 * error line, the enable switch's rpc payload + local apply (both success and
 * refusal), the two-stage delete confirm, and the AI-generation entry folding
 * a requirement into the shell's prompt channel.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UserPluginPanel, USER_PLUGIN_PANEL_CSS } from '../src/sidepanel-dsh/user-plugin-panel.tsx'
import type { PluginRpc, UserPluginItem } from '../src/sidepanel-dsh/user-plugin-panel.tsx'
import type { RpcOutcome } from '../src/sidepanel-dsh/rpc-client.ts'

// Appica's hooks subscribe to media queries through useSyncExternalStore; jsdom
// ships no matchMedia, so the store never subscribes and every render throws.
beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
})

afterEach(cleanup)

const ok = (value: unknown): RpcOutcome => ({ ok: true, value })
const fail = (message: string): RpcOutcome => ({ ok: false, error: { message } })

/** A scripted plugin rpc carrier; records every call for assertions. */
function fakeRpc(respond: (method: string, payload: Record<string, unknown>) => RpcOutcome | Promise<RpcOutcome>): {
  rpc: PluginRpc
  calls: Array<{ method: string; payload: Record<string, unknown> }>
} {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const rpc: PluginRpc = (method, payload) => {
    calls.push({ method, payload })
    return Promise.resolve(respond(method, payload))
  }
  return { rpc, calls }
}

const ROSTER: UserPluginItem[] = [
  {
    name: 'greet-on-prompt',
    title: '问候助手',
    description: '收到问候时自动回一句',
    enabled: true,
    registeredEvents: ['user/message'],
  },
  { name: 'page-watcher', title: '页面观察', description: '', enabled: false },
]

function renderPanel(rpc: PluginRpc, sendPrompt = vi.fn()): { sendPrompt: ReturnType<typeof vi.fn> } {
  render(<UserPluginPanel sessionId="session-main" sendPrompt={sendPrompt} onClose={vi.fn()} rpc={rpc} />)
  return { sendPrompt }
}

describe('user-plugin-panel', () => {
  it('loads the roster on open and renders every plugin row', async () => {
    const { rpc, calls } = fakeRpc(method => (method === 'plugin.list' ? ok({ items: ROSTER }) : fail('unexpected')))
    renderPanel(rpc)

    expect(calls).toContainEqual({ method: 'plugin.list', payload: {} })
    expect(await screen.findByText('greet-on-prompt')).toBeTruthy()
    expect(screen.getByText('问候助手')).toBeTruthy()
    expect(screen.getByText('收到问候时自动回一句')).toBeTruthy()
    expect(screen.getByText('user/message')).toBeTruthy()
    expect(screen.getByText('page-watcher')).toBeTruthy()
    // The enabled row's switch is on; the disabled row's is off.
    expect(screen.getByRole('switch', { name: '启用插件 greet-on-prompt' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: '启用插件 page-watcher' }).getAttribute('aria-checked')).toBe('false')
  })

  it('shows loading while the roster is in flight, then the empty guidance when there are none', async () => {
    let resolveList!: (outcome: RpcOutcome) => void
    const { rpc } = fakeRpc(method =>
      method === 'plugin.list'
        ? new Promise<RpcOutcome>((resolve) => { resolveList = resolve })
        : fail('unexpected'))
    renderPanel(rpc)

    expect(screen.getByText('加载中…')).toBeTruthy()

    act(() => { resolveList(ok({ items: [] })) })
    await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull())
    expect(screen.getByText('还没有用户插件——点击 AI 生成，让 Agent 帮你写第一个插件。')).toBeTruthy()
  })

  it('surfaces a refused roster read as an error line', async () => {
    const { rpc } = fakeRpc(() => fail('引擎未就绪'))
    renderPanel(rpc)

    expect((await screen.findByRole('alert')).textContent).toContain('引擎未就绪')
    // A refused read shows no empty guidance (the next poll may still succeed).
    expect(screen.queryByText('还没有用户插件——点击 AI 生成，让 Agent 帮你写第一个插件。')).toBeNull()
  })

  it('posts plugin.toggle and applies the host-returned state locally', async () => {
    const { rpc, calls } = fakeRpc((method, payload) => {
      if (method === 'plugin.list') return ok({ items: ROSTER })
      if (method === 'plugin.toggle') {
        return ok({ name: payload.name, enabled: payload.enabled, registeredEvents: [] })
      }
      return fail('unexpected')
    })
    renderPanel(rpc)
    await screen.findByText('greet-on-prompt')

    fireEvent.click(screen.getByRole('switch', { name: '启用插件 greet-on-prompt' }))
    await waitFor(() => {
      expect(calls).toContainEqual({ method: 'plugin.toggle', payload: { name: 'greet-on-prompt', enabled: false } })
    })
    // The row applies the response: switch off, bound-event tags gone.
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: '启用插件 greet-on-prompt' }).getAttribute('aria-checked')).toBe('false')
    })
    expect(screen.queryByText('user/message')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the row unchanged and shows the error line on a refused toggle', async () => {
    const { rpc } = fakeRpc((method, payload) => {
      if (method === 'plugin.list') return ok({ items: ROSTER })
      if (method === 'plugin.toggle') return fail(`插件不存在：${String(payload.name)}`)
      return fail('unexpected')
    })
    renderPanel(rpc)
    await screen.findByText('greet-on-prompt')

    fireEvent.click(screen.getByRole('switch', { name: '启用插件 greet-on-prompt' }))
    expect(await screen.findByText('插件不存在：greet-on-prompt')).toBeTruthy()
    expect(screen.getByRole('switch', { name: '启用插件 greet-on-prompt' }).getAttribute('aria-checked')).toBe('true')
  })

  it('renders a stored activation-failure marker and clears it after a successful toggle', async () => {
    const roster: UserPluginItem[] = [
      { name: 'broken-one', title: '坏插件', description: '', enabled: false, lastError: 'SyntaxError: 意外的标记' },
    ]
    const { rpc } = fakeRpc((method, payload) => {
      if (method === 'plugin.list') return ok({ items: roster })
      if (method === 'plugin.toggle') {
        return ok({ name: payload.name, enabled: payload.enabled, registeredEvents: ['user/message'] })
      }
      return fail('unexpected')
    })
    renderPanel(rpc)

    // The stored marker renders as an inline alert on the row.
    expect(await screen.findByText(/上次激活失败：SyntaxError/)).toBeTruthy()

    // Any successful toggle clears the marker locally (the host rebuilds the record).
    fireEvent.click(screen.getByRole('switch', { name: '启用插件 broken-one' }))
    await waitFor(() => expect(screen.queryByText(/上次激活失败/)).toBeNull())
    expect(screen.getByRole('switch', { name: '启用插件 broken-one' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('user/message')).toBeTruthy()
  })

  it('deletes only after the two-stage confirm; 取消 aborts without an rpc call', async () => {
    const { rpc, calls } = fakeRpc((method) => {
      if (method === 'plugin.list') return ok({ items: [ROSTER[0]!] })
      if (method === 'plugin.remove') return ok({ removed: true })
      return fail('unexpected')
    })
    renderPanel(rpc)
    await screen.findByText('greet-on-prompt')

    // First click arms the confirm; nothing is sent yet.
    fireEvent.click(screen.getByRole('button', { name: '删除插件 greet-on-prompt' }))
    expect(screen.getByRole('button', { name: '确认删除插件 greet-on-prompt' })).toBeTruthy()
    expect(calls.some(call => call.method === 'plugin.remove')).toBe(false)

    // 取消 folds back without sending.
    fireEvent.click(screen.getByRole('button', { name: '取消删除' }))
    expect(screen.queryByRole('button', { name: '确认删除插件 greet-on-prompt' })).toBeNull()
    expect(calls.some(call => call.method === 'plugin.remove')).toBe(false)

    // The second 删除 → 确认删除 round trips the rpc and retires the row.
    fireEvent.click(screen.getByRole('button', { name: '删除插件 greet-on-prompt' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除插件 greet-on-prompt' }))
    await waitFor(() => {
      expect(calls).toContainEqual({ method: 'plugin.remove', payload: { name: 'greet-on-prompt' } })
    })
    await waitFor(() => expect(screen.queryByText('greet-on-prompt')).toBeNull())
    expect(screen.getByText('还没有用户插件——点击 AI 生成，让 Agent 帮你写第一个插件。')).toBeTruthy()
  })

  it('AI 生成 folds the requirement into sendPrompt and closes the form with a hint', async () => {
    const { rpc } = fakeRpc(method => (method === 'plugin.list' ? ok({ items: [] }) : fail('unexpected')))
    const { sendPrompt } = renderPanel(rpc)
    await screen.findByText('还没有用户插件——点击 AI 生成，让 Agent 帮你写第一个插件。')

    fireEvent.click(screen.getByRole('button', { name: 'AI 生成' }))
    const input = screen.getByPlaceholderText(/描述你想要的插件/)
    fireEvent.change(input, { target: { value: '做一个问候插件' } })
    fireEvent.click(screen.getByRole('button', { name: '发送给 Agent' }))

    expect(sendPrompt).toHaveBeenCalledTimes(1)
    const instruction = sendPrompt.mock.calls[0]![0] as string
    expect(instruction).toContain('user_plugin_write')
    expect(instruction).toContain('做一个问候插件')
    expect(screen.queryByPlaceholderText(/描述你想要的插件/)).toBeNull()
    expect(await screen.findByText(/已把生成指令发给会话「session-main」，生成进度请看会话记录/)).toBeTruthy()
  })
})

describe('USER_PLUGIN_PANEL_CSS button discipline', () => {
  /** The body of the named rule (selector start → closing brace). */
  const rule = (selector: string): string => {
    const at = USER_PLUGIN_PANEL_CSS.indexOf(selector)
    expect(at).toBeGreaterThanOrEqual(0)
    return USER_PLUGIN_PANEL_CSS.slice(at, USER_PLUGIN_PANEL_CSS.indexOf('}', at) + 1)
  }

  it('keeps the layout-owned one-line discipline: the generation trigger stays one-line', () => {
    // The switch/buttons/textarea/badges carry appica's own one-line styles;
    // the panel stylesheet only pins the oversized generation trigger.
    expect(rule('.dshx-up-gen{')).toContain('white-space:nowrap')
  })

  it('wraps the action rows as whole buttons and keeps event tags atomic', () => {
    expect(rule('.dshx-up-genactions{')).toContain('flex-wrap:wrap')
    expect(rule('.dshx-up-itemactions{')).toContain('flex-wrap:wrap')
    expect(rule('.dshx-up-event{')).toContain('white-space:nowrap')
  })
})
