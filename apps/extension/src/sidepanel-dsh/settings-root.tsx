/**
 * `extension-settings-root`: the extension's phone-OS-style settings shell —
 * the FULL replacement of ui-settings-general's client module in this graph
 * (that bundle is not staged; see manifest.ts). The upstream chrome (top tab
 * band + flat rows) becomes a root menu — one row per section: icon · label ·
 * chevron — drilling into a per-section page with a back header. Section
 * PAGES stay upstream: 模型/内置插件/Agent 预设 are contributed by their own
 * roster rows (`settings.section` entries), and the General section here
 * registers the upstream `GeneralSection` component, so upstream section
 * evolution still flows in.
 *
 * What is deliberately NOT re-provided from the replaced module (all
 * desktop-lane, dead in this host):
 * - the Host-document settings action (its localized `t` chain does not
 *   survive replacement),
 * - the developer-tools row (its `setEnabled` persists through the engine's
 *   `ui-settings` module form face, which this host's engine composition
 *   never mounts — every write returns false; the extension's trajectory
 *   view is extension-native and does not read the preference),
 * - the desktop update channel row/badge, the sidebar toggle badge, the
 *   Host-release prompt, and the onboarding seats,
 * - the version row (the build lacks `DSH_CLIENT_VERSION`, and the 用户插件
 *   panel's 关于 row owns update copy).
 *
 * The module copy is hardcoded zh-CN like the rest of the shell chrome;
 * feature-owned section labels resolve through each contributor's locale.
 *
 * Registration map (one declarer per slot — this module now owns the
 * settings declarations the removed bundle used to own):
 * - `sidebar.settings` (children: `settings.section`) — the shell component.
 * - `settings.section` entry `general` (children: `settings.general.item`) —
 *   the upstream GeneralSection component.
 *
 * Row restyling inside the drill-down body lives in SHELL_CSS
 * ("phone-style settings" section), scoped under `.dshx-setbody` via the
 * stable `[data-slot]` anchors; the sheet-guarded class stems
 * (`[class*="panel"]`/`[class*="overlay"]`) are deliberately not used.
 *
 * @module settings-root
 */
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only service merges: ctx.locale, plus the composed occupant props.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { usePopoverDismiss } from './popover.tsx'
import {
  BoltIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CloudIcon,
  DatabaseIcon,
  GearIcon,
} from './icons.tsx'
// Source-plane import from the replaced package (not staged as a bundle):
// the compiled client.js is a self-registering script, unusable as a module.
import { GeneralSection } from '../../../../packages/client/ui-settings-general/src/client/GeneralSection.tsx'
import { AgentPresetsPage } from './presets-page.tsx'

/** The module id this file registers under (see manifest.ts/boot.ts). */
export const name = 'extension-settings-root'

/** Kernel-provided service this module's apply requires. */
export const inject: readonly string[] = ['slots', 'locale']

/** One projected root-menu row (mirrors the upstream section projection). */
interface SectionRow {
  readonly id: string
  readonly order: number
  readonly label: string
}

/** Observable section projection shared by the registered component. */
interface SectionsSource {
  getSnapshot: () => readonly SectionRow[]
  subscribe: (listener: () => void) => () => void
}

/**
 * Ledger → rows projection (upstream shellInjected's sections source,
 * re-owned here): slot version + locale revision key the cache; labels are
 * contributor thunks resolved per rebuild.
 */
function createSectionsSource(ctx: ClientContext): SectionsSource {
  let version = -1
  let revision = -1
  let rows: readonly SectionRow[] = []
  return {
    getSnapshot: () => {
      const nextVersion = ctx.slots.getVersion('settings.section')
      const nextRevision = ctx.locale.getSnapshot().revision
      if (nextVersion !== version || nextRevision !== revision) {
        version = nextVersion
        revision = nextRevision
        rows = ctx.slots.entries('settings.section')
          .map((entry) => {
            const options = entry.options as { id?: unknown; order?: unknown; label?: unknown }
            const label = options.label
            return {
              id: typeof options.id === 'string' ? options.id : '',
              order: typeof options.order === 'number' ? options.order : 0,
              label: typeof label === 'function' ? (label() ?? '') : typeof label === 'string' ? label : '',
            }
          })
          // The upstream agent-preset section is replaced by this host's own
          // page (extension-presets-page — the desktop-lane cards offer no
          // authoring here); the upstream entry stays registered (its bundle
          // also carries the composer's preset chip) but out of the menu.
          .filter(row => row.id !== '' && row.id !== 'agent-presets')
          .sort((a, b) => a.order - b.order)
      }
      return rows
    },
    subscribe: (listener) => {
      const offLedger = ctx.slots.subscribe('settings.section', listener)
      const offLocale = ctx.locale.subscribe(listener)
      return () => {
        offLedger()
        offLocale()
      }
    },
  }
}

/** Empty rows sentinel: a stable identity keeps useSyncExternalStore quiet. */
const EMPTY_ROWS: readonly SectionRow[] = []

/**
 * Pragmatic renderer type for the seat this root consumes — the framework's
 * own composed share for the declared child, so the register call's
 * SlotComponent check accepts the component as written.
 */
type SlotRenderer = PropsRenderSlots<'settings.section'>['renderSlot']

interface SettingsMenuRootProps {
  renderSlot: SlotRenderer
  /** Caller share: the full-page rail renders a labeled text row instead of the icon button. */
  labeled?: boolean
  /** Caller share: narrow docked posture (kept for slot-shape parity with the header mount). */
  wide?: boolean
}

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function sectionIcon(id: string): JSX.Element {
  if (id === 'models') return <DatabaseIcon size={16} />
  if (id === 'plugins') return <BoltIcon size={16} />
  if (id === 'agent-presets' || id === 'presets') return <CloudIcon size={16} />
  return <GearIcon size={16} />
}

/**
 * The trigger button plus the portaled phone-style sheet: root menu and
 * section drill-down are two phases of one component (activeId === undefined
 * is the menu). Open state is component-local — the occupant unmounts with
 * its mount point (header vs full-page rail), which just means the sheet
 * starts closed after a posture switch. The standalone settings page
 * (settings.html, the options_ui target) starts OPEN: the whole document
 * exists to present the settings.
 */
function SettingsMenuRoot({ renderSlot, labeled }: SettingsMenuRootProps): JSX.Element {
  const [open, setOpen] = useState(() => window.location.pathname.endsWith('/settings.html'))
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const subscribe = useCallback((onStoreChange: () => void): (() => void) =>
    (sectionsSource?.subscribe ?? (() => () => undefined))(onStoreChange), [])
  const getSnapshot = useCallback(() => sectionsSource?.getSnapshot() ?? EMPTY_ROWS, [])
  const rows = useSyncExternalStore(subscribe, getSnapshot)
  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])
  const panelRef = useRef<HTMLDivElement>(null)
  usePopoverDismiss(open, close, panelRef)
  // Entries can unmount underneath the requested id: fall back to the menu.
  const active = rows.find(row => row.id === activeId)?.id
  const activeLabel = rows.find(row => row.id === active)?.label ?? ''

  return (
    <>
      {labeled ? (
        <button
          type="button"
          className="dshx-railitem"
          aria-label="设置"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="设置"
          onClick={() => { setOpen(true) }}
        >
          <GearIcon size={14} />
          <span className="dshx-railitem-label">设置</span>
        </button>
      ) : (
        <button
          type="button"
          className="dshx-iconbtn"
          aria-label="设置"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="设置"
          onClick={() => { setOpen(true) }}
        >
          <GearIcon size={14} />
        </button>
      )}
      {open && createPortal((
        <div className="dshx-setovl" role="presentation">
          <div className="dshx-setmask" aria-hidden="true" onClick={close} />
          <div ref={panelRef} className="dshx-setpage" role="dialog" aria-modal="true" aria-label="设置">
            <div className="dshx-sethead">
              {active !== undefined && (
                <button type="button" className="dshx-setback" aria-label="返回" title="返回" onClick={() => { setActiveId(undefined) }}>
                  <ChevronLeftIcon size={15} />
                </button>
              )}
              <span className="dshx-settitle">{active === undefined ? '设置' : activeLabel}</span>
              <button type="button" className="dshx-setclose" aria-label="关闭设置" title="关闭" onClick={close}>
                <CloseIcon size={14} />
              </button>
            </div>
            {active === undefined ? (
              <div className="dshx-setmenu">
                {rows.map(row => (
                  <button
                    key={row.id}
                    type="button"
                    className="dshx-setrow"
                    onClick={() => { setActiveId(row.id) }}
                  >
                    <span className="dshx-setrowicon" aria-hidden="true">{sectionIcon(row.id)}</span>
                    <span className="dshx-setrowlabel">{row.label}</span>
                    <span className="dshx-setrowchev" aria-hidden="true"><ChevronRightIcon size={14} /></span>
                  </button>
                ))}
                {rows.length === 0 && <div className="dshx-setempty">设置加载中…</div>}
              </div>
            ) : (
              <div className="dshx-setbody">
                {renderSlot('settings.section', { close }, { only: active })}
              </div>
            )}
          </div>
        </div>
      ), document.body)}
    </>
  )
}

/** Assigned in apply() before registration; the page boots once, so the
    module-level closure is a safe handoff into the component. */
let sectionsSource: SectionsSource | undefined

/**
 * Register the replacement shell and the General section it owns. The
 * extension host always serves the settings face, so the upstream
 * `remoteAccess.whenAccess` gate is not replicated.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  sectionsSource = createSectionsSource(ctx)

  // The General section: the upstream component column carrying the
  // feature-owned item slots (upstream index.ts L266-273, zh label per the
  // shell-chrome convention).
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'general',
    order: 0,
    label: '通用设置',
    children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
  }, GeneralSection))

  ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
    name: 'sidebar.settings',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  }, SettingsMenuRoot))

  // The Agent 预设 page this host owns (extension-presets-page): authoring,
  // make-default, view, and delete over the chrome.storage roster. Ordered
  // after Models like the upstream section it replaces; the upstream entry's
  // menu row is filtered out in createSectionsSource above.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'presets',
    order: 20,
    label: 'Agent 预设',
  }, AgentPresetsPage))
}
