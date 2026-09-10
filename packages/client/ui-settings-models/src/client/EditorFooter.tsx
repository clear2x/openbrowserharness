/**
 * The action row every panel ends with, in the ZCode layout: the hint (or
 * destructive action) on the left, commit on the right.
 *
 * The panels commit different things — one creates a route, one edits a
 * profile, one stores a credential — but the row itself carries no such
 * knowledge. It renders what it is handed, so panels keep sole ownership of
 * when a commit is allowed and what the in-flight wording is.
 *
 * Cancel refuses input only while a commit is in flight, never because the
 * panel is disabled: a panel the deployment cannot write to must still be
 * dismissable.
 *
 * @module dsh-client-ui-settings-models/client/EditorFooter
 */

import type { ReactNode } from 'react'
import styles from './ModelsSection.module.css'

/** Props of {@link EditorFooter}. */
export interface EditorFooterProps {
  /** Content of the left seat: a muted usage hint or an extra action. */
  hint?: ReactNode
  /** Whether a commit is in flight; holds Cancel and swaps the commit label. */
  busy: boolean
  /** Whether the commit is refused, as judged by the owning panel. */
  submitDisabled: boolean
  /** Commit label while idle. */
  submitLabel?: string
  /** Commit label while a commit is in flight. */
  submitBusyLabel?: string
  /** Dismiss label; defaults to the settings editor copy. */
  cancelLabel?: ReactNode
  /** Dismiss the panel without committing. */
  onCancel?: () => void
  /** Run the panel's commit. */
  onSubmit?: () => void
}

/**
 * Render one provider panel's hint-and-action row.
 * @param props - the labels, commit gating, and handlers the owning panel supplies.
 * @returns the footer row.
 */
export function EditorFooter(props: EditorFooterProps): ReactNode {
  return (
    <div className={styles['editorActions']}>
      <span className={styles['editorHint']}>{props.hint}</span>
      <span className={styles['editorActionButtons']}>
        {props.onCancel === undefined || props.cancelLabel === undefined
          ? null
          : (
            <button
              type="button"
              className={styles['secondaryButton']}
              disabled={props.busy}
              onClick={props.onCancel}
            >
              {props.cancelLabel}
            </button>
          )}
        {props.onSubmit === undefined
          ? null
          : (
            <button
              type="button"
              className={styles['primaryButton']}
              disabled={props.submitDisabled}
              onClick={props.onSubmit}
            >
              {props.busy ? props.submitBusyLabel ?? '' : props.submitLabel ?? ''}
            </button>
          )}
      </span>
    </div>
  )
}
