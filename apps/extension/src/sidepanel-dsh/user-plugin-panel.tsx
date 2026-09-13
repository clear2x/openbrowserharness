/**
 * `user-plugin-panel`: the SidePanel's 用户插件 management panel — the UI
 * consumer for the engine's `plugin.*` RPC family (chrome/user-plugin-bridge),
 * rebuilt on the Appica UI component library (@appica/ui-react: Switch,
 * Button, Textarea, Badge, Loader; see scripts/build-appica-css.mjs for how
 * the component styles compile into appica.generated.css and follow the
 * shell's dark marker).
 *
 * Layout: a roster of plugin cards (name, title, description, registered
 * event badges) with an enable switch and a two-stage delete, an AI-generation
 * entry that folds a requirement description into the shell's `sendPrompt`
 * channel (the same `session.prompt` path the composer rides) so the current
 * session's agent writes and installs the plugin with `user_plugin_write`,
 * plus loading / error / empty states.
 *
 * Data flow: the roster is fetched on open and re-polled every 10 s while the
 * panel is open, so plugins the agent installs in the conversation appear
 * without a manual refresh; toggle/remove update the list locally from their
 * RPC responses and surface refusals as an inline error line.
 *
 * Mount point: extension-shell.tsx renders the panel inside the details
 * aside, exclusive with the tool-details pane. The aside is
 * `position:absolute` below 768 px, so the panel overlays the transcript and
 * can never squeeze the composer out of the panel.
 *
 * The rpc carrier is a prop (default: the module-level `rpc` singleton) so
 * tests inject a fake without touching the Port transport.
 *
 * @module user-plugin-panel
 */

import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
// Appica's compiled component styles (scripts/build-appica-css.mjs product);
// vite dedupes this import into the sidepanel bundle's single stylesheet.
import './appica.generated.css'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Loader } from '@appica/ui-react/loader'
import { Switch } from '@appica/ui-react/switch'
import { Textarea } from '@appica/ui-react/textarea'
import { rpc } from './rpc-client.ts'
import type { RpcOutcome } from './rpc-client.ts'
import { CloseIcon } from './icons.tsx'

/** Wire view of one `plugin.list` item (host record minus code — see chrome/user-plugins.ts). */
export interface UserPluginItem {
  /** Kebab-case id; also the `plugin.*` payload key. */
  name: string
  /** Human-facing display title. */
  title: string
  /** What the plugin does — free text the AI writes alongside the code. */
  description: string
  /** Whether the plugin is mounted on the engine. */
  enabled: boolean
  /** Event names the plugin is bound to right now (present only when mounted). */
  registeredEvents?: string[]
  /**
   * 最近一次激活失败的错误文本（host 落盘停用+失败标识；见 chrome/user-plugins.ts）。
   * 后续 write/toggle 成功即清除，行内红色提示随之消失。
   */
  lastError?: string
}

/** The rpc calling face: method + payload → outcome. Injectable for tests. */
export type PluginRpc = (method: string, payload: Record<string, unknown>) => Promise<RpcOutcome>

/** `plugin.toggle` ok value (the host returns the fresh flag + bound events). */
interface ToggleValue {
  name?: string
  enabled?: boolean
  registeredEvents?: unknown
}

/** `plugin.list` ok value (wire view). */
interface ListValue {
  items?: unknown
}

/** Refresh interval while the panel is open: agent-installed plugins appear without a manual refresh. */
const REFRESH_INTERVAL_MS = 10_000

/** The AI-generation instruction handed to `sendPrompt` (the agent drives `user_plugin_write`). */
const generateInstruction = (requirement: string): string =>
  `请根据以下需求用 user_plugin_write 工具生成并安装一个用户插件，完成后列出插件名：${requirement}`

/** Display label for a session id: short ids verbatim, long ids head-truncated. */
function shortLabel(sessionId: string): string {
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 8)}…`
}

/** Coerce the `plugin.list` ok value into wire-view items (RPC results are a wire boundary). */
function normalizeItems(value: unknown): UserPluginItem[] {
  const items = (value as ListValue | undefined)?.items
  if (!Array.isArray(items)) return []
  const out: UserPluginItem[] = []
  for (const entry of items) {
    const item = entry as Record<string, unknown> | null | undefined
    if (item === null || typeof item !== 'object') continue
    const name = item.name
    const title = item.title
    const description = item.description
    const enabled = item.enabled
    if (typeof name !== 'string' || typeof title !== 'string' ||
      typeof description !== 'string' || typeof enabled !== 'boolean') continue
    const events = item.registeredEvents
    const registeredEvents = Array.isArray(events)
      ? events.filter((event): event is string => typeof event === 'string')
      : undefined
    const lastError = item.lastError
    out.push({
      name,
      title,
      description,
      enabled,
      ...(registeredEvents === undefined ? {} : { registeredEvents }),
      ...(typeof lastError === 'string' && lastError !== '' ? { lastError } : {}),
    })
  }
  return out
}

export interface UserPluginPanelProps {
  /** The session the AI-generation instruction is sent to. */
  sessionId: string
  /** Shell prompt channel: sends one instruction to the current session (see extension-shell). */
  sendPrompt: (text: string) => void
  /** Close the panel (the aside close button). */
  onClose: () => void
  /** RPC carrier; defaults to the module-level singleton, injectable for tests. */
  rpc?: PluginRpc
}

/**
 * The user-plugin management panel body. Fetches the roster on mount, polls
 * it while open, and applies toggle/remove results locally.
 */
export function UserPluginPanel({ sessionId, sendPrompt, onClose, rpc: callRpc = rpc }: UserPluginPanelProps): JSX.Element {
  const [items, setItems] = useState<UserPluginItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiText, setAiText] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  /** Names with an in-flight toggle/remove; keeps the row's controls disabled until the RPC settles. */
  const [busyNames, setBusyNames] = useState<ReadonlySet<string>>(() => new Set())
  /** The built-in 网页截图 capability's opt-in state (null until the first read lands). */
  const [screenshotEnabled, setScreenshotEnabled] = useState<boolean | null>(null)
  const [screenshotBusy, setScreenshotBusy] = useState(false)

  const loadScreenshot = useCallback(async (): Promise<void> => {
    const result = await callRpc('capability.screenshot.get', {})
    if (result.ok) {
      const value = result.value as { enabled?: unknown } | undefined
      setScreenshotEnabled(value?.enabled === true)
    }
  }, [callRpc])

  const toggleScreenshot = (next: boolean): void => {
    setScreenshotBusy(true)
    void callRpc('capability.screenshot.set', { enabled: next }).then((result) => {
      setScreenshotBusy(false)
      if (result.ok) {
        const value = result.value as { enabled?: unknown } | undefined
        setScreenshotEnabled(value?.enabled === true)
      } else {
        setError(result.error?.message ?? '切换失败')
      }
    })
  }

  const markBusy = (name: string): void => {
    setBusyNames(current => new Set(current).add(name))
  }
  const clearBusy = (name: string): void => {
    setBusyNames((current) => {
      const next = new Set(current)
      next.delete(name)
      return next
    })
  }

  /** Fetch the roster; a refused read keeps the current list and the next poll retries. */
  const load = useCallback(async (): Promise<void> => {
    const result = await callRpc('plugin.list', {})
    if (result.ok) {
      setItems(normalizeItems(result.value))
      setError(null)
    } else {
      setError(result.error?.message ?? '用户插件列表加载失败')
    }
    setLoading(false)
  }, [callRpc])

  useEffect(() => {
    void load()
    void loadScreenshot()
    const timer = setInterval(() => { void load() }, REFRESH_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [load, loadScreenshot])

  /** Toggle one plugin's enable flag; the row applies the host's returned state. */
  const toggle = (item: UserPluginItem): void => {
    const next = !item.enabled
    markBusy(item.name)
    setError(null)
    void callRpc('plugin.toggle', { name: item.name, enabled: next }).then((result) => {
      clearBusy(item.name)
      if (result.ok) {
        const value = result.value as ToggleValue | undefined
        const events = value?.registeredEvents
        setItems(current => current.map((entry) => {
          if (entry.name !== item.name) return entry
          // 任意成功的 toggle 在 host 侧都会重建记录并清掉 lastError，行内同步。
          const { lastError: _cleared, ...rest } = entry
          return {
            ...rest,
            enabled: typeof value?.enabled === 'boolean' ? value.enabled : next,
            ...(Array.isArray(events)
              ? { registeredEvents: events.filter((event): event is string => typeof event === 'string') }
              : {}),
          }
        }))
      } else {
        setError(result.error?.message ?? '切换失败')
      }
    })
  }

  /** Delete one plugin after the two-stage confirm; the row leaves on success. */
  const remove = (name: string): void => {
    markBusy(name)
    setError(null)
    void callRpc('plugin.remove', { name }).then((result) => {
      clearBusy(name)
      if (result.ok) {
        setItems(current => current.filter(entry => entry.name !== name))
        setConfirming(null)
      } else {
        setError(result.error?.message ?? '删除失败')
      }
    })
  }

  /** Send the requirement through the shell's prompt channel and fold the form away. */
  const generate = (): void => {
    const requirement = aiText.trim()
    if (requirement === '') return
    sendPrompt(generateInstruction(requirement))
    setAiText('')
    setAiOpen(false)
    setHint(`已把生成指令发给会话「${shortLabel(sessionId)}」，生成进度请看会话记录。`)
  }

  const canGenerate = aiText.trim() !== ''

  return (
    <div className="dshx-up">
      <div className="dshx-up-head">
        <span className="dshx-up-title">用户插件</span>
        <button type="button" className="dshx-iconbtn" aria-label="关闭用户插件面板" title="关闭" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="dshx-up-body">
        {aiOpen ? (
          <div className="dshx-up-genform">
            <Textarea
              rows={3}
              inputSize="sm"
              value={aiText}
              placeholder="描述你想要的插件，例如：当用户说「你好」时自动回复问候。"
              onChange={(event) => { setAiText(event.target.value) }}
            />
            <div className="dshx-up-genactions">
              <Button variant="ghost" size="sm" onClick={() => { setAiOpen(false) }}>
                取消
              </Button>
              <Button size="sm" disabled={!canGenerate} onClick={generate}>
                发送给 Agent
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" className="dshx-up-gen" onClick={() => { setAiOpen(true); setHint(null) }}>
            AI 生成
          </Button>
        )}
        {hint !== null && <div className="dshx-up-hint">{hint}</div>}
        {error !== null && <div className="dshx-up-error" role="alert">{error}</div>}
        {/* Built-in capability: the user-opt-in page screenshot. Rendered as a
            plugin-style row (same switch affordance) so toggling a first-party
            capability feels exactly like toggling a user plugin. */}
        {screenshotEnabled !== null && (
          <div className="dshx-up-builtin">
            <div className="dshx-up-builtintitle">内置能力</div>
            <div className="dshx-up-item">
              <div className="dshx-up-itemhead">
                <span className="dshx-up-name">page-screenshot</span>
                <div className="dshx-up-itemactions">
                  <Switch
                    size="sm"
                    checked={screenshotEnabled}
                    disabled={screenshotBusy}
                    aria-label="启用能力 网页截图"
                    title={screenshotEnabled ? '停用网页截图' : '启用网页截图'}
                    onCheckedChange={(next) => { toggleScreenshot(next) }}
                  />
                </div>
              </div>
              <div className="dshx-up-itemtitle">网页截图</div>
              <div className="dshx-up-desc">让 Agent 可以截取当前网页作为证据（page_screenshot 工具）。</div>
            </div>
          </div>
        )}
        {loading && <div className="dshx-up-loading"><Loader aria-label="加载中" /><span>加载中…</span></div>}
        {!loading && items.length === 0 && error === null && (
          <div className="dshx-up-empty">还没有用户插件——点击 AI 生成，让 Agent 帮你写第一个插件。</div>
        )}
        {items.length > 0 && (
          <ul className="dshx-up-list">
            {items.map((item) => {
              const pendingDelete = confirming === item.name
              const busy = busyNames.has(item.name)
              return (
                <li key={item.name} className="dshx-up-item">
                  <div className="dshx-up-itemhead">
                    <span className="dshx-up-name" title={item.name}>{item.name}</span>
                    <div className="dshx-up-itemactions">
                      <Switch
                        size="sm"
                        checked={item.enabled}
                        disabled={busy}
                        aria-label={`启用插件 ${item.name}`}
                        title={item.enabled ? '停用插件' : '启用插件'}
                        onCheckedChange={() => { toggle(item) }}
                      />
                      {pendingDelete ? (
                        <>
                          <Button
                            variant="destructive"
                            size="sm"
                            aria-label={`确认删除插件 ${item.name}`}
                            disabled={busy}
                            onClick={() => { remove(item.name) }}
                          >
                            确认删除
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label="取消删除"
                            onClick={() => { setConfirming(null) }}
                          >
                            取消
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="dshx-up-del"
                          aria-label={`删除插件 ${item.name}`}
                          onClick={() => { setConfirming(item.name) }}
                        >
                          删除
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="dshx-up-itemtitle">{item.title}</div>
                  {item.description !== '' && <div className="dshx-up-desc">{item.description}</div>}
                  {item.lastError !== undefined && (
                    <div className="dshx-up-lasterror" role="alert">上次激活失败：{item.lastError}</div>
                  )}
                  {(item.registeredEvents?.length ?? 0) > 0 && (
                    <div className="dshx-up-events">
                      {item.registeredEvents?.map(event => (
                        <Badge key={event} variant="soft" size="sm" className="dshx-up-event">{event}</Badge>
                      ))}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * Panel stylesheet — layout skeleton only. Every control's visual language
 * (switch, buttons, textarea, event badges) comes from @appica/ui-react via
 * `appica.generated.css` (imported below); the classes kept here cover the
 * panel's flex/scroll frame, card containers, and text hierarchy, on the
 * shell's `--dsw-alias-*` tokens plus Appica's own `--error` token so the
 * alert line follows the same light/dark palettes.
 *
 * Button discipline: rows (`.dshx-up-genactions`, `.dshx-up-itemactions`)
 * wrap as whole buttons on narrow asides, and event badges stay atomic
 * between wrapping.
 */
export const USER_PLUGIN_PANEL_CSS = `
.dshx-up{display:flex;flex-direction:column;height:100%;min-height:0}
.dshx-up-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.dshx-up-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}
/* the header trigger's pressed state (the shell's .dshx-iconbtn base lives in SHELL_CSS) */
.dshx-iconbtn.is-active{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#333)}
.dshx-up-body{flex:1;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.35)) transparent}
.dshx-up-genform{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03))}
.dshx-up-genactions{display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap}
.dshx-up-gen{align-self:flex-start;height:32px;border-radius:10px;font-size:12px;white-space:nowrap}
.dshx-up-hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#888)}
.dshx-up-builtin{display:flex;flex-direction:column;gap:8px;margin-top:4px}
.dshx-up-builtintitle{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-up-error{font-size:11px;line-height:1.6;word-break:break-word;color:var(--error,#dc2626)}
.dshx-up-empty{padding:20px 12px;font-size:12px;line-height:1.7;text-align:center;color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-up-loading{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#888)}
.dshx-up-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.dshx-up-item{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03))}
.dshx-up-itemhead{display:flex;align-items:center;gap:8px;min-width:0}
.dshx-up-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dshx-up-itemactions{flex:none;margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshx-up-del{color:var(--dsw-alias-label-secondary,#888)}
.dshx-up-itemtitle{font-size:12px;font-weight:600}
.dshx-up-desc{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#888);word-break:break-word}
.dshx-up-lasterror{font-size:11px;line-height:1.6;word-break:break-word;color:var(--error,#dc2626)}
.dshx-up-events{display:flex;flex-wrap:wrap;gap:4px}
.dshx-up-event{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap}
`
