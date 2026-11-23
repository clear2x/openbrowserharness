/**
 * `extension-presets-page`: the extension-native Agent 预设 settings section —
 * the settings sheet's drill-down page for the chrome.storage preset roster
 * the api-bridge serves (`agentPreset.list/read/write/remove` + the
 * `agent-presets` settings namespace's `default` field). It replaces the
 * upstream ui-agent-preset section in this host: that page's cards are
 * desktop-lane (its help/guide surface and its conversational Creator entry
 * both key off services this graph never mounts), and it offers no way to
 * author a preset — the one thing this host's roster is for. The upstream
 * bundle stays staged (the composer's preset chip rides its conversation
 * seats); the settings menu simply filters its row out and renders this page
 * instead (see settings-root's createSectionsSource).
 *
 * Page capabilities: group the roster (内置 vs 自定义 by trust), make-default
 * (`settings.update` on the `agent-presets` ns), view the stored document
 * (`agentPreset.read`, read-only pre), delete a user row (two-step, shipped
 * rows refused server-side), and author: the ＋新建预设 form (and 编辑 for a
 * user row) writes through `agentPreset.write` — id/name/description/
 * systemPrompt, the exact stored shape the engine consumes at session
 * create/select.
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { rpc } from './rpc-client.ts'
import { CheckIcon, CloseIcon, PencilIcon, TrashIcon } from './icons.tsx'
import { CAPABILITY_FALLBACKS, isCapabilityKey } from '../shared/capability-keys.ts'
import { capabilityLabel, hasCapabilityLabel } from './locales/capabilities.ts'
import { shellT, useShellT } from './locales/index.ts'
import { agentPresetDescription, agentPresetName } from './locales/preset-labels.ts'

/** One `agentPreset.list` roster row (wire view). */
interface PresetRow {
  readonly id: string
  readonly trust: 'system' | 'user'
  readonly isDefault: boolean
  readonly name?: string
  readonly description?: string
  readonly broken?: string
  /** 能力开关预设（agentPreset.list 透传；缺省=全部跟随默认）。 */
  readonly capabilities?: Record<string, boolean>
}

/** `agentPreset.list` ok value (wire view). */
interface PresetListValue {
  presets?: PresetRow[]
}

/** The authoring form's editable fields (id is fixed while editing). */
interface PresetDraft {
  id: string
  name: string
  description: string
  systemPrompt: string
}

const EMPTY_DRAFT: PresetDraft = { id: '', name: '', description: '', systemPrompt: '' }

/** 能力开关的编辑态：值 + 是否被用户碰过（未碰过的键不写入，跟随默认）。 */
interface CapabilityEdits {
  values: Record<string, boolean>
  touched: Set<string>
}

const emptyCapabilityEdits = (): CapabilityEdits => ({ values: {}, touched: new Set() })

/** 初值：预设显式声明优先，否则读该键的出厂默认。 */
function initialCapabilityValues(explicit: Record<string, boolean> | undefined): Record<string, boolean> {
  const values: Record<string, boolean> = {}
  for (const [key, fallback] of Object.entries(CAPABILITY_FALLBACKS)) {
    values[key] = explicit?.[key] ?? fallback
  }
  return values
}

/** The preset document viewer overlay's content. */
interface PresetDoc {
  readonly title: string
  readonly content: string
}

/**
 * Render the drill-down page: roster groups, per-row actions, and the
 * authoring form. All writes go through the api-bridge; every action
 * refreshes the roster read so the page never drifts from storage.
 */
export function AgentPresetsPage(): JSX.Element {
  const t = useShellT()
  const [rows, setRows] = useState<readonly PresetRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<PresetDraft | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [capabilityEdits, setCapabilityEdits] = useState<CapabilityEdits>(emptyCapabilityEdits())
  const [doc, setDoc] = useState<PresetDoc | null>(null)
  const [deleteArm, setDeleteArm] = useState<string | null>(null)

  const load = useCallback((): void => {
    void rpc('agentPreset.list', {}).then((result) => {
      if (!result.ok) {
        setError(result.error?.message ?? shellT()('presets.error.listFailed'))
        return
      }
      setError(null)
      setRows((result.value as PresetListValue | undefined)?.presets ?? [])
    }).catch(() => { setError(shellT()('presets.error.listFailed')) })
  }, [])
  useEffect(() => { load() }, [load])

  const makeDefault = useCallback((id: string): void => {
    void rpc('settings.update', { ns: 'agent-presets', patch: { default: id } }).then((result) => {
      if (!result.ok) {
        setError(result.error?.message ?? shellT()('presets.error.defaultFailed'))
        return
      }
      load()
    }).catch(() => { setError(shellT()('presets.error.defaultFailed')) })
  }, [load])

  const openCreate = useCallback((): void => {
    setDraftError(null)
    setCapabilityEdits(emptyCapabilityEdits())
    setDraft({ ...EMPTY_DRAFT })
  }, [])

  const readPreset = useCallback(async (id: string): Promise<{ description?: string; content?: string } | undefined> => {
    const result = await rpc('agentPreset.read', { agentPreset: id })
    if (!result.ok) {
      setError(result.error?.message ?? shellT()('presets.error.readFailed'))
      return undefined
    }
    setError(null)
    return result.value as { description?: string; content?: string } | undefined
  }, [])

  const openEdit = useCallback((row: PresetRow): void => {
    void readPreset(row.id).then((value) => {
      if (value === undefined) return
      setDraftError(null)
      // Saved keys are explicit settings: they must re-enter the edit as
      // touched, or a no-touch re-save drops them (write spreads touched
      // keys only).
      const savedKeys = Object.keys(row.capabilities ?? {}).filter(isCapabilityKey)
      setCapabilityEdits({
        values: initialCapabilityValues(row.capabilities),
        touched: new Set(savedKeys),
      })
      // The document body is the stored shape pretty-printed; the form edits
      // the stored fields, and the prompt field is the addendum section.
      setDraft({
        id: row.id,
        name: row.name ?? row.id,
        description: value.description ?? '',
        systemPrompt: extractPromptAddendum(value.content ?? ''),
      })
    }).catch(() => { setError(shellT()('presets.error.readFailed')) })
  }, [readPreset])

  const saveDraft = useCallback((): void => {
    if (draft === null || saving) return
    const id = draft.id.trim()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      setDraftError(shellT()('presets.error.idInvalid'))
      return
    }
    setSaving(true)
    setDraftError(null)
    const capabilities = Object.fromEntries(
      [...capabilityEdits.touched].map(key => [key, capabilityEdits.values[key] ?? false]),
    )
    void rpc('agentPreset.write', {
      agentPreset: id,
      ...(draft.name.trim() === '' ? {} : { name: draft.name.trim() }),
      ...(draft.description.trim() === '' ? {} : { description: draft.description.trim() }),
      ...(draft.systemPrompt.trim() === '' ? {} : { systemPrompt: draft.systemPrompt }),
      ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
    }).then((result) => {
      setSaving(false)
      if (!result.ok) {
        setDraftError(result.error?.message ?? shellT()('presets.error.saveFailed'))
        return
      }
      setDraft(null)
      load()
    }).catch(() => {
      setSaving(false)
      setDraftError(shellT()('presets.error.saveFailed'))
    })
  }, [draft, saving, capabilityEdits, load])

  const remove = useCallback((id: string): void => {
    void rpc('agentPreset.remove', { agentPreset: id }).then((result) => {
      setDeleteArm(null)
      if (!result.ok) {
        setError(result.error?.message ?? shellT()('presets.error.removeFailed'))
        return
      }
      load()
    }).catch(() => { setError(shellT()('presets.error.removeFailed')) })
  }, [load])

  const viewDoc = useCallback((row: PresetRow): void => {
    void readPreset(row.id).then((value) => {
      if (value === undefined) return
      setDoc({ title: agentPresetName(shellT(), row), content: value.content ?? '' })
    }).catch(() => { setError(shellT()('presets.error.readFailed')) })
  }, [readPreset])

  const builtIn = rows.filter(row => row.trust === 'system')
  const custom = rows.filter(row => row.trust !== 'system')

  return (
    <div className="dshx-sproot" data-settings-page="presets">
      {error !== null && <p className="dshx-sperror" role="alert">{error}</p>}

      <h3 className="dshx-sphead">{t('presets.builtIn')}</h3>
      <ul className="dshx-splist">
        {builtIn.map(row => (
          <PresetItem
            key={row.id}
            row={row}
            onMakeDefault={() => { makeDefault(row.id) }}
            onView={() => { viewDoc(row) }}
          />
        ))}
      </ul>

      <h3 className="dshx-sphead">{t('presets.custom')}</h3>
      <ul className="dshx-splist">
        {custom.map(row => (
          <PresetItem
            key={row.id}
            row={row}
            onMakeDefault={() => { makeDefault(row.id) }}
            onView={() => { viewDoc(row) }}
            onEdit={() => { openEdit(row) }}
            deleteArmed={deleteArm === row.id}
            onArmDelete={() => { setDeleteArm(current => current === row.id ? null : row.id) }}
            onDelete={() => { remove(row.id) }}
          />
        ))}
        {custom.length === 0 && <li className="dshx-spempty">{t('presets.emptyCustom')}</li>}
      </ul>
      <button type="button" className="dshx-spcreate" onClick={openCreate}>{t('presets.create')}</button>

      {draft !== null && (
        <div className="dshx-spform">
          <div className="dshx-spform-row">
            <label className="dshx-spfield">
              <span className="dshx-spfield-label">{t('presets.field.id')}</span>
              <input
                className="dshx-spinput"
                value={draft.id}
                disabled={saving}
                placeholder="my-preset"
                onChange={(event) => { setDraft({ ...draft, id: event.target.value }) }}
              />
            </label>
            <label className="dshx-spfield">
              <span className="dshx-spfield-label">{t('presets.field.name')}</span>
              <input
                className="dshx-spinput"
                value={draft.name}
                disabled={saving}
                placeholder={t('presets.namePlaceholder')}
                onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }}
              />
            </label>
          </div>
          <label className="dshx-spfield">
            <span className="dshx-spfield-label">{t('presets.field.description')}</span>
            <input
              className="dshx-spinput"
              value={draft.description}
              disabled={saving}
              placeholder={t('presets.descriptionPlaceholder')}
              onChange={(event) => { setDraft({ ...draft, description: event.target.value }) }}
            />
          </label>
          <label className="dshx-spfield">
            <span className="dshx-spfield-label">{t('presets.field.systemPrompt')}</span>
            <textarea
              className="dshx-sptext"
              rows={6}
              value={draft.systemPrompt}
              disabled={saving}
              placeholder={t('presets.promptPlaceholder')}
              onChange={(event) => { setDraft({ ...draft, systemPrompt: event.target.value }) }}
            />
          </label>
          <div className="dshx-auto-field">
            <span className="dshx-auto-fieldlabel">
              {t('presets.capabilitiesLabel')}
              <button
                type="button"
                className="dshx-auto-planremove"
                onClick={() => { setCapabilityEdits(emptyCapabilityEdits()) }}
              >{t('presets.followAllDefault')}</button>
            </span>
            <div className="dshx-spcaps">
              {Object.keys(CAPABILITY_FALLBACKS).filter(key => key !== 'dsh-capability-ptc-mode' && isCapabilityKey(key) && hasCapabilityLabel(key)).map((key) => {
                const touched = capabilityEdits.touched.has(key)
                const on = capabilityEdits.values[key] ?? false
                return (
                  <button
                    key={key}
                    type="button"
                    className={`dshx-spcap${touched ? ' is-touched' : ''}${on ? ' is-on' : ''}`}
                    aria-pressed={touched ? on : undefined}
                    title={touched ? (on ? t('presets.capOnTitle') : t('presets.capOffTitle')) : t('presets.capUnsetTitle')}
                    onClick={() => {
                      setCapabilityEdits(current => ({
                        values: { ...current.values, [key]: !(current.touched.has(key) ? current.values[key] ?? false : on) },
                        touched: new Set([...current.touched, key]),
                      }))
                    }}
                  >{capabilityLabel(t, key)}</button>
                )
              })}
            </div>
            <div className="dshx-auto-planzone">{t('presets.capsNote')}</div>
          </div>
          {draftError !== null && <p className="dshx-sperror" role="alert">{draftError}</p>}
          <div className="dshx-spform-actions">
            <button type="button" className="dshx-ghostbtn" disabled={saving} onClick={() => { setDraft(null) }}>{t('shell.common.cancel')}</button>
            <button type="button" className="dshx-primarybtn" disabled={saving} onClick={saveDraft}>{t('presets.save')}</button>
          </div>
        </div>
      )}

      {doc !== null && (
        <div className="dshx-spdocovl" role="presentation">
          <div className="dshx-spdocmask" aria-hidden="true" onClick={() => { setDoc(null) }} />
          <div className="dshx-spdoc" role="dialog" aria-modal="true" aria-label={t('presets.docLabel', { name: doc.title })}>
            <div className="dshx-spdochead">
              <span className="dshx-spdoctitle">{t('presets.docTitle', { name: doc.title })}</span>
              <button type="button" className="dshx-setclose" aria-label={t('shell.common.close')} onClick={() => { setDoc(null) }}>
                <CloseIcon size={14} />
              </button>
            </div>
            <pre className="dshx-spdoccode">{doc.content}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

/** One roster row: identity line, description, and its action buttons. */
function PresetItem({
  row, onMakeDefault, onView, onEdit, deleteArmed, onArmDelete, onDelete,
}: {
  readonly row: PresetRow
  readonly onMakeDefault: () => void
  readonly onView: () => void
  readonly onEdit?: () => void
  readonly deleteArmed?: boolean
  readonly onArmDelete?: () => void
  readonly onDelete?: () => void
}): JSX.Element {
  const t = useShellT()
  const name = agentPresetName(t, row)
  const description = agentPresetDescription(t, row)
  return (
    <li className={`dshx-sprow${row.isDefault ? ' is-default' : ''}${row.broken !== undefined ? ' is-broken' : ''}`}>
      <div className="dshx-sprow-main">
        <span className="dshx-sprow-top">
          <span className="dshx-sprow-name" title={row.broken ?? undefined}>{name}</span>
          <span className={`dshx-sptag${row.isDefault ? ' is-solid' : ''}`}>{row.isDefault ? t('presets.tagDefault') : row.trust === 'system' ? t('presets.builtIn') : t('presets.custom')}</span>
          <code className="dshx-spid" title={row.id}>{row.id}</code>
        </span>
        {description !== undefined && description !== '' && <p className="dshx-sprow-desc">{description}</p>}
        {row.broken !== undefined && <p className="dshx-sperror" role="alert">{row.broken}</p>}
      </div>
      <div className="dshx-sprow-actions">
        {!row.isDefault && <button type="button" className="dshx-spact" title={t('presets.makeDefaultTitle')} onClick={onMakeDefault}>{t('presets.makeDefault')}</button>}
        <button type="button" className="dshx-spact" onClick={onView}>{t('presets.view')}</button>
        {onEdit !== undefined && (
          <button type="button" className="dshx-spact" aria-label={t('presets.editLabel', { name })} title={t('presets.edit')} onClick={onEdit}>
            <PencilIcon size={12} />
          </button>
        )}
        {onDelete !== undefined && (
          <button
            type="button"
            className={`dshx-spact is-armed${deleteArmed === true ? ' is-arming' : ''}`}
            aria-label={deleteArmed === true ? t('presets.deleteConfirmLabel', { name }) : t('presets.deleteLabel', { name })}
            title={deleteArmed === true ? t('shell.rail.deleteConfirmAgain') : t('shell.rail.delete')}
            onClick={() => { if (deleteArmed === true) onDelete(); else onArmDelete?.() }}
          >
            {deleteArmed === true ? <CheckIcon size={12} /> : <TrashIcon size={12} />}
          </button>
        )}
      </div>
    </li>
  )
}

/**
 * The stored document is pretty-printed JSON (presetDocument in api-bridge);
 * the 编辑 form wants the `systemPrompt` field back. Parses the JSON and
 * reads the field, falling back to empty when the shape is unrecognized.
 */
function extractPromptAddendum(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content)
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { systemPrompt?: unknown }).systemPrompt === 'string') {
      return (parsed as { systemPrompt: string }).systemPrompt
    }
  } catch {
    // Not JSON (an older document shape): no structured field to extract.
  }
  return ''
}
