/**
 * Browser shim for node:timers/promises — the util/atomic-write backoff and
 * other delay callers route through the global timer; the promise form is the
 * only surface this bundle needs.
 */

export function setTimeout(ms: number, value?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> {
  void options
  return new Promise((resolve) => {
    globalThis.setTimeout(() => {
      resolve(value)
    }, ms)
  })
}

export function setTimeout$1(ms: number, value?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> {
  return setTimeout(ms, value, options)
}

const timersPromisesShim = { setTimeout, setTimeout$1 }

export default timersPromisesShim
