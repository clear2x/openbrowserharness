/**
 * Browser shim for node:async_hooks.
 *
 * dsh's agent registry uses AsyncLocalStorage for initiator attribution:
 * `initiators.run(agent, operation)` scopes the agent for the duration of
 * an ASYNC operation, and `requireInitiator()` → `getStore()` reads it when
 * tool execution begins.
 *
 * Browser limitation: AsyncLocalStorage propagates across `await` via
 * Node's async_hooks — impossible to replicate synchronously. This shim:
 * - Stores the last NON-NULLISH value from `run()` / `enterWith()`
 * - Does NOT clear on scope exit (leaky; correct for single-agent host)
 * - IGNORES `run(undefined, ...)` — dsh's `withInitiator(undefined, op)`
 *   would otherwise overwrite the live agent during async LLM streaming,
 *   breaking every subsequent `requireInitiator()` call
 */

export class AsyncLocalStorage<S = unknown> {
  #value: S | undefined = undefined
  #has = false

  run<T>(store: S, callback: () => T): T {
    if (store !== undefined && store !== null) {
      this.#value = store
      this.#has = true
    }
    return callback()
  }

  getStore(): S | undefined {
    return this.#has ? this.#value : undefined
  }

  enterWith(store: S): void {
    if (store !== undefined && store !== null) {
      this.#value = store
      this.#has = true
    }
  }

  exit<R>(callback: () => R): R {
    return callback()
  }
}
