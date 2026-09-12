/**
 * SidePanel boot: run the REAL dsh web shell (`AppWebEntry` from
 * `@deepseek-ai/dsh-client-web`, compiled from workspace source through the
 * vite aliases) against the extension's static boot graph — same machinery
 * `dsh web` runs in a browser, with exactly two substitutions:
 *
 * 1. The graph: `window.__DSH_BOOT__` comes from `./manifest.ts` (the frozen
 *    36-row roster) instead of the host-side `ClientModuleRegistry` scan.
 *    Every UI plugin row still points at a real built `lib/client.js`, staged
 *    under `/plugins/<pkg>/client.js` by the vite copy pipeline — the default
 *    same-origin `<script>` transport loads them byte-for-byte (no eval; the
 *    bundles register factories through `window.__ModuleLoader__.load`).
 *
 * 2. The connection carrier: the connection row resolves to the static
 *    replacement module (`./connection-module.ts`, PortApiClient) instead of
 *    the package's own bundle.
 *
 * The static handoff rides the ONE seam `AppWebEntry` exposes (`loadBundle`):
 * the shell publishes its `ClientModuleSystem` on `window.__DSH_MODULES__`
 * before any bundle activity, and every bundle arrival — prefetch or
 * first-import — passes through `loadBundle`, so registering the replacement
 * module at the first `loadBundle` call is provably ahead of the first
 * connection resolution (the boot kernel awaits the whole prefetch tier
 * before creating entries, and the import path materializes a bundle only
 * after its `loadBundle` settled).
 *
 * `?fixture` keeps the official fixture lane: the connection row registers
 * the connection package's own client module (whose apply self-selects
 * `FixtureApiClient` on fixture pages), so the whole UI boots against the
 * in-memory fake server. Manual verification path (needs a built extension):
 * load the unpacked extension, open
 * `chrome-extension://<id>/sidepanel.html?fixture` in a normal tab — the full
 * dsh web UI must render with fixture data; then open the real SidePanel
 * (no query) — the same UI must come up against the Offscreen engine once a
 * DeepSeek API key is configured (engine settings: chrome.storage-backed).
 *
 * StrictMode is deliberately ABSENT: the `__ModuleLoader__` sink is a
 * page singleton (double-invoked effects would attempt a double boot and the
 * second constructor throws).
 */

// The shell kernel is imported by FILE, not through the package specifier:
// the package root resolves to a directory whose index has stale tsc `.js`
// twins beside the sources (an extensionless or directory-index lookup loads
// the twin, whose bare workspace imports then bypass the paths facade toward
// built registration bundles). The extensionful relative import pins the
// SOURCE kernel in every resolver; the tsconfig's
// rewriteRelativeImportExtensions:false keeps the path writable across the
// project reference, and the vite alias for the bare package name keeps any
// future importer equally source-bound in the build.
import { AppWebEntry } from '../../../../packages/client/web/src/boot.ts'
import type { DshWindow } from '@deepseek-ai/dsh-client-modules/client'
import {
  WELCOME_NOTICE_ACK_FIELD,
  WELCOME_NOTICE_SETTINGS_NAMESPACE,
  WELCOME_NOTICE_VERSION,
} from '../../../../packages/client/ui-settings-models/src/onboarding-copy.ts'
import * as PortConnectionModule from './connection-module.ts'
import {
  buildExtensionBootGraph,
  CONNECTION_MODULE_ID,
  EXTENSION_SHELL_MODULE_ID,
} from './manifest.ts'
import * as ExtensionShellModule from './extension-shell.tsx'

/**
 * Product-facing debranding + onboarding suppression:
 *
 * - The dsh welcome notice ("内测声明") is acknowledged before boot by seeding
 *   the ui-onboarding namespace (the same chrome.storage blob the api-bridge
 *   serves) with the CURRENT notice version imported from the very plugin
 *   that compares it — drift-proof against dsh updates.
 * - DeepSeek brand art (sidebar wordmark, rail fish, conversation empty-hero
 *   fish, boot wordmark) is hidden via css-module class stems, which the
 *   client build pipeline preserves inside every hashed class name.
 */
const GENERIC_NS_STORAGE_KEY = 'dsh-api-settings-namespaces'

async function seedWelcomeAcknowledgement(): Promise<void> {
  try {
    const items = await chrome.storage.local.get(GENERIC_NS_STORAGE_KEY)
    const raw = items[GENERIC_NS_STORAGE_KEY] as
      | Record<string, { revision?: unknown; value?: Record<string, unknown> }>
      | undefined
    const namespaces = raw !== null && typeof raw === 'object' && raw !== undefined ? raw : {}
    const entry = namespaces[WELCOME_NOTICE_SETTINGS_NAMESPACE]
    const value = entry !== null && typeof entry === 'object' && entry?.value !== null && typeof entry?.value === 'object'
      ? { ...entry.value }
      : {}
    if (value[WELCOME_NOTICE_ACK_FIELD] === WELCOME_NOTICE_VERSION) return
    value[WELCOME_NOTICE_ACK_FIELD] = WELCOME_NOTICE_VERSION
    namespaces[WELCOME_NOTICE_SETTINGS_NAMESPACE] = {
      revision: typeof entry?.revision === 'number' ? entry.revision + 1 : 1,
      value,
    }
    await chrome.storage.local.set({ [GENERIC_NS_STORAGE_KEY]: namespaces })
  } catch {
    // Seeding is best-effort: on failure the notice shows once and the
    // user's own acknowledgement persists thereafter.
  }
}

function installDebrandingStyles(): void {
  const style = document.createElement('style')
  style.id = 'obh-debrand'
  style.textContent = [
    // sidebar brand wordmark button (doubles the New Session shortcut; the
    // dedicated 新会话 button below remains)
    'button[class*="brand"] { display: none !important; }',
    // collapsed-rail fish mark
    '[class*="railFish"] { display: none !important; }',
    // conversation empty-hero fish + its hitbox
    '[class*="fishHitbox"] { display: none !important; }',
    // boot loading page wordmark
    '[class*="wordmark"] { display: none !important; }',
    // conversation hero workspace picker row (no occupant after ui-workspace removal)
    '[class*="heroWorkspace"] { display: none !important; }',
    ,
    // conversation hero workspace picker button (EmptyHero's css.workspace stem)
    'button[class*="workspace"][aria-haspopup] { display: none !important; }',
    // Rewrite the inert-workspace placeholder (no session selected yet).
    // Scoped to dsh's contenteditable composer ONLY — the extension shell's
    // own <textarea> placeholder must stay visible.
    '[contenteditable=true]::before { content: "给 Agent 发送指令…" !important; }',
    '[contenteditable=true][data-placeholder]:empty::before { color: transparent !important; }',
  ].join('\n')
  document.head.append(style)
}

/** Default bundle transport: a same-origin classic `<script>` (the shell's own defaultLoadBundle shape). */
const loadScript = (url: string): Promise<void> => new Promise((resolve, reject) => {
  const el = document.createElement('script')
  el.async = true
  el.src = url
  el.addEventListener('load', () => {
    el.remove()
    resolve()
  }, { once: true })
  el.addEventListener('error', () => {
    el.remove()
    reject(new Error(`sidepanel boot: bundle script ${url} failed to load`))
  }, { once: true })
  document.head.append(el)
})

/**
 * Build the boot seams: the default script transport plus the one-shot static
 * registration of the connection row's replacement module (see the module
 * comment for the ordering proof). On `?fixture` pages the connection row
 * registers the connection package's OWN client module instead, whose apply
 * self-selects the official fixture transport — the manual render lane.
 * @param fixture - whether the page URL carries `?fixture`.
 * @param loadBundle - bundle transport override (tests inject a fake).
 * @returns the `AppWebEntry` seams (loadBundle made non-optional: this
 * builder always provides one).
 */
export function createBootSeams(
  fixture: boolean,
  loadBundle: (url: string) => Promise<void> = loadScript,
): { readonly loadBundle: (url: string) => Promise<void> } {
  let registered = false
  const registerStaticModules = async (): Promise<void> => {
    if (registered) return
    registered = true
    const modules = (globalThis as DshWindow).__DSH_MODULES__
    if (modules === undefined) {
      throw new Error('sidepanel boot: window.__DSH_MODULES__ missing at first bundle load (shell kernel sequencing bug)')
    }
    // The extension-native root shell replaces ui-layout/ui-sidebar/ui-workspace.
    modules.registerStatic(EXTENSION_SHELL_MODULE_ID, ExtensionShellModule)
    const module = fixture
      ? await import('@deepseek-ai/dsh-client-connection/client')
      : PortConnectionModule
    modules.registerStatic(CONNECTION_MODULE_ID, module)
  }
  return {
    loadBundle: async (url: string) => {
      await registerStaticModules()
      await loadBundle(url)
    },
  }
}

/** Whether the current page URL asks for the official fixture transport. */
function fixturePage(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has('fixture')
}

/**
 * Boot the real dsh web UI into a mount point (the SidePanel entry calls this
 * once; see the module comment for why nothing may run it twice).
 * @param el - mount point (the page's #root).
 * @returns the AppWebEntry run promise (settles when the UI is up or the
 * loading page shows the failure report).
 */
export async function bootSidePanel(el: HTMLElement): Promise<void> {
  installDebrandingStyles()
  await seedWelcomeAcknowledgement()
  const win = globalThis as DshWindow
  win.__DSH_BOOT__ = buildExtensionBootGraph()
  await new AppWebEntry(el, createBootSeams(fixturePage())).run()
}
