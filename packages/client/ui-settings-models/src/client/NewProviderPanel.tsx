/**
 * The add-supplier wizard, the right-pane form the rail's 「+ 添加供应商」
 * opens, laid out like the ZCode reference: title, intro line, then three
 * bordered group cards — 供应商信息 (名称 / Base URL / API Key), API 格式
 * (the three selectable protocol cards), and 模型 (an empty-state hint, the
 * dashed 添加模型 entry, one row card per drafted model, and the shared
 * 添加模型 dialog) — closed by the hint-and-commit footer. The route id is
 * being *chosen* here — derived
 * from the display name so the user never authors an identifier by hand — and
 * the settings address does not exist until the single create lands: one
 * `settings.mutate` writes the whole profile at `providers.<route>`, then the
 * typed key travels through `credentials.set` under the reference the profile
 * records. Custom request headers are an edit-panel field, not a wizard one;
 * a declared route can gain them after the create without touching this form.
 *
 * Every gate the host's write enforces (route-id shape, public Base URL,
 * at least one model) is mirrored field-locally so the refusal names the field
 * while the user is still looking at it.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { apiKeyFailure } from './apiKey.ts'
import { EditorFooter } from './EditorFooter.tsx'
import { KeyVisibilityToggle } from './KeyVisibilityToggle.tsx'
import { ModelDialog } from './ModelDialog.tsx'
import { validateModelCatalog } from './model-catalog.ts'
import { publicHttpUrlFailure, routeIdFailure, slugOfName } from './profile-validation.ts'
import { ProtocolCards } from './ProtocolCards.tsx'
import { deriveKeyRef, messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The settings namespace a hand-declared provider is written into. */
const NS = 'llm-pi-ai'

/**
 * One drafted model row: the fields the inline dialog collects. `input` is
 * recorded only when the draft declares image input — text alone is the
 * engine's floor and stays unstored.
 */
export interface DraftModel {
  /** Wire model id as the provider names it. */
  id: string
  /** Rough context window in tokens; absent inherits the route default. */
  contextWindow?: number
  /** Per-model output cap in tokens; absent inherits the adapter default. */
  maxTokens?: number
  /** Declared input modalities; absent means text only. */
  input?: ReadonlyArray<'text' | 'image'>
}

/** Props of {@link NewProviderPanel}. */
export interface NewProviderPanelProps {
  /** Wire protocols the owning schema offers, in declaration order. */
  protocols: readonly string[]
  /**
   * Revision of the `llm-pi-ai` user section this wizard opened at, sent with
   * the create so a route another tab declared meanwhile is a refusal rather
   * than a silent overwrite of its whole profile.
   */
  revision: number
  /** Route ids already declared, which the derived id must not shadow. */
  taken: readonly string[]
  /** Wire faces for the write and the credential store. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** The create landed; the page selects and refreshes around `route`. */
  onCreated: (route: string) => void
  /** Discard the draft and return to the previously selected provider. */
  onCancel: () => void
}

/**
 * Render the add-supplier wizard.
 * @param props - protocol choices, the CAS revision, existing routes, and wire faces.
 * @returns the wizard.
 */
export function NewProviderPanel(props: NewProviderPanelProps): ReactNode {
  const { api, t, taken, protocols } = props
  const [name, setName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [protocol, setProtocol] = useState(protocols[0] ?? '')
  const [keyDraft, setKeyDraft] = useState('')
  // Local-only: whether the key field renders as text instead of password.
  const [reveal, setReveal] = useState(false)
  const [models, setModels] = useState<readonly DraftModel[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const disabled = props.readOnly || busy
  const route = slugOfName(name)
  const routeFailure = name.trim().length === 0 ? undefined : routeIdFailure(route, taken)
  const urlFailure = baseURL.length === 0 ? undefined : publicHttpUrlFailure(baseURL)
  const keyFailure = apiKeyFailure(keyDraft)
  const keyValue = keyDraft.trim()
  const modelFailure = validateModelCatalog(models)

  const ready = name.trim().length > 0
    && routeFailure === undefined
    && baseURL.length > 0
    && urlFailure === undefined
    && keyFailure === undefined
    && protocols.includes(protocol)
    && models.length > 0
    && modelFailure === undefined

  /** Perform the create: one profile write, then the credential. */
  const create = async (): Promise<void> => {
    const keyRef = deriveKeyRef(route)
    const storesKey = keyValue.length > 0
    setBusy(true)
    setFailure(undefined)
    try {
      const profile = {
        displayName: name.trim(),
        // The profile names the conventional reference only when this wizard
        // is about to store a key; a blank key field leaves the route on its
        // provider-native auth path.
        ...(storesKey ? { apiKeyEnv: keyRef } : {}),
        api: protocol,
        baseURL,
        models: models.map(model => ({ ...model })),
      }
      const response = await api.settings.mutate({
        ns: NS,
        ops: [{ op: 'set', path: ['providers', route], value: profile }],
        expectedRevision: props.revision,
      })
      if (!response.result.ok) {
        setFailure(response.result.error.message)
        return
      }
      if (storesKey) {
        const stored = await api.credentials.set({ ref: keyRef, value: keyValue })
        // The profile landed; saying the key did not is the only honest report.
        if (!stored.result.ok) {
          setFailure(stored.result.error.message)
          return
        }
      }
      props.onCreated(route)
    } catch (error) {
      // A transport failure rejects rather than answering; without this the
      // wizard would stay busy with nothing shown.
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles['editor']}>
      <div className={styles['editorHeader']}>
        <span className={styles['editorTitle']}>{t('addProviderTitle')}</span>
      </div>
      <p className={styles['editorIntro']}>{t('addProviderIntro')}</p>
      {/* Group 1 — provider facts: name, Base URL, and the credential, one
          bordered card the way the ZCode reference groups them. */}
      <section className={styles['formGroup']} aria-label={t('providerInfoGroup')}>
        <span className={styles['formGroupTitle']}>{t('providerInfoGroup')}</span>
        <div className={styles['formGroupBody']}>
          <div className={styles['field']}>
            <span className={styles['fieldLabel']}>{t('displayName')}</span>
            <input
              className={styles['input']}
              type="text"
              value={name}
              placeholder={t('namePlaceholder')}
              aria-label={t('displayName')}
              aria-invalid={routeFailure !== undefined}
              disabled={disabled}
              onChange={(event) => { setName(event.target.value) }}
            />
            {routeFailure === undefined ? null : <p className={styles['error']}>{routeFailure}</p>}
          </div>
          <div className={styles['field']}>
            <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
            <input
              className={styles['input']}
              type="text"
              value={baseURL}
              placeholder={t('baseUrlPlaceholder')}
              aria-label={t('baseUrl')}
              aria-invalid={urlFailure !== undefined}
              disabled={disabled}
              onChange={(event) => { setBaseURL(event.target.value) }}
            />
            {urlFailure === undefined ? null : <p className={styles['error']}>{urlFailure}</p>}
          </div>
          <div className={styles['field']}>
            <span className={styles['fieldLabel']}>{t('keyInput')}</span>
            <div className={styles['keyRow']}>
              <input
                className={styles['input']}
                type={reveal ? 'text' : 'password'}
                autoComplete="off"
                value={keyDraft}
                placeholder={t('keyPlaceholder')}
                aria-label={t('keyInput')}
                aria-invalid={keyFailure !== undefined}
                disabled={disabled}
                onChange={(event) => { setKeyDraft(event.target.value) }}
              />
              <KeyVisibilityToggle
                revealed={reveal}
                disabled={disabled}
                label={reveal ? t('hideKey') : t('showKey')}
                onToggle={() => { setReveal(current => !current) }}
              />
            </div>
            {keyFailure === undefined ? null : <p className={styles['error']}>{t(keyFailure)}</p>}
          </div>
        </div>
      </section>
      {/* Group 2 — the wire protocol, its own card. */}
      <section className={styles['formGroup']} aria-label={t('apiFormat')}>
        <span className={styles['formGroupTitle']}>{t('apiFormat')}</span>
        <div className={styles['formGroupBody']}>
          <ProtocolCards
            protocols={protocols}
            value={protocol}
            onChange={setProtocol}
            disabled={disabled}
            label={t('apiFormat')}
          />
        </div>
      </section>
      {/* Group 3 — the model catalog, judged locally and committed with the
          wizard: an empty-state line plus the dashed add entry, then one row
          card per drafted model. */}
      <section className={styles['modelCatalog']} aria-label={t('modelsLabel')}>
        <div className={styles['modelListHead']}>
          <span className={styles['modelCatalogTitle']}>{t('modelsLabel')}</span>
        </div>
        {models.length === 0
          ? <p className={styles['modelsEmpty']}>{t('modelsEmptyHint')}</p>
          : models.map((model, index) => (
            <div key={model.id} className={styles['modelEntry']}>
              <div className={styles['wizardModelRow']}>
                <span className={styles['wizardModelId']}>{model.id}</span>
                {model.contextWindow === undefined
                  ? null
                  : <span className={styles['wizardModelContext']}>{`${t('contextWindow')} ${String(model.contextWindow)}`}</span>}
                {model.maxTokens === undefined
                  ? null
                  : <span className={styles['wizardModelContext']}>{`${t('maxOutputTokens')} ${String(model.maxTokens)}`}</span>}
                {model.input?.includes('image') === true
                  ? <span className={styles['wizardModelContext']}>{t('modalityImage')}</span>
                  : null}
                <button
                  type="button"
                  className={styles['linkButton']}
                  aria-label={`${t('removeModel')} ${String(index + 1)}`}
                  disabled={disabled}
                  onClick={() => { setModels(current => current.filter((_model, at) => at !== index)) }}
                >
                  {t('remove')}
                </button>
              </div>
            </div>
          ))}
        {addOpen
          ? (
            // The shared inline mini-dialog: judged on save, appended to the
            // pending list; nothing writes until the wizard commits.
            <ModelDialog
              t={t}
              label={t('addModel')}
              existing={models.map(model => model.id)}
              onSave={(model) => {
                setModels(current => [...current, model])
                setAddOpen(false)
              }}
              onCancel={() => { setAddOpen(false) }}
            />
          )
          : (
            <button
              type="button"
              className={styles['addModelButton']}
              disabled={disabled}
              onClick={() => { setAddOpen(true) }}
            >
              <span aria-hidden="true" className={styles['addModelPlus']}>+</span>
              {t('addModel')}
            </button>
          )}
      </section>
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      <EditorFooter
        hint={(
          <span className={styles['footnoteHint']}>
            <span aria-hidden="true" className={styles['footnoteIcon']}>ⓘ</span>
            {t('providerNeedsModel')}
          </span>
        )}
        busy={busy}
        submitDisabled={disabled || !ready}
        submitLabel={t('createProvider')}
        submitBusyLabel={t('creating')}
        cancelLabel={t('cancel')}
        onCancel={props.onCancel}
        onSubmit={() => { void create() }}
      />
    </div>
  )
}
