/**
 * In-memory test double for the structural IndexedDB surface
 * (`StructuredDatabase`/`StructuredStore`). It keeps one map per object store,
 * interprets {@link KeyRangeLike} with IndexedDB's key-order rules (numbers <
 * strings < arrays; arrays compare element-wise, shorter prefix first), and
 * applies writes immediately — the coordinator serializes per-session writes,
 * so single-writer immediate application exercises the backend's logic without
 * re-implementing transaction staging. Tests reach into `state` to inject torn
 * tails and assert stored rows.
 * @module @deepseek-ai/dsh-session-persistence-indexeddb/tests/memory-idb
 */

import type {
  KeyRangeLike,
  OpenDatabase,
  StructuredDatabase,
  StructuredStore,
  StructuredTransaction,
} from '../src/index.ts'

/** Key shapes this double supports: strings and `[string, number]` arrays. */
type Key = string | [string, number]

/** One stored record with its materialized key. */
interface Entry {
  readonly key: Key
  readonly value: unknown
}

/** IDB key type order: numbers (1) < strings (2) < arrays (3); anything else is a caller bug. */
function typeOrder(key: unknown): number {
  if (typeof key === 'number') return 1
  if (typeof key === 'string') return 2
  if (Array.isArray(key)) return 3
  return 0
}

/**
 * Compare two keys under IndexedDB's total order. Recursion matters: array
 * ELEMENTS compare with the same cross-type rule (any number < any string <
 * any array), so an upper bound like `[sessionId, []]` sorts above every
 * `[sessionId, n]` — JavaScript's relational coercion would get that backwards
 * (`1 > []` is `true`), which is exactly the trap this comparator exists to
 * avoid.
 */
function compareKeys(a: unknown, b: unknown): number {
  const orderA = typeOrder(a)
  const orderB = typeOrder(b)
  if (orderA !== orderB) return orderA - orderB
  if (orderA === 1 || orderA === 2) {
    const left = a as number | string
    const right = b as number | string
    return left < right ? -1 : left > right ? 1 : 0
  }
  const left = a as unknown[]
  const right = b as unknown[]
  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index++) {
    const order = compareKeys(left[index], right[index])
    if (order !== 0) return order
  }
  return left.length - right.length
}

/** Whether one key falls inside a range (both bounds inclusive by default). */
function keyInRange(key: Key, range: KeyRangeLike): boolean {
  if (range.lower !== undefined) {
    if (range.lower === null) throw new Error('memory-idb: null lower bound is unsupported')
    const order = compareKeys(key, range.lower as Key)
    if (order < 0 || (order === 0 && range.lowerOpen)) return false
  }
  if (range.upper !== undefined) {
    if (range.upper === null) throw new Error('memory-idb: null upper bound is unsupported')
    const order = compareKeys(key, range.upper as Key)
    if (order > 0 || (order === 0 && range.upperOpen)) return false
  }
  return true
}

/** One store's live rows keyed by a canonical spelling of the key. */
interface MemoryStore {
  readonly keyPath: string | readonly string[]
  readonly rows: Map<string, Entry>
}

/** Canonical map key so distinct key values never collide. */
function canonical(key: Key): string {
  return typeof key === 'string' ? `s:${key}` : `a:${key[0]}:${key[1]}`
}

/** Materialize one record's key from the store's keyPath. */
function keyOf(store: MemoryStore, value: unknown): Key {
  if (typeof store.keyPath === 'string') {
    const field = (value as Record<string, unknown>)[store.keyPath]
    if (typeof field !== 'string') throw new Error(`memory-idb: record has no string ${store.keyPath} key`)
    return field
  }
  const [sessionIdField, seqField] = store.keyPath
  const record = value as Record<string, unknown>
  const sessionId = record[sessionIdField as string]
  const seq = record[seqField as string]
  if (typeof sessionId !== 'string' || typeof seq !== 'number') {
    throw new Error(`memory-idb: record has no [${String(sessionIdField)}, ${String(seqField)}] key`)
  }
  return [sessionId, seq]
}

/** Adapt one live store to the backend's promise-based surface. */
function adaptStore(store: MemoryStore): StructuredStore {
  const sortedEntries = (): Entry[] => [...store.rows.values()].sort((a, b) => compareKeys(a.key, b.key))
  return {
    get: async key => structuredClone(store.rows.get(canonical(key as Key))?.value),
    getAll: async range => structuredClone(
      sortedEntries()
        .filter(entry => range === undefined || keyInRange(entry.key, range))
        .map(entry => entry.value),
    ),
    put: async (record) => {
      const key = keyOf(store, record)
      store.rows.set(canonical(key), { key, value: structuredClone(record) })
    },
    delete: async (target) => {
      if (target !== null && typeof target === 'object' && !Array.isArray(target) && 'lower' in (target as object)) {
        const range = target as KeyRangeLike
        for (const entry of sortedEntries()) {
          if (keyInRange(entry.key, range)) store.rows.delete(canonical(entry.key))
        }
        return
      }
      store.rows.delete(canonical(target as Key))
    },
  }
}

/** Direct access for tests: inject torn rows, inspect stored state. */
interface MemoryDatabaseState {
  readonly sessions: Map<string, Entry>
  readonly events: Map<string, Entry>
}

/** A fresh in-memory database factory bound to one storage scope. */
export interface MemoryDatabase {
  /** The {@link OpenDatabase} the backend under test receives. */
  readonly open: OpenDatabase
  /** Direct row access for corruption injection and assertions. */
  readonly state: MemoryDatabaseState
  /** Canonical map key for one event row (test-side injection helper). */
  eventKey(sessionId: string, seq: number): string
}

/**
 * Create one in-memory storage scope. Every `open()` returns a NEW database
 * view over the SAME maps (a reopen after close sees the same rows), matching
 * how two mounts of one extension share an origin's database.
 */
export function createMemoryDatabase(): MemoryDatabase {
  const sessions: MemoryStore = { keyPath: 'sessionId', rows: new Map() }
  const events: MemoryStore = { keyPath: ['sessionId', 'seq'], rows: new Map() }
  return {
    open: async () => {
      // close() affects only its own connection, like a real IDBDatabase; a
      // later open() over the same scope sees the same rows.
      let closed = false
      const assertOpen = (): void => {
        if (closed) throw new Error('memory-idb: database is closed')
      }
      const database: StructuredDatabase = {
        transaction(storeNames, mode) {
          assertOpen()
          void mode
          const tx: StructuredTransaction = {
            store: (name) => {
              if (storeNames.includes(name) === false) throw new Error(`memory-idb: store "${name}" not in transaction`)
              if (name === 'sessions') return adaptStore(sessions)
              if (name === 'events') return adaptStore(events)
              throw new Error(`memory-idb: unknown store "${name}"`)
            },
            done: Promise.resolve(),
          }
          return tx
        },
        close: () => {
          closed = true
        },
      }
      return database
    },
    state: { sessions: sessions.rows, events: events.rows },
    eventKey: (sessionId, seq) => canonical([sessionId, seq]),
  }
}
