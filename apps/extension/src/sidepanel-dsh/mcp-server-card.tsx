/**
 * The services panel's「MCP 服务器」card: the toggle that turns this
 * extension INTO an MCP server. Flipping it writes the MCP capability flag;
 * the engine document dials the local bridge (scripts/mcp-bridge.mjs) and
 * serves MCP over it, so external harnesses and agents can drive the whole
 * dsh-api surface. The live dot reads the bridge-connection status the
 * engine publishes (chrome.storage `dsh-mcp-server-status`).
 *
 * @module mcp-server-card
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { rpc } from './rpc-client.ts'
import { useShellT } from './locales/index.ts'
import { MCP_SERVER_CAPABILITY_KEY } from '../shared/capability-keys.ts'
import { MCP_SERVER_STATUS_KEY, type McpServerStatusValue } from '../shared/mcp-server-protocol.ts'

/** The bridge command the hint row shows (run from the repo root). */
const BRIDGE_COMMAND = 'node apps/extension/scripts/mcp-bridge.mjs'

/**
 * The MCP server toggle card. Self-contained: capability read/write via the
 * generic capability RPCs, connection state via chrome.storage.onChanged.
 */
export function McpServerCard(): JSX.Element {
  const t = useShellT()
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<McpServerStatusValue | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void rpc('capability.get', { key: MCP_SERVER_CAPABILITY_KEY }).then((result) => {
      if (!alive || !result.ok) return
      setEnabled((result.value as { enabled?: boolean } | undefined)?.enabled === true)
    }).catch(() => {})
    const readStatus = (): void => {
      if (typeof chrome === 'undefined' || chrome.storage?.local === undefined) return
      void chrome.storage.local.get([MCP_SERVER_STATUS_KEY]).then((items) => {
        if (!alive) return
        setStatus((items[MCP_SERVER_STATUS_KEY] as McpServerStatusValue | undefined) ?? undefined)
      }).catch(() => {})
    }
    readStatus()
    let listener: ((changes: Record<string, { newValue?: unknown }>, area: string) => void) | undefined
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged !== undefined) {
      listener = (changes, area) => {
        if (area !== 'local') return
        if (MCP_SERVER_STATUS_KEY in changes) {
          setStatus((changes[MCP_SERVER_STATUS_KEY]?.newValue as McpServerStatusValue | undefined) ?? undefined)
        }
      }
      chrome.storage.onChanged.addListener(listener)
    }
    return () => {
      alive = false
      if (listener !== undefined) {
        try {
          chrome.storage.onChanged.removeListener(listener)
        } catch {
          // Minimal faces without removeListener keep the slot; the listener
          // is storage-key gated and inert after unmount.
        }
      }
    }
  }, [])

  const toggle = useCallback((): void => {
    if (enabled === undefined || busy) return
    setBusy(true)
    void rpc('capability.set', { key: MCP_SERVER_CAPABILITY_KEY, enabled: !enabled }).then((result) => {
      setBusy(false)
      if (result.ok) setEnabled(!enabled)
    }).catch(() => { setBusy(false) })
  }, [enabled, busy])

  const stateLabel = enabled !== true
    ? t('mcpServer.stateOff')
    : status?.state === 'connected'
      ? t('mcpServer.stateConnected')
      : t('mcpServer.stateWaiting')

  return (
    <div className="dshx-cred dshx-mcpsrv">
      <div className="dshx-cred-head">
        <span className="dshx-cred-title">{t('mcpServer.title')}</span>
        <span className="dshx-mcpsrv-dot" data-state={enabled === true ? (status?.state ?? 'waiting') : 'off'} aria-hidden="true" />
        <span className="dshx-cred-sub">{t('mcpServer.subtitle')}</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled === true}
          aria-label={t('mcpServer.enableLabel')}
          className={`dshx-switch${enabled === true ? ' is-on' : ''}`}
          disabled={enabled === undefined || busy}
          onClick={toggle}
        ><span className="dshx-switch-knob" /></button>
      </div>
      <div className="dshx-mcpsrv-status">{stateLabel}</div>
      <div className="dshx-cred-empty dshx-mcpsrv-hint">
        {t('mcpServer.hint')}
        <code>{BRIDGE_COMMAND}</code>
      </div>
    </div>
  )
}
