/**
 * The SidePanel's static boot manifest — the extension's frozen twin of the
 * graph `dsh web` composes at runtime (`window.__DSH_BOOT__`, wire shape
 * `WebBootGraph` from `@deepseek-ai/dsh-client-modules/client`).
 *
 * Provenance (why these rows, and why these flags):
 * - The 33-row browser roster of `packages/bundle/web-app/cordis.patch.yml`
 *   (lines 145–274: modules, connection, api-remotes, client-runtime,
 *   cordis-client-runner, ui-theme, locale, ui-layout, ui-sidebar, the five
 *   ui-settings* rows, ui-conversation, ui-tool, ui-cordis, ui-workflow-run,
 *   ui-deliverables, ui-workspace, ui-input-trigger, ui-commands, ui-skill,
 *   ui-subagent, ui-jobs, ui-goal, ui-message-feedback, ui-model-selection,
 *   ui-permission-presets, ui-agent-preset, ui-settings-plugins, ui-plan,
 *   ui-user-questions, ui-trajectory).
 * - PLUS three browser rows composed by `dsh web` through OTHER layers of the
 *   same graph, without which the 33 cannot activate (the boot sweep is
 *   all-or-nothing): `dsh-typert-registry` and `dsh-api-gateway` (rows of
 *   packages/bundle/base/cordis.patch.yml whose browser halves provide the
 *   `typert` / `remote` services that api-remotes and client-runtime inject)
 *   and `dsh-session-log-export` (a web-app patch row above the roster block,
 *   `apps/web/tests/assembled-boot.ts` carries the same three in its minimal
 *   live set).
 * - `dsh-client-hmr` (also a web graph row) is DELIBERATELY absent: there is
 *   no rebuild watcher in a packaged extension, and its stream would only
 *   produce reconnect noise against a nonexistent dev server.
 * - `inject` edges and `immediately` flags are copied VERBATIM from each
 *   package's `package.json` `dsh.client` declaration — the same metadata the
 *   Node `ClientModuleRegistry` composes into the real web wire. The one
 *   deliberate deviation: `dsh-client-connection` is demoted to lazy here
 *   because the extension registers its own replacement module statically
 *   (see `connection-module.ts`) — prefetching the official bundle would only
 *   load a factory the statics branch never consults.
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
 * (inject edges, immediately flag) with the one documented connection
 * deviation applied.
 */
const ROSTER: ReadonlyArray<{ id: string; inject: readonly string[]; immediately: boolean }> = [
  // ── immediately tier (package.json dsh.client.immediately === true) ──
  { id: '@deepseek-ai/dsh-typert-registry', inject: [], immediately: true },
  {
    id: '@deepseek-ai/dsh-api-gateway',
    inject: ['@deepseek-ai/dsh-typert-registry', CONNECTION_MODULE_ID],
    immediately: true,
  },
  { id: '@deepseek-ai/dsh-client-modules', inject: [], immediately: true },
  // Demoted from immediate: replaced by the static module below — see the
  // module comment. Everything else matches the package declaration.
  { id: CONNECTION_MODULE_ID, inject: [], immediately: false },
  // The shell's inject edges mirror the static module's `inject` export
  // verbatim (extension-shell.tsx); 'locale' backs the trajectory view's
  // toolbar translate.
  { id: 'extension-ui-shell', inject: ['slots', 'theme', 'workspaces', 'sessions', 'locale'], immediately: true },
  { id: '@deepseek-ai/dsh-api-remotes', inject: ['@deepseek-ai/dsh-api-gateway'], immediately: true },
  {
    id: '@deepseek-ai/dsh-client-runtime',
    inject: [CONNECTION_MODULE_ID, '@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-api-remotes'],
    immediately: true,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-theme',
    inject: [
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: true,
  },
  {
    id: '@deepseek-ai/dsh-client-locale',
    inject: [
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: true,
  },
  // ── lazy tier (fetched on first materialization) ──
  {
    id: '@deepseek-ai/dsh-cordis-client-runner',
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-modules',
      '@deepseek-ai/dsh-client-ui-theme',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-settings',
    inject: [CONNECTION_MODULE_ID, '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-api-remotes'],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-settings-general',
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-locale',
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-settings-models',
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
    inject: [
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-locale',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-conversation',
    inject: [
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-tool',
    inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-conversation'],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-cordis',
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-cordis-client-runner',
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-input-trigger',
      '@deepseek-ai/dsh-client-ui-tool',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-workflow-run',
    inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation'],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-deliverables',
    inject: [
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-input-trigger',
    inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale'],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-commands',
    inject: [
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-input-trigger',
      '@deepseek-ai/dsh-client-ui-conversation',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-skill',
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-tool',
      '@deepseek-ai/dsh-client-ui-input-trigger',
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-subagent',
    inject: [
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-input-trigger',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-jobs',
    inject: [
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-goal',
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-message-feedback',
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-model-selection',
    inject: [
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-commands',
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-permission-presets',
    inject: [
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-commands',
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-ui-settings',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-agent-preset',
    inject: [
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-settings-plugins',
    inject: [
      CONNECTION_MODULE_ID,
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-api-remotes',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-plan',
    inject: [
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-conversation',
    ],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-user-questions',
    inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-conversation'],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-client-ui-trajectory',
    inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation'],
    immediately: false,
  },
  {
    id: '@deepseek-ai/dsh-session-log-export',
    inject: [
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-commands',
      '@deepseek-ai/dsh-client-ui-conversation',
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
    // The 0.1.5 graph wires every entry through an initial combo batch. The
    // extension materializes modules statically (the import map owns them),
    // so one application-phase batch naming the whole roster satisfies the
    // wire contract without any combo script existing on disk.
    batches: [
      {
        phase: 'application',
        url: `/plugins/combo.js?rev=${EXTENSION_BOOT_REV}`,
        rev: EXTENSION_BOOT_REV,
        entries: entries.map(entry => entry.id),
      },
    ],
  }
}
