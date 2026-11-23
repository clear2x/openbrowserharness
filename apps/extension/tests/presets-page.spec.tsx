// @vitest-environment jsdom
/**
 * extension-presets-page: the Agent 预设 drill-down renders the roster in
 * 内置/自定义 groups with per-row actions, authors through `agentPreset.write`
 * (the one write the upstream section never offered in this host), makes
 * defaults through the `agent-presets` settings namespace, and deletes user
 * rows with the two-step arm/confirm. rpc is mocked at the module boundary —
 * the wire contracts pinned here are the api-bridge handlers' payloads.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPresetsPage } from '../src/sidepanel-dsh/presets-page.tsx'
import { rpc } from '../src/sidepanel-dsh/rpc-client.ts'

vi.mock('../src/sidepanel-dsh/rpc-client.ts', () => ({ rpc: vi.fn() }))

const ROSTER = {
  presets: [
    { id: 'default', trust: 'system', isDefault: true, name: '默认', description: '当前引擎：zhipu-coding/glm-5.3-flash' },
    { id: 'web-research', trust: 'system', isDefault: false, name: '网页研究员', description: '深读网页、多源交叉验证' },
    { id: 'my-preset', trust: 'user', isDefault: false, name: '我的预设', description: '自建' },
  ],
}

function scriptList(): void {
  vi.mocked(rpc).mockImplementation((method) => {
    if (method === 'agentPreset.list') return Promise.resolve({ ok: true, value: ROSTER })
    if (method === 'agentPreset.read') {
      return Promise.resolve({
        ok: true,
        value: {
          agentPreset: 'my-preset',
          trust: 'user',
          content: JSON.stringify({ id: 'my-preset', trust: 'user', name: '我的预设', description: '自建', systemPrompt: '你是测试助手。' }, null, 2),
          name: '我的预设',
          description: '自建',
        },
      })
    }
    return Promise.resolve({ ok: true, value: {} })
  })
}

describe('extension presets page', () => {
  beforeEach(() => {
    vi.mocked(rpc).mockReset()
    scriptList()
  })
  afterEach(() => { cleanup() })

  it('groups the roster into 内置 and 自定义 with per-row actions', async () => {
    render(<AgentPresetsPage />)
    await screen.findByText('我的预设')
    expect(screen.getByText('网页研究员')).toBeTruthy()
    // Exactly one solid 默认 tag (the isDefault row) among the trust tags.
    expect(document.querySelectorAll('.dshx-sptag.is-solid')).toHaveLength(1)
    // The default row carries no 设为默认; the other two do.
    expect(screen.getAllByText('设为默认')).toHaveLength(2)
    expect(screen.getByText('＋ 新建预设')).toBeTruthy()
    expect(rpc).toHaveBeenCalledWith('agentPreset.list', {})
  })

  it('creates a preset through agentPreset.write and refreshes the roster', async () => {
    render(<AgentPresetsPage />)
    fireEvent.click(await screen.findByText('＋ 新建预设'))
    fireEvent.change(screen.getByPlaceholderText('my-preset'), { target: { value: 'news-scout' } })
    fireEvent.change(screen.getByPlaceholderText('给预设起个名字'), { target: { value: '新闻哨兵' } })
    fireEvent.change(screen.getByPlaceholderText(/写给 Agent 的工作方式约定/), { target: { value: '只读快照。' } })
    fireEvent.click(screen.getByText('保存预设'))
    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('agentPreset.write', {
        agentPreset: 'news-scout',
        name: '新闻哨兵',
        systemPrompt: '只读快照。',
      })
    })
  })

  it('rejects an id outside the stored shape locally without a write', async () => {
    render(<AgentPresetsPage />)
    fireEvent.click(await screen.findByText('＋ 新建预设'))
    fireEvent.change(screen.getByPlaceholderText('my-preset'), { target: { value: 'Bad Id' } })
    fireEvent.click(screen.getByText('保存预设'))
    await screen.findByRole('alert')
    expect(rpc).not.toHaveBeenCalledWith('agentPreset.write', expect.anything())
  })

  it('deletes a user row with the two-step arm and confirm', async () => {
    render(<AgentPresetsPage />)
    const armed = await screen.findByRole('button', { name: '删除 我的预设' })
    fireEvent.click(armed)
    fireEvent.click(await screen.findByRole('button', { name: '确认删除 我的预设' }))
    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('agentPreset.remove', { agentPreset: 'my-preset' })
    })
  })

  it('edits a user row by loading its stored prompt addendum back into the form', async () => {
    render(<AgentPresetsPage />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑 我的预设' }))
    const prompt = await screen.findByDisplayValue('你是测试助手。') as HTMLTextAreaElement
    expect(screen.getByPlaceholderText<HTMLInputElement>('my-preset').value).toBe('my-preset')
    expect(prompt.disabled).toBe(false)
  })

  it('makes a non-default row the default through the agent-presets settings namespace', async () => {
    render(<AgentPresetsPage />)
    fireEvent.click((await screen.findAllByText('设为默认'))[0] as HTMLElement)
    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('settings.update', { ns: 'agent-presets', patch: { default: 'web-research' } })
    })
  })

  it('opens the read-only document viewer from the 查看 action', async () => {
    render(<AgentPresetsPage />)
    fireEvent.click((await screen.findAllByText('查看'))[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('"id": "my-preset"')
    expect(dialog.textContent).toContain('查看预设')
  })
})
