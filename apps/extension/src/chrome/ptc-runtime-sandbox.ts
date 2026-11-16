/**
 * The browser PtcRuntime: executes PTC programs inside the manifest-sandboxed
 * iframe over the postMessage bridge (`ptc-sandbox-bridge.ts`), replacing the
 * desktop's node:vm-backed `ptc-runtime-node` — a browser host has no vm or
 * worker-thread seam. The Service Definition contract is unchanged: bindings
 * round-trip as lossless JSON, the completion verdict and failure taxonomy
 * match, timeouts and aborts hard-stop the program, and no state is retained
 * (`stateOwner` is accepted and ignored, like every stateless provider).
 *
 * Documented deviations from the Node backend, forced by the substrate:
 * - `isolation` reports `'sandboxed-iframe'` (no worker thread or process).
 * - `cwd` is accepted in the spec but unused: the OPFS world has no process
 *   whose working directory a program could inherit.
 * - PtcImage values ride binding resolutions as plain objects; a completion
 *   shaped like one maps back to an image output block.
 * @module chrome-ptc-runtime
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PtcRuntime, PtcRuntimeError } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { PtcSandboxBridge, type BridgeBinding, type BridgeBindingFunction } from './ptc-sandbox-bridge.ts'

export const name = 'chrome-ptc-runtime'
/** The runtime contributes itself alone; the bridge owns its iframe. */
export const inject = [] as const

/** Config: the program budget defaults and cap. */
export interface Config {
  /** Default elapsed budget (ms) when a request omits `timeoutMs`. */
  defaultTimeoutMs: number
  /** Cap on request-supplied budgets (ms). */
  maxTimeoutMs: number
}

export const Config: z<Config> = z.object({
  defaultTimeoutMs: z.number().default(120_000),
  maxTimeoutMs: z.number().default(300_000),
})

/** Whether one completion value looks like a PtcImage plain-object twin. */
function looksLikePtcImage(value: unknown): value is { path: string; attachment: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.path === 'string' && candidate.attachment !== undefined
}

/**
 * Lossless-JSON verdict over one completion value: `undefined` (a program
 * ending without a return) means absent; anything JSON.stringify rejects
 * fails the run as `invalid-output`.
 */
function jsonVerdict(value: unknown): { present: boolean; json: unknown } | { failure: string } {
  if (value === undefined) return { present: false, json: undefined }
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) return { failure: 'the completion value is not lossless JSON' }
    return { present: true, json: JSON.parse(encoded) as unknown }
  } catch {
    return { failure: 'the completion value is not lossless JSON' }
  }
}

/** The sandbox-backed PTC runtime. */
export default class SandboxPtcRuntime extends PtcRuntime {
  /** The loader validates boot config through this schema. */
  static Config: z<Config> = Config

  override readonly language = 'typescript'
  override readonly isolation = 'sandboxed-iframe'

  private readonly bridge: PtcSandboxBridge
  private readonly defaultTimeoutMs: number
  private readonly maxTimeoutMs: number

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? 120_000
    this.maxTimeoutMs = config?.maxTimeoutMs ?? 300_000
    this.bridge = new PtcSandboxBridge(chrome.runtime.getURL('sandbox.html'))
  }

  /** Tear the bridge down with the composition (the iframe dies with the page anyway). */
  dispose(): void {
    this.bridge.dispose()
  }

  override resolve(request: PtcRunRequest): PtcRunSpec {
    if (typeof request.program !== 'string' || request.program.length === 0) {
      throw new PtcRuntimeError('the program must be a non-empty string', 'PTC_RUNTIME_INVALID_ARGUMENT')
    }
    let timeoutMs: number | null
    if (request.timeoutMs === null) {
      timeoutMs = null
    } else if (request.timeoutMs === undefined) {
      timeoutMs = this.defaultTimeoutMs
    } else if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new PtcRuntimeError('timeoutMs must be a positive finite number or null', 'PTC_RUNTIME_INVALID_ARGUMENT')
    } else {
      timeoutMs = Math.min(request.timeoutMs, this.maxTimeoutMs)
    }
    const cwd = typeof request.cwd === 'string' && request.cwd.length > 0 ? request.cwd : '/'
    return { ...request, cwd, timeoutMs }
  }

  override async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    const namespaces: BridgeBinding[] = []
    const functions: BridgeBindingFunction[] = []
    for (const namespace of spec.bindings) {
      const members = Object.keys(namespace.functions)
      namespaces.push({
        global: namespace.global,
        functions: members,
        ...(namespace.errorClass === undefined ? {} : { errorClass: namespace.errorClass }),
      })
      for (const member of members) {
        const bound = namespace.functions[member]
        if (bound === undefined) continue
        functions.push({ namespace: namespace.global, member, call: args => bound(args) })
      }
    }

    const outcome = await this.bridge.run({
      program: spec.program,
      bindings: namespaces,
      functions,
      deadlineMs: spec.timeoutMs,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    })

    const output = outcome.consoleLines.map(line => ({ type: 'text' as const, text: `${line.text}\n` }))
    if (!outcome.ok) {
      return {
        output,
        error: { kind: 'exception', message: outcome.error ?? 'the program failed' },
      }
    }
    const verdict = jsonVerdict(outcome.value)
    if ('failure' in verdict) {
      return { output, error: { kind: 'invalid-output', message: verdict.failure } }
    }
    if (verdict.present && looksLikePtcImage(verdict.json)) {
      return {
        output: [...output, { type: 'image' as const, attachment: verdict.json.attachment as never }],
      }
    }
    return {
      ...(verdict.present ? { value: verdict.json as never } : {}),
      output,
    }
  }
}
