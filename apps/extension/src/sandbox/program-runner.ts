/**
 * PTC program execution for the sandbox page: evaluates one async function
 * body per the PTC program format, with one null-prototype global per
 * declared binding namespace plus `console` and `inspect`. Host binding
 * calls round-trip over the binding-call/binding-result postMessage pair;
 * console lines stream out as program-console messages; the completion
 * value or the thrown error settles the run reply.
 *
 * This is the same indirect-eval mechanism the plugin lifecycle uses (the
 * manifest-sandboxed page is the only extension page whose CSP permits it —
 * see main.ts's security note for the threat model: the code is authored or
 * AI-generated on the local user's own behalf, not an adversarial surface).
 * @module sandbox/program-runner
 */

import { errText, postToHost, snapshotArg } from './protocol.ts'

/** Upper bound mirroring the host's program validation (defense in depth). */
const MAX_PROGRAM_LENGTH = 400_000

/** Program-visible rejection class per declared binding errorClass contract. */
interface ProgramErrorClass {
  name: string
  memberNameProperty: string
}

/** One declared binding namespace, host-validated before dispatch. */
interface ProgramBinding {
  global: string
  functions: string[]
  errorClass?: ProgramErrorClass
}

/** One in-flight program: its pending binding calls. */
interface ActiveProgram {
  pendingCalls: Map<string, (resolution: { ok: boolean; value?: unknown; error?: string }) => void>
}

/** Runs keyed by the host's run id; a torn-down run rejects its pending calls. */
const activePrograms = new Map<string, ActiveProgram>()

/** Monotonic binding-call ids (unique per page; the host keys runs separately). */
let nextBindingCallId = 0

/** Build the program-visible rejection for a failed binding call. */
function bindingRejection(binding: ProgramBinding, message: string): Error {
  if (binding.errorClass === undefined) return new Error(message)
  const errorClass = binding.errorClass
  const rejection = new Error(message)
  rejection.name = errorClass.name
  ;(rejection as unknown as Record<string, unknown>)[errorClass.memberNameProperty] = message
  return rejection
}

/**
 * Build one binding namespace global: null-prototype, one async member per
 * declared function name. Member calls park on the run's pending map until
 * the host settles them with a binding-result message; every posted call
 * carries the run id so the host can route the result back.
 */
function buildBindingNamespace(binding: ProgramBinding, run: ActiveProgram, runId: string): Record<string, unknown> {
  // Object.create's return is typed any; the null prototype IS the contract
  // (member names must never collide with Object.prototype), so the assert
  // documents the downgrade rather than hiding it.
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const ns: Record<string, unknown> = Object.create(null)
  for (const fn of binding.functions) {
    const member = (args: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const callId = `c${nextBindingCallId++}`
        run.pendingCalls.set(callId, (resolution) => {
          if (resolution.ok) resolve(resolution.value)
          else reject(bindingRejection(binding, resolution.error ?? 'binding call failed'))
        })
        postToHost({ id: runId, type: 'binding-call', callId, ns: binding.global, fn, args: [args] })
      })
    Object.assign(ns, { [fn]: member })
  }
  if (binding.errorClass !== undefined) {
    const errorClass = binding.errorClass
    ns[errorClass.name] = class extends Error {
      override name = errorClass.name
      constructor(message: string) {
        super(message)
        ;(this as unknown as Record<string, unknown>)[errorClass.memberNameProperty] = message
      }
    }
  }
  return ns
}

/**
 * Evaluate and run one PTC program (`op: 'program'`). The completion settles
 * the run reply: the resolved value posts back raw for the host's
 * lossless-JSON verdict, a rejection posts as the run's exception. The
 * cleanup bound to the reply deletes the run's pending-call map.
 */
export function handleProgram(request: Record<string, unknown>): void {
  const id = typeof request.id === 'string' ? request.id : ''
  const program = request.program
  if (typeof program !== 'string' || program.length === 0 || program.length > MAX_PROGRAM_LENGTH) {
    postToHost({ id, ok: false, error: `program：程序必须是非空且不超过 ${String(MAX_PROGRAM_LENGTH)} 字符的字符串` })
    return
  }
  const declared = Array.isArray(request.bindings) ? (request.bindings as ProgramBinding[]) : []
  const run: ActiveProgram = { pendingCalls: new Map() }
  activePrograms.set(id, run)

  const emitConsole = (level: string, args: unknown[]): void => {
    postToHost({ type: 'program-console', id, level, parts: args.map(a => snapshotArg(a, 0, new Set())) })
  }
  const sandboxConsole = {
    log: (...args: unknown[]): void => {
      emitConsole('log', args)
    },
    info: (...args: unknown[]): void => {
      emitConsole('info', args)
    },
    warn: (...args: unknown[]): void => {
      emitConsole('warn', args)
    },
    error: (...args: unknown[]): void => {
      emitConsole('error', args)
    },
  }
  const inspect = (value: unknown): string => JSON.stringify(snapshotArg(value, 4, new Set()))

  const namespaces = declared.map(binding => ({ global: binding.global, ns: buildBindingNamespace(binding, run, id) }))
  const parameterNames = [...namespaces.map(entry => entry.global), 'console', 'inspect']
  let programFn: (...params: unknown[]) => Promise<unknown>
  try {
    // Same mechanism as main.ts's plugin factory: this page is the
    // manifest-sandboxed one, the only extension page whose CSP permits
    // indirect eval.
    // oxlint-disable-next-line typescript/no-implied-eval
    programFn = new Function(...parameterNames, `"use strict";\nreturn (async () => {\n${program}\n})()`) as (...params: unknown[]) => Promise<unknown>
  } catch (err) {
    activePrograms.delete(id)
    postToHost({ id, ok: false, error: errText(err) })
    return
  }

  programFn(...namespaces.map(entry => entry.ns), sandboxConsole, inspect)
    .then((value) => {
      activePrograms.delete(id)
      // A completion the post pipe cannot clone (a function, a symbol) would
      // throw inside postMessage; report it as the run's failure instead.
      try {
        structuredClone(value)
      } catch {
        postToHost({ id, ok: false, error: 'program completion is not transferable (functions and symbols cannot cross the sandbox boundary)' })
        return
      }
      postToHost({ id, ok: true, value })
    })
    .catch((err: unknown) => {
      activePrograms.delete(id)
      postToHost({ id, ok: false, error: errText(err) })
    })
}

/** Settle one pending binding call of a still-running program; unknown ids drop. */
export function handleBindingResult(message: Record<string, unknown>): void {
  const runId = typeof message.id === 'string' ? message.id : ''
  const callId = typeof message.callId === 'string' ? message.callId : ''
  const run = activePrograms.get(runId)
  const settle = run?.pendingCalls.get(callId)
  if (settle === undefined) return
  run?.pendingCalls.delete(callId)
  if (message.ok === true) settle({ ok: true, value: message.value })
  else settle({ ok: false, error: typeof message.error === 'string' ? message.error : 'binding call failed' })
}
