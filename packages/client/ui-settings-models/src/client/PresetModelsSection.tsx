/**
 * User-added model rows for one OFFICIAL preset provider. The shipped preset
 * catalog is code (`llm-providers`), but providers keep releasing models
 * between extension updates; this section CAS-writes rows into the generic
 * `llm-preset-models` settings namespace ({ models: { <provider>: rows } })
 * and the engine merges them into the adapter catalog at read time — the
 * composer's model menu and the route resolution see them immediately, no
 * reload. Rows render with the custom-route panel's affordances (add/edit
 * dialog, delete link, default tag on nothing — the preset's own first row
 * stays the default).
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { ModelDialog } from './ModelDialog.tsx'
import type { DraftModel } from './NewProviderPanel.tsx'
import { messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The generic namespace the bridge serves user preset models through. */
const PRESET_MODELS_NS = 'llm-preset-models'

/** Props of {@link PresetModelsSection}. */
export interface PresetModelsSectionProps {
  /** Wire face for the namespace CAS write. */
  api: Pick<IApiClient, 'settings'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** The official preset route whose rows this section edits. */
  provider: string
  /** The `llm-preset-models` namespace view, when the describe carried one. */
  namespace?: SettingsNamespaceView
  /** Notify the page that rows changed, so joins refresh. */
  onSaved: () => void
}

/** Parse one provider's rows out of the namespace value. */
function rowsOf(namespace: SettingsNamespaceView | undefined, provider: string): DraftModel[] {
  const value = namespace?.value as Record<string, unknown> | undefined
  const models = value?.models
  if (models === null || typeof models !== 'object' || Array.isArray(models)) return []
  const rows = (models as Record<string, unknown>)[provider]
  if (!Array.isArray(rows)) return []
  return rows.filter((row): row is DraftModel =>
    row !== null && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string')
}

type ModelDialogState = { mode: 'add' } | { mode: 'edit'; index: number }

/**
 * Render the user-added model section for one official provider.
 * @param props - wire faces, copy, the preset id, and the namespace view.
 * @returns the section.
 */
export function PresetModelsSection(props: PresetModelsSectionProps): ReactNode {
  const { api, t, readOnly, provider, namespace } = props
  const disabled = readOnly
  const [dialog, setDialog] = useState<ModelDialogState | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const rows = rowsOf(namespace, provider)

  // A describe refresh (join/onSaved) can swap the namespace under an open
  // dialog; drop the dialog when its row vanished.
  useEffect(() => {
    if (dialog?.mode === 'edit' && rows[dialog.index] === undefined) setDialog(undefined)
  }, [rows, dialog])

  /** CAS-write the provider's full row list (unset when emptied). */
  const commit = async (next: DraftModel[]): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      // An absent namespace starts at revision 0 (the bridge materializes it
      // on first write), so the first add needs no prior describe.
      const ops = next.length === 0
        ? [{ op: 'unset' as const, path: ['models', provider] }]
        : [{ op: 'set' as const, path: ['models', provider], value: next }]
      const response = await api.settings.mutate({
        ns: PRESET_MODELS_NS,
        ops,
        expectedRevision: namespace?.revision ?? 0,
      })
      if (!response.result.ok) {
        setFailure(response.result.error.code === 'settings-conflict'
          ? t('conflict')
          : response.result.error.message)
        return
      }
      props.onSaved()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const commitModel = (model: DraftModel): void => {
    if (dialog === undefined) return
    const next = dialog.mode === 'edit'
      ? rows.map((entry, index) => index === dialog.index ? model : entry)
      : [...rows, model]
    setDialog(undefined)
    void commit(next)
  }

  return (
    <section className={styles['modelCatalog']} aria-label={t('modelsLabel')}>
      <div className={styles['modelListHead']}>
        <span className={styles['modelCatalogTitle']}>{t('modelsLabel')}</span>
        {rows.length === 0 ? <span className={styles['advancedHint']}>{t('modelsUserHint')}</span> : null}
      </div>
      {rows.map((model, index) => (
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
              aria-label={`${t('editModel')} ${String(index + 1)}`}
              disabled={disabled || busy}
              onClick={() => { setDialog({ mode: 'edit', index }) }}
            >
              {t('editModel')}
            </button>
            <button
              type="button"
              className={styles['linkButton']}
              aria-label={`${t('removeModel')} ${String(index + 1)}`}
              disabled={disabled || busy}
              onClick={() => { void commit(rows.filter((_entry, at) => at !== index)) }}
            >
              {t('remove')}
            </button>
          </div>
        </div>
      ))}
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      {dialog === undefined
        ? (
          <button
            type="button"
            className={styles['addModelButton']}
            disabled={disabled || busy}
            onClick={() => { setDialog({ mode: 'add' }) }}
          >
            {t('addModel')}
          </button>
        )
        : (
          <ModelDialog
            t={t}
            label={dialog.mode === 'edit' ? t('editModel') : t('addModel')}
            existing={dialog.mode === 'edit'
              ? rows.filter((_entry, at) => at !== dialog.index).map(entry => entry.id)
              : rows.map(entry => entry.id)}
            {...(dialog.mode === 'edit' ? { initial: rows[dialog.index] } : {})}
            disabled={disabled}
            onSave={commitModel}
            onCancel={() => { setDialog(undefined) }}
          />
        )}
    </section>
  )
}
