// @vitest-environment jsdom
/**
 * composer-bar spec (SidePanel composer toolbar): the context-meter chip
 * prefers the wire's real context windows over the local estimate table, the
 * model-menu rows carry 思考/视觉 capability badges, the reasoning-effort
 * segment hides for a catalogued model whose wire row exposes no reasoning
 * metadata, and the send pipeline (`dispatchSendLine`) routes `/` lines to
 * `commands/execute` (`//` escapes, `/export` hands off to the shell's export
 * callback, unknown commands fall back to a normal send with a notice) and
 * switches provider groups to their default model. The slash-candidate menu
 * (`SlashMenu`) lists `commands/list` merged with the shell-local `/export`,
 * filters by name prefix/description, fills on Enter / completes on Tab, and
 * dismisses on Esc and outside pointerdown; a failed `commands/list` degrades
 * to no menu. The @-mention pipeline addresses SUBAGENTS: `useSubagents`
 * reads `subagent.list` once per session (only continuable children become
 * candidates), `SubagentMenu` floats the word-bounded `@token` candidates
 * with the slash menu's fill/keyboard semantics, and `dispatchSendLine`
 * routes an `@名字 正文` line through `subagent.prompt` (longest-label
 * resolution, body only) with notice fallbacks for an unresolved name, a
 * refused delivery, and a `//` escape that outranks the mention grammar.
 * The rpc client is mocked — no chrome, no Port — and the component is
 * driven through testing-library like the other client-face specs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef, useState } from 'react'
import type { JSX } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { COMPOSER_CSS, ComposerBar, dispatchSendLine, SlashMenu, SubagentMenu, useSubagents } from '../src/sidepanel-dsh/composer-bar.tsx'
import type { ModelGroup, SubagentCandidate } from '../src/sidepanel-dsh/composer-bar.tsx'
import { rpc } from '../src/sidepanel-dsh/rpc-client.ts'

vi.mock('../src/sidepanel-dsh/rpc-client.ts', () => ({
  rpc: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/**
 * Scripted rpc answers: the boot selection, one usage reading (50k tokens),
 * the permission knob reading, and the agent-preset roster/history.
 */
function scriptRpc(
  current: { provider?: string; model?: string; reasoningEffort?: string },
  permission: { mode: string; planActive: boolean } | { failed: true } = { mode: 'confirm', planActive: false },
  options: {
    presets?: Array<{ id: string; name?: string; isDefault?: boolean; broken?: string }>
    selectedPreset?: string
  } = {},
): void {
  vi.mocked(rpc).mockImplementation((method: string, payload: unknown) => {
    if (method === 'session.models') {
      return Promise.resolve({ ok: true, value: { current } })
    }
    if (method === 'session.usage') {
      return Promise.resolve({ ok: true, value: { totalTokens: 50_000 } })
    }
    if (method === 'session.selectModel') {
      return Promise.resolve({ ok: true, value: { selected: {} } })
    }
    if (method === 'session.permission.get') {
      return 'failed' in permission
        ? Promise.resolve({ ok: false, error: { message: 'bridge down' } })
        : Promise.resolve({ ok: true, value: permission })
    }
    if (method === 'session.permission.set') {
      return Promise.resolve({ ok: true, value: {} })
    }
    if (method === 'session.history') {
      const events = options.selectedPreset === undefined
        ? []
        : [{ type: 'agent-preset/selected', data: { agentPreset: options.selectedPreset } }]
      return Promise.resolve({ ok: true, value: { events } })
    }
    if (method === 'agentPreset.list') {
      const rows = options.presets ?? [
        { id: 'default', name: '默认', isDefault: true },
        { id: 'research', name: '研究员' },
      ]
      return Promise.resolve({ ok: true, value: { presets: rows, authorable: true, hasDocument: false } })
    }
    if (method === 'agentPreset.select') {
      const wanted = (payload as { agentPreset?: string }).agentPreset ?? 'unknown'
      return Promise.resolve({ ok: true, value: { agentPreset: wanted } })
    }
    return Promise.resolve({ ok: false, error: { message: 'unexpected method' } })
  })
}

function renderBar(
  groups: ModelGroup[],
  current: { provider?: string; model?: string; reasoningEffort?: string },
  permission: { mode: string; planActive: boolean } | { failed: true } = { mode: 'confirm', planActive: false },
): void {
  scriptRpc(current, permission)
  render(
    <ComposerBar
      sessionId="session-main"
      running={false}
      canSend={false}
      groups={groups}
      onSend={vi.fn()}
      onInterrupt={vi.fn()}
    />,
  )
}

describe('composer-bar', () => {
  it('pairs the meter with the exact model window from the wire, beating the group window and the local table', async () => {
    renderBar([{
      id: 'deepseek',
      name: 'DeepSeek',
      contextWindow: 1_000_000,
      models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 200_000 }],
    }], { provider: 'deepseek', model: 'deepseek-v4-pro' })
    // 50k/200k — the model row's 200k window, not the group's 1M nor the
    // local deepseek default of 1M.
    expect(await screen.findByText('25% · 50k/200k')).toBeDefined()
  })

  it('falls back to the provider-group window when the model row carries none', async () => {
    renderBar([{
      id: 'acme',
      name: 'Acme',
      contextWindow: 64_000,
      models: [{ id: 'acme-large', name: 'Acme Large' }],
    }], { provider: 'acme', model: 'acme-large' })
    // 50k/64k — the group's disclosed window wins over the local table
    // (acme is absent from it anyway).
    expect(await screen.findByText('78% · 50k/64k')).toBeDefined()
  })

  it('uses a declared custom-route window verbatim', async () => {
    renderBar([{
      id: 'acme-gateway',
      name: 'Acme Gateway',
      models: [{ id: 'acme-large', name: 'Acme Large', contextWindow: 60_000 }],
    }], { provider: 'acme-gateway', model: 'acme-large' })
    // 50k/60k — the profile-disclosed window, no group-level fallback.
    expect(await screen.findByText('83% · 50k/60k')).toBeDefined()
  })

  it('keeps the local estimate table as the last-resort window', async () => {
    renderBar([], { provider: 'openai', model: 'gpt-4o' })
    // No wire metadata anywhere: the local openai default (128k) applies.
    expect(await screen.findByText('39% · 50k/128k')).toBeDefined()
  })

  it('renders 思考/视觉 capability badges on catalogued model rows', async () => {
    renderBar([{
      id: 'openai',
      name: 'OpenAI',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o', inputModalities: ['text', 'image'], reasoning: { efforts: [{}] } },
        { id: 'gpt-5-mini', name: 'GPT-5 mini' },
      ],
    }], { provider: 'openai', model: 'gpt-4o' })
    fireEvent.click(await screen.findByRole('button', { name: /GPT-4o/ }))
    const visionRow = await screen.findByRole('menuitem', { name: /GPT-4o/ })
    expect(within(visionRow).getByText('视觉')).toBeDefined()
    expect(within(visionRow).getByText('思考')).toBeDefined()
    const plainRow = screen.getByRole('menuitem', { name: /GPT-5 mini/ })
    expect(within(plainRow).queryByText('视觉')).toBeNull()
    expect(within(plainRow).queryByText('思考')).toBeNull()
  })

  it('keeps the effort dropdown always visible and clears a level on a model without reasoning', async () => {
    const groups: ModelGroup[] = [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning: { efforts: [{}] } }],
      },
      { id: 'plain', name: 'Plain', models: [{ id: 'plain-model', name: 'Plain Model' }] },
    ]
    renderBar(groups, { provider: 'plain', model: 'plain-model' })
    // Always-on dropdown (user requirement): visible even for the plain model.
    await screen.findByRole('button', { name: '思考强度' })
    // A level picked on a reasoning model must NOT carry across the switch to
    // the plain model — the runtime hard-refuses a reasoningEffort on a model
    // without reasoning metadata. Pick high first, then switch: the plain
    // switch's payload omits reasoningEffort entirely.
    fireEvent.click(await screen.findByRole('button', { name: /Plain Model/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /DeepSeek-V4-Pro/ }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '思考强度' })).toBeDefined()
    })
    fireEvent.click(screen.getByRole('button', { name: '思考强度' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /^高$/ }))
    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('session.selectModel', expect.objectContaining({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
      }))
    })
    fireEvent.click(await screen.findByRole('button', { name: /DeepSeek-V4-Pro/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Plain Model/ }))
    await waitFor(() => {
      const plainSwitch = vi.mocked(rpc).mock.calls.filter(([method]) => method === 'session.selectModel').at(-1)?.[1] as Record<string, unknown>
      expect(plainSwitch).toMatchObject({ provider: 'plain', model: 'plain-model' })
      expect('reasoningEffort' in plainSwitch).toBe(false)
    })
  })

  it('routes a / line through commands/execute without sending it to the model', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({
      ok: true,
      value: { commandId: 'cmd-1', result: { kind: 'success', text: 'Plan mode off.' } },
    })
    const prompt = vi.fn()
    const admitted = vi.fn()
    dispatchSendLine('session-main', '/plan off', {
      prompt,
      subagents: [],
      onCommandAdmitted: admitted,
      onSubagentSent: vi.fn(),
      notice: vi.fn(),
      exportLog: vi.fn(),
    })
    await waitFor(() => {
      expect(admitted).toHaveBeenCalledOnce()
    })
    // The typert invoke envelope the api-bridge commands dispatcher decodes.
    expect(rpc).toHaveBeenCalledWith('commands/execute', {
      args: { agentId: 'session-main', line: '/plan off' },
    })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('escapes a // prefix into a literal / prompt without calling the command bridge', () => {
    const prompt = vi.fn()
    dispatchSendLine('session-main', '//plan off', {
      prompt,
      subagents: [],
      onCommandAdmitted: vi.fn(),
      onSubagentSent: vi.fn(),
      notice: vi.fn(),
      exportLog: vi.fn(),
    })
    expect(prompt).toHaveBeenCalledWith('/plan off')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('hands the bare /export line to the shell export without the command bridge or the model', () => {
    const prompt = vi.fn()
    const exportLog = vi.fn()
    dispatchSendLine('session-main', '/export', {
      prompt,
      subagents: [],
      onCommandAdmitted: vi.fn(),
      onSubagentSent: vi.fn(),
      notice: vi.fn(),
      exportLog,
    })
    expect(exportLog).toHaveBeenCalledWith('session-main')
    expect(prompt).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('resolves /export with an argument through the command bridge like any other / line', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ ok: true, value: undefined })
    const prompt = vi.fn()
    const exportLog = vi.fn()
    dispatchSendLine('session-main', '/export json', {
      prompt,
      subagents: [],
      onCommandAdmitted: vi.fn(),
      onSubagentSent: vi.fn(),
      notice: vi.fn(),
      exportLog,
    })
    await waitFor(() => {
      expect(prompt).toHaveBeenCalledWith('/export json')
    })
    // The export implementation supports no format argument, so only the bare
    // command is client-side; the argumented line stays a command-bridge call.
    expect(rpc).toHaveBeenCalledWith('commands/execute', {
      args: { agentId: 'session-main', line: '/export json' },
    })
    expect(exportLog).not.toHaveBeenCalled()
  })

  it('falls back to a normal send with a notice when the command is unknown', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ ok: true, value: undefined })
    const prompt = vi.fn()
    const notice = vi.fn()
    dispatchSendLine('session-main', '/nope', {
      prompt,
      subagents: [],
      onCommandAdmitted: vi.fn(),
      onSubagentSent: vi.fn(),
      notice,
      exportLog: vi.fn(),
    })
    await waitFor(() => {
      expect(prompt).toHaveBeenCalledWith('/nope')
    })
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('/nope'))
  })

  it('falls back to a normal send with a notice when the command bridge refuses', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ ok: false, error: { message: 'bridge down' } })
    const prompt = vi.fn()
    const notice = vi.fn()
    dispatchSendLine('session-main', '/plan off', {
      prompt,
      subagents: [],
      onCommandAdmitted: vi.fn(),
      onSubagentSent: vi.fn(),
      notice,
      exportLog: vi.fn(),
    })
    await waitFor(() => {
      expect(prompt).toHaveBeenCalledWith('/plan off')
    })
    expect(notice).toHaveBeenCalled()
  })

  it('lands on the group default model when switching provider groups', async () => {
    renderBar([
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
          { id: 'deepseek-v4', name: 'DeepSeek-V4' },
        ],
      },
      {
        id: 'openai',
        name: 'OpenAI',
        models: [
          { id: 'gpt-5', name: 'GPT-5' },
          { id: 'gpt-4o', name: 'GPT-4o' },
        ],
      },
    ], { provider: 'deepseek', model: 'deepseek-v4-pro' })
    // Open the model menu and click the OpenAI GROUP header — no model row
    // picked, so the selection lands on the group's first catalogued model.
    fireEvent.click(await screen.findByRole('button', { name: /DeepSeek-V4-Pro/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'OpenAI' }))
    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('session.selectModel', expect.objectContaining({
        sessionId: 'session-main',
        provider: 'openai',
        model: 'gpt-5',
      }))
    })
  })

  it('renders the permission switcher with all three modes and switches from the menu', async () => {
    renderBar([], {}, { mode: 'ask-change', planActive: false })
    // The chip reads the folded knob (the poll's first success).
    fireEvent.click(await screen.findByTitle('权限模式：变更确认'))
    const menu = await screen.findByRole('menu', { name: '权限模式' })
    for (const label of ['每次确认', '变更确认', '完全访问']) {
      expect(within(menu).getByText(label)).toBeDefined()
    }
    // The current mode carries the checkmark styling; picking another mode
    // fires the durable switch and closes the menu.
    expect(within(menu).getByText('变更确认').closest('button')?.className).toContain('is-current')
    // The mode chip is the footer's rightmost chip: the sheet must use the
    // default right-edge anchor (no `--left`), or it spills past the panel.
    expect(menu.className).not.toContain('dshx-pop--left')
    fireEvent.click(within(menu).getByText('完全访问'))
    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('session.permission.set', { sessionId: 'session-main', mode: 'full' })
    })
    expect(screen.queryByRole('menu', { name: '权限模式' })).toBeNull()
  })

  it('hides the permission switcher until the first successful knob read', async () => {
    renderBar([], {}, { failed: true })
    // A failed read keeps the chip hidden instead of guessing a mode.
    expect(screen.queryByTitle('权限模式：变更确认')).toBeNull()
  })
})

describe('composer slash menu', () => {
  /** Two-way harness mirroring the shell's inputwrap: a textarea + the mounted SlashMenu. */
  function SlashHarness({ initial }: { initial: string }): JSX.Element {
    const [text, setText] = useState(initial)
    const ref = useRef<HTMLTextAreaElement>(null)
    return (
      <div>
        <textarea ref={ref} value={text} aria-label="composer" onChange={(event) => { setText(event.target.value) }} />
        <SlashMenu sessionId="session-main" text={text} onChange={setText} textareaRef={ref} />
      </div>
    )
  }

  /** Scripted rpc: one commands/list answer (+ everything else refused). */
  function scriptCommandList(rows: unknown, ok = true): void {
    vi.mocked(rpc).mockImplementation((method) => {
      if (method === 'commands/list') {
        return ok
          ? Promise.resolve({ ok: true, value: rows })
          : Promise.resolve({ ok: false, error: { message: 'bridge down' } })
      }
      return Promise.resolve({ ok: false, error: { message: 'unexpected method' } })
    })
  }

  const ENGINE_ROWS = [
    { name: 'plan', description: 'Toggle plan mode' },
    { name: 'compact', description: 'Compact the session' },
  ]

  it('opens on a bare / with engine commands merged with the shell-local /export row', async () => {
    scriptCommandList(ENGINE_ROWS)
    render(<SlashHarness initial="/" />)
    const listbox = await screen.findByRole('listbox', { name: '斜杠命令' })
    expect(within(listbox).getByText('/export')).toBeDefined()
    expect(within(listbox).getByText('导出本会话日志（浏览器下载）')).toBeDefined()
    expect(within(listbox).getByText('/plan')).toBeDefined()
    expect(within(listbox).getByText('Toggle plan mode')).toBeDefined()
    // The typert envelope the api-bridge commands dispatcher decodes.
    expect(rpc).toHaveBeenCalledWith('commands/list', { args: { agentId: 'session-main' } })
  })

  it('puts the local /export row first and drops an engine duplicate of it', async () => {
    scriptCommandList([{ name: 'export', description: 'Download this Session log as a ZIP archive' }, ...ENGINE_ROWS])
    render(<SlashHarness initial="/" />)
    const listbox = await screen.findByRole('listbox')
    const rows = within(listbox).getAllByRole('option')
    expect(rows).toHaveLength(3)
    expect(rows[0]?.textContent).toContain('/export')
    expect(rows[0]?.textContent).toContain('导出本会话日志（浏览器下载）')
  })

  it('filters by command-name prefix, hiding non-matching rows', async () => {
    scriptCommandList(ENGINE_ROWS)
    render(<SlashHarness initial="/pl" />)
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('/plan')).toBeDefined()
    expect(within(listbox).queryByText('/export')).toBeNull()
    expect(within(listbox).queryByText('/compact')).toBeNull()
  })

  it('falls back to description substring matches when no name is a prefix', async () => {
    scriptCommandList(ENGINE_ROWS)
    render(<SlashHarness initial="/mode" />)
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('/plan')).toBeDefined()
    expect(within(listbox).queryByText('/compact')).toBeNull()
    expect(within(listbox).queryByText('/export')).toBeNull()
  })

  it('keeps the menu closed for arguments and the // escape', async () => {
    scriptCommandList(ENGINE_ROWS)
    render(<SlashHarness initial="/plan off" />)
    expect(screen.queryByRole('listbox')).toBeNull()
    cleanup()
    render(<SlashHarness initial="//plain prompt" />)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('fills the highlighted command plus a trailing space on Enter and never executes it', async () => {
    scriptCommandList(ENGINE_ROWS)
    render(<SlashHarness initial="/" />)
    await screen.findByRole('listbox')
    const textarea = screen.getByLabelText('composer')
    // ↓ moves the highlight off the leading /export row onto /plan.
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull()
    })
    expect(textarea).toHaveProperty('value', '/plan ')
    expect(rpc).not.toHaveBeenCalledWith('commands/execute', expect.anything())
  })

  it('completes the bare name on Tab and keeps the menu open for refinement', async () => {
    scriptCommandList(ENGINE_ROWS)
    render(<SlashHarness initial="/pla" />)
    await screen.findByRole('listbox')
    const textarea = screen.getByLabelText('composer')
    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(textarea).toHaveProperty('value', '/plan')
    expect(screen.getByRole('listbox')).toBeDefined()
  })

  it('closes on Escape and re-arms on the next edit', async () => {
    scriptCommandList(ENGINE_ROWS)
    render(<SlashHarness initial="/" />)
    await screen.findByRole('listbox')
    fireEvent.keyDown(screen.getByLabelText('composer'), { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull()
    })
    fireEvent.change(screen.getByLabelText('composer'), { target: { value: '/comp' } })
    expect(await screen.findByRole('listbox')).toBeDefined()
  })

  it('closes on an outside pointerdown but not on a click back into the textarea', async () => {
    scriptCommandList(ENGINE_ROWS)
    render(<SlashHarness initial="/" />)
    await screen.findByRole('listbox')
    fireEvent.pointerDown(screen.getByLabelText('composer'))
    expect(screen.getByRole('listbox')).toBeDefined()
    fireEvent.pointerDown(document.body)
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull()
    })
  })

  it('degrades to no menu when commands/list refuses, leaving the hand-typed pipeline intact', async () => {
    scriptCommandList(undefined, false)
    render(<SlashHarness initial="/" />)
    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('commands/list', { args: { agentId: 'session-main' } })
    })
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('composer @ mention menu', () => {
  /** Two-way harness mirroring the shell's inputwrap: a textarea + the mounted SubagentMenu fed by useSubagents. */
  function SubagentHarness({ initial }: { initial: string }): JSX.Element {
    const [text, setText] = useState(initial)
    const ref = useRef<HTMLTextAreaElement>(null)
    const { subagents, refresh } = useSubagents('session-main')
    return (
      <div>
        <textarea ref={ref} value={text} aria-label="composer" onChange={(event) => { setText(event.target.value) }} />
        <SubagentMenu subagents={subagents} text={text} onChange={setText} textareaRef={ref} onMentionActive={refresh} />
      </div>
    )
  }

  /** Scripted rpc: one subagent.list answer (+ everything else refused). */
  function scriptSubagentList(rows: unknown[] | undefined, ok = true): void {
    vi.mocked(rpc).mockImplementation((method) => {
      if (method === 'subagent.list') {
        return Promise.resolve(ok
          ? { ok: true, value: { entries: rows ?? [], parentAvailable: true } }
          : { ok: false, error: { message: 'bridge down' } })
      }
      return Promise.resolve({ ok: false, error: { message: 'unexpected method' } })
    })
  }

  /** The subagent.list wire view: two continuable children + rows that can never take a prompt. */
  const CATALOG_ROWS = [
    { kind: 'child', id: 'session-res-1', mode: 'continuable', label: '深度研究', activity: 'running', hasChildren: false },
    { kind: 'child', id: 'session-trans-2', mode: 'continuable', label: '翻译助手', activity: 'inactive', hasChildren: false },
    { kind: 'child', id: 'session-shot-3', mode: 'one-shot', label: '一次性代理', activity: 'inactive', hasChildren: false },
    { kind: 'diagnostic', id: 'session-bad-4', reason: 'corrupt' },
  ]

  it('lists only continuable children with activity badges on a bare @', async () => {
    scriptSubagentList(CATALOG_ROWS)
    render(<SubagentHarness initial="@" />)
    const listbox = await screen.findByRole('listbox', { name: '子代理' })
    expect(within(listbox).getByText('@深度研究')).toBeDefined()
    expect(within(listbox).getByText('@翻译助手')).toBeDefined()
    expect(within(listbox).getByText('运行中')).toBeDefined()
    expect(within(listbox).getByText('空闲')).toBeDefined()
    // subagent.prompt refuses one-shot and diagnostic rows: not candidates.
    expect(within(listbox).queryByText('@一次性代理')).toBeNull()
    expect(within(listbox).queryByText('@session-bad-4')).toBeNull()
    expect(rpc).toHaveBeenCalledWith('subagent.list', { parentSessionId: 'session-main' })
  })

  it('opens mid-message on a word-bounded @ and stays closed for a glued one', async () => {
    scriptSubagentList(CATALOG_ROWS)
    render(<SubagentHarness initial="帮我 @研" />)
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('@深度研究')).toBeDefined()
    expect(within(listbox).queryByText('@翻译助手')).toBeNull()
    cleanup()
    render(<SubagentHarness initial="联系 a@b" />)
    // The email's @ is glued to a word: no mention is active, ever.
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('fills @label plus a trailing space on Enter and closes', async () => {
    scriptSubagentList(CATALOG_ROWS)
    render(<SubagentHarness initial="@翻" />)
    await screen.findByRole('listbox')
    const textarea = screen.getByLabelText('composer')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull()
    })
    expect(textarea).toHaveProperty('value', '@翻译助手 ')
  })

  it('fills on click, keeping the text before the mention', async () => {
    scriptSubagentList(CATALOG_ROWS)
    render(<SubagentHarness initial="帮我 @" />)
    const listbox = await screen.findByRole('listbox')
    fireEvent.click(within(listbox).getByRole('option', { name: /深度研究/ }))
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull()
    })
    expect(screen.getByLabelText('composer')).toHaveProperty('value', '帮我 @深度研究 ')
  })

  it('degrades to no menu when subagent.list refuses', async () => {
    scriptSubagentList(undefined, false)
    render(<SubagentHarness initial="@" />)
    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('subagent.list', { parentSessionId: 'session-main' })
    })
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('composer @ mention routing', () => {
  /** The parsed candidates useSubagents would serve for CATALOG_ROWS' continuable rows. */
  const CANDIDATES: SubagentCandidate[] = [
    { id: 'session-res-1', label: '深度研究', activity: 'running' },
    { id: 'session-trans-2', label: '翻译助手', activity: 'inactive' },
  ]

  it('routes an @-addressed line through subagent.prompt with the body only', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ ok: true, value: { messageId: 'msg-1' } })
    const prompt = vi.fn()
    const sent = vi.fn()
    dispatchSendLine('session-parent', '@深度研究 帮我查资料', {
      prompt,
      subagents: CANDIDATES,
      onCommandAdmitted: vi.fn(),
      onSubagentSent: sent,
      notice: vi.fn(),
      exportLog: vi.fn(),
    })
    await waitFor(() => {
      expect(sent).toHaveBeenCalledOnce()
    })
    // The flat payload the api-bridge subagent.prompt handler decodes.
    expect(rpc).toHaveBeenCalledWith('subagent.prompt', {
      parentSessionId: 'session-parent',
      childSessionId: 'session-res-1',
      content: [{ type: 'text', text: '帮我查资料' }],
    })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('prefers the longest multi-word label when resolving the mention', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ ok: true, value: { messageId: 'msg-2' } })
    dispatchSendLine('session-parent', '@research agent 查一下', {
      prompt: vi.fn(),
      subagents: [
        { id: 'session-word-1', label: 'research', activity: 'inactive' },
        { id: 'session-word-2', label: 'research agent', activity: 'running' },
      ],
      onCommandAdmitted: vi.fn(),
      onSubagentSent: vi.fn(),
      notice: vi.fn(),
      exportLog: vi.fn(),
    })
    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('subagent.prompt', expect.objectContaining({
        childSessionId: 'session-word-2',
      }))
    })
  })

  it('falls back to a normal send with a notice when the name resolves to nothing', () => {
    const prompt = vi.fn()
    const notice = vi.fn()
    dispatchSendLine('session-parent', '@不存在 嗨', {
      prompt,
      subagents: CANDIDATES,
      onCommandAdmitted: vi.fn(),
      onSubagentSent: vi.fn(),
      notice,
      exportLog: vi.fn(),
    })
    expect(prompt).toHaveBeenCalledWith('@不存在 嗨')
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('不存在'))
    expect(rpc).not.toHaveBeenCalled()
  })

  it('sends a glued @ line and a bodyless @名字 as plain messages, silently', () => {
    const prompt = vi.fn()
    const notice = vi.fn()
    const actions = {
      prompt,
      subagents: CANDIDATES,
      onCommandAdmitted: vi.fn(),
      onSubagentSent: vi.fn(),
      notice,
      exportLog: vi.fn(),
    }
    dispatchSendLine('session-parent', 'a@b.com 你好', actions)
    dispatchSendLine('session-parent', '@深度研究', actions)
    expect(prompt).toHaveBeenNthCalledWith(1, 'a@b.com 你好')
    expect(prompt).toHaveBeenNthCalledWith(2, '@深度研究')
    expect(notice).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('falls back to a normal send with a notice carrying the refusal summary', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ ok: false, error: { message: 'subagent cannot be resumed' } })
    const prompt = vi.fn()
    const notice = vi.fn()
    dispatchSendLine('session-parent', '@深度研究 嗨', {
      prompt,
      subagents: CANDIDATES,
      onCommandAdmitted: vi.fn(),
      onSubagentSent: vi.fn(),
      notice,
      exportLog: vi.fn(),
    })
    await waitFor(() => {
      expect(prompt).toHaveBeenCalledWith('@深度研究 嗨')
    })
    expect(notice).toHaveBeenCalledWith(
      '子代理「深度研究」投递失败（subagent cannot be resumed）：已按普通消息发送',
    )
  })

  it('truncates an overlong refusal summary in the fallback notice to 80 characters', async () => {
    const long = 'x'.repeat(200)
    vi.mocked(rpc).mockResolvedValueOnce({ ok: false, error: { message: long } })
    const notice = vi.fn()
    dispatchSendLine('session-parent', '@深度研究 嗨', {
      prompt: vi.fn(),
      subagents: CANDIDATES,
      onCommandAdmitted: vi.fn(),
      onSubagentSent: vi.fn(),
      notice,
      exportLog: vi.fn(),
    })
    await waitFor(() => {
      expect(notice).toHaveBeenCalled()
    })
    const [text] = notice.mock.calls[0] as [string]
    expect(text).toContain(`子代理「深度研究」投递失败（${'x'.repeat(79)}…）：已按普通消息发送`)
    expect(text).toContain('已按普通消息发送')
  })

  it('names an unknown reason when the refusal carries no message', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ ok: false, error: {} })
    const notice = vi.fn()
    dispatchSendLine('session-parent', '@深度研究 嗨', {
      prompt: vi.fn(),
      subagents: CANDIDATES,
      onCommandAdmitted: vi.fn(),
      onSubagentSent: vi.fn(),
      notice,
      exportLog: vi.fn(),
    })
    await waitFor(() => {
      expect(notice).toHaveBeenCalledWith(
        '子代理「深度研究」投递失败（未知原因）：已按普通消息发送',
      )
    })
  })

  it('keeps the // escape ahead of the mention grammar', () => {
    const prompt = vi.fn()
    dispatchSendLine('session-parent', '//@深度研究 嗨', {
      prompt,
      subagents: CANDIDATES,
      onCommandAdmitted: vi.fn(),
      onSubagentSent: vi.fn(),
      notice: vi.fn(),
      exportLog: vi.fn(),
    })
    expect(prompt).toHaveBeenCalledWith('/@深度研究 嗨')
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('COMPOSER_CSS toolbar button discipline', () => {
  /** The body of the named rule (selector start → closing brace). */
  const rule = (selector: string): string => {
    const at = COMPOSER_CSS.indexOf(selector)
    expect(at).toBeGreaterThanOrEqual(0)
    return COMPOSER_CSS.slice(at, COMPOSER_CSS.indexOf('}', at) + 1)
  }

  it('pins the one-line labels: effort dropdown chip, group headers, slash names', () => {
    expect(rule('.dshx-chiplabel{')).toContain('white-space:nowrap')
    expect(rule('.dshx-menugroup{')).toContain('white-space:nowrap')
    expect(rule('.dshx-slashitem-name{')).toContain('white-space:nowrap')
  })

  it('keeps the chip self-trim pins (labels ellipsize) and the bar clip-free for upward popovers', () => {
    expect(rule('.dshx-chiplabel{')).toContain('white-space:nowrap')
    expect(rule('.dshx-chiplabel{')).toContain('text-overflow:ellipsis')
    // The model/usage popovers anchor to .dshx-menuwrap and open upward past
    // the card edge — a clipping bar would hide them (only a shadow was
    // visible). Truncation is the labels' job, not the bar's.
    expect(rule('.dshx-cbar{')).not.toContain('overflow:hidden')
    expect(rule('.dshx-cbar .dshx-menuwrap{')).toContain('position:relative')
  })

  it('pins the permission-menu rows: fixed sheet width, name over one-line description', () => {
    expect(rule('.dshx-modepop{')).toContain('width:min(240px')
    expect(rule('.dshx-modeitem-text{')).toContain('flex-direction:column')
    expect(rule('.dshx-modeitem-desc{')).toContain('white-space:nowrap')
    expect(rule('.dshx-modeitem-desc{')).toContain('text-overflow:ellipsis')
  })
})

describe('agent-preset switcher', () => {
  const findChip = async (): Promise<HTMLElement> =>
    await screen.findByTitle('Agent 预设：默认')

  it('renders the roster from agentPreset.list with the live preset checked', async () => {
    renderBar([], { provider: 'deepseek', model: 'deepseek-v4-flash' })
    fireEvent.click(await findChip())
    const menu = await screen.findByRole('menu', { name: 'Agent 预设' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items).toHaveLength(2)
    expect(items[0]?.className).toContain('is-current')
    expect(items[0]?.textContent).toContain('默认')
    expect(items[1]?.textContent).toContain('研究员')
  })

  it('boots the chip label from the session log when the session switched presets', async () => {
    vi.mocked(rpc).mockImplementation((method: string) => {
      if (method === 'session.models') return Promise.resolve({ ok: true, value: { current: { provider: 'deepseek', model: 'deepseek-v4-flash' } } })
      if (method === 'session.usage') return Promise.resolve({ ok: true, value: { totalTokens: 0 } })
      if (method === 'session.permission.get') return Promise.resolve({ ok: true, value: { mode: 'confirm', planActive: false } })
      if (method === 'session.history') {
        return Promise.resolve({ ok: true, value: { events: [{ type: 'agent-preset/selected', data: { agentPreset: 'research' } }] } })
      }
      if (method === 'agentPreset.list') {
        return Promise.resolve({ ok: true, value: { presets: [
          { id: 'default', name: '默认', isDefault: true },
          { id: 'research', name: '研究员' },
        ], authorable: true, hasDocument: false } })
      }
      return Promise.resolve({ ok: false, error: { message: 'unexpected method' } })
    })
    render(
      <ComposerBar
        sessionId="session-main"
        running={false}
        canSend={false}
        groups={[]}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    )
    const chip = await screen.findByTitle('Agent 预设：研究员')
    expect(chip).toBeDefined()
  })

  it('submits agentPreset.select for the picked preset and closes the menu', async () => {
    renderBar([], { provider: 'deepseek', model: 'deepseek-v4-flash' })
    fireEvent.click(await findChip())
    const menu = await screen.findByRole('menu', { name: 'Agent 预设' })
    fireEvent.click(within(menu).getByText('研究员'))
    await waitFor(() => {
      const call = vi.mocked(rpc).mock.calls.filter(([method]) => method === 'agentPreset.select').at(-1)
      expect(call?.[1]).toEqual({ sessionId: 'session-main', agentPreset: 'research' })
    })
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Agent 预设' })).toBeNull()
    })
  })

  it('surfaces an agent-preset-locked refusal inline instead of closing the menu', async () => {
    scriptRpc(
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      { mode: 'confirm', planActive: false },
      {
        presets: [
          { id: 'default', name: '默认', isDefault: true },
          { id: 'research', name: '研究员' },
        ],
      },
    )
    vi.mocked(rpc).mockImplementation((method: string) => {
      if (method === 'session.models') return Promise.resolve({ ok: true, value: { current: {} } })
      if (method === 'session.usage') return Promise.resolve({ ok: true, value: { totalTokens: 0 } })
      if (method === 'session.permission.get') return Promise.resolve({ ok: true, value: { mode: 'confirm', planActive: false } })
      if (method === 'session.history') return Promise.resolve({ ok: true, value: { events: [] } })
      if (method === 'agentPreset.list') {
        return Promise.resolve({ ok: true, value: { presets: [
          { id: 'default', name: '默认', isDefault: true },
          { id: 'research', name: '研究员' },
        ], authorable: true, hasDocument: false } })
      }
      if (method === 'agentPreset.select') {
        return Promise.resolve({ ok: false, error: { message: '会话 session-main 已开始对话，其 agent 预设已固定', code: 'agent-preset-locked' } })
      }
      return Promise.resolve({ ok: false, error: { message: 'unexpected method' } })
    })
    render(
      <ComposerBar
        sessionId="session-main"
        running={false}
        canSend={false}
        groups={[]}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    )
    fireEvent.click(await screen.findByTitle('Agent 预设：默认'))
    const menu = await screen.findByRole('menu', { name: 'Agent 预设' })
    fireEvent.click(within(menu).getByText('研究员'))
    await waitFor(() => {
      expect(screen.getAllByText(/已开始对话/).length).toBeGreaterThan(0)
    })
    // the menu stays open so the user can pick another preset or retry
    expect(screen.queryByRole('menu', { name: 'Agent 预设' })).not.toBeNull()
  })

  it('disables a broken preset row', async () => {
    scriptRpc(
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      { mode: 'confirm', planActive: false },
      {
        presets: [
          { id: 'default', name: '默认', isDefault: true },
          { id: 'broken-one', name: '坏预设', broken: '缺少必填段' },
        ],
      },
    )
    render(
      <ComposerBar
        sessionId="session-main"
        running={false}
        canSend={false}
        groups={[]}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    )
    fireEvent.click(await screen.findByTitle('Agent 预设：默认'))
    const menu = await screen.findByRole('menu', { name: 'Agent 预设' })
    const broken = within(menu).getByText('坏预设').closest('button')
    expect(broken?.disabled).toBe(true)
  })
})
