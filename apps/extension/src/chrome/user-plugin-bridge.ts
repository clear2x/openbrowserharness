/**
 * RPC bridge methods for user plugins (`plugin.*`), shaped to merge into
 * chrome-api-bridge's method table.
 *
 * This file is deliberately SEPARATE from api-bridge.ts (which must not know
 * about the sandbox lane): the api-bridge dispatcher owns transport, framing,
 * and error wrapping; these handlers only parse payloads, delegate to
 * {@link UserPluginHost}, and return ok VALUES. Thrown Errors arrive at the
 * client as `{ok:false, error:{code:'internal', message}}` — input validation
 * failures are intentionally plain errors, not structured refusals.
 *
 * WIRING NOTE for the future one-line integration in api-bridge.ts:
 *   import { createUserPluginMethods } from './user-plugin-bridge'
 *   Object.assign(METHODS, createUserPluginMethods(userPluginHost()!))
 * (api-bridge's `MethodHandler` is `(payload: unknown, ctx: Context) =>
 * Promise<unknown>`; the handlers here take one argument and are assignable.)
 */

import type { Context } from '@deepseek-ai/cordis'
import type { UserPluginHost } from './user-plugins'

/**
 * One plugin.* method implementation. Signature-compatible with
 * chrome-api-bridge's private MethodHandler: returns the ok VALUE, throws for
 * structured failures.
 */
export type UserPluginMethodHandler = (payload: unknown, ctx: Context) => Promise<unknown>

/** Payload guards mirroring api-bridge's local helpers (they are module-private there). */
function payloadObject(payload: unknown, method: string): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${method}：payload 必须是对象`)
  }
  return payload as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, key: string, method: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${method}：字段 ${key} 必须是非空字符串`)
  }
  return value
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`字段 ${key} 必须是布尔值`)
  return value
}

/**
 * Build the plugin.* method table against a lazy host resolver.
 *
 * - `plugin.list`   {includeCode?: boolean} → { items }
 * - `plugin.write`  {name,title,description,code,enabled?} → { name, registeredEvents }
 * - `plugin.remove` {name} → { removed: true }
 * - `plugin.toggle` {name, enabled} → { name, enabled, registeredEvents }
 *
 * @param resolveHost - resolves the offscreen user-plugin host singleton at
 *   call time; the method table is built before the engine finishes booting,
 *   so the resolver (not a captured instance) must throw when absent.
 * @returns method-name → handler map ready to merge into an RPC dispatcher.
 */
export function createUserPluginMethods(
  resolveHost: () => UserPluginHost,
): Record<string, UserPluginMethodHandler> {
  return {
    'plugin.list': async (payload) => {
      const record = payloadObject(payload ?? {}, 'plugin.list')
      const includeCode = optionalBoolean(record, 'includeCode') ?? false
      return { items: await resolveHost().list(includeCode) }
    },

    'plugin.write': async (payload) => {
      const record = payloadObject(payload, 'plugin.write')
      const enabled = optionalBoolean(record, 'enabled')
      return await resolveHost().write({
        name: requiredString(record, 'name', 'plugin.write'),
        title: requiredString(record, 'title', 'plugin.write'),
        description: typeof record.description === 'string' ? record.description : '',
        code: requiredString(record, 'code', 'plugin.write'),
        ...(enabled === undefined ? {} : { enabled }),
      })
    },

    'plugin.remove': async (payload) => {
      const record = payloadObject(payload, 'plugin.remove')
      await resolveHost().remove(requiredString(record, 'name', 'plugin.remove'))
      return { removed: true }
    },

    'plugin.toggle': async (payload) => {
      const record = payloadObject(payload, 'plugin.toggle')
      const name = requiredString(record, 'name', 'plugin.toggle')
      const enabled = optionalBoolean(record, 'enabled')
      if (enabled === undefined) {
        throw new Error('plugin.toggle：字段 enabled 必须是布尔值（true=启用 / false=停用）')
      }
      return await resolveHost().toggle(name, enabled)
    },
  }
}
