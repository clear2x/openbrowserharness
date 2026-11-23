/**
 * `AccountCard`: the 用户插件 panel's DeepSeek account section — the
 * panel-side consumer of the `account.*` RPC family. Signing in uses the
 * platform's browser OAuth: `account.startSignIn` returns an authorize URL,
 * the card opens it in a new tab, and the platform redirects back through
 * the extension's loopback intercept (see shared/protocol.ts) into the
 * engine's account host, which exchanges the code for the stored grant.
 *
 * Data flow: `account.state` polls every 5 s while mounted; the attempt line
 * renders the active sign-in's phase so the wait for browser approval has
 * visible progress, and 取消 aborts the attempt while it is cancellable.
 *
 * @module account-card
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { rpc } from './rpc-client.ts'
import { shellT, useShellT } from './locales/index.ts'
import type { ShellLocaleKey } from './locales/index.ts'

/** Client-safe account state (the `account.state` value). */
interface AccountView {
  /** Credential presence; not a claim the server validated the token. */
  status: 'signed-out' | 'credential-stored'
  /** Active/latest sign-in attempt, null when none. */
  attempt: {
    id: string
    phase: 'initializing' | 'waiting-browser' | 'exchanging' | 'committing' | 'succeeded' | 'cancelled' | 'expired' | 'failed'
    authorizeUrl?: string
    errorCode?: string
  } | null
}

/** One sign-in attempt lifecycle phase. */
type AttemptPhase = NonNullable<AccountView['attempt']>['phase']

/** Dictionary keys for the attempt line, per sign-in attempt phase. */
const PHASE_LABEL_KEYS: Record<AttemptPhase, ShellLocaleKey> = {
  initializing: 'account.phase.initializing',
  'waiting-browser': 'account.phase.waitingBrowser',
  exchanging: 'account.phase.exchanging',
  committing: 'account.phase.committing',
  succeeded: 'account.phase.succeeded',
  cancelled: 'account.phase.cancelled',
  expired: 'account.phase.expired',
  failed: 'shell.transcript.failed',
}

/** Dictionary keys for the platform error codes the Host reports. */
const ERROR_LABEL_KEYS: Record<string, ShellLocaleKey> = {
  'no-response': 'account.error.noResponse',
  network: 'account.error.network',
  protocol: 'account.error.protocol',
  expired: 'account.error.expired',
  storage: 'account.error.storage',
}

/**
 * Render the DeepSeek account section.
 * @returns the section body.
 */
export function AccountCard(): JSX.Element {
  const t = useShellT()
  const [view, setView] = useState<AccountView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const outcome = await rpc('account.state', {}, 15_000)
    if (!mounted.current) return
    if (outcome.ok) {
      setView((outcome.value ?? null) as AccountView | null)
      setError('')
    } else {
      setError(outcome.error?.message ?? shellT()('account.error.readFailed'))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5_000)
    return () => { clearInterval(timer) }
  }, [refresh])

  /**
   * Start browser sign-in and open the authorize page in a new tab. The Host
   * answers startSignIn with the attempt still `initializing` — the authorize
   * URL exists only from the `waiting-browser` phase (the platform auth_init
   * roundtrip) — so the open rides a short poll on account.state instead of
   * the startSignIn payload. The 5s state timer keeps the phase line fresh
   * either way.
   */
  const startSignIn = useCallback(async (): Promise<void> => {
    setBusy(true)
    const outcome = await rpc('account.startSignIn', { locale: navigator.language || 'zh' }, 30_000)
    if (!mounted.current) return
    if (!outcome.ok) {
      setBusy(false)
      setError(outcome.error?.message ?? shellT()('account.error.startFailed'))
      return
    }
    for (let tick = 0; tick < 30; tick++) {
      await new Promise((resolve) => { setTimeout(resolve, 1000) })
      if (!mounted.current) return
      const state = await rpc('account.state', {}, 15_000)
      if (!state.ok) continue
      const view = (state.value ?? null) as AccountView | null
      setView(view)
      setError('')
      const attempt = view?.attempt ?? null
      // Any settled phase (and a vanished attempt) ends the wait; the URL
      // opens exactly once, from the phase that first carries it.
      if (attempt === null || attempt.phase !== 'initializing') {
        if (attempt?.phase === 'waiting-browser' && typeof attempt.authorizeUrl === 'string' && attempt.authorizeUrl !== '') {
          void chrome.tabs.create({ url: attempt.authorizeUrl })
        }
        break
      }
    }
    if (mounted.current) setBusy(false)
  }, [])

  /** Cancel the active attempt (the browser tab can stay open harmlessly). */
  const cancelSignIn = useCallback(async (attemptId: string): Promise<void> => {
    setBusy(true)
    const outcome = await rpc('account.cancelSignIn', { attemptId }, 30_000)
    setBusy(false)
    if (!mounted.current) return
    if (!outcome.ok) {
      setError(outcome.error?.message ?? shellT()('account.error.cancelFailed'))
      return
    }
    void refresh()
  }, [refresh])

  /** Remove the stored grant. */
  const signOut = useCallback(async (): Promise<void> => {
    setBusy(true)
    const outcome = await rpc('account.signOut', { locale: navigator.language || 'zh' }, 60_000)
    setBusy(false)
    if (!mounted.current) return
    if (!outcome.ok) {
      setError(outcome.error?.message ?? shellT()('account.error.signOutFailed'))
      return
    }
    void refresh()
  }, [refresh])

  const signedIn = view?.status === 'credential-stored'
  const attempt = view?.attempt ?? null
  const cancellable = attempt !== null && ['initializing', 'waiting-browser'].includes(attempt.phase)
  // The phase and the error code arrive over the wire: a value outside its
  // table renders raw.
  const phaseKey = attempt === null ? undefined : PHASE_LABEL_KEYS[attempt.phase]
  const errorKey = attempt === null || attempt.errorCode === undefined ? undefined : ERROR_LABEL_KEYS[attempt.errorCode]

  return (
    <div className="dshx-acct">
      <div className="dshx-acct-head">
        <span className="dshx-acct-title">{t('account.title')}</span>
        <span className="dshx-acct-sub">{t('account.subtitle')}</span>
      </div>
      {error !== '' && <div className="dshx-acct-error">{error}</div>}
      <div className="dshx-acct-row">
        {signedIn
          ? <Badge variant="soft" size="sm" className="dshx-acct-chip is-ok">{t('account.signedInBadge')}</Badge>
          : <Badge variant="soft" size="sm" className="dshx-acct-chip is-empty">{t('account.signedOutBadge')}</Badge>}
        <div className="dshx-acct-ops">
          {!signedIn && <Button size="sm" disabled={busy} onClick={() => { void startSignIn() }}>
            {attempt !== null && attempt.phase !== 'succeeded' ? t('account.continueSignIn') : t('account.signIn')}
          </Button>}
          {cancellable && attempt !== null && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void cancelSignIn(attempt.id) }}>{t('shell.common.cancel')}</Button>
          )}
          {signedIn && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void signOut() }}>{t('account.signOut')}</Button>}
        </div>
      </div>
      {attempt !== null && (
        <div className={`dshx-acct-attempt ${attempt.phase === 'failed' ? 'is-bad' : ''}`}>
          {phaseKey === undefined ? attempt.phase : t(phaseKey)}
          {attempt.phase === 'failed' && attempt.errorCode !== undefined
            && t('account.errorSuffix', { reason: errorKey === undefined ? attempt.errorCode : t(errorKey) })}
        </div>
      )}
      {signedIn && <div className="dshx-acct-hint">{t('account.hint')}</div>}
    </div>
  )
}

/** Section styles, injected by the shell's stylesheet bundle. */
export const ACCOUNT_CARD_CSS = `
.dshx-acct { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.03)); }
.dshx-acct-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dshx-acct-title { font-weight: 600; font-size: 13px; }
.dshx-acct-sub { font-size: 11px; opacity: 0.55; }
.dshx-acct-error { font-size: 12px; color: #f87171; }
.dshx-acct-row { display: flex; align-items: center; gap: 8px; }
.dshx-acct-chip.is-ok { color: #4ade80; }
.dshx-acct-chip.is-empty { opacity: 0.6; }
.dshx-acct-ops { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.dshx-acct-attempt { font-size: 12px; opacity: 0.75; }
.dshx-acct-attempt.is-bad { color: #f87171; opacity: 1; }
.dshx-acct-hint { font-size: 11px; opacity: 0.55; }
`
