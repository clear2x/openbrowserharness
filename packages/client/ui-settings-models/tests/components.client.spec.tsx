// @vitest-environment jsdom
/** Two-pane section wiring: rail groups, status dots, selection, and route removal. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  DEFAULT_PROVIDER_DELETE_REFUSED, ModelsSection, providerCopy, providerTargetLabel, removeProviderProfile,
} from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected } from '../src/client/ModelsSection.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => zh[key]

const OPENAI_PROFILE = {
  displayName: 'OpenAI',
  apiKeyEnv: 'OPENAI_API_KEY',
  api: 'openai',
  baseURL: 'https://proxy.example/v1',
  models: [{ id: 'gpt-x', contextWindow: 128_000 }],
}
const KEYLESS_PROFILE = {
  displayName: 'Keyless',
  api: 'anthropic',
  baseURL: 'https://keyless.example/v1',
  models: [{ id: 'claude-x' }],
}

/**
 * The extension host's official directory: one whole-section llm-deepseek row
 * (DeepSeek) carrying the preset's connection facts (the per-preset key
 * editor). Every other vendor arrives as a hand-declared route.
 */
const OFFICIAL_DIRECTORY: Array<Record<string, unknown>> = [
  { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true, keyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', api: 'openai', defaultModel: 'deepseek-v4-flash' },
]

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

function wireNamespaces(deepSeekKeySet: boolean): SettingsNamespaceView[] {
  return [
    {
      ns: 'llm-deepseek',
      schema: {},
      value: { provider: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
      base: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
      user: {},
      applies: 'live',
      secrets: [{ path: ['apiKeyEnv'], set: deepSeekKeySet }],
      revision: 3,
    },
    {
      ns: 'llm-pi-ai',
      schema: JSON.parse(JSON.stringify(PiAiSchema.toJSON())) as never,
      value: { providers: { openai: OPENAI_PROFILE, keyless: KEYLESS_PROFILE } },
      user: { providers: { openai: OPENAI_PROFILE, keyless: KEYLESS_PROFILE } },
      applies: 'live',
      secrets: [],
      revision: 7,
    },
  ]
}

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'internal', message, details: {} } } }
}

function scriptedFace(overrides: {
  deepSeekKeySet?: boolean
  describe?: (refs: string[]) => Record<string, unknown>
  mutate?: () => Promise<RpcResponse<SettingsNamespaceView>>
  unset?: () => Promise<RpcResponse<Record<string, never>>>
  discoverModels?: () => Promise<RpcResponse<{ models: Array<{ id: string; name: string }> }>>
} = {}) {
  const describeSettings = vi.fn(() => Promise.resolve(ok({
    writable: true,
    hasDocument: false,
    namespaces: wireNamespaces(overrides.deepSeekKeySet ?? true),
  })))
  const mutate = (overrides.mutate
    ?? vi.fn(() => Promise.resolve(ok(wireNamespaces(true)[1] as never)))) as unknown as ReturnType<typeof vi.fn>
  const face = {
    llm: {
      providers: vi.fn(() => Promise.resolve(ok({
        providers: [
          { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
          { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
          { provider: 'keyless', displayName: 'Keyless', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'keyless'], active: true },
        ],
      }))),
      models: vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] }))),
      discoverModels: overrides.discoverModels
        ?? vi.fn(() => Promise.resolve(ok({ models: [{ id: 'm1', name: 'M1' }] }))),
    },
    settings: { describe: describeSettings, mutate },
    credentials: {
      describe: vi.fn((payload: { refs: string[] }) => Promise.resolve(ok({
        credentials: overrides.describe !== undefined
          ? overrides.describe(payload.refs)
          : Object.fromEntries(payload.refs.map(ref => [ref, { configured: true, writable: true }])),
      }))),
      set: vi.fn(() => Promise.resolve(ok({}))),
      unset: overrides.unset ?? vi.fn(() => Promise.resolve(ok({}))),
    },
  }
  return {
    face,
    providers: face.llm.providers,
    discoverModels: face.llm.discoverModels,
    describeCredentials: face.credentials.describe,
    setCredential: face.credentials.set,
    unsetCredential: face.credentials.unset,
    mutate,
    describeSettings,
  }
}

type WireFace = ConstructorParameters<typeof ModelsSettingsStore>[0]

async function mount(scripted: ReturnType<typeof scriptedFace>) {
  const controller = new ModelsSettingsStore(scripted.face as unknown as WireFace)
  await controller.load()
  const injected: ModelsSectionInjected = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    api: scripted.face as never,
    t,
  }
  render(<ModelsSection {...injected} />)
  return scripted
}

const rail = (): HTMLElement => screen.getByRole('navigation', { name: zh.title })

/**
 * One rail row's selectable button, addressed by its provider name. The row
 * now also carries its default-provider control, so a name regex alone would
 * match both buttons; the name span's own button ancestor is unambiguous.
 */
const railButton = (name: string): HTMLElement =>
  within(rail()).getByText(name).closest('button') as HTMLElement

/** One rail row's wrapper: the selectable button plus its default control. */
const railRow = (name: string): HTMLElement =>
  railButton(name).parentElement as HTMLElement

describe('provider rail', () => {
  it('groups the official preset and the declared routes, each with a status dot', async () => {
    await mount(scriptedFace())
    expect(within(rail()).getByText(zh.officialGroup)).toBeDefined()
    expect(within(rail()).getByText(zh.customGroup)).toBeDefined()
    expect(within(rail()).getByText('DeepSeek')).toBeDefined()
    expect(within(rail()).getByText('OpenAI')).toBeDefined()
    expect(within(rail()).getByText('Keyless')).toBeDefined()
    // The add chip closes the rail.
    expect(within(rail()).getByRole('button', { name: zh.addSupplier })).toBeDefined()
  })

  it('paints the dot green for a stored key, a keyless route, and gray for a missing one', async () => {
    await mount(scriptedFace({
      describe: refs => Object.fromEntries(refs.map(ref => [
        ref,
        ref === 'OPENAI_API_KEY'
          ? { configured: false, writable: true }
          : { configured: true, writable: true },
      ])),
    }))
    const deepSeekItem = railButton('DeepSeek')
    expect(within(deepSeekItem).getByLabelText(zh.credentialConfigured)).toBeDefined()
    const openaiItem = railButton('OpenAI')
    expect(within(openaiItem).getByLabelText(zh.credentialMissing)).toBeDefined()
    const keylessItem = railButton('Keyless')
    expect(within(keylessItem).getByLabelText(zh.credentialConfigured)).toBeDefined()
  })

  it('adds a whole-section keyRef to the credential describe batch', async () => {
    const scripted = await mount(scriptedFace())
    await waitFor(() => {
      const batches = scripted.describeCredentials.mock.calls.map(call => call[0].refs)
      expect(batches.some(refs => refs.includes('DEEPSEEK_API_KEY'))).toBe(true)
    })
  })
})

describe('selection', () => {
  it('opens the official panel first and shows the route editor for a declared route', async () => {
    await mount(scriptedFace())
    // Default selection: the official preset.
    expect(screen.getByLabelText(zh.keyInput)).toBeDefined()
    fireEvent.click(railButton('OpenAI'))
    // The route id is a readonly fact of an existing route.
    const routeInput = screen.getByLabelText(zh.routeLabel) as HTMLInputElement
    expect(routeInput.value).toBe('openai')
    expect(routeInput.readOnly).toBe(true)
    expect(screen.getByLabelText(zh.baseUrl)).toBeDefined()
    expect(screen.getByLabelText(zh.headers)).toBeDefined()
    expect(screen.getByRole('radiogroup', { name: zh.apiFormat })).toBeDefined()
  })

  it('opens the add-supplier wizard from the rail and returns on cancel', async () => {
    await mount(scriptedFace())
    fireEvent.click(within(rail()).getByRole('button', { name: zh.addSupplier }))
    expect(screen.getByLabelText(zh.displayName)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
    // 取消 lands back on the previously picked provider.
    expect(screen.getByLabelText(zh.keyInput)).toBeDefined()
  })
})

describe('probe verdicts', () => {
  it('repaints the rail dot green after a successful test', async () => {
    const scripted = await mount(scriptedFace({
      describe: refs => Object.fromEntries(refs.map(ref => [ref, { configured: ref !== 'DEEPSEEK_API_KEY', writable: true }])),
      discoverModels: vi.fn(() => Promise.resolve(ok({ models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }))),
    }))
    const deepSeekItem = () => railButton('DeepSeek')
    expect(within(deepSeekItem()).getByLabelText(zh.credentialMissing)).toBeDefined()
    fireEvent.change(screen.getByLabelText(zh.keyInput), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByRole('button', { name: zh.testConnection }))
    await waitFor(() => { expect(screen.getByText(zh.probeOk.replace('{count}', '2'))).toBeDefined() })
    // The verdict, not just the stored credential, paints the dot.
    expect(within(deepSeekItem()).getByLabelText(zh.credentialConfigured)).toBeDefined()
    expect(scripted.discoverModels).toHaveBeenCalledWith(expect.objectContaining({
      settingsNs: 'llm-deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-test',
    }))
  })
})

describe('route removal', () => {
  it('removes the profile and the page-managed credential after confirmation', async () => {
    const scripted = await mount(scriptedFace())
    fireEvent.click(railButton('OpenAI'))
    fireEvent.click(screen.getByRole('button', { name: zh.remove }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('OpenAI')
    fireEvent.click(within(dialog).getByRole('button', { name: providerCopy(zh.deleteConfirm, { provider: 'openai', displayName: 'OpenAI' }) }))
    await waitFor(() => { expect(scripted.unsetCredential).toHaveBeenCalledWith({ ref: 'OPENAI_API_KEY' }) })
    await waitFor(() => expect(scripted.mutate).toHaveBeenCalledWith({
      ns: 'llm-pi-ai',
      ops: [{ op: 'unset', path: ['providers', 'openai'] }],
    }))
    // Selection falls back to the official provider.
    await waitFor(() => { expect(screen.getByLabelText(zh.keyInput)).toBeDefined() })
  })

  it('reports a refused removal instead of dropping the row silently', async () => {
    const scripted = await mount(scriptedFace({
      unset: vi.fn(() => Promise.resolve(ok({}))),
      mutate: vi.fn(() => Promise.resolve(fail('拒绝删除')) as never),
    }))
    fireEvent.click(railButton('OpenAI'))
    fireEvent.click(screen.getByRole('button', { name: zh.remove }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: providerCopy(zh.deleteConfirm, { provider: 'openai', displayName: 'OpenAI' }) }))
    await waitFor(() => { expect(screen.getByText('拒绝删除')).toBeDefined() })
    expect(scripted.mutate).toHaveBeenCalled()
  })

  it('blocks deleting the engine default provider in the confirmation dialog', async () => {
    const scripted = scriptedFace()
    // The engine default rides the llm-deepseek namespace's provider bit;
    // pointing it at the custom route makes that row the 默认 row.
    scripted.describeSettings.mockImplementation(() => Promise.resolve(ok({
      writable: true,
      hasDocument: false,
      namespaces: [
        { ...wireNamespaces(true)[0]!, value: { ...(wireNamespaces(true)[0]!.value as Record<string, unknown>), provider: 'openai' } },
        wireNamespaces(true)[1]!,
      ],
    })))
    await mount(scripted)
    fireEvent.click(railButton('OpenAI'))
    fireEvent.click(screen.getByRole('button', { name: zh.remove }))
    const dialog = screen.getByRole('dialog')
    // The dialog says why the delete cannot proceed, and the commit stays
    // disabled — no write reaches the wire at all.
    expect(within(dialog).getByText(DEFAULT_PROVIDER_DELETE_REFUSED)).toBeDefined()
    const confirm = within(dialog).getByRole('button', {
      name: providerCopy(zh.deleteConfirm, { provider: 'openai', displayName: 'OpenAI' }),
    })
    expect(confirm.hasAttribute('disabled')).toBe(true)
    fireEvent.click(confirm)
    expect(scripted.unsetCredential).not.toHaveBeenCalled()
    expect(scripted.mutate).not.toHaveBeenCalled()
    // 取消 still closes the dialog without side effects.
    fireEvent.click(within(dialog).getByRole('button', { name: zh.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('default provider', () => {
  it('marks the current default and switches it through one settings.mutate path op', async () => {
    const scripted = scriptedFace()
    const providerState = { provider: 'deepseek' }
    scripted.describeSettings.mockImplementation(() => Promise.resolve(ok({
      writable: true,
      hasDocument: false,
      namespaces: [
        {
          ...wireNamespaces(true)[0]!,
          value: {
            ...(wireNamespaces(true)[0]!.value as Record<string, unknown>),
            provider: providerState.provider,
          },
        },
        wireNamespaces(true)[1]!,
      ],
    })))
    scripted.mutate.mockImplementation(async (payload: { ns: string; ops: unknown }) => {
      const op = (payload.ops as Array<{ op: 'set'; path: string[]; value: string }>)[0]!
      providerState.provider = op.value
      return ok(wireNamespaces(true)[0] as never)
    })
    await mount(scripted)
    // The official row is the default: it shows the 默认 tag and no switch link.
    expect(within(rail()).getByText(zh.defaultProvider)).toBeDefined()
    expect(screen.queryByRole('button', { name: `${zh.setDefaultProvider} DeepSeek` })).toBeNull()
    // Switching to a declared route writes the provider bit to the shared
    // engine-settings section, then the rail repaints on the reload.
    fireEvent.click(within(railRow('OpenAI')).getByRole('button', { name: `${zh.setDefaultProvider} OpenAI` }))
    await waitFor(() => expect(scripted.mutate).toHaveBeenCalledWith({
      ns: 'llm-deepseek',
      ops: [{ op: 'set', path: ['provider'], value: 'openai' }],
      expectedRevision: 3,
    }))
    // The tag moved: OpenAI is the default now, DeepSeek offers the switch.
    await waitFor(() => { expect(screen.getByRole('button', { name: `${zh.setDefaultProvider} DeepSeek` })).toBeDefined() })
    expect(within(railRow('OpenAI')).getByText(zh.defaultProvider)).toBeDefined()
    expect(screen.queryByText(zh.defaultProviderMissing)).toBeNull()
  })

  it('annotates each rail row with its default model', async () => {
    await mount(scriptedFace())
    // The official row inherits the active preset's default model from the
    // engine-settings base layer; declared routes name their first stored row.
    expect(within(rail()).getByText(`${zh.defaultModel} deepseek-v4-flash`)).toBeDefined()
    expect(within(rail()).getByText(`${zh.defaultModel} gpt-x`)).toBeDefined()
    expect(within(rail()).getByText(`${zh.defaultModel} claude-x`)).toBeDefined()
  })

  it('warns when the default provider is no longer in the directory', async () => {
    const scripted = scriptedFace()
    const namespaces = wireNamespaces(true)
    namespaces[0] = { ...namespaces[0]!, value: { ...(namespaces[0]!.value as Record<string, unknown>), provider: 'ghost-route' } }
    scripted.describeSettings.mockImplementation(() => Promise.resolve(ok({
      writable: true,
      hasDocument: false,
      namespaces,
    })))
    await mount(scripted)
    expect(screen.getByText(zh.defaultProviderMissing)).toBeDefined()
  })
})

describe('official group', () => {
  /**
   * The single-preset directory with the DeepSeek key stored (or missing, by
   * override).
   */
  function officialFace(deepSeekKeySet = true) {
    return scriptedFace({
      describe: refs => Object.fromEntries(refs.map(ref => [
        ref,
        { configured: ref === 'DEEPSEEK_API_KEY' ? deepSeekKeySet : true, writable: true },
      ])),
    })
  }

  it('renders the sole official preset as its own rail row with a status dot', async () => {
    const scripted = officialFace()
    scripted.providers.mockResolvedValue(ok({ providers: OFFICIAL_DIRECTORY as never }))
    await mount(scripted)
    expect(within(rail()).getByText('DeepSeek')).toBeDefined()
    // Stored key → green; the removed presets surface no phantom rows.
    expect(within(railButton('DeepSeek')).getByLabelText(zh.credentialConfigured)).toBeDefined()
    expect(within(rail()).queryByText('OpenAI')).toBeNull()
    expect(within(rail()).queryByText('Ollama')).toBeNull()
    // The row names its own preset default model, and the engine default
    // stays DeepSeek: 默认 tag, no switch.
    expect(within(rail()).getByText(`${zh.defaultModel} deepseek-v4-flash`)).toBeDefined()
    expect(within(rail()).getByText(zh.defaultProvider)).toBeDefined()
    expect(screen.queryByRole('button', { name: `${zh.setDefaultProvider} DeepSeek` })).toBeNull()
  })

  it('paints the official row gray while the preset key is missing', async () => {
    const scripted = officialFace(false)
    scripted.providers.mockResolvedValue(ok({ providers: OFFICIAL_DIRECTORY as never }))
    await mount(scripted)
    expect(within(railButton('DeepSeek')).getByLabelText(zh.credentialMissing)).toBeDefined()
  })

  it('opens the preset key editor and stores the key under the directory-named ref', async () => {
    const scripted = officialFace()
    scripted.providers.mockResolvedValue(ok({ providers: OFFICIAL_DIRECTORY as never }))
    await mount(scripted)
    fireEvent.click(railButton('DeepSeek'))
    const baseUrlInput = screen.getByLabelText(zh.baseUrl) as HTMLInputElement
    expect(baseUrlInput.value).toBe('https://api.deepseek.com')
    expect(baseUrlInput.readOnly).toBe(true)
    fireEvent.change(screen.getByLabelText(zh.keyInput), { target: { value: 'sk-deepseek' } })
    fireEvent.click(screen.getByRole('button', { name: zh.apply }))
    await waitFor(() => { expect(scripted.setCredential).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY', value: 'sk-deepseek' }) })
  })
})

describe('pure helpers', () => {
  it('labels a target with its route when the name differs', () => {
    expect(providerTargetLabel({ provider: 'openai', displayName: 'OpenAI' })).toBe('OpenAI (openai)')
    expect(providerTargetLabel({ provider: 'DeepSeek', displayName: 'DeepSeek' })).toBe('DeepSeek')
    expect(providerCopy(zh.deleteTitle, { provider: 'openai', displayName: 'OpenAI' })).toBe('删除 OpenAI (openai)？')
  })

  it('removes a profile through the store refresh', async () => {
    const scripted = scriptedFace()
    const controller = new ModelsSettingsStore(scripted.face as unknown as WireFace)
    await controller.load()
    const failure = await removeProviderProfile(scripted.face as never, controller, {
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
    })
    expect(failure).toBeUndefined()
    expect(scripted.mutate).toHaveBeenCalled()
  })

  it('refuses to remove the provider the engine currently uses as default', async () => {
    const scripted = scriptedFace()
    const controller = new ModelsSettingsStore(scripted.face as unknown as WireFace)
    await controller.load()
    const failure = await removeProviderProfile(scripted.face as never, controller, {
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
    }, 'openai')
    expect(failure).toBe(DEFAULT_PROVIDER_DELETE_REFUSED)
    // The refusal lands before any write: neither the credential nor the
    // settings mutate fires, so the operation stays cleanly retryable.
    expect(scripted.unsetCredential).not.toHaveBeenCalled()
    expect(scripted.mutate).not.toHaveBeenCalled()
  })

  it('removes a profile that is not the engine default', async () => {
    const scripted = scriptedFace()
    const controller = new ModelsSettingsStore(scripted.face as unknown as WireFace)
    await controller.load()
    const failure = await removeProviderProfile(scripted.face as never, controller, {
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
    }, 'deepseek')
    expect(failure).toBeUndefined()
    expect(scripted.mutate).toHaveBeenCalled()
  })
})
