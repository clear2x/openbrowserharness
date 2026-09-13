/**
 * Build for the Chrome MV3 extension host.
 *
 * Strategy: bundle the WORKSPACE-BUILT libs (run `pnpm run build:lib` first —
 * node_modules workspace links resolve @deepseek-ai/* to each package's
 * lib/index.js), and alias the handful of node: builtins the mounted dsh
 * closure touches to browser shims under src/shims/. Bundler errors naming an
 * un-shimmed node import are the loop: add a shim, rebuild.
 *
 * The SidePanel adds two more concerns on top:
 * - CLIENT-PACKAGE ALIASES: the sidepanel-dsh entry boots the real dsh web
 *   shell (`@deepseek-ai/dsh-client-web`). The shell and its platform
 *   externals must compile from SOURCE so their CSS rides this pipeline and
 *   every bundle sees one module instance (the apps/web precedent), and the
 *   connection package's `/client` subpaths must NEVER resolve to their
 *   built artifacts — `lib/client.js` is the `window.__ModuleLoader__`
 *   registration bundle, not an importable module (the sidepanel registers
 *   its own Port-backed replacement statically instead).
 * - PLUGIN BUNDLE COPY: the boot manifest points every UI plugin row at
 *   `/plugins/<pkg>/client.js` inside the extension origin; the closeBundle
 *   step below copies each roster package's built client artifact there,
 *   byte-for-byte (minus its sourceMappingURL pointer), straight from the
 *   same `exports['./client']` the `dsh web` server serves.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import { EXTENSION_PLUGIN_IDS } from './src/sidepanel-dsh/manifest'

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url))
const repoRoot = r('../..')
const packagesRoot = join(repoRoot, 'packages')

// Single source of truth for the version the module shim reports to dsh-llm's
// attribution User-Agent: read the root manifest at build time, inject as a
// compile-time constant (see src/shims/module.ts).
const rootVersion = (JSON.parse(readFileSync(r('../../package.json'), 'utf8')) as { version: string }).version

/** Resolve `exports['./client']` to a relative bundle path (string or one-level conditional). */
function clientExportOf(pkgName: string, exportsField: unknown): string {
  if (typeof exportsField !== 'object' || exportsField === null) {
    throw new Error(`client-bundles: ${pkgName} has no exports map`)
  }
  const client = (exportsField as Record<string, unknown>)['./client']
  if (client === undefined) {
    throw new Error(`client-bundles: ${pkgName} exports no "./client" bundle`)
  }
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`client-bundles: ${pkgName} exports["./client"] must be a string or an object with a string default`)
}

/** The source connection package (every /client-subpath alias below points into it). */
const connectionSrc = r('../../packages/client/connection/src')

/**
 * Copy every roster package's built client bundle into
 * `dist/plugins/<pkg>/client.js`. Reads the roster from the SAME module the
 * boot manifest builds on (single source of truth), locates each package
 * under `packages/<group>/<pkg>`, and follows its `exports['./client']`.
 * Missing artifacts fail the build loudly with the build:lib instruction.
 */
function copyClientBundles(): Plugin {
  return {
    name: 'dsh-copy-client-bundles',
    closeBundle() {
      // name → package directory, one scan over packages/<group>/<pkg>.
      const byName = new Map<string, string>()
      for (const group of readdirSync(packagesRoot, { withFileTypes: true })) {
        if (!group.isDirectory()) continue
        for (const pkg of readdirSync(join(packagesRoot, group.name), { withFileTypes: true })) {
          if (!pkg.isDirectory()) continue
          const manifest = join(packagesRoot, group.name, pkg.name, 'package.json')
          if (!existsSync(manifest)) continue
          const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name
          if (typeof name === 'string') byName.set(name, dirname(manifest))
        }
      }
      const missing: string[] = []
      for (const id of EXTENSION_PLUGIN_IDS) {
        const packageDir = byName.get(id)
        if (packageDir === undefined) {
          missing.push(`${id}: no package under ${packagesRoot} declares this name`)
          continue
        }
        const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>
        const rel = clientExportOf(id, manifest.exports)
        const source = join(packageDir, rel)
        if (!existsSync(source) || !statSync(source).isFile()) {
          missing.push(`${id}: built client bundle missing at ${rel} — run \`pnpm run build:lib\` first`)
          continue
        }
        const target = join(r('dist'), 'plugins', id, 'client.js')
        mkdirSync(dirname(target), { recursive: true })
        // Strip the sourceMappingURL pointer: the .map is not copied into
        // dist, and a dangling reference only produces devtools 404 noise.
        const code = readFileSync(source, 'utf8').replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n')
        writeFileSync(target, code)
      }
      if (missing.length > 0) {
        throw new Error(
          `client-bundles: ${String(missing.length)} plugin bundle(s) failed to stage:\n${missing.join('\n')}`,
        )
      }
      // eslint-disable-next-line no-console -- build-time diagnostics
      console.log(`client-bundles: staged ${String(EXTENSION_PLUGIN_IDS.length)} plugin bundles into dist/plugins`)
    },
  }
}

export default defineConfig(({ command }) => {
  // node: builtin shims exist for the EXTENSION BUNDLE (browser pages have no
  // node). Vitest runs under real Node, where the specs themselves import
  // node:fs (the roster-provenance tests read the repo tree), so the shims
  // apply to builds only.
  const nodeShimAliases: Array<{ find: string; replacement: string }> = command === 'build'
    ? [
        { find: 'node:async_hooks', replacement: r('src/shims/async_hooks.ts') },
        { find: 'node:util/types', replacement: r('src/shims/util-types.ts') },
        { find: 'node:util', replacement: r('src/shims/util.ts') },
        { find: 'node:crypto', replacement: r('src/shims/crypto.ts') },
        { find: 'node:path', replacement: r('src/shims/path.ts') },
        { find: 'node:module', replacement: r('src/shims/module.ts') },
        { find: 'node:fs/promises', replacement: r('src/shims/fs-promises.ts') },
        { find: 'node:fs', replacement: r('src/shims/fs.ts') },
        { find: 'node:buffer', replacement: r('src/shims/buffer.ts') },
        { find: 'node:os', replacement: r('src/shims/os.ts') },
      ]
    : []
  return {
  plugins: [react(), copyClientBundles()],
  define: {
    __DSH_VERSION__: JSON.stringify(rootVersion),
  },
  build: {
    outDir: 'dist',
    target: 'chrome134',
    minify: true,
    sourcemap: false,
    // No modulepreload links in the extension pages: a chrome-extension://
    // modulepreload is a cross-world resource mismatch for Chromium (a
    // console warning per page load) and the extension entry pages load their
    // few chunks through native module imports anyway, so the prefetch gain
    // is nil.
    modulePreload: false,
    rollupOptions: {
      input: {
        background: r('src/background/main.ts'),
        offscreen: r('offscreen.html'),
        // User-plugin sandbox page: becomes dist/sandbox.html; declared under
        // manifest "sandbox.pages" (the only page allowed to eval/new Function).
        sandbox: r('sandbox.html'),
        sidepanel: r('sidepanel.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  resolve: {
    alias: [
      ...nodeShimAliases,
      // The vendored loader is not a package.json dependency of this app
      // (reported as a missing dependency); types arrive through the tsconfig
      // project reference, runtime through this alias into the vendor's
      // BUILT lib — its const-enum usages (FiberState) are inlined there,
      // while the source form would demand a runtime FiberState export the
      // built cordis lib erases. Its only node: import (createRequire) is
      // covered by the module shim above.
      {
        find: '@deepseek-ai/cordis-plugin-loader',
        replacement: r('../../vendor/loader/lib/index.js'),
      },
      // ── dsh web shell (sidepanel): compile from source, apps/web style ──
      // Exact-match regexes only: a string find is a startsWith match and
      // would rewrite the /client subpath specifiers aliased further down.
      { find: /^@deepseek-ai\/dsh-client-web$/, replacement: r('../../packages/client/web/src/boot.tsx') },
      { find: /^@deepseek-ai\/dsh-client-web-react$/, replacement: r('../../packages/client/web-react/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-slots$/, replacement: r('../../packages/client/ui-slots/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: r('../../packages/client/ui-primitives/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-ui-attachment$/, replacement: r('../../packages/client/ui-attachment/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-schema-form$/, replacement: r('../../packages/client/schema-form/src/index.ts') },
      {
        find: /^@deepseek-ai\/dsh-client-modules\/client$/,
        replacement: r('../../packages/client/modules/src/client/index.ts'),
      },
      // ── client runtime + locale: the sidepanel source imports these
      // TYPE-ONLY (erased before bundling), but the spec files import real
      // values (SlotRegistry, the registries), so vitest must resolve the
      // specifiers the same source-plane way as the aliases above.
      {
        find: /^@deepseek-ai\/dsh-client-runtime\/client$/,
        replacement: r('../../packages/client/runtime/src/client/index.ts'),
      },
      // ── session-persistence: the spec's declared-agent startup relies on
      // the backend's NotFound being the SAME class object agent-loop's
      // restore fallback tests against — one source module, one class.
      {
        find: /^@deepseek-ai\/dsh-session-persistence$/,
        replacement: r('../../packages/session/session-persistence/src/index.ts'),
      },
      {
        find: /^@deepseek-ai\/dsh-session-persistence-indexeddb$/,
        replacement: r('../../packages/session/session-persistence-indexeddb/src/index.ts'),
      },
      {
        find: /^@deepseek-ai\/dsh-client-locale\/client$/,
        replacement: r('../../packages/client/locale/src/client/index.ts'),
      },
      {
        find: /^@deepseek-ai\/dsh-client-ui-trajectory\/client$/,
        replacement: r('../../packages/client/ui-trajectory/src/client/index.ts'),
      },
      // ── apiproxy values (AbstractApiClient, frame/receipt schemas): the
      // sidepanel's PortApiClient extends the real browser-safe carrier base
      // and re-parses frames/receipts with the real zod schemas, so these
      // specifiers must bind to the real sources (no node imports in the
      // api/fetch layers).
      {
        find: /^@deepseek-ai\/dsh-host-apiproxy\/client$/,
        replacement: r('../../packages/host/apiproxy/src/fetch/client.ts'),
      },
      {
        find: /^@deepseek-ai\/dsh-host-apiproxy\/api\/events\.schema$/,
        replacement: r('../../packages/host/apiproxy/src/api/events.schema.ts'),
      },
      {
        find: /^@deepseek-ai\/dsh-host-apiproxy\/api\/rpc\.schema$/,
        replacement: r('../../packages/host/apiproxy/src/api/rpc.schema.ts'),
      },
      // ── connection package: the sidepanel boots the official shell through
      // the public '/client' subpath (source — the ?fixture lane's apply
      // self-selects the official transports), and its replacement module
      // reaches the package-internal pieces it needs (ConnectionController,
      // FixtureApiClient, isLoopbackHostname) through relative source imports.
      // The built lib/client.js (the __ModuleLoader__ registration bundle) is
      // never an import target.
      { find: /^@deepseek-ai\/dsh-client-connection\/client$/, replacement: join(connectionSrc, 'client/index.ts') },
    ],
  },
  }
})
