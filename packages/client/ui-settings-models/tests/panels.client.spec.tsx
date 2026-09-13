// @vitest-environment jsdom
/** Right-pane forms: 测试连接 probes, declared-route edits, and the add-supplier wizard. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-host-apiproxy/api/settings'
import { DeepSeekPanel } from '../src/client/DeepSeekPanel.tsx'
import { CustomRoutePanel } from '../src/client/CustomRoutePanel.tsx'
import { NewProviderPanel } from '../src/client/NewProviderPanel.tsx'
import styles from '../src/client/ModelsSection.module.css'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof zh) => zh[key]

/** The wire face slice the panels take. */
type Api = Pick<IApiClient, 'settings' | 'credentials' | 'llm'>

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function refused(message: string): RpcResponse<never> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'bad-request', message, details: {} } as never } }
}

const PiAiSchema = Schema.object({
  providers: Schema.dict(Schema.object({
    displayName: Schema.string(),
    apiKeyEnv: Schema.string().role('credential-ref'),
    api: Schema.union(['anthropic', 'openai', 'openai-responses']),
    baseURL: Schema.string(),
    headersText: Schema.string().role('textarea'),
    models: Schema.array(Schema.object({ id: Schema.string().required() })),
  })),
})

const PI_AI_NS: SettingsNamespaceView = {
  ns: 'llm-pi-ai',
  schema: JSON.parse(JSON.stringify(PiAiSchema.toJSON())) as unknown,
  value: {
    providers: {
      openai: {
        displayName: 'OpenAI',
        apiKeyEnv: 'OPENAI_API_KEY',
        api: 'openai',
        baseURL: 'https://proxy.example/v1',
        headersText: 'X-Team: a',
        models: [{ id: 'gpt-x', contextWindow: 128_000 }],
      },
    },
  },
  user: {
    providers: {
      openai: {
        displayName: 'OpenAI',
        apiKeyEnv: 'OPENAI_API_KEY',
        api: 'openai',
        baseURL: 'https://proxy.example/v1',
        headersText: 'X-Team: a',
        models: [{ id: 'gpt-x', contextWindow: 128_000 }],
      },
    },
  },
  applies: 'live',
  secrets: [],
  revision: 4,
}

function wireFace(overrides: {
  mutate?: (payload: { ns: string; ops: unknown }) => Promise<RpcResponse<SettingsNamespaceView>>
  set?: (payload: { ref: string; value: string }) => Promise<RpcResponse<Record<string, never>>>
  discoverModels?: (payload: Record<string, unknown>) => Promise<RpcResponse<{ models: Array<{ id: string }> }>>
  describe?: (refs: string[]) => Record<string, unknown>
} = {}) {
  const mutate = vi.fn(overrides.mutate ?? (() => Promise.resolve(ok(PI_AI_NS))))
  const set = vi.fn(overrides.set ?? (() => Promise.resolve(ok({}))))
  const discoverModels = vi.fn(overrides.discoverModels ?? (() => Promise.resolve(ok({ models: [{ id: 'm1' }] }))))
  const face = {
    settings: {
      describe: vi.fn(() => Promise.resolve(ok({ writable: true, namespaces: [PI_AI_NS] }))),
      mutate,
    },
    credentials: {
      describe: vi.fn((payload: { refs: string[] }) => Promise.resolve(ok({
        credentials: overrides.describe !== undefined
          ? overrides.describe(payload.refs)
          : Object.fromEntries(payload.refs.map(ref => [ref, { configured: false, writable: true }])),
      }))),
      set,
      unset: vi.fn(() => Promise.resolve(ok({}))),
    },
    llm: { discoverModels },
  }
  return { face, mutate, set, discoverModels }
}

describe('DeepSeekPanel', () => {
  it('stores the typed key under the managed reference', async () => {
    const scripted = wireFace()
    const onSaved = vi.fn()
    render(
      <DeepSeekPanel
        api={scripted.face as unknown as Api}
        t={t}
        readOnly={false}
        credentialRef="DEEPSEEK_API_KEY"
        reportProbe={() => {}}
        onSaved={onSaved}
      />,
    )
    fireEvent.change(screen.getByLabelText(zh.keyInput), { target: { value: 'sk-official' } })
    fireEvent.click(screen.getByRole('button', { name: zh.apply }))
    await waitFor(() => { expect(scripted.set).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY', value: 'sk-official' }) })
    await waitFor(() => { expect(onSaved).toHaveBeenCalled() })
  })

  it('tests the endpoint with the typed key and reports both verdicts', async () => {
    // First call answers with a catalog, the second refuses — one verdict of
    // each kind from the same mounted panel.
    let probeCalls = 0
    const scripted = wireFace({
      discoverModels: () => {
        probeCalls += 1
        return probeCalls === 1
          ? Promise.resolve(ok({ models: [{ id: 'a' }, { id: 'b' }] }))
          : Promise.resolve(refused('端点返回 401 Unauthorized'))
      },
    })
    const reportProbe = vi.fn()
    render(
      <DeepSeekPanel
        api={scripted.face as unknown as Api}
        t={t}
        readOnly={false}
        credentialRef="DEEPSEEK_API_KEY"
        baseURL="https://api.deepseek.com"
        provider="deepseek"
        reportProbe={reportProbe}
        onSaved={() => {}}
      />,
    )
    // An empty key field is allowed: the probe carries no apiKey, and the host
    // answers with the preset's stored credential (the `provider` routes it).
    expect(screen.getByRole('button', { name: zh.testConnection }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: zh.testConnection }))
    await waitFor(() => { expect(screen.getByText(zh.probeOk.replace('{count}', '2'))).toBeDefined() })
    expect(scripted.discoverModels).toHaveBeenCalledWith(expect.objectContaining({
      settingsNs: 'llm-deepseek',
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      api: 'openai',
    }))
    expect(scripted.discoverModels.mock.calls[0]![0]).not.toHaveProperty('apiKey')
    expect(reportProbe).toHaveBeenCalledWith({ kind: 'ok', count: 2 })
    fireEvent.change(screen.getByLabelText(zh.keyInput), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByRole('button', { name: zh.testConnection }))
    await waitFor(() => { expect(screen.getByText(zh.probeFailed.replace('{message}', '端点返回 401 Unauthorized'))).toBeDefined() })
    expect(scripted.discoverModels).toHaveBeenLastCalledWith(expect.objectContaining({
      settingsNs: 'llm-deepseek',
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      api: 'openai',
      apiKey: 'sk-test',
    }))
    expect(reportProbe).toHaveBeenLastCalledWith({ kind: 'failed', message: '端点返回 401 Unauthorized' })
  })

  it('renders the preset facts and probes with the preset protocol', async () => {
    const scripted = wireFace()
    render(
      <DeepSeekPanel
        api={scripted.face as unknown as Api}
        t={t}
        readOnly={false}
        credentialRef="ANTHROPIC_API_KEY"
        displayName="Anthropic"
        baseURL="https://api.anthropic.com/v1"
        protocol="anthropic"
        provider="anthropic"
        reportProbe={() => {}}
        onSaved={() => {}}
      />,
    )
    // The header names the preset, and the endpoint is a readonly fact.
    expect(screen.getByText('Anthropic')).toBeDefined()
    const baseUrlInput = screen.getByLabelText(zh.baseUrl) as HTMLInputElement
    expect(baseUrlInput.value).toBe('https://api.anthropic.com/v1')
    expect(baseUrlInput.readOnly).toBe(true)
    fireEvent.change(screen.getByLabelText(zh.keyInput), { target: { value: 'sk-ant' } })
    fireEvent.click(screen.getByRole('button', { name: zh.testConnection }))
    await waitFor(() => { expect(scripted.discoverModels).toHaveBeenCalledWith(expect.objectContaining({
      settingsNs: 'llm-deepseek',
      provider: 'anthropic',
      baseURL: 'https://api.anthropic.com/v1',
      api: 'anthropic',
      apiKey: 'sk-ant',
    })) })
  })

  it('renders the keyless panel for a preset without a credential ref', async () => {
    const scripted = wireFace()
    render(
      <DeepSeekPanel
        api={scripted.face as unknown as Api}
        t={t}
        readOnly={false}
        displayName="Ollama"
        baseURL="http://localhost:11434/v1"
        provider="ollama"
        reportProbe={() => {}}
        onSaved={() => {}}
      />,
    )
    // Nothing to store: no key field, no commit footer, keyless status shown.
    expect(screen.getByText(zh.keylessProvider)).toBeDefined()
    expect(screen.queryByLabelText(zh.keyInput)).toBeNull()
    expect(screen.queryByRole('button', { name: zh.apply })).toBeNull()
    // The probe still asks the endpoint, without a key.
    expect(screen.getByRole('button', { name: zh.testConnection }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: zh.testConnection }))
    await waitFor(() => { expect(scripted.discoverModels).toHaveBeenCalledWith(expect.objectContaining({
      settingsNs: 'llm-deepseek',
      provider: 'ollama',
      baseURL: 'http://localhost:11434/v1',
      api: 'openai',
    })) })
    expect(scripted.discoverModels.mock.calls[0]![0]).not.toHaveProperty('apiKey')
  })

  it('toggles the key input between masked and revealed', () => {
    const scripted = wireFace()
    render(
      <DeepSeekPanel
        api={scripted.face as unknown as Api}
        t={t}
        readOnly={false}
        credentialRef="DEEPSEEK_API_KEY"
        reportProbe={() => {}}
        onSaved={() => {}}
      />,
    )
    const keyInput = (): HTMLInputElement => screen.getByLabelText(zh.keyInput) as HTMLInputElement
    // Masked by default; the eye offers to reveal.
    expect(keyInput().type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: zh.showKey }))
    expect(keyInput().type).toBe('text')
    // Revealed, the same toggle relabels and flips the input back.
    fireEvent.click(screen.getByRole('button', { name: zh.hideKey }))
    expect(keyInput().type).toBe('password')
    expect(screen.getByRole('button', { name: zh.showKey })).toBeDefined()
  })
})

describe('CustomRoutePanel', () => {
  it('edits the profile in place with path ops, keeping unshown fields', async () => {
    const scripted = wireFace()
    render(
      <CustomRoutePanel
        route="openai"
        namespace={PI_AI_NS}
        api={scripted.face as unknown as Api}
        t={t}
        readOnly={false}
        reportProbe={() => {}}
        onSaved={() => {}}
        onRequestDelete={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText(zh.displayName), { target: { value: 'OpenAI Global' } })
    fireEvent.change(screen.getByLabelText(zh.baseUrl), { target: { value: 'https://proxy2.example/v1' } })
    fireEvent.click(screen.getByRole('radio', { name: /Anthropic Messages/ }))
    fireEvent.click(screen.getByRole('button', { name: zh.apply }))
    await waitFor(() => { expect(scripted.mutate).toHaveBeenCalledWith(expect.objectContaining({
      ns: 'llm-pi-ai',
      expectedRevision: 4,
    })) })
    const ops = scripted.mutate.mock.calls[0]![0].ops as Array<{ op: string; path: string[]; value?: unknown }>
    const touched = ops.map(op => op.path.join('.')).sort()
    expect(touched).toEqual([
      'providers.openai.api',
      'providers.openai.baseURL',
      'providers.openai.displayName',
    ])
    expect(ops.find(op => op.path[2] === 'api')?.value).toBe('anthropic')
    // headersText and models were not touched, so they survive the edit.
    expect(touched).not.toContain('providers.openai.headersText')
    expect(touched).not.toContain('providers.openai.models')
  })

  it('stores a typed key under the profile-named reference', async () => {
    const scripted = wireFace({
      describe: refs => Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
    })
    render(
      <CustomRoutePanel
        route="openai"
        namespace={PI_AI_NS}
        api={scripted.face as unknown as Api}
        t={t}
        readOnly={false}
        reportProbe={() => {}}
        onSaved={() => {}}
        onRequestDelete={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText(zh.keyInput), { target: { value: ' sk-new ' } })
    fireEvent.click(screen.getByRole('button', { name: zh.apply }))
    await waitFor(() => { expect(scripted.set).toHaveBeenCalledWith({ ref: 'OPENAI_API_KEY', value: 'sk-new' }) })
  })

  it('names an illegal base URL before any write', async () => {
    const scripted = wireFace()
    render(
      <CustomRoutePanel
        route="openai"
        namespace={PI_AI_NS}
        api={scripted.face as unknown as Api}
        t={t}
        readOnly={false}
        reportProbe={() => {}}
        onSaved={() => {}}
        onRequestDelete={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText(zh.baseUrl), { target: { value: 'http://localhost:3000' } })
    expect(screen.getByText('Base URL 不能指向本机（localhost/环回地址）')).toBeDefined()
    expect(screen.getByRole('button', { name: zh.apply }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh.apply }))
    await Promise.resolve()
    expect(scripted.mutate).not.toHaveBeenCalled()
  })

  it('probes the drafted endpoint with the route identity and typed key', async () => {
    const scripted = wireFace({
      discoverModels: vi.fn(() => Promise.resolve(ok({ models: [{ id: 'm1' }, { id: 'm2' }] }))),
    })
    const reportProbe = vi.fn()
    render(
      <CustomRoutePanel
        route="openai"
        namespace={PI_AI_NS}
        api={scripted.face as unknown as Api}
        t={t}
        readOnly={false}
        reportProbe={reportProbe}
        onSaved={() => {}}
        onRequestDelete={() => {}}
      />,
    )
    // An empty key field omits apiKey: the host then probes the route's stored
    // credential (and stored protocol) under the route identity.
    fireEvent.click(screen.getByRole('button', { name: zh.testConnection }))
    await waitFor(() => { expect(screen.getByText(zh.probeOk.replace('{count}', '2'))).toBeDefined() })
    expect(scripted.discoverModels).toHaveBeenCalledWith(expect.objectContaining({
      settingsNs: 'llm-pi-ai',
      provider: 'openai',
      baseURL: 'https://proxy.example/v1',
    }))
    expect(scripted.discoverModels.mock.calls[0]![0]).not.toHaveProperty('apiKey')
    expect(reportProbe).toHaveBeenCalledWith({ kind: 'ok', count: 2 })
    // A typed draft key rides the payload instead of the stored credential.
    fireEvent.change(screen.getByLabelText(zh.keyInput), { target: { value: 'sk-draft' } })
    fireEvent.click(screen.getByRole('button', { name: zh.testConnection }))
    await waitFor(() => {
      expect(scripted.discoverModels).toHaveBeenLastCalledWith(expect.objectContaining({
        settingsNs: 'llm-pi-ai',
        provider: 'openai',
        baseURL: 'https://proxy.example/v1',
        apiKey: 'sk-draft',
      }))
    })
  })

  it('manages the route models through the shared dialog and commits them with the profile save', async () => {
    const scripted = wireFace()
    render(
      <CustomRoutePanel
        route="openai"
        namespace={PI_AI_NS}
        api={scripted.face as unknown as Api}
        t={t}
        readOnly={false}
        reportProbe={() => {}}
        onSaved={() => {}}
        onRequestDelete={() => {}}
      />,
    )
    // The stored row renders with its capacity badge, and the first row is
    // the route default.
    expect(screen.getByText('gpt-x')).toBeDefined()
    expect(screen.getByText(`${zh.contextWindow} 128000`)).toBeDefined()
    expect(screen.getByText(zh.defaultModel)).toBeDefined()
    // Add a second model through the shared dialog (opened-at defaults).
    fireEvent.click(screen.getByRole('button', { name: zh.addModel }))
    fireEvent.change(screen.getByLabelText(zh.modelId), { target: { value: 'gpt-y' } })
    fireEvent.click(withinDialog().getByRole('button', { name: zh.apply }))
    expect(screen.getByText('gpt-y')).toBeDefined()
    // Edit it: the dialog prefills the stored row and judges on save.
    fireEvent.click(screen.getByRole('button', { name: `${zh.editModel} 2` }))
    const editDialog = screen.getByRole('group', { name: zh.editModel })
    expect(within(editDialog).getByLabelText(zh.modelId)).toHaveProperty('value', 'gpt-y')
    fireEvent.change(within(editDialog).getByLabelText(zh.contextWindow), { target: { value: '262144' } })
    fireEvent.click(within(editDialog).getByRole('button', { name: zh.apply }))
    expect(screen.getByText(`${zh.contextWindow} 262144`)).toBeDefined()
    // Commit: the edited models array rides one path op with the save.
    fireEvent.click(screen.getByRole('button', { name: zh.apply }))
    await waitFor(() => { expect(scripted.mutate).toHaveBeenCalled() })
    const ops = scripted.mutate.mock.calls[0]![0].ops as Array<{ op: string; path: string[]; value?: unknown }>
    const modelsOp = ops.find(op => op.path.join('.') === 'providers.openai.models')
    expect(modelsOp).toBeDefined()
    expect(modelsOp!.value).toEqual([
      { id: 'gpt-x', contextWindow: 128_000 },
      { id: 'gpt-y', contextWindow: 262_144, maxTokens: 128_000 },
    ])
  })

  it('removes a model row and holds the save gate at zero models', async () => {
    const scripted = wireFace()
    render(
      <CustomRoutePanel
        route="openai"
        namespace={PI_AI_NS}
        api={scripted.face as unknown as Api}
        t={t}
        readOnly={false}
        reportProbe={() => {}}
        onSaved={() => {}}
        onRequestDelete={() => {}}
      />,
    )
    // Deleting the only stored row empties the list; the write gate mirrors
    // the host's at-least-one-model refusal locally.
    fireEvent.click(screen.getByRole('button', { name: `${zh.removeModel} 1` }))
    expect(screen.queryByText('gpt-x')).toBeNull()
    expect(screen.getByText(zh.modelsNeedOne)).toBeDefined()
    expect(screen.getByRole('button', { name: zh.apply }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh.apply }))
    await Promise.resolve()
    expect(scripted.mutate).not.toHaveBeenCalled()
    // Re-adding a model reopens the gate, and the commit carries the new list.
    fireEvent.click(screen.getByRole('button', { name: zh.addModel }))
    fireEvent.change(screen.getByLabelText(zh.modelId), { target: { value: 'gpt-z' } })
    fireEvent.click(withinDialog().getByRole('button', { name: zh.apply }))
    expect(screen.getByRole('button', { name: zh.apply }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: zh.apply }))
    await waitFor(() => { expect(scripted.mutate).toHaveBeenCalled() })
    const ops = scripted.mutate.mock.calls[0]![0].ops as Array<{ path: string[]; value?: unknown }>
    const modelsOp = ops.find(op => op.path.join('.') === 'providers.openai.models')
    expect(modelsOp!.value).toEqual([{ id: 'gpt-z', contextWindow: 1_000_000, maxTokens: 128_000 }])
  })

  it('toggles the key input between masked and revealed', () => {
    const scripted = wireFace()
    render(
      <CustomRoutePanel
        route="openai"
        namespace={PI_AI_NS}
        api={scripted.face as unknown as Api}
        t={t}
        readOnly={false}
        reportProbe={() => {}}
        onSaved={() => {}}
        onRequestDelete={() => {}}
      />,
    )
    const keyInput = (): HTMLInputElement => screen.getByLabelText(zh.keyInput) as HTMLInputElement
    expect(keyInput().type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: zh.showKey }))
    expect(keyInput().type).toBe('text')
    fireEvent.click(screen.getByRole('button', { name: zh.hideKey }))
    expect(keyInput().type).toBe('password')
    expect(screen.getByRole('button', { name: zh.showKey })).toBeDefined()
  })
})

describe('NewProviderPanel', () => {
  function mountWizard(scripted: ReturnType<typeof wireFace>, props: Partial<Parameters<typeof NewProviderPanel>[0]> = {}) {
    const onCreated = props.onCreated ?? vi.fn()
    render(
      <NewProviderPanel
        protocols={['anthropic', 'openai', 'openai-responses']}
        revision={4}
        taken={props.taken ?? []}
        api={scripted.face as unknown as Api}
        t={t}
        readOnly={false}
        onCreated={onCreated}
        onCancel={props.onCancel ?? vi.fn()}
      />,
    )
    return onCreated
  }

  it('renders the reference form: intro, three protocol cards in schema order, no headers field', () => {
    const scripted = wireFace()
    mountWizard(scripted)
    expect(screen.getByText(zh.addProviderTitle)).toBeDefined()
    expect(screen.getByText(zh.addProviderIntro)).toBeDefined()
    const group = screen.getByRole('radiogroup', { name: zh.apiFormat })
    const radios = within(group).getAllByRole('radio')
    // The first card is selected by default; the ✓ rides its title line, where
    // every card width has room (the endpoint line wraps inside narrow cards).
    expect(radios.map(radio => radio.textContent)).toEqual([
      '✓ Anthropic Messages/v1/messages',
      'Chat Completions/chat/completions',
      'Responses/responses',
    ])
    // Custom headers are an edit-panel field, not a create-wizard one.
    expect(screen.queryByLabelText(zh.headers)).toBeNull()
    // The footer names the create, and the hint carries the model requirement.
    expect(screen.getByRole('button', { name: zh.createProvider }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(zh.providerNeedsModel)).toBeDefined()
  })

  it('cards the form into provider/api/model groups in the ZCode layout', () => {
    const scripted = wireFace()
    mountWizard(scripted)
    // Three named group cards; the provider facts live in the first one.
    const infoGroup = screen.getByRole('region', { name: zh.providerInfoGroup })
    expect(within(infoGroup).getByLabelText(zh.displayName)).toBeDefined()
    expect(within(infoGroup).getByLabelText(zh.baseUrl)).toBeDefined()
    expect(within(infoGroup).getByLabelText(zh.keyInput)).toBeDefined()
    expect(within(screen.getByRole('region', { name: zh.apiFormat })).getByRole('radiogroup', { name: zh.apiFormat })).toBeDefined()
    const modelGroup = screen.getByRole('region', { name: zh.modelsLabel })
    // The empty catalog says so and offers the ghost add row.
    expect(within(modelGroup).getByText(zh.modelsEmptyHint)).toBeDefined()
    expect(within(modelGroup).getByRole('button', { name: zh.addModel })).toBeDefined()
    // The picked protocol card carries the selected class; picking another moves it.
    const cards = within(screen.getByRole('radiogroup', { name: zh.apiFormat })).getAllByRole('radio')
    expect(cards[0]!.className).toContain(styles['protocolCardActive'])
    expect(cards[1]!.className).not.toContain(styles['protocolCardActive'])
    fireEvent.click(cards[1]!)
    expect(cards[1]!.className).toContain(styles['protocolCardActive'])
    expect(cards[0]!.className).not.toContain(styles['protocolCardActive'])
    // Footer: hint left, cancel (outline) then save (filled, gated) right.
    // Classes are addressed through the imported module so the assertions
    // hold under the hashed CSS-module names the tests compile with.
    const footer = document.querySelector(`.${styles['editorActions']}`)
    expect(footer).not.toBeNull()
    const buttons = footer!.querySelector(`.${styles['editorActionButtons']}`)
    expect(buttons).not.toBeNull()
    const [cancel, save] = [...buttons!.querySelectorAll('button')]
    expect(cancel!.className).toContain(styles['secondaryButton'])
    expect(save!.className).toContain(styles['primaryButton'])
    expect(cancel!.textContent).toBe(zh.cancel)
    expect(save!.textContent).toBe(zh.createProvider)
    expect(save!.hasAttribute('disabled')).toBe(true)
  })

  it('opens the model dialog as a titled card and dismisses it from the close ×', () => {
    const scripted = wireFace()
    mountWizard(scripted)
    fireEvent.click(screen.getByRole('button', { name: zh.addModel }))
    const dialog = screen.getByRole('group', { name: zh.addModel })
    // The header bar names the action and offers the ×, which dismisses the
    // draft without adding a row.
    expect(within(dialog).getByText(zh.addModel)).toBeDefined()
    expect(within(dialog).getByLabelText(`${zh.inputType} ${zh.modalityText}`).closest('label')?.className)
      .toContain(styles['modalityChipLocked'])
    fireEvent.click(within(dialog).getByRole('button', { name: zh.close }))
    expect(screen.queryByRole('group', { name: zh.addModel })).toBeNull()
    expect(screen.getByText(zh.modelsEmptyHint)).toBeDefined()
  })

  it('derives the route id from the name and refuses a collision in Chinese', () => {
    const scripted = wireFace()
    mountWizard(scripted, { taken: ['acme-gateway'] })
    fireEvent.change(screen.getByLabelText(zh.displayName), { target: { value: 'Acme Gateway' } })
    // A name colliding with a taken route is named immediately, in Chinese.
    expect(screen.getByText('已有提供方使用了这个路由 ID。')).toBeDefined()
    fireEvent.change(screen.getByLabelText(zh.displayName), { target: { value: 'Local Relay' } })
    expect(screen.queryByText('已有提供方使用了这个路由 ID。')).toBeNull()
  })

  it('drafts models through the inline dialog and refuses bad rows in place', () => {
    const scripted = wireFace()
    mountWizard(scripted)
    fireEvent.click(screen.getByRole('button', { name: zh.addModel }))
    fireEvent.change(screen.getByLabelText(zh.modelId), { target: { value: 'acme-large' } })
    fireEvent.change(screen.getByLabelText(zh.contextWindow), { target: { value: 'abc' } })
    fireEvent.click(withinDialog().getByRole('button', { name: zh.apply }))
    expect(screen.getByText(zh.modelContextInvalid)).toBeDefined()
    fireEvent.change(screen.getByLabelText(zh.contextWindow), { target: { value: '131072' } })
    fireEvent.change(screen.getByLabelText(zh.maxOutputTokens), { target: { value: '-4' } })
    fireEvent.click(withinDialog().getByRole('button', { name: zh.apply }))
    expect(screen.getByText(zh.modelMaxTokensInvalid)).toBeDefined()
    fireEvent.change(screen.getByLabelText(zh.maxOutputTokens), { target: { value: '32768' } })
    fireEvent.click(withinDialog().getByRole('button', { name: zh.apply }))
    expect(screen.getByText('acme-large')).toBeDefined()
    // A duplicate id is judged in the dialog, not at the submit gate.
    fireEvent.click(screen.getByRole('button', { name: zh.addModel }))
    fireEvent.change(screen.getByLabelText(zh.modelId), { target: { value: 'acme-large' } })
    fireEvent.click(withinDialog().getByRole('button', { name: zh.apply }))
    expect(screen.getByText(zh.modelIdDuplicate)).toBeDefined()
    fireEvent.click(withinDialog().getByRole('button', { name: zh.cancel }))
    expect(screen.getByText('acme-large')).toBeDefined()
  })

  it('locks the text modality and stores image input with the dialog defaults', async () => {
    const scripted = wireFace()
    mountWizard(scripted)
    fireEvent.change(screen.getByLabelText(zh.displayName), { target: { value: 'Vision Relay' } })
    fireEvent.change(screen.getByLabelText(zh.baseUrl), { target: { value: 'https://vision.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: zh.addModel }))
    const inputText = withinDialog().getByLabelText(`${zh.inputType} ${zh.modalityText}`) as HTMLInputElement
    const outputText = withinDialog().getByLabelText(`${zh.outputType} ${zh.modalityText}`) as HTMLInputElement
    expect(inputText.checked).toBe(true)
    expect(inputText.hasAttribute('disabled')).toBe(true)
    expect(outputText.checked).toBe(true)
    expect(outputText.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText(zh.modelId), { target: { value: 'vision-large' } })
    fireEvent.click(withinDialog().getByLabelText(`${zh.inputType} ${zh.modalityImage}`))
    fireEvent.click(withinDialog().getByRole('button', { name: zh.apply }))
    expect(screen.getByText('vision-large')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: zh.createProvider }))
    await waitFor(() => { expect(scripted.mutate).toHaveBeenCalled() })
    const profile = (scripted.mutate.mock.calls[0]![0].ops as Array<{ value: Record<string, unknown> }>)[0]!.value
    // The dialog's opened-at defaults are real values, and the declared image
    // input travels with the model into the stored profile.
    expect(profile.models).toEqual([
      { id: 'vision-large', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'] },
    ])
  })

  it('writes the whole profile in one mutate, then the credential, and selects the route', async () => {
    const scripted = wireFace()
    const onCreated = mountWizard(scripted)
    fireEvent.change(screen.getByLabelText(zh.displayName), { target: { value: 'Acme Gateway' } })
    fireEvent.change(screen.getByLabelText(zh.baseUrl), { target: { value: 'https://api.acme.dev/v1' } })
    fireEvent.change(screen.getByLabelText(zh.keyInput), { target: { value: 'sk-acme' } })
    fireEvent.click(screen.getByRole('radio', { name: /Chat Completions/ }))
    // The submit gate holds while no model is drafted.
    expect(screen.getByRole('button', { name: zh.createProvider }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh.addModel }))
    fireEvent.change(screen.getByLabelText(zh.modelId), { target: { value: 'acme-large' } })
    fireEvent.change(screen.getByLabelText(zh.contextWindow), { target: { value: '131072' } })
    fireEvent.click(withinDialog().getByRole('button', { name: zh.apply }))
    fireEvent.click(screen.getByRole('button', { name: zh.createProvider }))
    await waitFor(() => { expect(scripted.mutate).toHaveBeenCalledWith({
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'acme-gateway'],
        value: {
          displayName: 'Acme Gateway',
          apiKeyEnv: 'ACME_GATEWAY_API_KEY',
          api: 'openai',
          baseURL: 'https://api.acme.dev/v1',
          models: [{ id: 'acme-large', contextWindow: 131_072, maxTokens: 128_000 }],
        },
      }],
      expectedRevision: 4,
    }) })
    await waitFor(() => { expect(scripted.set).toHaveBeenCalledWith({ ref: 'ACME_GATEWAY_API_KEY', value: 'sk-acme' }) })
    await waitFor(() => { expect(onCreated).toHaveBeenCalledWith('acme-gateway') })
  })

  it('keeps a keyless route off the credential seam entirely', async () => {
    const scripted = wireFace()
    const onCreated = mountWizard(scripted)
    fireEvent.change(screen.getByLabelText(zh.displayName), { target: { value: 'Local Relay' } })
    fireEvent.change(screen.getByLabelText(zh.baseUrl), { target: { value: 'https://relay.example/v1' } })
    fireEvent.click(screen.getByRole('radio', { name: /Anthropic Messages/ }))
    fireEvent.click(screen.getByRole('button', { name: zh.addModel }))
    fireEvent.change(screen.getByLabelText(zh.modelId), { target: { value: 'relay-small' } })
    fireEvent.click(withinDialog().getByRole('button', { name: zh.apply }))
    fireEvent.click(screen.getByRole('button', { name: zh.createProvider }))
    await waitFor(() => { expect(scripted.mutate).toHaveBeenCalled() })
    const profile = (scripted.mutate.mock.calls[0]![0].ops as Array<{ value: Record<string, unknown> }>)[0]!.value
    expect(profile.apiKeyEnv).toBeUndefined()
    expect(profile.api).toBe('anthropic')
    expect(scripted.set).not.toHaveBeenCalled()
    await waitFor(() => { expect(onCreated).toHaveBeenCalledWith('local-relay') })
  })

  it('reports a refused create without clearing the draft', async () => {
    const scripted = wireFace({
      mutate: vi.fn(() => Promise.resolve(refused('llm-pi-ai：providers 必须是对象'))),
    })
    mountWizard(scripted)
    fireEvent.change(screen.getByLabelText(zh.displayName), { target: { value: 'Acme' } })
    fireEvent.change(screen.getByLabelText(zh.baseUrl), { target: { value: 'https://api.acme.dev/v1' } })
    fireEvent.click(screen.getByRole('button', { name: zh.addModel }))
    fireEvent.change(screen.getByLabelText(zh.modelId), { target: { value: 'acme-large' } })
    fireEvent.click(withinDialog().getByRole('button', { name: zh.apply }))
    fireEvent.click(screen.getByRole('button', { name: zh.createProvider }))
    await waitFor(() => { expect(screen.getByText('llm-pi-ai：providers 必须是对象')).toBeDefined() })
    expect(screen.getByLabelText(zh.displayName)).toHaveProperty('value', 'Acme')
  })

  it('toggles the key input between masked and revealed', () => {
    const scripted = wireFace()
    mountWizard(scripted)
    const keyInput = (): HTMLInputElement => screen.getByLabelText(zh.keyInput) as HTMLInputElement
    expect(keyInput().type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: zh.showKey }))
    expect(keyInput().type).toBe('text')
    fireEvent.click(screen.getByRole('button', { name: zh.hideKey }))
    expect(keyInput().type).toBe('password')
    expect(screen.getByRole('button', { name: zh.showKey })).toBeDefined()
  })
})

/** The inline mini-dialog, addressed by its group role. */
/**
 * Structural return type: resolves identically under tsc and the lint
 * program's type view (the library's generic BoundFunctions collapses to
 * `any` in the latter).
 */
function withinDialog(): {
  getByRole: (role: string, options?: { name?: string | RegExp; hidden?: boolean }) => HTMLElement
  getByLabelText: (label: string | RegExp) => HTMLElement
} {
  return within(screen.getByRole('group', { name: zh.addModel }))
}
