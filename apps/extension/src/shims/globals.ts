/**
 * Browser shims for ambient Node globals (`process`, `Buffer`).
 *
 * The vendored `@deepseek-ai/cordis-plugin-loader` reads
 * `process.env.CORDIS_SHARED` / `process.versions.node` /
 * `process.execArgv` at construction time (Node-module-system probing).
 * The extension bundle provides the smallest surface that keeps those reads
 * side-effect free: no env, a Node version of 0 (so the loader's internal
 * Node module-system hook resolves to `undefined`, which the offscreen boot
 * replaces with a static module importer), and no exec flags.
 *
 * `globalThis.Buffer` covers packages that reference the Node global
 * directly (no `node:buffer` import to alias): the mounted closure's tool
 * -output truncation paths call `Buffer.byteLength` on every tool result,
 * so without the global every browser tool fails with "Buffer is not
 * defined". The surface stays the shim's: `byteLength` only.
 *
 * This file MUST be the first import of every extension entry: it patches
 * the globals before any module body that reads them evaluates.
 */

import { Buffer as BufferShim } from './buffer'

interface ProcessShim {
  env: Record<string, string | undefined>
  versions: { node: string }
  execArgv: string[]
}

const scope = globalThis as { process?: ProcessShim; Buffer?: unknown }

if (scope.process === undefined) {
  scope.process = {
    env: Object.create(null),
    versions: { node: '0.0.0' },
    execArgv: [],
  }
}

if (scope.Buffer === undefined) {
  scope.Buffer = BufferShim
}
