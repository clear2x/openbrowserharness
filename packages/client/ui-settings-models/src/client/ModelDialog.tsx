/**
 * The inline model mini-dialog shared by the add-supplier wizard and the
 * declared-route editor: model id, context window, max output tokens, and the
 * modality toggles — judged on save, nothing writes until the owner commits
 * the draft into its own pending list. Text input is the engine's checked
 * floor and stays locked; only a declared image input is worth storing, since
 * the engine reads absence as text-only.
 *
 * A fresh dialog opens with the same capacity defaults the engine's adapters
 * use; a dialog opened over an existing model prefills its stored values and
 * preserves the fields this dialog does not edit (the stored `name`, say).
 *
 * Smart config (ZCode port): after the model id settles for a beat, the
 * bundled rules knowledge base resolves a recommendation and fills any field
 * the user has not touched — a touched field keeps its value, so explicit
 * edits always outrank the knowledge base.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DraftModel } from './NewProviderPanel.tsx'
import type { en } from './locales.ts'
import { resolveModelRecommendation } from './model-rules.ts'
import styles from './ModelsSection.module.css'

/** Context window a fresh dialog opens with. */
const DEFAULT_MODEL_CONTEXT = '1000000'

/** Max output tokens a fresh dialog opens with. */
const DEFAULT_MODEL_MAX_TOKENS = '128000'

/** Idle delay after the last model-id keystroke before the rules resolve. */
const RESOLVE_IDLE_MS = 1200

/** How long the auto-filled feedback strip stays visible. */
const DETECTED_FEEDBACK_MS = 3500

/** Props of {@link ModelDialog}. */
export interface ModelDialogProps {
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Accessible label of the group, naming the action this dialog performs. */
  label: string
  /** Model ids already taken, which the draft must not duplicate. */
  existing: readonly string[]
  /** The model being edited, when the dialog opened over one. */
  initial?: DraftModel
  /** Wire protocol of the owning route, when known (refines api-gated rules). */
  apiType?: string
  /** Base URL of the owning route, when known (refines site-gated rules). */
  baseURL?: string
  /** Disable the controls (read-only settings provider). */
  disabled?: boolean
  /** Commit the judged draft. */
  onSave: (model: DraftModel) => void
  /** Discard the draft. */
  onCancel: () => void
}

/**
 * Render the inline model dialog.
 * @param props - copy, the group label, taken ids, the edited model, and callbacks.
 * @returns the dialog.
 */
export function ModelDialog(props: ModelDialogProps): ReactNode {
  const { t, label, existing, initial, disabled } = props
  const [modelId, setModelId] = useState(initial?.id ?? '')
  const [context, setContext] = useState(() => initial === undefined
    ? DEFAULT_MODEL_CONTEXT
    : initial.contextWindow === undefined ? '' : String(initial.contextWindow))
  const [maxTokens, setMaxTokens] = useState(() => initial === undefined
    ? DEFAULT_MODEL_MAX_TOKENS
    : initial.maxTokens === undefined ? '' : String(initial.maxTokens))
  const [image, setImage] = useState(initial?.input?.includes('image') === true)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // Which fields the user has edited: an untouched field keeps following the
  // knowledge base, a touched one is the user's explicit value and stops
  // auto-filling. Image tracks any toggle at all (on or off is explicit).
  const touched = useRef({ context: false, maxTokens: false, image: false })
  const [detected, setDetected] = useState(false)

  // Smart config: after the model id idles, resolve the bundled rules and
  // fill untouched fields. The resolution is a local synchronous fold, so the
  // debounce itself owns the race: each keystroke clears the previous timer
  // and only the settled id resolves.
  useEffect(() => {
    if (disabled || initial !== undefined) return undefined
    const id = modelId.trim()
    if (id === '') return undefined
    const timer = setTimeout(() => {
      const recommendation = resolveModelRecommendation({
        modelId: id,
        apiType: props.apiType,
        baseURL: props.baseURL,
      })
      if (recommendation === undefined) return
      if (recommendation.contextWindow !== undefined && !touched.current.context) {
        setContext(String(recommendation.contextWindow))
      }
      if (recommendation.maxTokens !== undefined && !touched.current.maxTokens) {
        setMaxTokens(String(recommendation.maxTokens))
      }
      if (recommendation.supportsImage === true && !touched.current.image) {
        setImage(true)
      }
      setDetected(true)
    }, RESOLVE_IDLE_MS)
    return () => { clearTimeout(timer) }
  }, [modelId, disabled, initial, props.apiType, props.baseURL])
  useEffect(() => {
    if (!detected) return undefined
    const clear = setTimeout(() => { setDetected(false) }, DETECTED_FEEDBACK_MS)
    return () => { clearTimeout(clear) }
  }, [detected])

  /** Judge the drafts field-locally, then commit the row into the pending list. */
  const save = (): void => {
    const id = modelId.trim()
    if (id.length === 0) {
      setFailure(t('modelIdRequired'))
      return
    }
    if (existing.includes(id)) {
      setFailure(t('modelIdDuplicate'))
      return
    }
    const contextText = context.trim()
    let contextWindow: number | undefined
    if (contextText.length > 0) {
      const parsed = Number(contextText)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setFailure(t('modelContextInvalid'))
        return
      }
      contextWindow = parsed
    }
    const maxTokensText = maxTokens.trim()
    let maxTokensValue: number | undefined
    if (maxTokensText.length > 0) {
      const parsed = Number(maxTokensText)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setFailure(t('modelMaxTokensInvalid'))
        return
      }
      maxTokensValue = parsed
    }
    // Editing keeps the stored row's untouched fields; cleared capacities
    // return the row to the engine-default inheritance.
    const draft: DraftModel = { ...(initial === undefined ? {} : initial), id }
    if (contextWindow === undefined) delete draft.contextWindow
    else draft.contextWindow = contextWindow
    if (maxTokensValue === undefined) delete draft.maxTokens
    else draft.maxTokens = maxTokensValue
    if (image) draft.input = ['text', 'image']
    else delete draft.input
    props.onSave(draft)
  }

  return (
    <div className={styles['modelDialog']} role="group" aria-label={label}>
      <div className={styles['modelDialogHeader']}>
        <span className={styles['modelDialogTitle']}>{label}</span>
        <button
          type="button"
          className={styles['modelDialogClose']}
          aria-label={t('close')}
          disabled={disabled}
          onClick={props.onCancel}
        >
          ×
        </button>
      </div>
      <div className={styles['modelDialogBody']}>
        <label className={styles['modelField']}>
          <span className={styles['modelFieldLabel']}>{t('modelId')}</span>
          <input
            className={styles['input']}
            type="text"
            value={modelId}
            placeholder={t('modelId')}
            aria-label={t('modelId')}
            autoFocus
            disabled={disabled}
            onChange={(event) => { setModelId(event.target.value) }}
          />
        </label>
        <div className={styles['modelDialogRow']}>
          <label className={styles['modelField']}>
            <span className={styles['modelFieldLabel']}>{t('contextWindow')}</span>
            <input
              className={styles['input']}
              type="text"
              inputMode="numeric"
              value={context}
              aria-label={t('contextWindow')}
              disabled={disabled}
              onChange={(event) => {
                touched.current.context = true
                setContext(event.target.value)
              }}
            />
          </label>
          <label className={styles['modelField']}>
            <span className={styles['modelFieldLabel']}>{t('maxOutputTokens')}</span>
            <input
              className={styles['input']}
              type="text"
              inputMode="numeric"
              value={maxTokens}
              aria-label={t('maxOutputTokens')}
              disabled={disabled}
              onChange={(event) => {
                touched.current.maxTokens = true
                setMaxTokens(event.target.value)
              }}
            />
          </label>
        </div>
        <div className={styles['modalityRow']}>
          <span className={styles['modelFieldLabel']}>{t('inputType')}</span>
          {/* Text input is the engine's floor: a checked, disabled chip whose
              lock glyph says the protocol fixed it. */}
          <label
            className={`${styles['modalityChip']} ${styles['modalityChipLocked']}`}
            title={t('modalityLocked')}
          >
            <input type="checkbox" checked disabled aria-label={`${t('inputType')} ${t('modalityText')}`} />
            <span aria-hidden="true" className={styles['modalityLock']}>🔒</span>
            {t('modalityText')}
          </label>
          <label className={styles['modalityChip']}>
            <input
              type="checkbox"
              checked={image}
              aria-label={`${t('inputType')} ${t('modalityImage')}`}
              disabled={disabled}
              onChange={(event) => {
                touched.current.image = true
                setImage(event.target.checked)
              }}
            />
            {t('modalityImage')}
          </label>
        </div>
        <div className={styles['modalityRow']}>
          <span className={styles['modelFieldLabel']}>{t('outputType')}</span>
          <label
            className={`${styles['modalityChip']} ${styles['modalityChipLocked']}`}
            title={t('modalityLocked')}
          >
            <input type="checkbox" checked disabled aria-label={`${t('outputType')} ${t('modalityText')}`} />
            <span aria-hidden="true" className={styles['modalityLock']}>🔒</span>
            {t('modalityText')}
          </label>
        </div>
      </div>
      {detected && <p className={styles['autoDetected']}>{t('autoDetectedHint')}</p>}
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      <div className={styles['modelDialogActions']}>
        <button type="button" className={styles['secondaryButton']} disabled={disabled} onClick={props.onCancel}>
          {t('cancel')}
        </button>
        <button type="button" className={styles['primaryButton']} disabled={disabled} onClick={save}>
          {t('apply')}
        </button>
      </div>
    </div>
  )
}
