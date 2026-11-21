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

/** zh phase labels for the attempt line. */
const PHASE_LABELS: Record<AttemptPhase, string> = {
  initializing: '初始化中…',
  'waiting-browser': '等待浏览器授权…',
  exchanging: '交换凭据中…',
  committing: '提交凭据中…',
  succeeded: '登录成功',
  cancelled: '已取消',
  expired: '已过期',
  failed: '失败',
}

/** zh labels for the platform error codes the Host reports. */
const ERROR_LABELS: Record<string, string> = {
  'no-response': '网络无响应',
  network: '网络失败',
  protocol: '协议错误（授权被平台拒绝）',
  expired: '授权超时',
  storage: '本地凭据存取失败',
}

/**
 * Render the DeepSeek account section.
 * @returns the section body.
 */
export function AccountCard(): JSX.Element {
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
      setError(outcome.error?.message ?? '读取账号状态失败')
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
      setError(outcome.error?.message ?? '发起登录失败')
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
      setError(outcome.error?.message ?? '取消登录失败')
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
      setError(outcome.error?.message ?? '退出登录失败')
      return
    }
    void refresh()
  }, [refresh])

  const signedIn = view?.status === 'credential-stored'
  const attempt = view?.attempt ?? null
  const cancellable = attempt !== null && ['initializing', 'waiting-browser'].includes(attempt.phase)

  return (
    <div className="dshx-acct">
      <div className="dshx-acct-head">
        <span className="dshx-acct-title">DeepSeek 账号</span>
        <span className="dshx-acct-sub">用账号登录替代 API Key（官方模型路由）</span>
      </div>
      {error !== '' && <div className="dshx-acct-error">{error}</div>}
      <div className="dshx-acct-row">
        {signedIn
          ? <Badge variant="soft" size="sm" className="dshx-acct-chip is-ok">已登录</Badge>
          : <Badge variant="soft" size="sm" className="dshx-acct-chip is-empty">未登录</Badge>}
        <div className="dshx-acct-ops">
          {!signedIn && <Button size="sm" disabled={busy} onClick={() => { void startSignIn() }}>
            {attempt !== null && attempt.phase !== 'succeeded' ? '继续登录' : '登录'}
          </Button>}
          {cancellable && attempt !== null && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void cancelSignIn(attempt.id) }}>取消</Button>
          )}
          {signedIn && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void signOut() }}>退出登录</Button>}
        </div>
      </div>
      {attempt !== null && (
        <div className={`dshx-acct-attempt ${attempt.phase === 'failed' ? 'is-bad' : ''}`}>
          {PHASE_LABELS[attempt.phase] ?? attempt.phase}
          {attempt.phase === 'failed' && attempt.errorCode !== undefined && `：${ERROR_LABELS[attempt.errorCode] ?? attempt.errorCode}`}
        </div>
      )}
      {signedIn && <div className="dshx-acct-hint">账号凭据已存入本机——官方 DeepSeek 模型路由可直接使用。</div>}
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
