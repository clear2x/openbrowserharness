/**
 * Right-pane form for one hand-declared provider route. The route id is fixed
 * — it names the credential and the settings address, and nothing here can
 * rename either — while the profile's own fields edit in place: display name,
 * Base URL, API key, wire protocol, the custom request headers, and the
 * route's model rows (add / edit / delete through the shared model dialog; the
 * first stored row is the route's default model). Edits land as minimal
 * `settings.mutate` path ops against the stored section, so fields this form
 * does not show survive untouched.
 *
 * 测试连接 interrogates the endpoint the form currently shows (typed key
 * included) through `llm.discoverModels`; the host attaches the route's stored
 * custom headers to that interrogation, so the probe travels the way a real
 * request will.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CredentialView, IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { getPath } from '@deepseek-ai/dsh-client-schema-form'
import { apiKeyFailure } from './apiKey.ts'
import { EditorFooter } from './EditorFooter.tsx'
import { KeyVisibilityToggle } from './KeyVisibilityToggle.tsx'
import { ModelDialog } from './ModelDialog.tsx'
import type { DraftModel } from './NewProviderPanel.tsx'
import { useEndpointProbe } from './probe.ts'
import type { ProbeSummary } from './probe.ts'
import { headersTextFailure, publicHttpUrlFailure } from './profile-validation.ts'
import { ProtocolCards } from './ProtocolCards.tsx'
import { deriveKeyRef, messageOf, pathOps, protocolChoices } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link CustomRoutePanel}. */
export interface CustomRoutePanelProps {
  /** The route id (readonly here; it names the settings address and credential). */
  route: string
  /** The owning `llm-pi-ai` namespace view (schema, layers, revision). */
  namespace: SettingsNamespaceView
  /** Wire faces for writes and the endpoint probe. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Report a settled probe verdict so the rail dot can follow it. */
  reportProbe: (summary: ProbeSummary | undefined) => void
  /** Notify the page that a write committed, so joins refresh. */
  onSaved: () => void
  /** Ask the page to open the delete confirmation for this route. */
  onRequestDelete: () => void
}

/** The profile subtree this panel edits, or an empty draft when unresolved. */
function profileOf(namespace: SettingsNamespaceView, route: string): Record<string, unknown> {
  for (const layer of [namespace.user, namespace.value]) {
    const profile = getPath(layer, ['providers', route])
    if (typeof profile === 'object' && profile !== null && !Array.isArray(profile)) {
      return structuredClone(profile) as Record<string, unknown>
    }
  }
  return {}
}

/** A profile field as a string, or '' when absent. */
function stringField(profile: Record<string, unknown>, key: string): string {
  const value = profile[key]
  return typeof value === 'string' ? value : ''
}

/**
 * The profile's model rows, in stored order. The first row is the route's
 * default model (the engine falls back to it when no model is selected).
 * @param draft - the profile this panel edits.
 * @returns the rows the panel may add to, edit, or remove.
 */
function modelsOf(draft: Record<string, unknown>): DraftModel[] {
  const stored = draft.models
  if (!Array.isArray(stored)) return []
  return stored.filter((entry): entry is DraftModel =>
    typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string')
}

/**
 * One open model dialog: the add-model draft, or the edit of the row at an
 * index (the first row is the route default, so an id comparison would be
 * ambiguous after an earlier row was edited).
 */
type ModelDialogState = { mode: 'add' } | { mode: 'edit'; index: number }

/**
 * Render one declared route's editing panel.
 * @param props - the route, its namespace, wire faces, and callbacks.
 * @returns the panel.
 */
export function CustomRoutePanel(props: CustomRoutePanelProps): ReactNode {
  const { route, namespace, api, t } = props
  const protocols = protocolChoices(namespace)
  const [draft, setDraft] = useState(() => profileOf(namespace, route))
  const [keyDraft, setKeyDraft] = useState('')
  // Local-only: whether the key field renders as text instead of password.
  const [reveal, setReveal] = useState(false)
  const [keyState, setKeyState] = useState<CredentialView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [modelDialog, setModelDialog] = useState<ModelDialogState | undefined>(undefined)
  // CAS baselines captured at mount: the write is judged against the section
  // this panel opened over, not whatever it grew into meanwhile.
  const [committedOriginal, setCommittedOriginal] = useState<unknown>(
    () => getPath(namespace.user, ['providers', route]),
  )
  const [expectedRevision, setExpectedRevision] = useState(() => namespace.revision)
  const [probeState, runProbe] = useEndpointProbe(api)

  const storedProfile = getPath(namespace.value, ['providers', route])
  const namedRef = typeof (storedProfile as { apiKeyEnv?: unknown } | null)?.apiKeyEnv === 'string'
    ? (storedProfile as { apiKeyEnv: string }).apiKeyEnv
    : undefined
  const keyRef = namedRef ?? deriveKeyRef(route)

  useEffect(() => {
    let stale = false
    void api.credentials.describe({ refs: [keyRef] }).then(
      (response) => {
        if (!stale && response.result.ok) setKeyState(response.result.value.credentials[keyRef])
      },
      () => undefined,
    )
    return () => { stale = true }
  }, [api.credentials, keyRef])

  const disabled = props.readOnly || busy
  const keyValue = keyDraft.trim()
  const keyFailure = apiKeyFailure(keyDraft)
  const keyLocked = keyState?.writable === false

  const setField = (key: string, value: string): void => {
    setDraft(current => ({ ...current, [key]: value }))
  }

  // Immediate, field-local refusals — the same rules the host's write gate
  // enforces, named while the user is still looking at the field.
  const baseURL = stringField(draft, 'baseURL')
  const headersText = stringField(draft, 'headersText')
  const models = modelsOf(draft)
  const urlFailure = baseURL.length === 0 ? undefined : publicHttpUrlFailure(baseURL)
  const headersFailure = headersTextFailure(headersText)
  const probeBaseURL = baseURL.length > 0 ? baseURL : undefined

  const test = async (): Promise<void> => {
    const summary = await runProbe({
      settingsNs: namespace.ns,
      provider: route,
      ...(probeBaseURL === undefined ? {} : { baseURL: probeBaseURL }),
      ...(keyValue.length === 0 ? {} : { apiKey: keyValue }),
    })
    props.reportProbe(summary)
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      // A route whose profile named no reference materializes the conventional
      // one exactly when this panel is about to store a key; a blank key field
      // keeps the profile's own auth path untouched.
      const next = namedRef === undefined && keyValue.length > 0
        ? { ...draft, apiKeyEnv: keyRef }
        : draft
      const ops = pathOps(['providers', route], committedOriginal, next)
      if (ops.length > 0) {
        const response = await api.settings.mutate({ ns: namespace.ns, ops, expectedRevision })
        if (!response.result.ok) {
          setFailure(response.result.error.code === 'settings-conflict' ? t('conflict') : response.result.error.message)
          return
        }
        setCommittedOriginal(getPath(response.result.value.user, ['providers', route]))
        setExpectedRevision(response.result.value.revision)
      }
      if (keyValue.length > 0) {
        const stored = await api.credentials.set({ ref: keyRef, value: keyValue })
        if (!stored.result.ok) {
          setFailure(stored.result.error.message)
          return
        }
      }
      setKeyDraft('')
      props.onSaved()
    } catch (error) {
      // A transport failure rejects rather than answering; without this the
      // panel would stay busy forever with nothing shown.
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const submitBlocked = disabled || keyFailure !== undefined || urlFailure !== undefined
    || headersFailure !== undefined || baseURL.length === 0
    || protocols.length === 0 || models.length === 0

  /** Commit the judged dialog draft into the profile's model rows. */
  const commitModel = (model: DraftModel): void => {
    if (modelDialog?.mode === 'edit') {
      const at = modelDialog.index
      setDraft(current => ({
        ...current,
        models: modelsOf(current).map((entry, index) => index === at ? model : entry),
      }))
    } else {
      setDraft(current => ({ ...current, models: [...modelsOf(current), model] }))
    }
    setModelDialog(undefined)
  }

  /** Drop the row at `at`; the save gate holds the profile above zero models. */
  const removeModelAt = (at: number): void => {
    setDraft(current => ({ ...current, models: modelsOf(current).filter((_entry, index) => index !== at) }))
  }

  const statusLine = probeState.kind === 'idle'
    ? null
    : (
      <span
        className={
          `${styles['statusLine']} ${
            probeState.kind === 'ok' ? styles['statusOk'] : ''
          } ${
            probeState.kind === 'failed' ? styles['statusFailed'] : ''
          }`.trim()}
        role="status"
      >
        {probeState.kind === 'busy'
          ? t('testing')
          : probeState.kind === 'ok'
            ? t('probeOk').replace('{count}', String(probeState.count))
            : t('probeFailed').replace('{message}', probeState.message)}
      </span>
    )

  return (
    <div className={styles['editor']}>
      <div className={styles['editorHeader']}>
        <span className={styles['editorTitle']}>{stringField(draft, 'displayName') || route}</span>
        <span className={styles['editorRoute']}>{t('customTag')}</span>
        <span className={styles['headerSpacer']} />
        <button
          type="button"
          className={styles['dangerButton']}
          disabled={props.readOnly || busy}
          onClick={props.onRequestDelete}
        >
          {t('remove')}
        </button>
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('routeLabel')}</span>
        <input
          className={styles['input']}
          type="text"
          value={route}
          readOnly
          aria-label={t('routeLabel')}
          aria-readonly="true"
        />
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('displayName')}</span>
        <input
          className={styles['input']}
          type="text"
          value={stringField(draft, 'displayName')}
          placeholder={route}
          aria-label={t('displayName')}
          disabled={disabled}
          onChange={(event) => { setField('displayName', event.target.value) }}
        />
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
        <input
          className={styles['input']}
          type="text"
          value={baseURL}
          placeholder="https://gateway.example/v1"
          aria-label={t('baseUrl')}
          aria-invalid={urlFailure !== undefined}
          disabled={disabled}
          onChange={(event) => { setField('baseURL', event.target.value) }}
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
            placeholder={keyLocked
              ? t('keyEnvLocked')
              : keyState?.configured === true ? t('keyStored') : t('keyPlaceholder')}
            aria-label={t('keyInput')}
            aria-invalid={keyFailure !== undefined}
            disabled={disabled || keyLocked}
            onChange={(event) => { setKeyDraft(event.target.value) }}
          />
          <KeyVisibilityToggle
            revealed={reveal}
            disabled={disabled || keyLocked}
            label={reveal ? t('hideKey') : t('showKey')}
            onToggle={() => { setReveal(current => !current) }}
          />
        </div>
        {keyFailure === undefined ? null : <p className={styles['error']}>{t(keyFailure)}</p>}
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('apiFormat')}</span>
        <ProtocolCards
          protocols={protocols}
          value={stringField(draft, 'api')}
          onChange={(protocol) => { setField('api', protocol) }}
          disabled={disabled}
          label={t('apiFormat')}
        />
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('headers')}</span>
        <textarea
          className={styles['input']}
          rows={3}
          value={headersText}
          placeholder={'X-Request-Id: abc123\n# comment line'}
          aria-label={t('headers')}
          aria-invalid={headersFailure !== undefined}
          disabled={disabled}
          onChange={(event) => { setField('headersText', event.target.value) }}
        />
        <p className={styles['advancedHint']}>{t('headersHint')}</p>
        {headersFailure === undefined ? null : <p className={styles['error']}>{headersFailure}</p>}
      </div>
      <section className={styles['modelCatalog']} aria-label={t('modelsLabel')}>
        <div className={styles['modelListHead']}>
          <span className={styles['modelCatalogTitle']}>{t('modelsLabel')}</span>
          {models.length === 0 ? <span className={styles['advancedHint']}>{t('modelsNeedOne')}</span> : null}
        </div>
        {models.map((model, index) => (
          <div key={model.id} className={styles['modelEntry']}>
            <div className={styles['wizardModelRow']}>
              <span className={styles['wizardModelId']}>{model.id}</span>
              {index === 0
                ? <span className={styles['defaultModelTag']}>{t('defaultModel')}</span>
                : null}
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
                aria-label={`${t('editModel')} ${String(index + 1)}`}
                disabled={disabled}
                onClick={() => { setModelDialog({ mode: 'edit', index }) }}
              >
                {t('editModel')}
              </button>
              <button
                type="button"
                className={styles['linkButton']}
                aria-label={`${t('removeModel')} ${String(index + 1)}`}
                disabled={disabled}
                onClick={() => { removeModelAt(index) }}
              >
                {t('remove')}
              </button>
            </div>
          </div>
        ))}
        {modelDialog === undefined
          ? (
            <button
              type="button"
              className={styles['addModelButton']}
              disabled={disabled}
              onClick={() => { setModelDialog({ mode: 'add' }) }}
            >
              {t('addModel')}
            </button>
          )
          : (
            <ModelDialog
              t={t}
              label={modelDialog.mode === 'edit' ? t('editModel') : t('addModel')}
              existing={modelDialog.mode === 'edit'
                ? models.filter((_entry, at) => at !== modelDialog.index).map(entry => entry.id)
                : models.map(entry => entry.id)}
              {...(modelDialog.mode === 'edit' ? { initial: models[modelDialog.index] } : {})}
              disabled={disabled}
              onSave={commitModel}
              onCancel={() => { setModelDialog(undefined) }}
            />
          )}
      </section>
      <div className={styles['testRow']}>
        <button
          type="button"
          className={styles['secondaryButton']}
          disabled={disabled || probeBaseURL === undefined}
          onClick={() => { void test() }}
        >
          {probeState.kind === 'busy' ? t('testing') : t('testConnection')}
        </button>
        {statusLine}
      </div>
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      <EditorFooter
        hint={t('keyHint')}
        busy={busy}
        submitDisabled={submitBlocked}
        submitLabel={t('apply')}
        submitBusyLabel={t('applying')}
        onSubmit={() => { void apply() }}
      />
    </div>
  )
}
