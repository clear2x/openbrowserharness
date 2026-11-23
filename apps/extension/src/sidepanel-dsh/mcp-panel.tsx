/**
 * `McpPanel`: the 用户插件 panel's MCP servers section — the panel-side
 * consumer of the engine's `mcp.*` RPC family (chrome/api-bridge driving the
 * offscreen mcpManager composition row).
 *
 * Layout: a roster of server rows (name, transport chip, status chip, URL)
 * with enable switches, a per-row 探测/重启/删除 action pair, and an add form
 * (name + URL + optional headers JSON). Only `streamable-http` servers are
 * offered: the stdio transport spawns a child process, which no browser
 * surface can serve, so the form does not present it.
 *
 * Data flow: `mcp.list` is polled every 5 s while mounted (the manager's
 * `watch` typert stream has no extension transport bridge); every mutation
 * posts the complete `servers` dict through `mcp.setServers` — the manager
 * reconciles the diff, so a toggle or delete of one row is a whole-dict
 * write that keeps the others.
 *
 * @module mcp-panel
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Switch } from '@appica/ui-react/switch'
import { rpc } from './rpc-client.ts'
import { shellT, useShellT } from './locales/index.ts'

/** One row of `mcp.list` (the McpManagedServerView wire shape). */
interface McpServerView {
  /** The `servers` key; also the instance's tool namespace. */
  name: string
  /** False for a retained cleanup-failure record whose entry is gone. */
  configured: boolean
  /** Runtime status: a connection state, `disabled`, or a failure shape. */
  status: { state: string } & Record<string, unknown>
}

/** The user-editable fields of one configured server (streamable-http only). */
interface McpServerForm {
  /** Server key and tool namespace. */
  name: string
  /** Streamable-HTTP endpoint. */
  url: string
  /** Optional JSON object of request headers (Authorization 等). */
  headersJson: string
}

const EMPTY_FORM: McpServerForm = { name: '', url: '', headersJson: '' }

/** Status chip text and tone for one view's runtime status. */
function statusChip(status: McpServerView['status']): { text: string; tone: 'green' | 'amber' | 'red' | 'gray' } {
  const t = shellT()
  const state = status.state
  if (state === 'connected') return { text: t('mcpServer.stateConnected'), tone: 'green' }
  if (state === 'connecting' || state === 'waiting-credentials' || state === 'needs-auth') return { text: state, tone: 'amber' }
  if (state === 'disabled') return { text: t('mcp.status.disabled'), tone: 'gray' }
  if (state === 'failed') {
    const reason = status.reason
    return { text: t('mcp.status.failed', { reason: typeof reason === 'string' ? reason : JSON.stringify(reason ?? '') }), tone: 'red' }
  }
  return { text: state, tone: 'gray' }
}

/**
 * Render the MCP servers section.
 * @param props - nothing: the section owns its polling and form state.
 * @returns the section body.
 */
export function McpPanel(): JSX.Element {
  const t = useShellT()
  const [views, setViews] = useState<McpServerView[] | null>(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState<McpServerForm>(EMPTY_FORM)
  const [probe, setProbe] = useState<{ name: string; text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  /** Read the roster once; polling re-calls this. Errors surface inline. */
  const refresh = useCallback(async (): Promise<void> => {
    const outcome = await rpc('mcp.list', {}, 15_000)
    if (!mounted.current) return
    if (outcome.ok) {
      const entries = (outcome.value as { servers?: unknown } | undefined)?.servers
      if (Array.isArray(entries)) setViews(entries as McpServerView[])
      else setViews([])
      setError('')
    } else {
      setError(outcome.error?.message ?? shellT()('mcp.error.listFailed'))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5_000)
    return () => { clearInterval(timer) }
  }, [refresh])

  /** Post the complete servers dict; the manager reconciles the diff. */
  const postServers = useCallback(async (entries: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    const outcome = await rpc('mcp.setServers', { servers: entries }, 30_000)
    setBusy(false)
    if (!mounted.current) return false
    if (!outcome.ok) {
      setError(outcome.error?.message ?? shellT()('mcp.error.writeFailed'))
      return false
    }
    setError('')
    void refresh()
    return true
  }, [refresh])

  /** Merge one form into the dict (validated here; the manager revalidates). */
  const addServer = useCallback(async (): Promise<void> => {
    const t = shellT()
    const name = form.name.trim()
    const url = form.url.trim()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
      setError(t('mcp.error.nameInvalid'))
      return
    }
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      setError(t('mcp.error.urlInvalid'))
      return
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      setError(t('mcp.error.transport'))
      return
    }
    let headers: Record<string, string> = {}
    const headersText = form.headersJson.trim()
    if (headersText !== '') {
      try {
        const parsed: unknown = JSON.parse(headersText)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('not an object')
        headers = Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
          .map(([key, value]) => [key, String(value)]))
      } catch {
        setError(t('mcp.error.headersInvalid'))
        return
      }
    }
    const current = serverDict(views)
    if (Object.hasOwn(current, name)) {
      setError(t('mcp.error.duplicate', { name }))
      return
    }
    if (await postServers({ ...current, [name]: { transport: 'streamable-http', url, headers, enabled: true } })) {
      setForm(EMPTY_FORM)
    }
  }, [form, views, postServers])

  /** Flip one row's `enabled`; a disabled row keeps its config. */
  const toggleServer = useCallback(async (view: McpServerView): Promise<void> => {
    const current = serverDict(views)
    const entry = current[view.name]
    if (entry === undefined || typeof entry !== 'object') return
    await postServers({
      ...current,
      [view.name]: { ...(entry as Record<string, unknown>), enabled: !(entry as { enabled?: boolean }).enabled },
    })
  }, [views, postServers])

  /** Remove one row (the manager retains a cleanup-failure record if any). */
  const removeServer = useCallback(async (view: McpServerView): Promise<void> => {
    const current = serverDict(views)
    const { [view.name]: _removed, ...rest } = current
    await postServers(rest)
  }, [views, postServers])

  /** Probe one server without touching its live instance; result inline. */
  const probeServer = useCallback(async (view: McpServerView): Promise<void> => {
    const t = shellT()
    setProbe({ name: view.name, text: t('mcp.probe.probing'), ok: true })
    const outcome = await rpc('mcp.probe', { name: view.name }, 60_000)
    if (!mounted.current) return
    if (outcome.ok) {
      const result = outcome.value as { ok?: boolean; toolNames?: unknown; error?: unknown } | undefined
      const toolCount = Array.isArray(result?.toolNames) ? result?.toolNames.length : undefined
      const okProbe = result?.ok === true
      const errorText = typeof result?.error === 'string' ? result.error : JSON.stringify(result?.error ?? '')
      const text = okProbe
        ? (toolCount === undefined ? t('mcp.probe.ok') : t('mcp.probe.okTools', { count: toolCount }))
        : (result?.error === undefined ? t('mcp.probe.failed') : t('mcp.probe.failedReason', { reason: errorText.slice(0, 120) }))
      setProbe({ name: view.name, text, ok: okProbe })
    } else {
      setProbe({ name: view.name, text: outcome.error?.message ?? t('mcp.probe.requestFailed'), ok: false })
    }
  }, [])

  /** Restart one server's live instance with a fresh reconnect budget. */
  const restartServer = useCallback(async (view: McpServerView): Promise<void> => {
    setBusy(true)
    const outcome = await rpc('mcp.restart', { name: view.name }, 60_000)
    setBusy(false)
    if (mounted.current && !outcome.ok) setError(outcome.error?.message ?? shellT()('mcp.error.restartFailed'))
  }, [])

  return (
    <div className="dshx-mcp">
      <div className="dshx-mcp-head">
        <span className="dshx-mcp-title">{t('mcp.sectionTitle')}</span>
        <span className="dshx-mcp-sub">{t('mcp.subtitle')}</span>
      </div>
      {error !== '' && <div className="dshx-mcp-error">{error}</div>}
      {views === null
        ? <div className="dshx-mcp-empty">{t('automation.reading')}</div>
        : (
          views.length === 0
            ? <div className="dshx-mcp-empty">{t('mcp.empty')}</div>
            : (
              <div className="dshx-mcp-rows">
                {views.map((view) => {
                  const chip = statusChip(view.status)
                  return (
                    <div className="dshx-mcp-row" key={view.name}>
                      <div className="dshx-mcp-rowmain">
                        <span className="dshx-mcp-name">{view.name}</span>
                        <Badge variant="soft" size="sm" className={`dshx-mcp-chip is-${chip.tone}`}>{chip.text}</Badge>
                      </div>
                      <div className="dshx-mcp-rowops">
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void probeServer(view) }}>{t('mcp.probe')}</Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void restartServer(view) }}>{t('mcp.restart')}</Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void removeServer(view) }}>{t('shell.rail.delete')}</Button>
                        <Switch
                          checked={view.status.state !== 'disabled'}
                          disabled={busy || !view.configured}
                          onCheckedChange={() => { void toggleServer(view) }}
                        />
                      </div>
                      {probe !== null && probe.name === view.name && (
                        <div className={`dshx-mcp-probe ${probe.ok ? 'is-ok' : 'is-bad'}`}>{probe.text}</div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
        )}
      <div className="dshx-mcp-form">
        <input
          className="dshx-mcp-input"
          placeholder={t('mcp.namePlaceholder')}
          value={form.name}
          onChange={(event) => { setForm({ ...form, name: event.target.value }) }}
        />
        <input
          className="dshx-mcp-input"
          placeholder={t('mcp.urlPlaceholder')}
          value={form.url}
          onChange={(event) => { setForm({ ...form, url: event.target.value }) }}
        />
        <input
          className="dshx-mcp-input"
          placeholder={t('mcp.headersPlaceholder')}
          value={form.headersJson}
          onChange={(event) => { setForm({ ...form, headersJson: event.target.value }) }}
        />
        <div className="dshx-mcp-hint">
          {t('mcp.hintBefore')}<code>{t('mcp.hintTemplate')}</code>{t('mcp.hintAfter')}
        </div>
        <Button size="sm" disabled={busy || form.name.trim() === '' || form.url.trim() === ''} onClick={() => { void addServer() }}>
          {t('mcp.add')}
        </Button>
      </div>
    </div>
  )
}

/** Rebuild the `servers` dict wire shape from the polled views (config rows only). */
function serverDict(views: McpServerView[] | null): Record<string, unknown> {
  // The wire views carry runtime status, not the stored entry fields; the
  // dict rebuild therefore goes through the manager's own view of the entry
  // set: the RPC `mcp.list` response additionally carries each configured
  // entry (see the bridge's `mcp.list` handler wiring `entry` beside `view`).
  const dict: Record<string, unknown> = {}
  for (const view of views ?? []) {
    const entry = (view as McpServerView & { entry?: unknown }).entry
    if (view.configured && entry !== undefined && entry !== null) dict[view.name] = entry
  }
  return dict
}

/** Section styles, injected once by the user-plugin panel's CSS constant. */
export const MCP_PANEL_CSS = `
.dshx-mcp { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.03)); }
.dshx-mcp-head { display: flex; align-items: baseline; gap: 8px; }
.dshx-mcp-title { font-weight: 600; font-size: 13px; }
.dshx-mcp-sub { font-size: 11px; opacity: 0.55; }
.dshx-mcp-error { font-size: 12px; color: #f87171; }
.dshx-mcp-empty { font-size: 12px; opacity: 0.6; display: flex; align-items: center; gap: 6px; }
.dshx-mcp-chip.is-green { color: #4ade80; }
.dshx-mcp-chip.is-amber { color: #fbbf24; }
.dshx-mcp-chip.is-red { color: #f87171; }
.dshx-mcp-chip.is-gray { opacity: 0.6; }
.dshx-mcp-rows { display: flex; flex-direction: column; gap: 6px; }
.dshx-mcp-row { border: 1px solid var(--dshx-line, #2a2a2a); border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
.dshx-mcp-rowmain { display: flex; align-items: center; gap: 8px; }
.dshx-mcp-name { font-weight: 600; font-size: 12px; }
.dshx-mcp-rowops { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
.dshx-mcp-probe { font-size: 11px; opacity: 0.85; }
.dshx-mcp-probe.is-ok { color: #4ade80; }
.dshx-mcp-probe.is-bad { color: #f87171; }
.dshx-mcp-form { display: flex; flex-direction: column; gap: 6px; }
.dshx-mcp-hint { font-size: 11px; line-height: 1.6; opacity: 0.6; word-break: break-word; }
.dshx-mcp-hint code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; opacity: 0.9; }
.dshx-mcp-input { background: transparent; border: 1px solid var(--dshx-line, #2a2a2a); border-radius: 6px; padding: 6px 8px; font-size: 12px; color: inherit; }
.dshx-mcp-input:focus { outline: none; border-color: #7c5cfc; }
`
