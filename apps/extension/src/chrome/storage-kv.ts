/**
 * `chrome-storage-kv`: the browser-host KV storage backend — one
 * chrome.storage.local key per KV unit (whole-unit JSON snapshot, stamped with
 * the unit format version), published through the SW-routed storage client the
 * engine's settings/skills already ride. Registers as backend `chrome` on the
 * storage hub so the platform-neutral `dsh-storage-domain` layer (and the
 * message-feedback sidecar it owns) serves from extension-native persistence.
 *
 * Concurrency note: the domain layer serializes writes per unit (one write
 * chain), so the read-modify-write whole-unit publish is single-writer per
 * unit — the same durability argument the JSON backend's atomic file rewrite
 * makes.
 */

import type { Context } from '@deepseek-ai/cordis'
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { storageGet, storageSet } from './storage-client'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'chrome-storage-kv'

/** The hub must exist before the backend can register. */
export const inject = ['storage']

/** This plugin has no config. */
export interface Config {}

/** Storage key prefix holding one whole-unit snapshot per KV unit. */
const KEY_PREFIX = 'dsh-kv:'

/** Whole-unit medium shape persisted under one chrome.storage key. */
interface UnitMedium {
  version: number
  tables: Record<string, Record<string, unknown>>
  global: unknown
}

/** chrome.storage backend: owns the prefixed key space and serves `kv`. */
class ChromeStorageBackend implements StorageBackend {
  private readonly units = new Map<string, ChromeStorageUnit>()
  private closed = false

  readonly kv: KvFacet = {
    open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      if (this.closed) throw new StorageError('closed', 'chrome storage backend is closed')
      validateDescriptor(descriptor)
      if (this.units.has(descriptor.name)) {
        // Double-open is a caller bug, not a medium condition.
        throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`)
      }
      const unit = new ChromeStorageUnit(descriptor)
      await unit.load()
      if (this.closed) {
        await unit.close()
        throw new StorageError('closed', 'chrome storage backend is closed')
      }
      this.units.set(descriptor.name, unit)
      return unit
    },
  }

  async close(): Promise<void> {
    this.closed = true
    for (const unit of [...this.units.values()]) await unit.close()
    this.units.clear()
  }
}

/** One opened unit: in-memory snapshot, write-through whole-unit publish. */
class ChromeStorageUnit implements KvUnit {
  private readonly tables = new Map<string, Map<string, unknown>>()
  private globalValue: unknown
  private closed = false

  constructor(private readonly descriptor: KvUnitDescriptor) {
    for (const table of descriptor.tables) this.tables.set(table, new Map())
    this.globalValue = undefined
  }

  /** Load the medium, refusing a version the descriptor does not own. */
  async load(): Promise<void> {
    const items = await storageGet([KEY_PREFIX + this.descriptor.name])
    const medium = items[KEY_PREFIX + this.descriptor.name] as UnitMedium | undefined
    if (medium === undefined) return
    if (medium === null || typeof medium !== 'object' || typeof medium.version !== 'number') {
      throw new StorageError('malformed-medium', `unit '${this.descriptor.name}' is not a parseable KV medium`)
    }
    if (medium.version !== this.descriptor.version) {
      throw new StorageError(
        'version-mismatch',
        `unit '${this.descriptor.name}' medium version ${String(medium.version)} ≠ descriptor version ${String(this.descriptor.version)}`,
      )
    }
    for (const [table, records] of Object.entries(medium.tables ?? {})) {
      const target = this.tables.get(table)
      if (target === undefined) {
        throw new StorageError(
          'malformed-medium',
          `unit '${this.descriptor.name}' medium carries undeclared table '${table}'`,
        )
      }
      if (records === null || typeof records !== 'object') {
        throw new StorageError('malformed-medium', `unit '${this.descriptor.name}' table '${table}' is not a record map`)
      }
      for (const [key, value] of Object.entries(records)) target.set(key, value)
    }
    this.globalValue = medium.global
  }

  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of this.tables) {
      tables[table] = Object.fromEntries([...records.entries()].map(([key, value]) => [key, structuredClone(value)]))
    }
    return Promise.resolve({ tables, global: structuredClone(this.globalValue) })
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    this.table(table).set(key, structuredClone(value))
    await this.publish()
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    this.table(table).delete(key)
    await this.publish()
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new StorageError('malformed-medium', `unit '${this.descriptor.name}' declares no global slot`)
    }
    this.globalValue = structuredClone(value)
    await this.publish()
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }

  private table(table: string): Map<string, unknown> {
    const records = this.tables.get(table)
    if (records === undefined) {
      throw new StorageError('malformed-medium', `unit '${this.descriptor.name}' has no table '${table}'`)
    }
    return records
  }

  /** Publish the whole stamped unit. */
  private async publish(): Promise<void> {
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of this.tables) tables[table] = Object.fromEntries(records)
    const medium: UnitMedium = { version: this.descriptor.version, tables, global: this.globalValue }
    await storageSet({ [KEY_PREFIX + this.descriptor.name]: medium })
  }

  private assertOpen(): void {
    if (this.closed) throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
  }
}

function validateDescriptor(descriptor: KvUnitDescriptor): void {
  if (!UNIT_NAME_RE.test(descriptor.name)) {
    throw new StorageError('malformed-medium', `invalid unit name '${descriptor.name}'`)
  }
  for (const table of descriptor.tables) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new StorageError('malformed-medium', `invalid table name '${table}' in unit '${descriptor.name}'`)
    }
  }
}

/**
 * Register the `chrome` backend on the storage hub.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  const backend = new ChromeStorageBackend()
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register('chrome', backend)
    return async () => {
      unregister()
      await backend.close()
    }
  })
  ctx.provide(storageBackendServiceKey('chrome'), backend)
}
