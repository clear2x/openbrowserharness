/**
 * Browser shim for node:module.
 *
 * Two consumers in the mounted dsh closure:
 * - `@deepseek-ai/dsh-llm` (attribution.ts) calls
 *   `createRequire(import.meta.url)('../package.json')` at module top level to
 *   read its own version — a bare throwing stub would crash module
 *   evaluation, so the returned require answers any *.json path with a
 *   synthetic manifest carrying only `version`. The bundler injects the REAL
 *   root-manifest version as `__DSH_VERSION__` (vite.config.ts `define`), so
 *   the attribution User-Agent stays honest with zero drift.
 * - `vendor/loader` (internal.ts) uses createRequire to probe Node's internal
 *   module loader; in the bundle the probe is unreachable (the process shim
 *   reports Node 0) and any attempted builtin require fails loudly.
 */

// Injected by vite define at build time; absent in non-bundled contexts (tests).
declare const __DSH_VERSION__: string | undefined

const manifestVersion = typeof __DSH_VERSION__ === 'string' ? __DSH_VERSION__ : '0.0.0-extension'

interface NodeRequire {
  (id: string): unknown
  resolve(id: string): string
}

export function createRequire(): NodeRequire {
  const require: NodeRequire = (id: string): unknown => {
    if (typeof id === 'string' && id.endsWith('.json')) {
      return { version: manifestVersion }
    }
    throw new Error(`node:module require("${id}") is not available in the extension bundle`)
  }
  require.resolve = (id: string): string => {
    throw new Error(`createRequire.resolve("${id}") is not available in the extension bundle`)
  }
  return require
}
