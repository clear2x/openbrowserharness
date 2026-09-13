/**
 * Settings shell root: the sidebar-foot trigger row plus the settings
 * surface. The surface is one chrome in two forms (SettingsRoot.module.css
 * owns the breakpoint): over 768px of host width it is the centered modal
 * card on the mask; at ≤768px (extension SidePanel documents, where the
 * panel is the whole viewport) it bleeds full-size — no mask, no card
 * dressing — with the 36px tab band reading as a continuation of the shell
 * header above it. The shell is a pure composition face — every piece of
 * text (trigger label, panel title, close label, sections) arrives from
 * registrants through slots; accessible names resolve to that content
 * (trigger: its own text; dialog: aria-labelledby the visually-hidden title
 * node — the tab band is the visible wayfinding, so no second title row is
 * spent on it; close: visually-hidden slot text). Modal open state and the
 * active section id are component-local viewing state; the onboarding
 * coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact is active. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  ConnectionIndicator,
  IconAgentPresetOutline16, IconCloseOutline16, IconDataOutline16,
  IconPersonalizationOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionIndicatorState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

const RECOVERY_CONFIRMATION_MS = 2_000

/** Tab glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 className={css.tabIcon} size={14} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.tabIcon} size={14} />
  if (id === 'plugins') return <IconPersonalizationOutline16 className={css.tabIcon} size={14} />
  return <IconSettingsOutline16 className={css.tabIcon} size={14} />
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * The settings surface: full-viewport layer + the panel (modal card on wide
 * hosts, full-bleed sheet on narrow ones — the breakpoint lives in the
 * stylesheet). The topbar is one 36px band: the section tabs, the action
 * seat, and the single close control; the band is flex-pinned above the
 * scrolling options area, which is its sticky guarantee. Close paths: that
 * close button, a mask click (wide form only — the full-bleed sheet has no
 * mask), and document-level Escape (mounted only while open, so the listener
 * lifetime is the panel's).
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Baseline focus management: entering the dialog lands on the close button.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {/* The dialog's accessible name: the header seat text, visually
            hidden. The tabs carry the visible wayfinding, so the band spends
            no second row on a title. */}
        <div className={css.hiddenLabel} id={titleId}>{renderSlot('settings.header', {})}</div>
        <header className={css.topbar}>
          <nav className={css.tabs}>
            <div className={css.tabList}>
              {rows.map(row => (
                <button
                  key={row.id}
                  type="button"
                  className={clsx(css.tab, row.id === active && css.active)}
                  aria-current={row.id === active ? 'true' : undefined}
                  onClick={() => { onSelect(row.id) }}
                >
                  {navIcon(row.id)}
                  <span className={css.tabLabel}>{row.label}</span>
                </button>
              ))}
            </div>
          </nav>
          <div className={css.actions}>{renderSlot('settings.action', {})}</div>
          <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
            <IconCloseOutline16 size={14} />
            <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
          </button>
        </header>
        <div className={css.options}>
          {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
        </div>
      </div>
    </div>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const {
    wide, reconnect, useConnectionState, useSections, useOnboardingSteps, useSessions, renderSlot, t,
  } = props
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const [showRecovery, setShowRecovery] = useState(false)
  const triggerButton = useRef<HTMLButtonElement | null>(null)
  const wasOpen = useRef(open)
  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])
  // Restore after the close commit, when the dialog can no longer own focus.
  useEffect(() => {
    if (wasOpen.current && !open) triggerButton.current?.focus()
    wasOpen.current = open
  }, [open])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    setOpen(true)
  }, [])

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  const connectionState = useConnectionState(state => state)
  const previousConnectionState = useRef(connectionState)
  useLayoutEffect(() => {
    const previous = previousConnectionState.current
    previousConnectionState.current = connectionState
    if (connectionState !== 'connected') {
      setShowRecovery(false)
      return
    }
    if (previous !== 'disconnected' && previous !== 'connecting') return
    setShowRecovery(true)
    const timeout = window.setTimeout(() => { setShowRecovery(false) }, RECOVERY_CONFIRMATION_MS)
    return () => { window.clearTimeout(timeout) }
  }, [connectionState])

  let connectionIndicator: ConnectionIndicatorState | undefined
  if (connectionState === 'disconnected') {
    connectionIndicator = 'disconnected'
  } else if (connectionState === 'connecting') {
    connectionIndicator = 'connecting'
  } else if (showRecovery) {
    connectionIndicator = 'recovered'
  }

  return (
    <>
      <button
        ref={triggerButton}
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-label={t('trigger')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(true) }}
      >
        {renderSlot('settings.trigger', { wide })}
      </button>
      <ConnectionIndicator
        state={wide ? connectionIndicator : undefined}
        disconnectedLabel={t('connection.error')}
        reconnectLabel={t('connection.retry')}
        connectingLabel={t('connection.connecting')}
        recoveredLabel={t('connection.connected')}
        reconnectActionLabel={t('connection.reconnect')}
        restartActionLabel={t('connection.restart')}
        onReconnect={reconnect}
      />
      {open && (
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
        />
      )}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
