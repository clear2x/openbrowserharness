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
 * Mount point: extension-shell.tsx renders the panel in a full-bleed
 * viewport-fixed overlay — the same mounting posture as the settings sheet —
 * so the management surfaces get the whole SidePanel window instead of the
 * 340px details aside (which stays exclusive to tool details).
 *
 * The rpc carrier is a prop (default: the module-level `rpc` singleton) so
 * tests inject a fake without touching the Port transport.
 *
 * @module user-plugin-panel
 */

import { useCallback, useEffect, useRef, useState } from 'react'
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
import { ChevronRightIcon, CloseIcon } from './icons.tsx'
import { shellT, useShellT } from './locales/index.ts'
import type { ShellLocaleKey } from './locales/index.ts'

/**
 * Services (account/credentials/MCP/scheduled tasks/About) live in the
 * sibling「服务」panel — see services-panel.tsx; this panel's bottom entry
 * row jumps there.
 */

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
  /** Open the sibling「服务」panel (the bottom entry row). */
  onOpenServices: () => void
  /** A newer release exists (cached by the services panel's 关于 check) — dots the entry row. */
  updateAvailable?: boolean | undefined
  /** RPC carrier; defaults to the module-level singleton, injectable for tests. */
  rpc?: PluginRpc
}

/**
 * The user-plugin management panel body. Fetches the roster on mount, polls
 * it while open, and applies toggle/remove results locally.
 */
export function UserPluginPanel({
  sessionId, sendPrompt, onClose, onOpenServices, updateAvailable,
  rpc: callRpc = rpc,
}: UserPluginPanelProps): JSX.Element {
  const t = useShellT()
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
  /** The default-on built-in capabilities' state (null until the first read lands). */
  const [capabilityState, setCapabilityState] = useState<Record<string, boolean | null>>({})
  const [capabilityBusy, setCapabilityBusy] = useState<string | null>(null)
  /** Import in flight; the file input is the hidden sibling of the 导入 button. */
  const [importBusy, setImportBusy] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

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
        setError(result.error?.message ?? shellT()('plugins.toggleFailed'))
      }
    })
  }

  /** Download the whole roster as one portable JSON document. */
  const exportRoster = (): void => {
    void callRpc('plugin.export', {}).then((result) => {
      if (!result.ok) {
        setError(result.error?.message ?? shellT()('plugins.exportFailed'))
        return
      }
      const blob = new Blob([JSON.stringify(result.value, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'obh-user-plugins.json'
      anchor.click()
      URL.revokeObjectURL(url)
      setHint(shellT()('plugins.exportedHint'))
    })
  }

  /** Read one exported document and merge it into the roster (replace-by-name). */
  const importRoster = (file: File): void => {
    setImportBusy(true)
    void file.text().then((text) => {
      let document_: unknown
      try {
        document_ = JSON.parse(text)
      } catch {
        setImportBusy(false)
        setError(shellT()('plugins.importInvalid'))
        return
      }
      void callRpc('plugin.import', { document: document_ }).then((result) => {
        setImportBusy(false)
        if (!result.ok) {
          setError(result.error?.message ?? shellT()('plugins.importFailed'))
          return
        }
        const value = result.value as { imported?: unknown; failed?: unknown } | undefined
        const imported = typeof value?.imported === 'number' ? value.imported : 0
        const failed = typeof value?.failed === 'number' && value.failed > 0 ? value.failed : 0
        const translate = shellT()
        setHint(translate('plugins.importedHint', {
          count: imported,
          rejected: failed > 0 ? translate('plugins.importedRejected', { count: failed }) : '',
        }))
        void load()
      })
    })
  }

  /** The default-on built-in capability rows (the 内置能力 section beyond the opt-in screenshot). */
  const DEFAULT_ON_CAPABILITIES: ReadonlyArray<{
    readonly key: string
    readonly name: string
    readonly titleKey: ShellLocaleKey
    readonly descKey: ShellLocaleKey
    /**
     * Row-specific on/off titles; absent rows compose them from the shared
     * `停用/启用` templates (the zh templates leave no gap before a Latin label).
     */
    readonly onTitleKey?: ShellLocaleKey
    readonly offTitleKey?: ShellLocaleKey
  }> = [
    {
      key: 'dsh-capability-virtual-cursor',
      name: 'virtual-cursor',
      titleKey: 'capability.virtualCursor',
      descKey: 'capabilityDesc.virtualCursor',
    },
    {
      key: 'dsh-capability-site-knowledge',
      name: 'site-knowledge',
      titleKey: 'capability.siteKnowledge',
      descKey: 'capabilityDesc.siteKnowledge',
    },
    {
      key: 'dsh-capability-privacy-mask',
      name: 'privacy-mask',
      titleKey: 'capability.privacyMask',
      descKey: 'capabilityDesc.privacyMask',
    },
    {
      key: 'dsh-capability-humanized-input',
      name: 'humanized-input',
      titleKey: 'capability.humanizedInput',
      descKey: 'capabilityDesc.humanizedInput',
    },
    {
      key: 'dsh-capability-snap-lean',
      name: 'snap-lean',
      titleKey: 'capability.snapLean',
      descKey: 'capabilityDesc.snapLean',
    },
    {
      key: 'dsh-capability-banner-clean',
      name: 'banner-clean',
      titleKey: 'capability.bannerClean',
      descKey: 'capabilityDesc.bannerClean',
    },
    {
      key: 'dsh-capability-lazy-load',
      name: 'lazy-load',
      titleKey: 'capability.lazyLoad',
      descKey: 'capabilityDesc.lazyLoad',
    },
    {
      key: 'dsh-capability-anim-freeze',
      name: 'anim-freeze',
      titleKey: 'capability.animFreeze',
      descKey: 'capabilityDesc.animFreeze',
    },
    {
      key: 'dsh-capability-tracking-clean',
      name: 'tracking-clean',
      titleKey: 'capability.trackingClean',
      descKey: 'capabilityDesc.trackingClean',
    },
    {
      key: 'dsh-capability-auto-settle',
      name: 'auto-settle',
      titleKey: 'capability.autoSettle',
      descKey: 'capabilityDesc.autoSettle',
    },
    {
      key: 'dsh-capability-block-media',
      name: 'block-media',
      titleKey: 'capability.blockMedia',
      descKey: 'capabilityDesc.blockMedia',
    },
    {
      key: 'dsh-capability-beacon-block',
      name: 'beacon-block',
      titleKey: 'capability.beaconBlock',
      descKey: 'capabilityDesc.beaconBlock',
    },
    {
      key: 'dsh-capability-safe-click',
      name: 'safe-click',
      titleKey: 'capability.safeClick',
      descKey: 'capabilityDesc.safeClick',
    },
    {
      key: 'dsh-capability-submit-guard',
      name: 'submit-guard',
      titleKey: 'capability.submitGuard',
      descKey: 'capabilityDesc.submitGuard',
    },
    {
      key: 'dsh-capability-tool-groups',
      name: 'tool-groups',
      titleKey: 'capability.toolGroups',
      descKey: 'capabilityDesc.toolGroups',
    },
    {
      key: 'dsh-capability-ptc-mode',
      name: 'ptc-mode',
      titleKey: 'capability.ptcMode',
      descKey: 'capabilityDesc.ptcMode',
      onTitleKey: 'plugins.ptcModeDisable',
      offTitleKey: 'plugins.ptcModeEnable',
    },
  ]

  const loadCapability = useCallback(async (key: string): Promise<void> => {
    const result = await callRpc('capability.get', { key })
    if (result.ok) {
      const value = result.value as { enabled?: unknown } | undefined
      setCapabilityState(current => ({ ...current, [key]: value?.enabled === true }))
    }
  }, [callRpc])

  const toggleCapability = (key: string, next: boolean): void => {
    setCapabilityBusy(key)
    void callRpc('capability.set', { key, enabled: next }).then((result) => {
      setCapabilityBusy(null)
      if (result.ok) {
        const value = result.value as { enabled?: unknown } | undefined
        setCapabilityState(current => ({ ...current, [key]: value?.enabled === true }))
      } else {
        setError(result.error?.message ?? shellT()('plugins.toggleFailed'))
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
      setError(result.error?.message ?? shellT()('plugins.listFailed'))
    }
    setLoading(false)
  }, [callRpc])

  useEffect(() => {
    void load()
    void loadScreenshot()
    for (const capability of DEFAULT_ON_CAPABILITIES) void loadCapability(capability.key)
    const timer = setInterval(() => { void load() }, REFRESH_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [load, loadScreenshot, loadCapability])

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
        setError(result.error?.message ?? shellT()('plugins.toggleFailed'))
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
        setError(result.error?.message ?? shellT()('plugins.removeFailed'))
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
    setHint(shellT()('plugins.generateSent', { session: shortLabel(sessionId) }))
  }

  const canGenerate = aiText.trim() !== ''

  return (
    <div className="dshx-up">
      <div className="dshx-up-head">
        <span className="dshx-up-title">{t('shell.rail.userPlugins')}</span>
        <button type="button" className="dshx-iconbtn" aria-label={t('plugins.closeLabel')} title={t('shell.common.close')} onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="dshx-up-body">
        <div className="dshx-up-inner">
          {hint !== null && <div className="dshx-up-hint">{hint}</div>}
          {error !== null && <div className="dshx-up-error" role="alert">{error}</div>}
          {/* Roster first — the panel's namesake surface. Its section head
              carries the three actions (AI 生成 / 导出 / 导入). */}
          <section className="dshx-up-section">
            <div className="dshx-up-sechead">
              <span className="dshx-up-sectitle">{t('shell.rail.userPlugins')}</span>
              <div className="dshx-up-secops">
                <button type="button" className="dshx-up-portbtn" title={t('plugins.aiGenerateTitle')} onClick={() => { setAiOpen(true); setHint(null) }}>
                  {t('plugins.aiGenerate')}
                </button>
                <button type="button" className="dshx-up-portbtn" title={t('plugins.exportTitle')} onClick={exportRoster}>
                  {t('plugins.export')}
                </button>
                <button type="button" className="dshx-up-portbtn" title={t('plugins.importTitle')} disabled={importBusy} onClick={() => { importInputRef.current?.click() }}>
                  {importBusy ? t('plugins.importing') : t('plugins.import')}
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file !== undefined) importRoster(file)
                    event.target.value = ''
                  }}
                />
              </div>
            </div>
            {aiOpen && (
              <div className="dshx-up-genform">
                <Textarea
                  rows={3}
                  inputSize="sm"
                  value={aiText}
                  placeholder={t('plugins.aiPlaceholder')}
                  onChange={(event) => { setAiText(event.target.value) }}
                />
                <div className="dshx-up-genactions">
                  <Button variant="ghost" size="sm" onClick={() => { setAiOpen(false) }}>
                    {t('shell.common.cancel')}
                  </Button>
                  <Button size="sm" disabled={!canGenerate} onClick={generate}>
                    {t('plugins.sendToAgent')}
                  </Button>
                </div>
              </div>
            )}
            {loading && <div className="dshx-up-loading"><Loader aria-label={t('plugins.loadingLabel')} /><span>{t('plugins.loading')}</span></div>}
            {!loading && items.length === 0 && error === null && (
              <div className="dshx-up-empty">{t('plugins.empty')}</div>
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
                            aria-label={t('plugins.pluginSwitchLabel', { name: item.name })}
                            title={item.enabled ? t('plugins.pluginDisableTitle') : t('plugins.pluginEnableTitle')}
                            onCheckedChange={() => { toggle(item) }}
                          />
                          {pendingDelete ? (
                            <>
                              <Button
                                variant="destructive"
                                size="sm"
                                aria-label={t('plugins.confirmDeletePluginLabel', { name: item.name })}
                                disabled={busy}
                                onClick={() => { remove(item.name) }}
                              >
                                {t('plugins.confirmDelete')}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={t('plugins.cancelDeleteLabel')}
                                onClick={() => { setConfirming(null) }}
                              >
                                {t('shell.common.cancel')}
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="dshx-up-del"
                              aria-label={t('plugins.deletePluginLabel', { name: item.name })}
                              onClick={() => { setConfirming(item.name) }}
                            >
                              {t('shell.rail.delete')}
                            </Button>
                          )}
                        </div>
                      </div>
                      <div className="dshx-up-itemtitle">{item.title}</div>
                      {item.description !== '' && <div className="dshx-up-desc">{item.description}</div>}
                      {item.lastError !== undefined && (
                        <div className="dshx-up-lasterror" role="alert">{t('plugins.lastError', { reason: item.lastError })}</div>
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
          </section>
          {/* Built-in capability: the user-opt-in page screenshot. Rendered as a
              switch row (same affordance) so toggling a first-party capability
              feels exactly like toggling a user plugin. The auto-fill grid packs
              the rows across the full panel width. */}
          {(screenshotEnabled !== null || Object.values(capabilityState).some(value => value !== null && value !== undefined)) && (
            <section className="dshx-up-section">
              <div className="dshx-up-sechead">
                <span className="dshx-up-sectitle">{t('plugins.builtInTitle')}</span>
              </div>
              <div className="dshx-up-capgrid">
                <div className="dshx-up-item">
                  <div className="dshx-up-itemhead">
                    <span className="dshx-up-itemtitle" title="page-screenshot">{t('capability.screenshot')}</span>
                    <div className="dshx-up-itemactions">
                      <Switch
                        size="sm"
                        checked={screenshotEnabled ?? false}
                        disabled={screenshotBusy}
                        aria-label={t('plugins.enableCapabilityLabel', { label: t('capability.screenshot') })}
                        title={screenshotEnabled
                          ? t('plugins.capabilityDisable', { label: t('capability.screenshot') })
                          : t('plugins.capabilityEnable', { label: t('capability.screenshot') })}
                        onCheckedChange={(next) => { toggleScreenshot(next) }}
                      />
                    </div>
                  </div>
                  <div className="dshx-up-desc">{t('capabilityDesc.screenshot')}</div>
                </div>
                {DEFAULT_ON_CAPABILITIES.map((capability) => {
                  const enabled = capabilityState[capability.key]
                  const busy = capabilityBusy === capability.key
                  if (enabled === null || enabled === undefined) return null
                  const title = t(capability.titleKey)
                  return (
                    <div key={capability.key} className="dshx-up-item">
                      <div className="dshx-up-itemhead">
                        <span className="dshx-up-itemtitle" title={capability.name}>{title}</span>
                        <div className="dshx-up-itemactions">
                          <Switch
                            size="sm"
                            checked={enabled}
                            disabled={busy}
                            aria-label={t('plugins.enableCapabilityLabel', { label: title })}
                            title={enabled
                              ? t(capability.onTitleKey ?? 'plugins.capabilityDisable', { label: title })
                              : t(capability.offTitleKey ?? 'plugins.capabilityEnable', { label: title })}
                            onCheckedChange={(next) => { toggleCapability(capability.key, next) }}
                          />
                        </div>
                      </div>
                      <div className="dshx-up-desc">{t(capability.descKey)}</div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
          {/* Services entry row: the account/credentials/MCP/scheduled-tasks/
              About cards live in the sibling「服务」panel — the full-page rail
              opens it directly; this row is the narrow side panel's only
              route (no rail, no extra header button). */}
          <section className="dshx-up-section">
            <button
              type="button"
              className="dshx-up-servicerow"
              aria-label={updateAvailable === true ? t('plugins.servicesOpenUpdateLabel') : t('plugins.servicesOpenLabel')}
              onClick={onOpenServices}
            >
              <span className="dshx-up-itemtitle">{t('plugins.servicesTitle')}</span>
              {updateAvailable === true && <span className="dshx-updot" aria-hidden="true" />}
              <ChevronRightIcon size={14} />
            </button>
            <div className="dshx-up-desc">{t('plugins.servicesDesc')}</div>
          </section>
        </div>
      </div>
    </div>
  )
}

/**
 * Panel stylesheet — layout skeleton only. Every control's visual language
 * (switch, buttons, textarea, event badges) comes from @appica/ui-react via
 * `appica.generated.css` (imported below); the classes kept here cover the
 * overlay frame, section cards, the two-column management row, and text
 * hierarchy, on the shell's `--dsw-alias-*` tokens plus Appica's own
 * `--error` token so the alert line follows the same light/dark palettes.
 *
 * Button discipline: rows (`.dshx-up-genactions`, `.dshx-up-secops`,
 * `.dshx-up-itemactions`) wrap as whole buttons on narrow windows, and event
 * badges stay atomic between wrapping.
 */
export const USER_PLUGIN_PANEL_CSS = `
.dshx-up{display:flex;flex-direction:column;height:100%;min-height:0}
/* Full-bleed overlay mount: the panel fills the whole SidePanel window the
   same way the settings sheet does (viewport-fixed above everything). */
.dshx-up-overlay{position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff)}
.dshx-up-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.dshx-up-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}
/* the header trigger's pressed state (the shell's .dshx-iconbtn base lives in SHELL_CSS) */
.dshx-iconbtn.is-active{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#333)}
.dshx-up-body{flex:1;min-height:0;overflow-y:auto;padding:16px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.35)) transparent}
/* centered content column: full width is usable, very wide panels stay sane */
.dshx-up-inner{width:100%;max-width:1080px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
/* unified section card material — the same card the roster rows use */
.dshx-up-section{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03))}
.dshx-up-sechead{display:flex;align-items:center;gap:8px}
.dshx-up-sectitle{min-width:0;font-size:12.5px;font-weight:600}
.dshx-up-secops{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshx-up-portbtn{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#777);cursor:pointer;font-size:11.5px;white-space:nowrap;transition:color .15s ease,border-color .15s ease}
.dshx-up-portbtn:hover{color:var(--dsw-alias-label-primary,#333);border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.22))}
.dshx-up-portbtn:disabled{opacity:.6;cursor:default}
/* the「服务」entry row: a whole-row button (icon trailing) inside a section card */
.dshx-up-servicerow{display:flex;align-items:center;gap:8px;width:100%;padding:0;border:0;background:transparent;color:inherit;cursor:pointer;font-size:12px;font-weight:600;text-align:left}
.dshx-up-servicerow:hover{color:var(--dsw-alias-brand-primary,#4c7dfd)}
.dshx-up-servicerow svg{margin-left:auto;color:var(--dsw-alias-label-tertiary,#aaa)}
.dshx-up-genform{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:10px;background:var(--dsw-alias-bg-base,#fff)}
.dshx-up-genactions{display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap}
.dshx-up-hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#888)}
.dshx-up-error{font-size:11px;line-height:1.6;word-break:break-word;color:var(--error,#dc2626)}
.dshx-up-empty{padding:16px 12px;font-size:12px;line-height:1.7;text-align:center;color:var(--dsw-alias-label-tertiary,#aaa)}
/* the 关于 row: version + 检查更新 */
.dshx-up-aboutrow{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dshx-up-version{font-size:11.5px;color:var(--dsw-alias-label-secondary,#777)}
.dshx-up-about a{color:var(--dsw-alias-brand-primary,#4c7dfd)}
.dshx-up-loading{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#888)}
.dshx-up-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.dshx-up-item{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;background:var(--dsw-alias-bg-base,#fff)}
.dshx-up-itemhead{display:flex;align-items:center;gap:8px;min-width:0}
.dshx-up-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dshx-up-itemtitle{min-width:0;font-size:12px;font-weight:600}
.dshx-up-itemhead .dshx-up-itemtitle{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshx-up-itemactions{flex:none;margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshx-up-del{color:var(--dsw-alias-label-secondary,#888)}
/* built-in capability rows pack across the panel width */
.dshx-up-capgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
.dshx-up-desc{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#888);word-break:break-word}
.dshx-up-lasterror{font-size:11px;line-height:1.6;word-break:break-word;color:var(--error,#dc2626)}
.dshx-up-events{display:flex;flex-wrap:wrap;gap:4px}
.dshx-up-event{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap}
/* management cards on two columns; stacked below the narrow breakpoint */
.dshx-up-cols{display:flex;align-items:flex-start;gap:12px}
.dshx-up-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:12px}
@media (max-width:619px){.dshx-up-cols{flex-direction:column}}
`
