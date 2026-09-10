/**
 * Show/hide toggle for a secret key field, shared by the official-provider
 * panel, the custom-route panel, and the add-supplier wizard. The toggle flips
 * the sibling input between `type="password"` and `type="text"`; the reveal
 * state is local component state and never persists. The shared icon set
 * carries no eye glyph, so this module owns a minimal stroke pair.
 */

import type { ReactNode } from 'react'
import styles from './ModelsSection.module.css'

/** Props of {@link KeyVisibilityToggle}. */
export interface KeyVisibilityToggleProps {
  /** Whether the sibling input currently renders as text (revealed). */
  revealed: boolean
  /** Localized accessible name: 显示密钥 while masked, 隐藏密钥 while revealed. */
  label: string
  /** Disable the toggle together with the input it flips. */
  disabled: boolean
  /** Flip the reveal state. */
  onToggle: () => void
}

/**
 * Render the eye toggle button. The open eye offers to reveal a masked key;
 * the slashed eye offers to mask a revealed one.
 * @param props - the reveal state, its label, and the flip callback.
 * @returns the toggle button.
 */
export function KeyVisibilityToggle(props: KeyVisibilityToggleProps): ReactNode {
  const { revealed, label, disabled, onToggle } = props
  return (
    <button
      type="button"
      className={styles['keyToggle']}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onToggle}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M1.5 8C1.5 8 4 3.5 8 3.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
        {revealed
          ? <path d="M2.5 13.5 13.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          : null}
      </svg>
    </button>
  )
}
