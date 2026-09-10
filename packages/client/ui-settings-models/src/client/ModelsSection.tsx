/**
 * Models settings section, laid out like a provider manager: a left rail of
 * providers (官方 group — one row per official preset, then every hand-declared
 * route, then the dashed 「+ 添加供应商」 entry) and one right-hand form for
 * the selection. Each rail row paints its key state as a status dot — green
 * when the provider can serve requests (key stored, or a keyless route that is
 * live), gray otherwise — and a successful 测试连接 repaints the selected row
 * green for the session. The rail also marks the engine's default provider
 * (默认 tag) and lets any other row switch to it (设为默认, one
 * `settings.mutate` path op on the shared engine-settings section), with each
 * row's default model caption underneath.
 *
 * The host stays the single fact source: every mutation writes through the
 * wire (`credentials.set`, `settings.mutate`) and the page re-renders from the
 * next describe, pushed or refetched. A route removal first requires
 * confirmation; the whole-section official routes have no removable profile.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, IconGlobeOutline14, IconLinkOutline16, IconPlusOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import { CustomRoutePanel } from './CustomRoutePanel.tsx'
import { DeepSeekPanel } from './DeepSeekPanel.tsx'
import { PresetModelsSection } from './PresetModelsSection.tsx'
import { NewProviderPanel } from './NewProviderPanel.tsx'
import { defaultModelOf, deriveKeyRef, messageOf, protocolChoices, providerUsable } from './store.ts'
import type { ModelsSettingsState, ModelsSettingsStore, OfficialProviderEntry, ProviderRow } from './store.ts'
import type { ProbeSummary } from './probe.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Injected dependencies of {@link ModelsSection} (slot `inject`). */
export interface ModelsSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ModelsSettingsStore
  /** uSES subscription hook bound to the store. */
  useSnapshot: SnapshotSelectorHook<ModelsSettingsState>
  /** Wire faces the editor writes through. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type ModelsSectionProps = Partial<ModelsSectionInjected>

/** Provider identity shared by row actions and confirmation copy. */
export interface ProviderIdentity {
  /** Stable provider route id. */
  provider: string
  /** Human-facing provider name. */
  displayName: string
}

/** The whole-section official route, keyed by its preset id. */
const OFFICIAL_PROVIDER = 'deepseek'

/**
 * Refusal for removing the provider the engine currently routes requests to:
 * deletion would leave the default dangling (the composer names a model with
 * no route), so the delete stays blocked until the default moves elsewhere.
 */
export const DEFAULT_PROVIDER_DELETE_REFUSED = '该供应商是当前默认供应商，请先切换默认再删除'

/** Right-pane sentinel selecting the add-supplier wizard. */
const NEW_PROVIDER = '@new'

/** One removable custom route addressed by the delete confirmation. */
interface DeleteTarget extends ProviderIdentity {
  settingsNs: string
  settingsPath: readonly string[]
  /** The page-managed credential, when this route's profile named one. */
  credentialRef?: string
}

/** The custom route a rail row addresses, with its removable credential. */
function deleteTargetOf(row: ProviderRow): DeleteTarget {
  const managedRef = deriveKeyRef(row.entry.provider)
  const credentialRef = row.apiKeyEnv === managedRef
    && row.credential?.configured === true
    && row.credential.writable
    ? managedRef
    : undefined
  return {
    provider: row.entry.provider,
    displayName: row.entry.displayName,
    settingsNs: row.entry.settingsNs,
    settingsPath: row.entry.settingsPath,
    ...credentialRef === undefined ? {} : { credentialRef },
  }
}

/**
 * Remove one user-added provider and its page-managed credential. Credential
 * removal comes first so a second-step failure leaves the provider row visible
 * and the whole operation safely retryable; both unsets are idempotent.
 * The settings removal names the profile rather than rebuilding its whole
 * namespace from a partial view. Removing the provider the engine currently
 * uses as default is refused before any write: the default would otherwise
 * dangle (the composer names a model with no route behind it).
 * @param api - settings and credential wire faces.
 * @param controller - the page store to refresh.
 * @param target - the provider's settings address and optional managed credential.
 * @param defaultProvider - the engine's current default provider route; when
 * it equals the target's route id, the removal is refused.
 * @returns the failure message, or undefined once the write and reload landed.
 */
export async function removeProviderProfile(
  api: Pick<IApiClient, 'settings' | 'credentials'>,
  controller: ModelsSettingsStore,
  target: { settingsNs: string; settingsPath: readonly string[]; credentialRef?: string },
  defaultProvider?: string,
): Promise<string | undefined> {
  if (defaultProvider !== undefined && defaultProvider !== ''
    && target.settingsPath[target.settingsPath.length - 1] === defaultProvider) {
    return DEFAULT_PROVIDER_DELETE_REFUSED
  }
  try {
    if (target.credentialRef !== undefined) {
      const credential = await api.credentials.unset({ ref: target.credentialRef })
      if (!credential.result.ok) return credential.result.error.message
    }
    const response = await api.settings.mutate({
      ns: target.settingsNs,
      ops: [{ op: 'unset', path: [...target.settingsPath] }],
    })
    if (!response.result.ok) return response.result.error.message
  } catch (error) {
    // The transport rejected rather than answering; the caller must be able
    // to retry the idempotent operation instead of the row silently staying.
    return messageOf(error)
  }
  await controller.load()
  return undefined
}

/** Stable visible and accessible identity for one provider target. */
export function providerTargetLabel(target: ProviderIdentity): string {
  return target.provider === target.displayName
    ? target.provider
    : `${target.displayName} (${target.provider})`
}

/** Replace the one provider placeholder in localized destructive-action copy. */
export function providerCopy(template: string, target: ProviderIdentity): string {
  return template.replace('{provider}', () => providerTargetLabel(target))
}

/**
 * Render the Models section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, api, t } = props
  if (controller === undefined || useSnapshot === undefined || api === undefined || t === undefined) return null
  return <Loaded injected={{ controller, useSnapshot, api, t }} />
}

function Loaded({ injected }: { injected: ModelsSectionInjected }): ReactNode {
  const { controller, api, t } = injected
  const state = injected.useSnapshot(snapshot => snapshot)
  // The right pane's subject: the official preset, one declared route, or the
  // add-supplier wizard. `lastPicked` is where 取消 in the wizard returns to.
  const [selected, setSelected] = useState<string>(OFFICIAL_PROVIDER)
  const [lastPicked, setLastPicked] = useState<string>(OFFICIAL_PROVIDER)
  // Probe verdicts per provider, for the session: a settled 测试连接 repaints
  // that row's rail dot and shows under the form until the next verdict.
  const [verdicts, setVerdicts] = useState<ReadonlyMap<string, ProbeSummary>>(() => new Map())
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedIdentity, setSavedIdentity] = useState<ProviderIdentity | undefined>(undefined)
  const [defaultBusy, setDefaultBusy] = useState(false)
  const [defaultFailure, setDefaultFailure] = useState<string | undefined>(undefined)

  // The engine's active default provider, from the shared engine-settings
  // section; rows compare their route id against it for the 默认 tag, and the
  // delete confirmation refuses to remove the row that carries it.
  const currentProvider = (() => {
    const engineValue = state.namespaces.get('llm-deepseek')?.value
    if (typeof engineValue !== 'object' || engineValue === null) return undefined
    const provider = (engineValue as { provider?: unknown }).provider
    return typeof provider === 'string' && provider.length > 0 ? provider : undefined
  })()
  const defaultMissing = currentProvider !== undefined
    && !state.rows.some(row => row.entry.provider === currentProvider)

  const pick = (provider: string): void => {
    setSavedIdentity(undefined)
    setSelected(provider)
    if (provider !== NEW_PROVIDER) setLastPicked(provider)
  }

  const reportProbe = (provider: string) => (summary: ProbeSummary | undefined): void => {
    setVerdicts((previous) => {
      const next = new Map(previous)
      if (summary === undefined) next.delete(provider)
      else next.set(provider, summary)
      return next
    })
  }

  const announceSaved = (identity: ProviderIdentity): void => {
    // Announced only once the refreshed join is in the snapshot, so the notice
    // names the provider as the directory currently does.
    void controller.load().then(() => { setSavedIdentity(identity) })
  }

  const closeDelete = (): void => {
    if (deleting) return
    setDeleteTarget(undefined)
    setDeleteFailure(undefined)
  }

  const confirmDelete = (): void => {
    /* v8 ignore next -- the action only renders with a target and is disabled while a deletion is pending */
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    setDeleteFailure(undefined)
    void removeProviderProfile(api, controller, deleteTarget, currentProvider)
      .then((failure) => {
        if (failure !== undefined) {
          setDeleteFailure(failure)
          return
        }
        if (selected === deleteTarget.provider) setSelected(OFFICIAL_PROVIDER)
        setDeleteTarget(undefined)
      })
      .finally(() => { setDeleting(false) })
  }

  /**
   * Switch the engine's default provider: one path op against the shared
   * engine-settings section, then a reload so the rail repaints the 默认 tag.
   * @param provider - the rail row's route id.
   */
  const setDefault = async (provider: string): Promise<void> => {
    setDefaultBusy(true)
    setDefaultFailure(undefined)
    try {
      const engineNamespace = state.namespaces.get('llm-deepseek')
      const response = await api.settings.mutate({
        ns: 'llm-deepseek',
        ops: [{ op: 'set', path: ['provider'], value: provider }],
        ...(engineNamespace === undefined ? {} : { expectedRevision: engineNamespace.revision }),
      })
      if (!response.result.ok) {
        setDefaultFailure(response.result.error.message)
        return
      }
      await controller.load()
    } catch (error) {
      // A transport failure rejects rather than answering; without this the
      // switch would fail silently and the rail would keep the stale tag.
      setDefaultFailure(messageOf(error))
    } finally {
      setDefaultBusy(false)
    }
  }

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  const officialRows = state.rows.filter(row =>
    row.entry.settingsNs === 'llm-deepseek' && row.entry.settingsPath.length === 0)
  const customRows = state.rows.filter(row =>
    row.entry.settingsNs === 'llm-pi-ai'
    && row.entry.settingsPath.length > 0
    && row.configured)
  // Hand-declared routes live in the pi-ai namespace, the only one whose
  // schema names the wire protocols; without it mounted there is nothing to
  // declare and the entry point stays disabled.
  const customNamespace = state.namespaces.get('llm-pi-ai')
  const presetModelsNamespace = state.namespaces.get('llm-preset-models')
  const protocols = protocolChoices(customNamespace)

  const dotOn = (row: ProviderRow): boolean =>
    providerUsable(row) || verdicts.get(row.entry.provider)?.kind === 'ok'

  const railItem = (row: ProviderRow, icon: ReactNode): ReactNode => {
    const active = selected === row.entry.provider
    const on = dotOn(row)
    const isDefault = row.entry.provider === currentProvider
    const defaultModel = defaultModelOf(state.namespaces, row)
    return (
      <div key={row.entry.provider} className={styles['railItemWrap']}>
        <button
          type="button"
          className={`${styles['railItem']} ${active ? styles['railItemActive'] : ''}`.trim()}
          aria-current={active ? 'true' : undefined}
          onClick={() => { pick(row.entry.provider) }}
        >
          <span className={styles['railIcon']}>{icon}</span>
          <span className={styles['railTexts']}>
            <span className={styles['railName']}>{row.entry.displayName}</span>
            {defaultModel === undefined
              ? null
              : <span className={styles['railModel']}>{`${t('defaultModel')} ${defaultModel}`}</span>}
          </span>
          <span
            className={`${styles['railDot']} ${on ? styles['railDotOn'] : styles['railDotOff']}`.trim()}
            role="img"
            aria-label={on ? t('credentialConfigured') : t('credentialMissing')}
            title={on ? t('credentialConfigured') : t('credentialMissing')}
          />
        </button>
        {isDefault
          ? <span className={styles['railTag']}>{t('defaultProvider')}</span>
          : (
            <button
              type="button"
              className={styles['linkButton']}
              aria-label={`${t('setDefaultProvider')} ${row.entry.displayName}`}
              disabled={!state.writable || defaultBusy}
              onClick={() => { void setDefault(row.entry.provider) }}
            >
              {t('setDefaultProvider')}
            </button>
          )}
      </div>
    )
  }

  const officialNamespace = state.namespaces.get('llm-deepseek')
  const officialBaseURL = (() => {
    if (officialNamespace === undefined) return undefined
    const value = officialNamespace.value
    if (typeof value !== 'object' || value === null) return undefined
    const baseURL = (value as { baseURL?: unknown }).baseURL
    return typeof baseURL === 'string' && baseURL.length > 0 ? baseURL : undefined
  })()

  const pane = (() => {
    if (selected === NEW_PROVIDER) {
      /* v8 ignore next -- the rail's add button is disabled without this namespace */
      if (customNamespace === undefined) return null
      return (
        <NewProviderPanel
          protocols={protocols}
          revision={customNamespace.revision}
          taken={customRows.map(row => row.entry.provider)}
          api={api}
          t={t}
          readOnly={!state.writable}
          onCreated={(route) => {
            setSavedIdentity({ provider: route, displayName: route })
            void controller.load().then(() => { pick(route) })
          }}
          onCancel={() => { setSelected(lastPicked) }}
        />
      )
    }
    const officialRow = officialRows.find(row => row.entry.provider === selected)
    if (officialRow !== undefined) {
      const official = officialRow.entry as OfficialProviderEntry
      // The credential reference a typed key stores under: the preset's own
      // ref when the directory names one ('' = keyless panel), else the joined
      // base-layer ref or the conventional derivation (legacy hosts).
      const keyEnv = official.keyEnv
      const credentialRef = keyEnv === undefined
        ? officialRow.apiKeyEnv ?? deriveKeyRef(officialRow.entry.provider)
        : keyEnv === '' ? undefined : keyEnv
      // The probe asks the engine's effective endpoint while this row is the
      // active provider (a deployment override applies to it alone), and the
      // preset's own endpoint for every other row.
      const paneBaseURL = officialRow.entry.provider === currentProvider
        ? officialBaseURL ?? official.baseURL
        : official.baseURL
      return (
        <div key={officialRow.entry.provider}>
          <DeepSeekPanel
            api={api}
            t={t}
            readOnly={!state.writable}
            {...(credentialRef === undefined ? {} : { credentialRef })}
            displayName={officialRow.entry.displayName}
            {...(paneBaseURL === undefined ? {} : { baseURL: paneBaseURL })}
            {...(official.api === undefined
              ? {}
              : { protocol: official.api as 'openai' | 'anthropic' })}
            provider={officialRow.entry.provider}
            reportProbe={reportProbe(officialRow.entry.provider)}
            onSaved={() => { announceSaved(officialRow.entry) }}
          />
          {/* User-added rows join the preset's shipped catalog: the engine
              merges them at read time, so the composer menu sees them on the
              next request without a reload. */}
          <PresetModelsSection
            api={api}
            t={t}
            readOnly={!state.writable}
            provider={officialRow.entry.provider}
            {...(presetModelsNamespace === undefined ? {} : { namespace: presetModelsNamespace })}
            onSaved={() => { announceSaved(officialRow.entry) }}
          />
        </div>
      )
    }
    const row = customRows.find(candidate => candidate.entry.provider === selected)
    if (row !== undefined && customNamespace !== undefined) {
      return (
        <CustomRoutePanel
          key={row.entry.provider}
          route={row.entry.provider}
          namespace={customNamespace}
          api={api}
          t={t}
          readOnly={!state.writable}
          reportProbe={reportProbe(row.entry.provider)}
          onSaved={() => { announceSaved(row.entry) }}
          onRequestDelete={() => {
            setSavedIdentity(undefined)
            setDeleteFailure(undefined)
            setDeleteTarget(deleteTargetOf(row))
          }}
        />
      )
    }
    return <p className={styles['paneEmpty']}>{t('paneEmpty')}</p>
  })()

  // The confirmation never deletes the engine's default provider: the wire
  // guard refuses it anyway, and disabling the commit plus the inline notice
  // says why while the dialog is still open.
  const deleteBlocked = deleteTarget !== undefined && deleteTarget.provider === currentProvider

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      {!state.writable && state.status === 'ready' ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {savedIdentity === undefined
        ? null
        : (
          <p className={styles['savedNotice']} role="status" aria-live="polite">
            {providerCopy(t('savedProvider'), savedIdentity)}
          </p>
        )}
      {defaultMissing
        ? <p className={styles['notice']}>{t('defaultProviderMissing')}</p>
        : null}
      {defaultFailure === undefined
        ? null
        : <p className={styles['error']}>{defaultFailure}</p>}
      <div className={styles['layout']}>
        <nav className={styles['rail']} aria-label={t('title')}>
          <span className={styles['railGroupLabel']}>{t('officialGroup')}</span>
          {officialRows.map(row => railItem(row, <IconGlobeOutline14 size={14} />))}
          <span className={styles['railGroupLabel']}>{t('customGroup')}</span>
          {customRows.map(row => railItem(row, <IconLinkOutline16 size={14} />))}
          <button
            type="button"
            className={styles['railAdd']}
            disabled={protocols.length === 0 || !state.writable}
            onClick={() => { pick(NEW_PROVIDER) }}
          >
            <IconPlusOutline16 size={14} />
            {t('addSupplier')}
          </button>
        </nav>
        <div className={styles['pane']}>{pane}</div>
      </div>
      <Modal
        open={deleteTarget !== undefined}
        onClose={closeDelete}
        title={deleteTarget === undefined ? '' : providerCopy(t('deleteTitle'), deleteTarget)}
        closeLabel={t('close')}
        description={deleteTarget === undefined
          ? ''
          : providerCopy(
            deleteTarget.credentialRef === undefined
              ? t('deleteDescription')
              : t('deleteDescriptionWithCredential'),
            deleteTarget,
          )}
        className={styles['deleteDialog'] as string}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={deleting} onClick={closeDelete}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={styles['deleteConfirm']}
              disabled={deleting || deleteBlocked}
              onClick={confirmDelete}
            >
              {deleteTarget === undefined
                ? ''
                : providerCopy(deleting ? t('deleting') : t('deleteConfirm'), deleteTarget)}
            </Button>
          </>
        )}
      >
        {deleteFailure === undefined ? null : <p className={styles['error']}>{deleteFailure}</p>}
        {deleteBlocked ? <p className={styles['notice']}>{DEFAULT_PROVIDER_DELETE_REFUSED}</p> : null}
      </Modal>
    </div>
  )
}
