/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-persistence-indexeddb`.
 * @module @deepseek-ai/dsh-session-persistence-indexeddb/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-persistence-indexeddb'

/** Cordis companion plugin name. */
export const name = 'session-persistence-indexeddb-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: persistence correctness requires backend round-trip and crash-tail tests;
 * this backend exposes no continuously observable in-process relation beyond the shared coordinator.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
