/**
 * The SidePanel's static boot manifest — the extension's frozen twin of the
 * graph `dsh web` composes at runtime (`window.__DSH_BOOT__`, wire shape
 * `WebBootGraph` from `@deepseek-ai/dsh-client-modules/client`).
 *
 * Provenance (why these rows, and why these flags):
 * - The 45-row browser roster of `packages/bundle/web-app/cordis.patch.yml`,
 *   minus the desktop-chrome rows the extension replaces or cannot host:
 *   `dsh-client-connection` (the extension registers its own replacement
 *   statically — see `connection-module.ts`), `dsh-client-ui-layout`,
 *   `dsh-client-ui-sidebar`, and `dsh-client-ui-workspace` (the shell's own
 *   `layout` service covers what they render), `dsh-client-ui-chat` and
 *   `dsh-client-ui-brand-official` (desktop chat-page and brand chrome; the
 *   SidePanel mounts the trajectory view instead — nothing else in the
 *   roster needs their services).
 * - PLUS six rows the desktop composes through OTHER layers of the same
 *   graph, without which the roster cannot activate (the boot sweep is
 *   all-or-nothing): `dsh-typert-registry` and `dsh-api-gateway` (rows of
 *   packages/bundle/base/cordis.patch.yml providing the `typert` / `remote`
 *   services), `dsh-session-log-export` (a web-app patch row above the
 *   roster block), and — because the extension has no Node-side package scan
 *   to pull dependencies in — the transitive web rows the roster's inject
 *   edges name: `dsh-api-session-controller` (the `sessions` service),
 *   `dsh-api-workspace-controller`, and `dsh-api-workspace-files`
 *   (`apps/web/tests/assembled-boot.ts` carries the same extras in its
 *   minimal live set).
 * - Upstream 0.1.5 removed `dsh-client-runtime`; `dsh-client-ui-renderer`
 *   (immediate, inject-free) took over its seat in every inject edge.
 * - `dsh-client-hmr` (also a web graph row) is DELIBERATELY absent: there is
 *   no rebuild watcher in a packaged extension, and its stream would only
 *   produce reconnect noise against a nonexistent dev server.
 * - `inject` edges and `immediately` flags are copied VERBATIM from each
 *   package's `package.json` `dsh.client` declaration — the same metadata the
 *   Node `ClientModuleRegistry` composes into the real web wire — except
 *   references to the excluded chrome rows (ui-layout/ui-sidebar/
 *   ui-workspace/ui-chat), which order loads against modules this graph never
 *   ships. The one flag deviation: `dsh-client-connection` is demoted to lazy
 *   because its static replacement owns activation.
 *
 * The vite build pipeline (`vite.config.ts`) consumes the same roster to copy
 * each package's `exports['./client']` artifact to `dist/plugins/<id>/client.js`,
 * so this module is the single source of truth for both the wire and the
 * bundle layout. Pure data + pure functions: no browser APIs (imported by
 * Node-side config and tests alike).
 */

import type { WebBootEntry, WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'

/**
 * Consistency anchor for the whole graph. The web host pins a content hash
 * per bundle; the extension ships every bundle in the same package as the
 * wire itself, so a constant rev is the equally-strong consistency statement
 * (the only way to change one side is to rebuild the extension).
 */
export const EXTENSION_BOOT_REV = 'ext'

/** The id under which the extension's replacement connection module is registered. */
export const CONNECTION_MODULE_ID = '@deepseek-ai/dsh-client-connection'

/**
 * The frozen plugin roster: id → package-declared `dsh.client` metadata
 * (inject edges, immediately flag) with the documented deviations applied.
 */
const ROSTER: ReadonlyArray<{ id: string; inject: readonly string[]; immediately: boolean }> = [
  { id: '@deepseek-ai/dsh-typert-registry', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-api-gateway', inject: ['@deepseek-ai/dsh-typert-registry', CONNECTION_MODULE_ID], immediately: true },
  { id: '@deepseek-ai/dsh-client-modules', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-connection', inject: [], immediately: false },
  {
    id: 'extension-ui-shell',
    inject: [
      'slots',
      'theme',
      'workspaces',
      'sessions',
      'locale',
      // The trajectory host binds the conversation ledger's target directly
      // (uiConversation) instead of consuming the desktop's hidden view ring;
      // the declared inject is what keeps the traceable proxy from refusing
      // that read.
      'uiConversation',
    ],
    immediately: true,
  },
  { id: '@deepseek-ai/dsh-api-remotes', inject: ['@deepseek-ai/dsh-api-gateway'], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-renderer', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-file-upload', inject: ['@deepseek-ai/dsh-api-remotes'], immediately: true },
  {
    id: '@deepseek-ai/dsh-client-ui-theme',
    inject: [
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: true,
  },
  {
    id: '@deepseek-ai/dsh-client-locale',
    inject: [
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: true,
  },
  {
    id: '@deepseek-ai/dsh-cordis-client-runner',
    inject: [
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-modules',
      '@deepseek-ai/dsh-client-ui-theme',
    ],
    immediately: false,
  },
  { id: '@deepseek-ai/dsh-client-ui-settings', inject: ['@deepseek-ai/dsh-api-remotes'], immediately: false },
  { id: '@deepseek-ai/dsh-api-session-controller', inject: ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-file-upload'], immediately: false },
  {
    id: '@deepseek-ai/dsh-client-ui-settings-general',
    inject: [
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-locale',
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: false,
  },
  { id: '@deepseek-ai/dsh-client-ui-settings-models', inject: ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-api-remotes'], immediately: false },
  {
    id: '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
    inject: [
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-agent-preset',
    ],
    immediately: false,
  },
  { id: '@deepseek-ai/dsh-client-ui-settings-plugins', inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-api-remotes'], immediately: false },
  {
    id: '@deepseek-ai/dsh-client-ui-commands',
    inject: [
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-input-trigger',
      '@deepseek-ai/dsh-client-ui-conversation',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-input-trigger',
    inject: [
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-renderer',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-tool',
    inject: [
      '@deepseek-ai/dsh-api-workspace-controller',
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-conversation',
    inject: [
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-file-upload',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-client-ui-settings',
    ],
    immediately: false,
  },
  { id: '@deepseek-ai/dsh-client-ui-session', inject: ['@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-renderer'], immediately: false },
  {
    id: '@deepseek-ai/dsh-client-ui-attachment',
    inject: [
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-trajectory',
      '@deepseek-ai/dsh-client-ui-tool',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-approval',
    inject: [
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-session',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-trajectory',
    inject: [
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-session',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-cordis',
    inject: [
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-cordis-client-runner',
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-input-trigger',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-client-ui-tool',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-deliverables',
    inject: [
      '@deepseek-ai/dsh-api-remotes',
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-tool',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-goal',
    inject: [
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-session',
    ],
    immediately: false,
  },
  { id: '@deepseek-ai/dsh-client-ui-jobs', inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-primitives'], immediately: false },
  {
    id: '@deepseek-ai/dsh-client-ui-message-feedback',
    inject: [
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-commands',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-model-selection',
    inject: [
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-commands',
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-permission-presets',
    inject: [
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-commands',
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-ui-settings',
    ],
    immediately: false,
  },
  { id: '@deepseek-ai/dsh-client-ui-plan', inject: ['@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-conversation'], immediately: false },
  { id: '@deepseek-ai/dsh-client-ui-schedule', inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-primitives'], immediately: false },
  {
    id: '@deepseek-ai/dsh-client-ui-skill',
    inject: [
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-tool',
      '@deepseek-ai/dsh-client-ui-input-trigger',
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-ui-sidebar-right',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-subagent',
    inject: [
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-input-trigger',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-agent-preset',
    inject: [
      '@deepseek-ai/dsh-api-session-controller',
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-user-questions',
    inject: [
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-session',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-workflow-run',
    inject: [
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-session',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-reference',
    inject: [
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-api-session-controller',
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-input-trigger',
      '@deepseek-ai/dsh-client-ui-sidebar-right',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-sidebar-right',
    inject: [
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-resources',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-session',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-sidebar-files',
    inject: [
      '@deepseek-ai/dsh-api-workspace-files',
      '@deepseek-ai/dsh-client-ui-sidebar-right',
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
    inject: [
      '@deepseek-ai/dsh-api-gateway',
      '@deepseek-ai/dsh-api-workspace-files',
      '@deepseek-ai/dsh-client-ui-sidebar-right',
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: false,
  },
  { id: '@deepseek-ai/dsh-client-resources', inject: ['@deepseek-ai/dsh-client-ui-renderer'], immediately: false },
  { id: '@deepseek-ai/dsh-api-workspace-controller', inject: ['@deepseek-ai/dsh-api-gateway', CONNECTION_MODULE_ID], immediately: false },
  { id: '@deepseek-ai/dsh-api-workspace-files', inject: ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-resources'], immediately: false },
  {
    id: '@deepseek-ai/dsh-session-log-export',
    inject: [
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-commands',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-session',
    ],
    immediately: false,
  },
]

/**
 * The graph-row ids, in roster order (row order carries no semantics — fiber
 * inject waiting owns activation order).
 */
export const EXTENSION_SHELL_MODULE_ID = 'extension-ui-shell'
/** Roster rows served by STATIC modules (registerStatic wins; no bundle copy). */
const STATIC_MODULE_IDS: readonly string[] = [CONNECTION_MODULE_ID, EXTENSION_SHELL_MODULE_ID]
export const EXTENSION_PLUGIN_IDS: readonly string[] = ROSTER.map(row => row.id).filter(id => !STATIC_MODULE_IDS.includes(id))

/** Build one wire entry (the url layout the vite copy pipeline mirrors on disk). */
function wireEntry(row: { id: string; inject: readonly string[]; immediately: boolean }): WebBootEntry {
  return {
    id: row.id,
    url: `/plugins/${row.id}/client.js?rev=${EXTENSION_BOOT_REV}`,
    rev: EXTENSION_BOOT_REV,
    ...(row.inject.length === 0 ? {} : { inject: [...row.inject] }),
    ...(row.immediately ? { immediately: true } : {}),
  }
}

/**
 * The boot graph installed as `window.__DSH_BOOT__` before `AppWebEntry.run()`
 * (a fresh object per call — callers may mutate their copy without poisoning
 * this module's frozen data).
 */
export function buildExtensionBootGraph(): WebBootGraph {
  const entries = ROSTER.map(wireEntry)
  return {
    rev: EXTENSION_BOOT_REV,
    entries,
    // One application-phase batch per entry: the 0.1.5 loader derives each
    // row's initial-load URL from its batch, so the batch URL must be the
    // same per-package script the vite copy pipeline staged on disk (the
    // web app serves a concatenating combo.js instead; the extension has no
    // server to combine through).
    batches: entries.map(entry => ({
      phase: 'application' as const,
      url: entry.url,
      rev: EXTENSION_BOOT_REV,
      entries: [entry.id],
    })),
  }
}
