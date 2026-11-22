/**
 * `services-panel`: the「服务」panel — the user-picked services that used to
 * live inside the user-plugin panel (DeepSeek account, credentials, MCP
 * servers, scheduled tasks, plus the About row), now a SIBLING panel at the
 * same navigation level. Opened from the full-page rail's 服务 row and from
 * the user-plugin panel's bottom entry (the narrow side panel has no extra
 * header button). The card components are fully self-contained (rpc singleton
 * + their own CSS exports, injected by the shell's style tag), so this module
 * only composes them; the About row (version + update check) moved here with
 * its storage key — the shell's update dot reads the same key.
 *
 * Styling reuses the user-plugin panel's skeleton classes (`dshx-up-*`, all
 * defined in `USER_PLUGIN_PANEL_CSS`, injected once by the shell) — no new
 * CSS constant.
 *
 * @module services-panel
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import './appica.generated.css'
import { rpc } from './rpc-client.ts'
import { AccountCard } from './account-card.tsx'
import { AiLocalCard } from './ai-local-card.tsx'
import { CredentialsCard } from './credentials-card.tsx'
import { McpPanel } from './mcp-panel.tsx'
import { McpServerCard } from './mcp-server-card.tsx'
import { CloseIcon } from './icons.tsx'

/** This build's manifest version — the 关于 row's baseline for the update check. */
const panelVersion: string = typeof chrome !== 'undefined' && chrome.runtime !== undefined
  ? chrome.runtime.getManifest().version
  : '0.0.0-dev'

/** chrome.storage.local key caching the last update-check outcome (the shell's trigger dot reads it too). */
export const UPDATE_CHECK_STORAGE_KEY = 'dshx.updateCheck'

/** The cached outcome of one update check (written on success only). */
export interface UpdateCheckCache {
  /** Epoch ms of the last successful check. */
  checkedAt: number
  /** The latest published version string ('' when unresolvable). */
  latest: string
  /** Whether `latest` differs from the running manifest version. */
  available: boolean
  /** The release page to open. */
  url: string
}

/** One day: the panel auto-checks at most this often; the button always checks immediately. */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface ServicesPanelProps {
  /** Close the panel (the shell's overlay close). */
  onClose: () => void
}

/**
 * The services management panel body. Mounts the four self-contained service
 * cards in two columns with the About row, and carries the update-check
 * state machine (moved here with the About row from the user-plugin panel).
 */
export function ServicesPanel({ onClose }: ServicesPanelProps): JSX.Element {
  /** The 关于 row's update-check state (idle → checking → latest | available | failed). */
  const [updateState, setUpdateState] = useState<
    | { readonly phase: 'idle' }
    | { readonly phase: 'checking' }
    | { readonly phase: 'latest'; readonly current: string }
    | { readonly phase: 'available'; readonly current: string; readonly latest: string; readonly url: string }
    | { readonly phase: 'failed'; readonly message: string }
  >({ phase: 'idle' })

  const checkUpdate = useCallback((): void => {
    setUpdateState({ phase: 'checking' })
    void rpc('app/updateCheck', {}).then((result) => {
      if (!result.ok) {
        setUpdateState({ phase: 'failed', message: result.error?.message ?? '检查失败' })
        return
      }
      // The bridge reads only the release tag; the comparison uses this
      // panel's own manifest version (the offscreen page has no getManifest).
      const value = result.value as { latest?: unknown; url?: unknown }
      const latest = typeof value?.latest === 'string' ? value.latest : ''
      const url = typeof value?.url === 'string' ? value.url : ''
      const available = latest !== '' && latest !== panelVersion
      if (available) {
        setUpdateState({ phase: 'available', current: panelVersion, latest, url })
      } else {
        setUpdateState({ phase: 'latest', current: panelVersion })
      }
      if (typeof chrome !== 'undefined' && chrome.storage !== undefined) {
        const cache: UpdateCheckCache = { checkedAt: Date.now(), latest, available, url }
        void chrome.storage.local.set({ [UPDATE_CHECK_STORAGE_KEY]: cache })
      }
    })
  }, [])

  // Reopen onto the cached outcome and refresh it once a day: the 关于 row
  // speaks on mount instead of waiting for a button the user does not know
  // exists. Failures stay silent here — the manual check surfaces them.
  useEffect(() => {
    if (typeof chrome === 'undefined' || chrome.storage === undefined) return undefined
    let alive = true
    const read = async (): Promise<void> => {
      const stored = await chrome.storage.local.get(UPDATE_CHECK_STORAGE_KEY)
      if (!alive) return
      const cache = stored[UPDATE_CHECK_STORAGE_KEY] as UpdateCheckCache | undefined
      if (cache !== undefined && cache.available) {
        setUpdateState({ phase: 'available', current: panelVersion, latest: cache.latest, url: cache.url })
      }
      if (cache === undefined || Date.now() - cache.checkedAt > UPDATE_CHECK_INTERVAL_MS) checkUpdate()
    }
    void read()
    return () => { alive = false }
  }, [checkUpdate])

  return (
    <div className="dshx-up">
      <div className="dshx-up-head">
        <span className="dshx-up-title">服务</span>
        <button type="button" className="dshx-iconbtn" aria-label="关闭服务面板" title="关闭" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="dshx-up-body">
        <div className="dshx-up-inner">
          <div className="dshx-up-cols">
            <div className="dshx-up-col">
              {/* 账号:DeepSeek 账号登录/状态(account.* RPC 面,浏览器 OAuth 回环拦截)。 */}
              <AccountCard />
              {/* 凭证:MCP 请求头模板引用的凭证值存取(credentials.* RPC 面)。 */}
              <CredentialsCard />
            </div>
            <div className="dshx-up-col">
              {/* MCP 服务器开关:把本扩展作为 MCP 服务器开放给外部 harness/agent
                  (能力位 → offscreen 连本地桥 scripts/mcp-bridge.mjs 服务 MCP)。 */}
              <McpServerCard />
              {/* MCP 服务器:外部 MCP 编队的列表/增删/探测/重启(mcp.* RPC 面)。 */}
              <McpPanel />
              {/* 本地 AI:端侧模型目录/设备档位/生命周期(aiLocal.* RPC 面)。 */}
              <AiLocalCard />
            </div>
          </div>
          {/* 关于:解包安装永不自动更新——对照最新发布标签,让面板能说出一包新 zip 的存在。 */}
          <section className="dshx-up-section dshx-up-about">
            <div className="dshx-up-sechead">
              <span className="dshx-up-sectitle">关于</span>
            </div>
            <div className="dshx-up-aboutrow">
              <span className="dshx-up-version">OpenBrowserHarness v{panelVersion}</span>
              <button
                type="button"
                className="dshx-up-portbtn"
                disabled={updateState.phase === 'checking'}
                onClick={checkUpdate}
              >检查更新</button>
            </div>
            {updateState.phase === 'checking' && <div className="dshx-up-hint">正在查询最新发布…</div>}
            {updateState.phase === 'latest' && <div className="dshx-up-hint">已是最新版本。</div>}
            {updateState.phase === 'available' && (
              <div className="dshx-up-hint">
                新版本 v{updateState.latest} 可用（当前 v{updateState.current}）——
                <a href={updateState.url} target="_blank" rel="noreferrer">前往发布页下载</a>，解压后在扩展管理页重新加载。
              </div>
            )}
            {updateState.phase === 'failed' && <div className="dshx-up-error" role="alert">{updateState.message}</div>}
          </section>
        </div>
      </div>
    </div>
  )
}
