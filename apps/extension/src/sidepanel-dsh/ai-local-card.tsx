/**
 * `AiLocalCard`: the services panel's「本地 AI」card — the panel-side
 * consumer of the `aiLocal.*` RPC family. Renders the machine's device tiers
 * (WebGPU real / SwiftShader software / missing, built-in Gemini Nano) and
 * the on-device model catalog with each entry's lifecycle state. Planned
 * roadmap rows render as 敬请期待; concrete entries carry a 下载 button whose
 * errors surface on the row (never silently swallowed). While an install is
 * in flight the card polls the catalog at 2 s so the row flips to 已就绪 the
 * moment the manager finishes — the install RPC itself can take many minutes
 * (model downloads) and may outlive the card's view.
 *
 * @module ai-local-card
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { rpc } from './rpc-client.ts'
import { AI_LOCAL_LABEL_KEYS, AI_LOCAL_PURPOSE_KEYS } from './locales/ai-local.ts'
import { shellT, useShellT } from './locales/index.ts'
import type { ShellLocaleKey } from './locales/index.ts'

/** The device-tier block of the `aiLocal.catalog` view. */
interface DeviceView {
  webgpu: 'real' | 'software' | 'unavailable'
  geminiNano: 'ready' | 'downloadable' | 'unavailable' | 'unsupported'
}

/** One catalog row as the card renders it. */
interface ModelRow {
  id: string
  label: string
  purposeZh: string
  declaredBytes: number
  minDevice: 'any' | 'webgpu'
  planned: boolean
  state: 'unavailable' | 'ready' | 'failed'
  error?: string
  sizeBytes?: number
}

/** The whole `aiLocal.catalog` value. */
interface AiLocalCatalogView {
  device: DeviceView & { at: number }
  models: ModelRow[]
}

/** One usage-ledger row (`aiLocal.usage`). */
interface UsageEntry {
  ts: number
  capability: string
  model: string
  durationMs: number
  detail: string
  selfTest?: boolean
}

/** Dictionary keys for the usage ledger's capability column; an uncatalogued capability renders its wire value. */
const CAPABILITY_LABEL_KEYS: Record<string, ShellLocaleKey> = {
  ocr: 'aiLocal.capability.ocr',
  caption: 'aiLocal.capability.caption',
  asr: 'aiLocal.capability.asr',
  embed: 'aiLocal.capability.embed',
}

/** Dictionary keys for the WebGPU tier. */
const WEBGPU_LABEL_KEYS: Record<DeviceView['webgpu'], ShellLocaleKey> = {
  real: 'aiLocal.webgpu.real',
  software: 'aiLocal.webgpu.software',
  unavailable: 'aiLocal.webgpu.unavailable',
}

/** Dictionary keys for the built-in Gemini Nano tier. */
const NANO_LABEL_KEYS: Record<DeviceView['geminiNano'], ShellLocaleKey> = {
  ready: 'aiLocal.nano.ready',
  downloadable: 'aiLocal.nano.downloadable',
  unavailable: 'aiLocal.nano.unavailable',
  unsupported: 'aiLocal.nano.unsupported',
}

/** Format one byte count as a compact MB estimate. */
function mbLabel(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))}MB`
}

/**
 * Render the on-device AI section.
 * @returns the section body.
 */
export function AiLocalCard(): JSX.Element {
  const t = useShellT()
  const [view, setView] = useState<AiLocalCatalogView | null>(null)
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState('')
  /** Per-row install failure text (the row's own error line, not the panel's). */
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({})
  const [usage, setUsage] = useState<UsageEntry[]>([])
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const outcome = await rpc('aiLocal.catalog', {}, 15_000)
    if (!mounted.current) return
    if (outcome.ok) {
      setView((outcome.value ?? null) as AiLocalCatalogView | null)
      setError('')
    } else {
      setError(outcome.error?.message ?? shellT()('aiLocal.catalogReadFailed'))
    }
    const usageOutcome = await rpc('aiLocal.usage', {}, 10_000)
    if (!mounted.current) return
    if (usageOutcome.ok) {
      const value = usageOutcome.value as { entries?: UsageEntry[] } | undefined
      setUsage(Array.isArray(value?.entries) ? value.entries : [])
    }
  }, [])

  /**
   * Install one model and surface every failure on the row. The RPC budget
   * covers the slowest mirror download (hundreds of MB); while it runs, a
   * 2 s catalog poll flips the row to 已就绪 as soon as the manager settles
   * — including when this RPC has already timed out but the manager-side
   * install is still going.
   */
  const install = useCallback(async (id: string): Promise<void> => {
    setInstallErrors(previous => ({ ...previous, [id]: '' }))
    setInstalling(id)
    const outcome = await rpc('aiLocal.install', { id }, 600_000)
    if (!mounted.current) return
    const value = outcome.value as { ok?: boolean; error?: string } | undefined
    if (!outcome.ok || !value?.ok) {
      const detail = value?.error ?? outcome.error?.message ?? shellT()('aiLocal.installFailed')
      setInstallErrors(previous => ({ ...previous, [id]: detail.slice(0, 200) }))
    }
    setInstalling('')
    await refresh()
  }, [refresh])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 8_000)
    return () => { clearInterval(timer) }
  }, [refresh])

  // While any install is in flight, poll faster so the row's state change
  // (下载中 → 已就绪/失败) lands promptly even after an RPC timeout.
  useEffect(() => {
    if (installing === '') return undefined
    const timer = setInterval(() => { void refresh() }, 2_000)
    return () => { clearInterval(timer) }
  }, [installing, refresh])

  return (
    <section className="dshx-up-section">
      <div className="dshx-up-sechead">
        <span className="dshx-up-sectitle">{t('aiLocal.title')}</span>
        <button type="button" className="dshx-up-portbtn" onClick={() => { void refresh() }}>{t('aiLocal.refresh')}</button>
      </div>
      {view !== null && (
        <div className="dshx-up-hint">
          {t('aiLocal.deviceLine', { webgpu: t(WEBGPU_LABEL_KEYS[view.device.webgpu]), nano: t(NANO_LABEL_KEYS[view.device.geminiNano]) })}
        </div>
      )}
      {view !== null && view.models.map((model) => {
        const rowError = installErrors[model.id] ?? (model.state === 'failed' ? model.error ?? t('shell.transcript.failed') : '')
        const purposeKey = AI_LOCAL_PURPOSE_KEYS[model.id]
        const labelKey = AI_LOCAL_LABEL_KEYS[model.id]
        return (
          <div key={model.id} className="dshx-up-aboutrow">
            <span className="dshx-up-version">
              {t('aiLocal.rowMeta', {
                label: labelKey === undefined ? model.label : t(labelKey),
                size: mbLabel(model.declaredBytes),
                gpu: model.minDevice === 'webgpu' ? t('aiLocal.needsGpu') : '',
                purpose: purposeKey === undefined ? model.purposeZh : t(purposeKey),
              })}
            </span>
            {model.state === 'ready'
              ? <span className="dshx-up-hint">{t('aiLocal.ready')}</span>
              : model.planned
                ? <span className="dshx-up-hint">{t('aiLocal.planned')}</span>
                : installing === model.id
                  ? <span className="dshx-up-hint">{t('aiLocal.downloading', { size: mbLabel(model.declaredBytes) })}</span>
                  : <button
                    type="button"
                    className="dshx-up-portbtn"
                    onClick={() => { void install(model.id) }}
                  >{t('aiLocal.download')}</button>}
            {rowError !== '' && <div className="dshx-up-error" role="alert">{rowError}</div>}
          </div>
        )
      })}
      {usage.length > 0 && (
        <div className="dshx-up-hint">
          {t('aiLocal.recentTitle')}
          {usage.slice(0, 5).map((entry) => {
            const capabilityKey = CAPABILITY_LABEL_KEYS[entry.capability]
            return (
              <div key={entry.ts}>
                {t('aiLocal.usageEntry', {
                  time: new Date(entry.ts).toLocaleTimeString(),
                  capability: capabilityKey === undefined ? entry.capability : t(capabilityKey),
                  model: entry.model,
                  selfTest: entry.selfTest === true ? t('aiLocal.selfTest') : '',
                  seconds: (Math.max(1, Math.round(entry.durationMs / 100) / 10)).toFixed(1),
                  detail: entry.detail,
                })}
              </div>
            )
          })}
          {usage.length > 5 ? <div>{t('aiLocal.archived', { count: usage.length - 5 })}</div> : ''}
        </div>
      )}
      {error !== '' && <div className="dshx-up-error" role="alert">{error}</div>}
    </section>
  )
}
