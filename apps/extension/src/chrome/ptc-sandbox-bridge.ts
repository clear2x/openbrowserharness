/**
 * Host side of the PTC sandbox bridge: one hidden `sandbox.html` iframe per
 * bridge, driven over the same postMessage protocol as the user-plugin host
 * (see src/sandbox/main.ts's module doc for the wire shapes). The bridge owns
 * the iframe lifecycle — creation with a readiness handshake, program
 * dispatch, binding-call dispatch back into host functions, console
 * accumulation, and the hard stop (iframe replacement) that kills a runaway
 * program on timeout or abort.
 *
 * The sandbox isolates the extension bundle from accidental breakage, not
 * malicious code from the user — same threat model note as the sandbox page.
 * @module chrome/ptc-sandbox-bridge
 */

/** One declared binding namespace handed to the sandbox with the program. */
export interface BridgeBinding {
  global: string
  functions: string[]
  errorClass?: { name: string; memberNameProperty: string }
}

/** One host function behind a binding member. */
export interface BridgeBindingFunction {
  namespace: string
  member: string
  call(args: unknown): Promise<unknown>
}

/** Everything captured from one finished program. */
export interface BridgeRunOutcome {
  ok: boolean
  value?: unknown
  error?: string
  consoleLines: Array<{ level: string; text: string }>
}

/** One in-flight run: its binding functions, console sink, and completion resolver. */
interface PendingRun {
  bindings: BridgeBindingFunction[]
  consoleLines: Array<{ level: string; text: string }>
  settle(outcome: BridgeRunOutcome): void
}

/** Host→sandbox source tag (matches src/sandbox/protocol.ts). */
const HOST_TAG = 'obh-sandbox'
/** Sandbox→host source tag (matches src/sandbox/protocol.ts). */
const SANDBOX_TAG = 'obh-sandbox-host'

export class PtcSandboxBridge {
  private iframe: HTMLIFrameElement | undefined
  private ready: Promise<void> | undefined
  private nextRunId = 0
  private readonly pending = new Map<string, PendingRun>()

  private readonly listener = (event: MessageEvent): void => {
    if (event.source !== this.iframe?.contentWindow) return
    const data: unknown = event.data
    if (data === null || typeof data !== 'object') return
    const message = data as Record<string, unknown>
    if (message.source !== SANDBOX_TAG) return
    if (message.type === 'ready') {
      this.readyResolve?.()
      this.readyResolve = undefined
      return
    }
    if (typeof message.id !== 'string') return
    const run = this.pending.get(message.id)
    if (run === undefined) return
    if (message.type === 'program-console') {
      const parts = Array.isArray(message.parts) ? (message.parts as unknown[]) : []
      const level = typeof message.level === 'string' ? message.level : 'log'
      run.consoleLines.push({ level, text: parts.map(part => typeof part === 'string' ? part : JSON.stringify(part)).join(' ') })
      return
    }
    if (message.type === 'binding-call') {
      this.dispatchBinding(message.id, run, message)
      return
    }
    // The run reply: ok + completion value, or ok:false + the failure text.
    this.finish(message.id, run, message.ok === true
      ? { ok: true, value: message.value, consoleLines: run.consoleLines }
      : { ok: false, error: typeof message.error === 'string' ? message.error : 'program failed', consoleLines: run.consoleLines })
  }

  /** The pending handshake resolver, held until the sandbox posts `ready`. */
  private readyResolve: (() => void) | undefined

  constructor(private readonly sandboxUrl: string) {
    window.addEventListener('message', this.listener)
  }

  /** Ensure the hidden iframe exists and has completed its ready handshake. */
  ensureReady(): Promise<void> {
    this.ready ??= new Promise((resolve) => {
      const iframe = document.createElement('iframe')
      iframe.src = this.sandboxUrl
      // Invisible but present: display:none can suppress iframe loading in
      // some engines (the user-plugin host hit the same wall), so park it
      // off-canvas instead.
      iframe.style.position = 'fixed'
      iframe.style.width = '0'
      iframe.style.height = '0'
      iframe.style.border = '0'
      iframe.style.visibility = 'hidden'
      iframe.style.left = '-9999px'
      document.body.appendChild(iframe)
      this.iframe = iframe
      // The sandbox posts `ready` at module load. A lost handshake (the post
      // racing the listener install) resolves at first load-event + tick.
      this.readyResolve = resolve
      iframe.addEventListener('load', () => {
        setTimeout(() => {
          if (this.readyResolve === resolve) {
            this.readyResolve = undefined
            resolve()
          }
        }, 50)
      })
    })
    return this.ready
  }

  /**
   * Run one program. The returned promise settles with the sandbox outcome —
   * including the failure kinds this bridge owns: an aborted signal or an
   * expired deadline hard-stops the iframe (killing the program mid-loop) and
   * fails every in-flight run.
   * @param deadlineMs - Elapsed budget; null runs without a bridge-owned deadline.
   */
  async run(input: {
    program: string
    bindings: BridgeBinding[]
    functions: BridgeBindingFunction[]
    deadlineMs: number | null
    signal?: AbortSignal
  }): Promise<BridgeRunOutcome> {
    await this.ensureReady()
    return new Promise((resolve) => {
      const iframe = this.iframe
      const frameWindow = iframe?.contentWindow
      if (iframe === undefined || frameWindow === undefined || frameWindow === null) {
        resolve({ ok: false, error: 'the sandbox iframe is not available', consoleLines: [] })
        return
      }
      const runId = `p${this.nextRunId++}`
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => {
        this.hardStop('abort', 'the program was aborted')
      }
      const settle = (outcome: BridgeRunOutcome): void => {
        if (timer !== undefined) clearTimeout(timer)
        input.signal?.removeEventListener('abort', onAbort)
        this.pending.delete(runId)
        resolve(outcome)
      }
      input.signal?.addEventListener('abort', onAbort, { once: true })
      // An already-aborted signal fired during listener registration.
      if (input.signal?.aborted === true) {
        input.signal.removeEventListener('abort', onAbort)
        resolve({ ok: false, error: 'abort: the program was aborted', consoleLines: [] })
        return
      }
      this.pending.set(runId, { bindings: input.functions, consoleLines: [], settle })
      // The deadline budgets the program itself, so it starts at dispatch.
      if (input.deadlineMs !== null) {
        timer = setTimeout(() => {
          this.hardStop('timeout', `the program exceeded its ${String(input.deadlineMs)}ms budget`)
        }, input.deadlineMs)
      }
      frameWindow.postMessage({
        source: HOST_TAG,
        id: runId,
        op: 'program',
        program: input.program,
        bindings: input.bindings,
      }, '*')
    })
  }

  /** Settle one run and drop it from the pending map. */
  private finish(runId: string, run: PendingRun, outcome: BridgeRunOutcome): void {
    this.pending.delete(runId)
    run.settle(outcome)
  }

  /**
   * Kill every in-flight run by replacing the iframe: the programs die
   * mid-loop (a postMessage cannot interrupt a synchronous loop), pending
   * binding calls fail with `kind`, and the fresh iframe re-handshakes lazily
   * on the next run.
   */
  private hardStop(kind: string, message: string): void {
    const dying = [...this.pending.entries()]
    this.pending.clear()
    this.iframe?.remove()
    this.iframe = undefined
    this.ready = undefined
    this.readyResolve = undefined
    for (const [, run] of dying) run.settle({ ok: false, error: `${kind}: ${message}`, consoleLines: run.consoleLines })
  }

  /** Answer one sandbox binding-call by invoking the declared host function. */
  private dispatchBinding(runId: string, run: PendingRun, message: Record<string, unknown>): void {
    const callId = typeof message.callId === 'string' ? message.callId : ''
    const ns = typeof message.ns === 'string' ? message.ns : ''
    const fn = typeof message.fn === 'string' ? message.fn : ''
    const args = Array.isArray(message.args) ? (message.args as unknown[]) : []
    const answer = (payload: Record<string, unknown>): void => {
      this.iframe?.contentWindow?.postMessage({ source: HOST_TAG, type: 'binding-result', id: runId, callId, ...payload }, '*')
    }
    const target = run.bindings.find(candidate => candidate.namespace === ns && candidate.member === fn)
    if (target === undefined) {
      answer({ ok: false, error: `binding "${ns}.${fn}" is not declared` })
      return
    }
    Promise.resolve().then(() => target.call(args[0]))
      .then((value) => {
        answer({ ok: true, value })
      })
      .catch((err: unknown) => {
        answer({ ok: false, error: err instanceof Error ? err.message : String(err) })
      })
  }

  /** Drop the bridge: listener off, iframe gone. In-flight runs die with the page. */
  dispose(): void {
    window.removeEventListener('message', this.listener)
    this.iframe?.remove()
    this.iframe = undefined
    this.ready = undefined
    this.readyResolve = undefined
  }
}
