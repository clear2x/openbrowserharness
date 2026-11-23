// @vitest-environment jsdom
/**
 * shell i18n spec: the fork's own side-panel surfaces under the `en` face of
 * the locale seat (a real `LocaleRuntime` opened on an en-US browser), with
 * every wire answer scripted in ASCII. Each surface must render without a
 * single CJK character and without a bare dictionary key — the regression net
 * for copy that creeps back into a component or an `en` entry left in Chinese.
 * Each surface is also spot-checked in `en` and `zh` for the strings an `en`
 * reader would otherwise have seen in Chinese (the composer placeholder and
 * effort chips, the trajectory fold, the on-device model rows, the update
 * line). rpc is mocked at the module boundary; there is no chrome and no Port.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { MuxFrame, RpcReceipt } from '@deepseek-ai/dsh-host-apiproxy/api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHIPPED_AGENT_PRESETS } from '../src/shared/shipped-agent-presets.ts'
import { AutomationPanel } from '../src/sidepanel-dsh/automation-panel.tsx'
import { ComposerBar } from '../src/sidepanel-dsh/composer-bar.tsx'
import type { ModelGroup } from '../src/sidepanel-dsh/composer-bar.tsx'
import { InteractionCards } from '../src/sidepanel-dsh/interaction-cards.tsx'
import { InteractionStore } from '../src/sidepanel-dsh/interaction-store.ts'
import { bindShellLocaleFace, installShellLocale, type ShellLocaleHost } from '../src/sidepanel-dsh/locales/index.ts'
import { shellEn } from '../src/sidepanel-dsh/locales/dictionaries.ts'
import { AgentPresetsPage } from '../src/sidepanel-dsh/presets-page.tsx'
import { rpc } from '../src/sidepanel-dsh/rpc-client.ts'
import type { RpcOutcome } from '../src/sidepanel-dsh/rpc-client.ts'
import { ServicesPanel } from '../src/sidepanel-dsh/services-panel.tsx'
import { TrajectoryHost } from '../src/sidepanel-dsh/trajectory-host.tsx'
import { UserPluginPanel } from '../src/sidepanel-dsh/user-plugin-panel.tsx'

vi.mock('../src/sidepanel-dsh/rpc-client.ts', () => ({
  rpc: vi.fn(),
}))

/** Han ideographs and the CJK extensions: text an `en` reader cannot be shown. */
const CJK_RUNS = /[\u3400-\u9fff]+/gu
/** A dictionary key surfaced verbatim: a lowercase namespace plus dotted segments. */
const BARE_KEY = /(?<![\w./-])[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+(?![\w./-])/gu
const KEYS = new Set<string>(Object.keys(shellEn))

/** The on-device catalog rows as the wire carries them: the catalog's own ids, ASCII data elsewhere. */
const CATALOG_MODELS = ['embed-e5-small', 'ocr-ppocr-mobile', 'caption-smolvlm2-256m', 'asr-whisper-base', 'asr-whisper-small']
  .map(id => ({
    id,
    label: `wire label of ${id}`,
    purposeZh: `wire purpose of ${id}`,
    declaredBytes: 150 * 1024 * 1024,
    minDevice: 'any',
    planned: id === 'asr-whisper-small',
    state: id === 'asr-whisper-base' ? 'failed' : 'ready',
    error: 'download interrupted',
    sizeBytes: 150 * 1024 * 1024,
  }))

const GROUPS: ModelGroup[] = [{
  id: 'zhipu-coding',
  name: 'Zhipu Coding',
  contextWindow: 200_000,
  models: [{
    id: 'glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    inputModalities: ['text'],
    reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'max', name: 'max' }], defaultEffort: 'max' },
  }],
}]

const HISTORY = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  {
    type: 'user/message', seq: 1, time: 2,
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Click the button on the page' }], source: { kind: 'user' } },
  },
  {
    type: 'assistant/message', seq: 2, time: 3,
    data: {
      turn: 1, step: 1,
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Clicking it now.' }], source: { kind: 'model', provider: 'zhipu-coding' } },
    },
  },
  { type: 'tool/call', seq: 3, time: 4, data: { turn: 1, step: 1, name: 'page_click', arguments: '{"index":3}' } },
  {
    type: 'tool/result', seq: 4, time: 5,
    data: {
      turn: 1, step: 1,
      message: {
        id: 't1', role: 'tool', source: { kind: 'tool', callId: 'c1', name: 'page_click' },
        content: [{ type: 'tool-result', toolCallId: 'c1', text: 'Button clicked' }],
      },
    },
  },
  { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
]

/** The scripted wire: ASCII data for the methods a surface reads on mount. */
function wire(): Record<string, unknown> {
  return {
    'session.models': { current: { provider: 'zhipu-coding', model: 'glm-5.3-flash', reasoningEffort: 'max' } },
    'session.usage': { totalTokens: 50_000 },
    'session.permission.get': { mode: 'confirm', planActive: false },
    'session.history': { events: HISTORY.map(event => ({ event })) },
    // The roster as the host sends it: shipped rows carry their zh names, as on the wire.
    'agentPreset.list': {
      presets: [
        ...SHIPPED_AGENT_PRESETS.map((preset, index) => ({
          id: preset.id, trust: 'system', isDefault: index === 0, name: preset.name, description: preset.description,
        })),
        { id: 'my-preset', trust: 'user', isDefault: false, name: 'My preset', description: 'Built by me' },
      ],
      authorable: true,
      hasDocument: false,
    },
    'account.state': { status: 'signed-out', attempt: null },
    'credentials.listRefs': { refs: [{ ref: 'DEEPSEEK_API_KEY', configured: true }, { ref: 'GITHUB_TOKEN', configured: false }] },
    'capability.get': { enabled: false },
    'mcp.list': {
      servers: [
        { name: 'docs', configured: true, status: { state: 'connected' } },
        { name: 'broken', configured: true, status: { state: 'failed', reason: 'ECONNREFUSED' } },
      ],
    },
    'aiLocal.catalog': {
      device: { webgpu: 'real', geminiNano: 'ready', at: 0 },
      models: CATALOG_MODELS,
    },
    'aiLocal.usage': { entries: [{ ts: 0, capability: 'ocr', model: 'ppocr', durationMs: 1250, detail: '12 frames' }] },
    'app/updateCheck': { latest: '9.9.9', url: 'https://example.invalid/release' },
  }
}

function ok(value: unknown): RpcOutcome {
  return { ok: true, value }
}

function fail(message: string): RpcOutcome {
  return { ok: false, error: { message } }
}

/** Answer every rpc from the scripted wire; an unscripted method is a plain ASCII refusal. */
function scriptRpc(answers: Record<string, unknown> = wire()): void {
  vi.mocked(rpc).mockImplementation((method: string) => {
    if (method in answers) return Promise.resolve(ok(answers[method]))
    return Promise.resolve(fail(`unscripted ${method}`))
  })
}

/** Open the shell on a client root whose locale the pinned browser languages decide. */
async function openShell(languages: readonly string[]): Promise<void> {
  vi.stubGlobal('navigator', { languages, language: languages[0] ?? '' })
  const ctx = new Context()
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin((inner: ShellLocaleHost) => { installShellLocale(inner) })
}

/** Every CJK run and every bare dictionary key in the rendered document. */
function leaks(): { cjk: string[]; keys: string[] } {
  const text = document.body.textContent ?? ''
  return {
    cjk: text.match(CJK_RUNS) ?? [],
    keys: (text.match(BARE_KEY) ?? []).filter(token => KEYS.has(token)),
  }
}

/** The `en` regression net for the rendered document. */
function expectEnglish(): void {
  const { cjk, keys } = leaks()
  expect(cjk, document.body.textContent ?? '').toEqual([])
  expect(keys, document.body.textContent ?? '').toEqual([])
}

beforeEach(() => {
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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  bindShellLocaleFace(undefined)
})

describe('shell surfaces under en', () => {
  it('renders the composer with English effort and mode chips', async () => {
    await openShell(['en-US'])
    scriptRpc()
    const { container } = render(
      <ComposerBar
        sessionId="session-main"
        running={false}
        canSend
        groups={GROUPS}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    )
    await waitFor(() => { expect(container.textContent).toContain('Reasoning: Max') })
    expect(container.textContent).toContain('GLM 5.3 Flash')
    expect(container.textContent).toContain('25% · 50k/200k')
    // The preset chip and its menu read the dictionary for shipped rows, the stored name for user rows.
    const chip = screen.getByRole('button', { name: 'Agent preset' })
    expect(chip.getAttribute('title')).toBe('Agent preset: Standard mode')
    fireEvent.click(chip)
    expect(screen.getByRole('menuitem', { name: 'Standard mode' }).getAttribute('title'))
      .toBe('The full-featured browser agent: page browsing and actions, script inspection, site knowledge, plans, goals, and subagents are all available.')
    expect(screen.getByRole('menuitem', { name: 'Web researcher' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Stock watcher' }).getAttribute('title')).not.toMatch(CJK_RUNS)
    expect(screen.getByRole('menuitem', { name: 'My preset' })).toBeTruthy()
    expectEnglish()
  })

  it('renders the trajectory fold and lanes', async () => {
    await openShell(['en-US'])
    scriptRpc()
    const { container, getByLabelText } = render(<TrajectoryHost sessionId="session-main" refreshSeq={0} />)
    await waitFor(() => { expect(container.textContent).toContain('Turn 1') })
    expect(getByLabelText('Search the trajectory')).toBeTruthy()
    expect(container.textContent).toContain('Click the button on the page')
    expect(container.querySelectorAll('.dshx-trj-lane')).toHaveLength(3)
    expectEnglish()
  })

  it('renders the interaction cards', async () => {
    await openShell(['en-US'])
    const store = new InteractionStore()
    const respond = vi.fn((): Promise<RpcReceipt> => Promise.resolve({ accepted: true }))
    store.setRespond(respond)
    const feed = (rpcId: string, frame: unknown): void => {
      act(() => {
        store.handleMuxEnvelope({ rpcId: RpcId(rpcId), payload: frame as MuxFrame })
      })
    }
    feed('rpc-q', {
      type: 'question/requested', sessionId: 'session-main',
      questions: [{ id: 'q1', question: 'Which step next?', options: [{ label: 'Ship it' }, { label: 'Hold' }] }],
    })
    feed('rpc-a', { type: 'approval/requested', sessionId: 'session-main', approvalId: 'ap-1', toolName: 'page_evaluate', callId: 'call-1', reason: 'Run a script in the page' })
    render(<InteractionCards store={store} />)
    expect(await screen.findByText('Which step next?')).toBeTruthy()
    expectEnglish()
  })

  it('renders the agent presets page', async () => {
    await openShell(['en-US'])
    scriptRpc()
    render(<AgentPresetsPage />)
    expect(await screen.findByText('My preset')).toBeTruthy()
    expect(screen.getAllByText('Built-in')).toHaveLength(SHIPPED_AGENT_PRESETS.length)
    expect(screen.getAllByText('Custom').length).toBeGreaterThan(0)
    expect(screen.getByText('Standard mode')).toBeTruthy()
    expect(screen.getByText('Web researcher')).toBeTruthy()
    expect(screen.getByText('Watches the finance creators you choose, reads every video, and distills stock and market signals; pair it with a schedule for daily checks')).toBeTruthy()
    expectEnglish()
  })

  it('renders the user plugin panel', async () => {
    await openShell(['en-US'])
    const pluginRpc = (method: string): Promise<RpcOutcome> => Promise.resolve(
      method === 'plugin.list'
        ? ok({ items: [{ name: 'greeter', title: 'Greeter', description: 'Replies to a greeting', enabled: true, registeredEvents: ['user/message'] }] })
        : fail('unscripted'))
    render(
      <UserPluginPanel
        sessionId="session-main"
        sendPrompt={vi.fn()}
        onClose={vi.fn()}
        onOpenServices={vi.fn()}
        rpc={pluginRpc}
      />,
    )
    expect(await screen.findByText('Greeter')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Enable plugin greeter' }).getAttribute('aria-checked')).toBe('true')
    expectEnglish()
  })

  it('renders the automation panel', async () => {
    await openShell(['en-US'])
    scriptRpc()
    const { container } = render(
      <AutomationPanel onClose={vi.fn()} sessionId="session-main" ensureSession={async () => 'session-main'} />,
    )
    await waitFor(() => { expect(container.textContent).toContain('Create task') })
    expect(container.textContent).toContain('Deliver to')
    expect(container.textContent).toContain('Schedule')
    expect(container.textContent).toContain('Preset: Follow session')
    expectEnglish()
  })

  it('renders the services panel with every card and the update line', async () => {
    await openShell(['en-US'])
    scriptRpc()
    const { container } = render(<ServicesPanel onClose={vi.fn()} />)
    await waitFor(() => { expect(container.textContent).toContain('Local AI') })
    expect(container.textContent).toContain('Device tier: Real GPU (WebGPU available) · Gemini Nano: Built-in model ready')
    expect(container.textContent).toContain('Whisper base transcription')
    expect(container.textContent).toContain('Local speech transcription for videos without subtitles (the higher-quality Chinese tier)')
    // A catalogued model reads from the dictionary, never from the wire's zh label.
    expect(container.textContent).not.toContain('wire label')
    expect(container.textContent).toContain('DEEPSEEK_API_KEY')
    expect(container.textContent).toContain('OpenBrowserHarness v')
    expectEnglish()
    fireEvent.click(screen.getByRole('button', { name: /Check/ }))
    await waitFor(() => { expect(container.textContent).toContain('9.9.9') })
    expectEnglish()
  })
})

describe('shell surfaces under zh', () => {
  it('keeps the zh wording the fork authored', async () => {
    await openShell(['zh-CN'])
    scriptRpc()
    const { container } = render(
      <ComposerBar
        sessionId="session-main"
        running={false}
        canSend
        groups={GROUPS}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
      />,
    )
    await waitFor(() => { expect(container.textContent).toContain('思考：最高') })
    expect(container.textContent).toContain('25% · 50k/200k')
    const { cjk, keys } = leaks()
    expect(cjk).toContain('思考')
    expect(keys).toEqual([])
  })
})
