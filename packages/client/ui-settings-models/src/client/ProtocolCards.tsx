/**
 * The API-format chooser the ZCode-style provider form renders as selectable
 * cards, in the namespace schema's own declaration order:
 * `Anthropic Messages (/v1/messages)` for the native Messages wire,
 * `Chat Completions (/chat/completions)` for the OpenAI-compatible one, and
 * `Responses (/responses)` for the OpenAI Responses wire. The choices
 * themselves come from the owning namespace's own schema union, so what is
 * offered can never drift from what the adapters serve; a value the card has no
 * label for still renders (as its raw id) rather than disappearing from the
 * choice set.
 */

import type { ReactNode } from 'react'
import styles from './ModelsSection.module.css'

/** Display copy of one selectable format card. */
interface ProtocolCardCopy {
  /** Card title, e.g. `Chat Completions`. */
  title: string
  /** Endpoint fragment under the title, e.g. `/chat/completions`. */
  endpoint?: string
}

/**
 * Label a schema choice with its ZCode-surface wording, keyed by the engine's
 * protocol identifiers.
 */
const CARD_COPY: Readonly<Record<string, ProtocolCardCopy>> = {
  anthropic: { title: 'Anthropic Messages', endpoint: '/v1/messages' },
  openai: { title: 'Chat Completions', endpoint: '/chat/completions' },
  'openai-responses': { title: 'Responses', endpoint: '/responses' },
}

/** Props of {@link ProtocolCards}. */
export interface ProtocolCardsProps {
  /** Choices the namespace schema offers, in declaration order. */
  protocols: readonly string[]
  /** The chosen value, or '' while nothing is picked. */
  value: string
  /** Pick one value. */
  onChange: (protocol: string) => void
  /** Disable every card (read-only deployment or a pending write). */
  disabled: boolean
  /** Accessible name of the group. */
  label: string
}

/**
 * Render the protocol picker cards.
 * @param props - choices, current pick, change handler, and group name.
 * @returns the radio-style cards.
 */
export function ProtocolCards(props: ProtocolCardsProps): ReactNode {
  return (
    <div className={styles['protocolCards']} role="radiogroup" aria-label={props.label}>
      {props.protocols.map((protocol) => {
        const checked = props.value === protocol
        const copy = CARD_COPY[protocol] ?? { title: protocol }
        return (
          <button
            key={protocol}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={props.disabled}
            className={
              `${styles['protocolCard']} ${checked ? styles['protocolCardActive'] : ''}`.trim()
            }
            onClick={() => { if (!checked) props.onChange(protocol) }}
          >
            {/* The ✓ rides the title line, where every width has room; the
                endpoint line below stays clean, free to wrap inside a narrow
                card without stranding the verdict glyph. */}
            <span className={styles['protocolCardTitle']}>
              {checked ? '✓ ' : ''}
              {copy.title}
            </span>
            {copy.endpoint === undefined
              ? null
              : <span className={styles['protocolCardEndpoint']}>{copy.endpoint}</span>}
          </button>
        )
      })}
    </div>
  )
}
