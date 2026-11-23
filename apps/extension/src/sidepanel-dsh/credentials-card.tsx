/**
 * `CredentialsCard`: the 用户插件 panel's credential vault section — the
 * panel-side consumer of the `credentials.*` RPC family. MCP 服务器 headers
 * reference these values through `${credential:REF}` templates; this card is
 * where the user stores the values those templates name (a token for a
 * GitHub MCP server, an API key for a paid endpoint) without developer
 * tools.
 *
 * Layout: a roster of reference rows (name, configured chip) with per-row
 * 写入/删除 actions and a store form (reference name + value). Values are
 * write-only from the panel: the roster reads names and configured flags —
 * stored values never leave the engine.
 *
 * Data flow: `credentials.listRefs` polls every 8 s while mounted; writes go
 * through `credentials.set`/`credentials.unset`, which fan out the
 * `credentials/reference-updated` event the MCP clients observe for
 * reconnection.
 *
 * @module credentials-card
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { rpc } from './rpc-client.ts'
import { shellT, useShellT } from './locales/index.ts'

/** One row of `credentials.listRefs`. */
interface CredentialRefView {
  /** The UPPERCASE_SNAKE reference name. */
  ref: string
  /** Whether a non-empty value is stored. */
  configured: boolean
}

/** The store form fields. */
interface CredentialForm {
  ref: string
  value: string
}

const EMPTY_FORM: CredentialForm = { ref: '', value: '' }

/**
 * Render the credential vault section.
 * @returns the section body.
 */
export function CredentialsCard(): JSX.Element {
  const t = useShellT()
  const [refs, setRefs] = useState<CredentialRefView[] | null>(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState<CredentialForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  /** Read the reference census once; polling re-calls this. */
  const refresh = useCallback(async (): Promise<void> => {
    const outcome = await rpc('credentials.listRefs', {}, 15_000)
    if (!mounted.current) return
    if (outcome.ok) {
      const rows = (outcome.value as { refs?: unknown } | undefined)?.refs
      setRefs(Array.isArray(rows) ? rows as CredentialRefView[] : [])
      setError('')
    } else {
      setError(outcome.error?.message ?? shellT()('credentials.readFailed'))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 8_000)
    return () => { clearInterval(timer) }
  }, [refresh])

  /** Store (or overwrite) one reference value; MCP clients reconnect on the event. */
  const storeValue = useCallback(async (): Promise<void> => {
    const ref = form.ref.trim()
    if (!/^[A-Z][A-Z0-9_]*$/.test(ref)) {
      setError(shellT()('credentials.nameInvalid'))
      return
    }
    if (form.value === '') {
      setError(shellT()('credentials.valueRequired'))
      return
    }
    setBusy(true)
    const outcome = await rpc('credentials.set', { ref, value: form.value }, 30_000)
    setBusy(false)
    if (!mounted.current) return
    if (!outcome.ok) {
      setError(outcome.error?.message ?? shellT()('credentials.writeFailed'))
      return
    }
    setForm(EMPTY_FORM)
    void refresh()
  }, [form, refresh])

  /** Clear one reference; templates referencing it will wait for a value. */
  const clearRef = useCallback(async (name: string): Promise<void> => {
    setBusy(true)
    const outcome = await rpc('credentials.unset', { ref: name }, 30_000)
    setBusy(false)
    if (!mounted.current) return
    if (!outcome.ok) {
      setError(outcome.error?.message ?? shellT()('credentials.clearFailed'))
      return
    }
    void refresh()
  }, [refresh])

  return (
    <div className="dshx-cred">
      <div className="dshx-cred-head">
        <span className="dshx-cred-title">{t('credentials.title')}</span>
        <span className="dshx-cred-sub">{t('credentials.subtitle')}</span>
      </div>
      {error !== '' && <div className="dshx-cred-error">{error}</div>}
      {refs === null
        ? <div className="dshx-cred-empty">{t('automation.reading')}</div>
        : (
          refs.length === 0
            ? <div className="dshx-cred-empty">{t('credentials.empty')}</div>
            : (
              <div className="dshx-cred-rows">
                {refs.map(row => (
                  <div className="dshx-cred-row" key={row.ref}>
                    <div className="dshx-cred-rowmain">
                      <span className="dshx-cred-name">{row.ref}</span>
                      {row.configured
                        ? <Badge variant="soft" size="sm" className="dshx-cred-chip is-ok">{t('credentials.configuredBadge')}</Badge>
                        : <Badge variant="soft" size="sm" className="dshx-cred-chip is-empty">{t('credentials.emptyBadge')}</Badge>}
                    </div>
                    <div className="dshx-cred-rowops">
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void clearRef(row.ref) }}>{t('shell.rail.delete')}</Button>
                    </div>
                  </div>
                ))}
              </div>
            )
        )}
      <div className="dshx-cred-form">
        <input
          className="dshx-cred-input"
          placeholder={t('credentials.namePlaceholder')}
          value={form.ref}
          onChange={(event) => { setForm({ ...form, ref: event.target.value }) }}
        />
        <input
          className="dshx-cred-input"
          type="password"
          placeholder={t('credentials.valuePlaceholder')}
          value={form.value}
          onChange={(event) => { setForm({ ...form, value: event.target.value }) }}
        />
        <Button size="sm" disabled={busy || form.ref.trim() === '' || form.value === ''} onClick={() => { void storeValue() }}>
          {t('credentials.store')}
        </Button>
      </div>
    </div>
  )
}

/** Section styles, injected by the shell's stylesheet bundle. */
export const CREDENTIALS_CARD_CSS = `
.dshx-cred { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.03)); }
.dshx-cred-head { display: flex; align-items: baseline; gap: 8px; }
.dshx-cred-title { font-weight: 600; font-size: 13px; }
.dshx-cred-sub { font-size: 11px; opacity: 0.55; }
.dshx-cred-error { font-size: 12px; color: #f87171; }
.dshx-cred-empty { font-size: 12px; opacity: 0.6; }
.dshx-cred-rows { display: flex; flex-direction: column; gap: 6px; }
.dshx-cred-row { border: 1px solid var(--dshx-line, #2a2a2a); border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
.dshx-cred-rowmain { display: flex; align-items: center; gap: 8px; }
.dshx-cred-name { font-weight: 600; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dshx-cred-chip.is-ok { color: #4ade80; }
.dshx-cred-chip.is-empty { opacity: 0.6; }
.dshx-cred-rowops { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
.dshx-cred-form { display: flex; flex-direction: column; gap: 6px; }
.dshx-cred-input { background: transparent; border: 1px solid var(--dshx-line, #2a2a2a); border-radius: 6px; padding: 6px 8px; font-size: 12px; color: inherit; width: 100%; box-sizing: border-box; }
.dshx-cred-input:focus { outline: none; border-color: #7c5cfc; }
`
