/** Shared settlement deadline for the startup and probe budgets. */

import { McpLocalError } from './diagnostic.ts'

/**
 * Detach a timer from process lifetime where the runtime supports it. A Node
 * `Timeout` carries `unref` (the deadline never holds the process open); a
 * browser timer is a bare number with nothing to detach, so the optional call
 * is the runtime-safe form of the same intent.
 * @param timer - the handle `setTimeout` returned under either runtime.
 */
export function detachTimer(timer: ReturnType<typeof setTimeout>): void {
  const handle = timer as { unref?(): void }
  handle.unref?.()
}

/**
 * Settle with `promise`, or reject with an `MCP_TIMEOUT` {@link McpLocalError}
 * carrying `timeoutMessage` once `remainingMs` elapses first. The timer never holds the process open, and a non-Error
 * rejection is wrapped so callers always observe an Error.
 * @param promise - operation the deadline bounds.
 * @param remainingMs - remaining budget in milliseconds (clamped to at least 1).
 * @param timeoutMessage - diagnostic carried by the deadline rejection.
 * @returns the operation's value; rejects with the deadline or the operation's failure.
 */
export function withDeadline<T>(promise: Promise<T>, remainingMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new McpLocalError(timeoutMessage, 'MCP_TIMEOUT'))
    }, Math.max(1, remainingMs))
    detachTimer(timer)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
