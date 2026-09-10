/**
 * Right-pane form for one official preset route (the DeepSeek row first): a
 * single write-only API-key input backed by `credentials.set`, plus the
 * availability probe. Base URL and model-catalog overrides stay owned by
 * `settings.yaml`; this page only manages what the credential seam owns, which
 * is the one thing the launch UI can never read back. The probe asks the
 * endpoint the row names (the public endpoint unless a deployment overrode
 * it), so a green verdict is real connectivity and authentication rather than
 * the adapter registry echoing its static catalog.
 *
 * A preset that needs no key (the keyless Ollama route) renders the keyless
 * panel: the endpoint facts stay visible, the probe still works, and no key
 * field or commit footer appears because there is nothing to store.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CredentialView, IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { apiKeyFailure } from './apiKey.ts'
import { EditorFooter } from './EditorFooter.tsx'
import { KeyVisibilityToggle } from './KeyVisibilityToggle.tsx'
import { useEndpointProbe } from './probe.ts'
import type { ProbeSummary } from './probe.ts'
import { messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The public DeepSeek endpoint, used when no settings join overrides it. */
const DEEPSEEK_PUBLIC_BASE_URL = 'https://api.deepseek.com'

/** Props of {@link DeepSeekPanel}. */
export interface DeepSeekPanelProps {
  /** Wire face for the credential write and the endpoint probe. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /**
   * Credential reference the typed key stores under (e.g. `DEEPSEEK_API_KEY`).
   * Absent = keyless preset: the panel stores nothing and shows no key field.
   */
  credentialRef?: string
  /** Human-facing provider name; defaults to DeepSeek. */
  displayName?: string
  /** Endpoint the probe asks; defaults to the public DeepSeek one. */
  baseURL?: string
  /** Wire protocol the endpoint speaks; defaults to `openai`. */
  protocol?: 'openai' | 'anthropic'
  /**
   * The preset route id (e.g. `deepseek`, `openai`, `ollama`). The host's
   * probe keys its stored-credential fallback on it: an empty key field then
   * verifies the already-stored key instead of probing without auth.
   */
  provider?: string
  /** Report a settled probe verdict so the rail dot can follow it. */
  reportProbe: (summary: ProbeSummary | undefined) => void
  /** Notify the page that a key was stored, so joins refresh. */
  onSaved: () => void
}

/**
 * Render the official-provider panel.
 * @param props - wire faces, copy, the managed reference, and callbacks.
 * @returns the panel.
 */
export function DeepSeekPanel(props: DeepSeekPanelProps): ReactNode {
  const { api, t, credentialRef, displayName, baseURL, protocol, provider } = props
  const keyless = credentialRef === undefined
  const [keyDraft, setKeyDraft] = useState('')
  // Local-only: whether the key field renders as text instead of password.
  const [reveal, setReveal] = useState(false)
  const [keyState, setKeyState] = useState<CredentialView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [probeState, runProbe] = useEndpointProbe(api)

  useEffect(() => {
    if (credentialRef === undefined) return
    let stale = false
    void api.credentials.describe({ refs: [credentialRef] }).then(
      (response) => {
        if (!stale && response.result.ok) setKeyState(response.result.value.credentials[credentialRef])
      },
      () => undefined,
    )
    return () => { stale = true }
  }, [api.credentials, credentialRef])

  const keyValue = keyDraft.trim()
  const keyFailure = apiKeyFailure(keyDraft)
  const locked = keyState?.writable === false
  const disabled = props.readOnly || busy
  const probeBaseURL = baseURL ?? DEEPSEEK_PUBLIC_BASE_URL

  const save = async (): Promise<void> => {
    // The commit button only renders on a keyed panel, so the reference is set.
    const ref = credentialRef as string
    setBusy(true)
    setFailure(undefined)
    try {
      const stored = await api.credentials.set({ ref, value: keyValue })
      if (!stored.result.ok) {
        setFailure(stored.result.error.message)
        return
      }
      setKeyDraft('')
      props.onSaved()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const test = async (): Promise<void> => {
    const summary = await runProbe({
      settingsNs: 'llm-deepseek',
      ...(provider === undefined ? {} : { provider }),
      baseURL: probeBaseURL,
      api: protocol ?? 'openai',
      // An empty key probes the preset's stored credential: the host falls
      // back on `provider`, so a saved route verifies without re-typing.
      ...(keyValue.length > 0 ? { apiKey: keyValue } : {}),
    })
    props.reportProbe(summary)
  }

  return (
    <div className={styles['editor']}>
      <div className={styles['editorHeader']}>
        <span className={styles['editorTitle']}>{displayName ?? 'DeepSeek'}</span>
        <span className={styles['editorRoute']}>{t('officialTag')}</span>
      </div>
      <p className={styles['intro']}>{t('officialIntro')}</p>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
        <input
          className={styles['input']}
          type="text"
          value={probeBaseURL}
          readOnly
          aria-label={t('baseUrl')}
          aria-readonly="true"
        />
      </div>
      {keyless
        ? <p className={styles['statusLine']} role="status">{t('keylessProvider')}</p>
        : (
          <div className={styles['field']}>
            <span className={styles['fieldLabel']}>{t('keyInput')}</span>
            <div className={styles['keyRow']}>
              <input
                className={styles['input']}
                type={reveal ? 'text' : 'password'}
                autoComplete="off"
                value={keyDraft}
                placeholder={locked
                  ? t('keyEnvLocked')
                  : keyState?.configured === true ? t('keyStored') : t('keyPlaceholder')}
                aria-label={t('keyInput')}
                aria-invalid={keyFailure !== undefined}
                disabled={disabled || locked}
                onChange={(event) => { setKeyDraft(event.target.value) }}
              />
              <KeyVisibilityToggle
                revealed={reveal}
                disabled={disabled || locked}
                label={reveal ? t('hideKey') : t('showKey')}
                onToggle={() => { setReveal(current => !current) }}
              />
            </div>
            {keyFailure === undefined ? null : <p className={styles['error']}>{t(keyFailure)}</p>}
          </div>
        )}
      {/* The probe mutates nothing, so its button stays enabled whatever the
          commit gates say; the verdict renders beside it and paints the rail
          dot through `reportProbe`. An empty key field is allowed too: the
          host answers with the preset's stored credential (a keyed panel with
          nothing stored fails loudly). A keyless preset probes with no key,
          and a malformed draft is still refused before any round trip. */}
      <div className={styles['testRow']}>
        <button
          type="button"
          className={styles['secondaryButton']}
          disabled={disabled || (!keyless && keyFailure !== undefined)}
          onClick={() => { void test() }}
        >
          {probeState.kind === 'busy' ? t('testing') : t('testConnection')}
        </button>
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
              : probeState.kind === 'failed'
                ? t('probeFailed').replace('{message}', probeState.message)
                : null}
        </span>
      </div>
      {keyless
        ? null
        : (
          <>
            {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
            <EditorFooter
              hint={t('keyHint')}
              busy={busy}
              submitDisabled={disabled || locked || keyValue.length === 0 || keyFailure !== undefined}
              submitLabel={t('apply')}
              submitBusyLabel={t('applying')}
              onSubmit={() => { void save() }}
            />
          </>
        )}
    </div>
  )
}
