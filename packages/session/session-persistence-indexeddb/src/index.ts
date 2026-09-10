/**
 * IndexedDB durable session-persistence backend for browser/extension hosts.
 * Sessions and events live in two object stores of one configurable database;
 * a {@link PersistenceCoordinator} supplies buffering, adoption, crash-repair
 * sequencing, and disposal quiescence, exactly as in the JSONL/SQLite backends.
 *
 * Torn-tail mapping: IndexedDB transactions are atomic, so a half-written
 * batch cannot persist. The torn concept still maps onto "rows the committed
 * prefix does not cover" — a first malformed row or seq gap (externally
 * injected, or written by a future multi-transaction mode) marks everything
 * from that seq on as a torn tail; {@link IndexedDbPersistence.commitRepair}
 * deletes by key range from that seq, which is the IDB equivalent of the
 * JSONL byte truncate.
 * @module @deepseek-ai/dsh-session-persistence-indexeddb
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE, DEFAULT_WRITE_BATCH_MAX_DELAY_MS, MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator, SessionPersistence, SessionPersistenceRevision,
  type PersistenceBackend, type SessionInspection, type SessionLocation,
  type SessionPersistenceSnapshot, type SessionPersistenceRevision as PersistenceRevision,
  type StoredPrefix, type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionId, SessionHeader, SessionPreparation } from '@deepseek-ai/dsh-session'

/** Object store holding one row per materialized session. */
export const SESSIONS_STORE = 'sessions'
/** Object store holding one row per stored event, keyed `[sessionId, seq]`. */
export const EVENTS_STORE = 'events'
/** Database schema version; v1 creates both stores. */
export const DATABASE_VERSION = 1
/** Default database name. */
export const DEFAULT_DB_NAME = 'dsh-sessions'

// ─────────────────────────── structural IndexedDB surface ───────────────────────────

/**
 * Minimal structural mirror of `IDBKeyRange`. Real `IDBKeyRange` instances
 * satisfy it structurally, and the in-memory test double reads the same four
 * fields — one range representation crosses both.
 */
export interface KeyRangeLike {
  readonly lower: unknown
  readonly upper: unknown
  readonly lowerOpen: boolean
  readonly upperOpen: boolean
}

/** One object store's operations as plain promises (structural `IDBObjectStore`). */
export interface StructuredStore {
  get(key: unknown): Promise<unknown>
  getAll(range?: KeyRangeLike): Promise<unknown[]>
  put(record: unknown): Promise<void>
  delete(keyOrRange: unknown): Promise<void>
}

/** One transaction over named stores (structural `IDBTransaction`). */
export interface StructuredTransaction {
  store(name: string): StructuredStore
  /** Resolves when the transaction has committed; rejects on abort. */
  readonly done: Promise<void>
}

/** One opened database (structural `IDBDatabase`). */
export interface StructuredDatabase {
  transaction(storeNames: readonly string[], mode: 'readonly' | 'readwrite'): StructuredTransaction
  close(): void
}

/** Injectable database opener; the default uses the global `indexedDB`. */
export type OpenDatabase = (dbName: string, version: number) => Promise<StructuredDatabase>

/**
 * Build a closed key range over one session's event keys: everything from
 * `[sessionId, fromSeq]` (inclusive) up to but excluding any key whose second
 * component stops being this session. The empty-array upper bound is greater
 * than every `[sessionId, n]` under IndexedDB's key order (arrays order above
 * scalars), so it selects the session's whole suffix.
 */
function eventRange(sessionId: SessionId, fromSeq = 0): KeyRangeLike {
  const upper = [sessionId, []]
  if (typeof IDBKeyRange !== 'undefined') {
    return IDBKeyRange.bound([sessionId, fromSeq], upper)
  }
  return { lower: [sessionId, fromSeq], upper, lowerOpen: false, upperOpen: false }
}

/** Resolve an IndexedDB request into a promise with a Chinese failure message. */
function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('session-persistence-indexeddb：IndexedDB 请求失败'))
  })
}

/** Adapt one native `IDBObjectStore` to {@link StructuredStore}. */
function adaptStore(store: IDBObjectStore): StructuredStore {
  const asRange = (range: KeyRangeLike | undefined): IDBKeyRange | undefined => {
    if (range === undefined) return undefined
    if (typeof IDBKeyRange !== 'undefined' && range instanceof IDBKeyRange) return range
    if (typeof IDBKeyRange === 'undefined') return undefined
    return IDBKeyRange.bound(range.lower, range.upper, range.lowerOpen, range.upperOpen)
  }
  return {
    get: key => requestAsPromise(store.get(key as IDBValidKey)),
    getAll: range => requestAsPromise(store.getAll(asRange(range))),
    put: async (record) => { await requestAsPromise(store.put(record)) },
    delete: async (target) => { await requestAsPromise(store.delete(target as IDBValidKey)) },
  }
}

/** Adapt one native `IDBDatabase` to {@link StructuredDatabase}. */
function adaptDatabase(db: IDBDatabase): StructuredDatabase {
  return {
    transaction(storeNames, mode) {
      const tx = db.transaction(storeNames as string[], mode)
      const adapted: StructuredTransaction = {
        store: name => adaptStore(tx.objectStore(name)),
        done: new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve()
          tx.onabort = () => reject(tx.error ?? new Error('session-persistence-indexeddb：IndexedDB 事务已中止'))
          tx.onerror = () => reject(tx.error ?? new Error('session-persistence-indexeddb：IndexedDB 事务失败'))
        }),
      }
      return adapted
    },
    close: () => db.close(),
  }
}

/** The default opener: the page/worker global `indexedDB`. */
export const defaultOpenDatabase: OpenDatabase = (dbName, version) => new Promise((resolve, reject) => {
  const factory: IDBFactory | undefined = typeof indexedDB !== 'undefined'
    ? indexedDB
    : (globalThis as { indexedDB?: IDBFactory }).indexedDB
  if (factory === undefined) {
    reject(new Error('session-persistence-indexeddb：当前环境没有可用的 indexedDB 全局对象，无法打开会话数据库'))
    return
  }
  const request = factory.open(dbName, version)
  request.onupgradeneeded = () => {
    const db = request.result
    if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
      db.createObjectStore(SESSIONS_STORE, { keyPath: 'sessionId' })
    }
    if (!db.objectStoreNames.contains(EVENTS_STORE)) {
      db.createObjectStore(EVENTS_STORE, { keyPath: ['sessionId', 'seq'] })
    }
  }
  request.onsuccess = () => resolve(adaptDatabase(request.result))
  request.onerror = () => reject(request.error ?? new Error(`session-persistence-indexeddb：打开数据库 "${dbName}" 失败`))
  request.onblocked = () => reject(new Error(`session-persistence-indexeddb：打开数据库 "${dbName}" 被其他连接阻塞`))
})

// ─────────────────────────── stored rows ───────────────────────────

/** One `sessions`-store row: the durable header plus the revision counter. */
interface SessionRow {
  readonly sessionId: string
  readonly header: SessionHeader
  /** Monotonic per-session counter; every durable write bumps it. */
  readonly revision: number
  readonly createdAt: number
}

/** One `events`-store row carrying the complete event record. */
interface EventRow {
  readonly sessionId: string
  readonly seq: number
  readonly event: SessionEvent
}

/**
 * The torn-tail repair token: delete every event row with
 * `seq >= truncateFromSeq`. Coordinator-opaque; produced by
 * {@link IndexedDbPersistence.loadStored} and consumed by
 * {@link IndexedDbPersistence.commitRepair}.
 */
export interface IndexedDbTornMarker {
  readonly truncateFromSeq: number
}

/** Whether one stored row is shaped like an event continuing a log at `seq`. */
function rowContinues(row: unknown, seq: number): row is EventRow {
  if (typeof row !== 'object' || row === null) return false
  const record = row as Record<string, unknown>
  if (record['seq'] !== seq || typeof record['sessionId'] !== 'string') return false
  const event = record['event']
  if (typeof event !== 'object' || event === null) return false
  const candidate = event as Record<string, unknown>
  return candidate['seq'] === seq && typeof candidate['type'] === 'string'
    && typeof candidate['time'] === 'number' && 'data' in candidate
}

/**
 * Find the preserved contiguous prefix of one session's ordered event rows.
 * The first malformed row or seq gap ends the committed prefix; everything
 * from that seq on is a never-committed torn tail. Rows above the gap are
 * excluded from the returned prefix (they are deleted by repair).
 * @param rows - one session's event rows, ordered by key ascending.
 * @param base - the seq the first row must carry (`0` for a whole-log read,
 *   the requested `fromSeq` for a suffix read).
 * @returns the preserved rows plus the truncation point when a torn tail exists.
 */
export function scanEventRows(rows: readonly unknown[], base = 0): { preserved: EventRow[]; tornFrom?: number } {
  const preserved: EventRow[] = []
  for (const [index, row] of rows.entries()) {
    if (!rowContinues(row, base + index)) break
    preserved.push(row as EventRow)
  }
  return preserved.length < rows.length ? { preserved, tornFrom: base + preserved.length } : { preserved }
}

// ─────────────────────────── the backend ───────────────────────────

/** Plugin config: database name plus the coordinator policy knobs. */
export interface Config {
  /**
   * IndexedDB database name. Defaults to `dsh-sessions`; deployments sharing
   * one origin under different profiles use distinct names.
   */
  dbName?: string
  /** Maximum cold Session preparations retained for history-to-resume reuse. */
  preparedSessionCacheSize?: number
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number
}

/** Extra construction options that never travel through plugin config. */
export interface IndexedDbPersistenceOptions {
  /** Database opener override (tests inject an in-memory adapter). */
  readonly openDatabase?: OpenDatabase
}

/**
 * The IndexedDB persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence` and delegates write-path orchestration to a
 * {@link PersistenceCoordinator}.
 */
export class IndexedDbPersistence extends SessionPersistence implements PersistenceBackend<IndexedDbTornMarker> {
  override readonly supportsRawArtifacts = false

  static inject = ['sessions']

  static Config: z<Config> = z.object({
    dbName: z.string().default(DEFAULT_DB_NAME),
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })

  /**
   * Backend label for coordinator diagnostics and effects. It shadows
   * `Service.name` (set to `'sessionPersistence'` by the base constructor)
   * without changing the service key — same pattern as the JSONL/SQLite
   * backends.
   */
  override readonly name = 'session-persistence-indexeddb'

  private readonly dbName: string
  private readonly dbPromise: Promise<StructuredDatabase>
  private readonly coordinator: PersistenceCoordinator<IndexedDbTornMarker>

  constructor(ctx: Context, config: Config = {}, options: IndexedDbPersistenceOptions = {}) {
    super(ctx)
    this.dbName = config.dbName ?? DEFAULT_DB_NAME
    const opening = (options.openDatabase ?? defaultOpenDatabase)(this.dbName, DATABASE_VERSION)
    // Keep the rejection observable to every hook while avoiding an unhandled
    // rejection before the first hook awaits it.
    opening.catch(() => {})
    this.dbPromise = opening
    this.coordinator = new PersistenceCoordinator<IndexedDbTornMarker>(this.ctx, this, {
      preparedSessionCacheSize: config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    })
  }

  /** The opened database; rejects with the Chinese open failure when unavailable. */
  private database(signal?: AbortSignal): Promise<StructuredDatabase> {
    signal?.throwIfAborted()
    return this.dbPromise
  }

  /** The source-qualified revision for one row. */
  private revisionOf(id: SessionId, row: SessionRow): PersistenceRevision {
    return SessionPersistenceRevision(`indexeddb:${this.dbName}:${id}:${row.revision}`)
  }

  // --- SessionPersistence service API (delegated to the coordinator) ---

  /**
   * Resolve the session's storage locator without touching the database: the
   * database name plus the row key prefix that owns its header and events.
   */
  locate(meta: SessionHeader): SessionLocation {
    return { kind: 'indexeddb', path: `${this.dbName}/${SESSIONS_STORE}/${meta.id}` }
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  // One method serves both public `list`/`listSnapshots` and the backend hook;
  // delegating them to the coordinator would call this hook recursively.

  // --- PersistenceBackend hooks (the object-store primitives) ---

  /** Read a stored prefix by id: header row plus every event row, detached. */
  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<IndexedDbTornMarker> | undefined> {
    signal?.throwIfAborted()
    const db = await this.database(signal)
    const tx = db.transaction([SESSIONS_STORE, EVENTS_STORE], 'readonly')
    const row = await tx.store(SESSIONS_STORE).get(id) as SessionRow | undefined
    if (row === undefined) return undefined
    const rows = await tx.store(EVENTS_STORE).getAll(eventRange(id)) as unknown[]
    signal?.throwIfAborted()
    const { preserved, tornFrom } = scanEventRows(rows)
    return {
      meta: structuredClone(row.header),
      events: preserved.map(stored => structuredClone(stored.event)),
      revision: this.revisionOf(id, row),
      ...tornFrom !== undefined ? { tornMarker: { truncateFromSeq: tornFrom } } : {},
    }
  }

  /** Read one row's revision without loading its events. */
  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    signal?.throwIfAborted()
    const db = await this.database(signal)
    const tx = db.transaction([SESSIONS_STORE], 'readonly')
    const row = await tx.store(SESSIONS_STORE).get(id) as SessionRow | undefined
    signal?.throwIfAborted()
    return row === undefined ? undefined : this.revisionOf(id, row)
  }

  /**
   * Seek-capable suffix read: the events store is keyed by `[sessionId, seq]`,
   * so the range query reads only `seq >= fromSeq`. Torn rows past the
   * preserved region are dropped, never repaired (non-mutating read).
   */
  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted()
    const db = await this.database(signal)
    const tx = db.transaction([SESSIONS_STORE, EVENTS_STORE], 'readonly')
    const row = await tx.store(SESSIONS_STORE).get(id) as SessionRow | undefined
    if (row === undefined) return undefined
    const rows = await tx.store(EVENTS_STORE).getAll(eventRange(id, fromSeq)) as unknown[]
    signal?.throwIfAborted()
    return {
      meta: structuredClone(row.header),
      events: scanEventRows(rows, fromSeq).preserved.map(stored => structuredClone(stored.event)),
    }
  }

  /**
   * Durably append a batch in ONE transaction: materialize the sessions row
   * (when lazy) and put every event row, or fail without touching stored
   * state. The transaction is the atomicity + durability boundary — the IDB
   * counterpart of the JSONL temp-file publish.
   */
  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    if (events.length === 0 && isMaterialized) return
    const db = await this.database()
    const tx = db.transaction([SESSIONS_STORE, EVENTS_STORE], 'readwrite')
    const sessions = tx.store(SESSIONS_STORE)
    const eventRows = tx.store(EVENTS_STORE)
    const existing = await sessions.get(meta.id) as SessionRow | undefined
    await sessions.put({
      sessionId: meta.id,
      header: structuredClone(meta),
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? meta.createdAt,
    } satisfies SessionRow)
    for (const event of events) {
      await eventRows.put({ sessionId: meta.id, seq: event.seq, event: structuredClone(event) } satisfies EventRow)
    }
    await tx.done
  }

  /**
   * Make a crash repair durable in ONE transaction: delete the torn tail by
   * key range (`seq >= truncateFromSeq`) and put the synthetic closers, then
   * bump the revision. The coordinator does not require atomicity here, but
   * one transaction is free on this medium.
   */
  async commitRepair(
    meta: SessionHeader,
    tornMarker: IndexedDbTornMarker | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    if (tornMarker === undefined && closers.length === 0) return
    const db = await this.database()
    const tx = db.transaction([SESSIONS_STORE, EVENTS_STORE], 'readwrite')
    const sessions = tx.store(SESSIONS_STORE)
    const eventRows = tx.store(EVENTS_STORE)
    if (tornMarker !== undefined) {
      await eventRows.delete(eventRange(meta.id, tornMarker.truncateFromSeq))
    }
    for (const closer of closers) {
      await eventRows.put({ sessionId: meta.id, seq: closer.seq, event: structuredClone(closer) } satisfies EventRow)
    }
    const existing = await sessions.get(meta.id) as SessionRow | undefined
    await sessions.put({
      sessionId: meta.id,
      header: structuredClone(meta),
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? meta.createdAt,
    } satisfies SessionRow)
    await tx.done
  }

  /** List every materialized session's metadata (each row IS a materialized session). */
  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    const db = await this.database(signal)
    const tx = db.transaction([SESSIONS_STORE], 'readonly')
    const rows = await tx.store(SESSIONS_STORE).getAll() as unknown[]
    signal?.throwIfAborted()
    return (rows as SessionRow[]).map(row => structuredClone(row.header))
  }

  /** List metadata plus the source-qualified revision for each session. */
  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    const db = await this.database(signal)
    const tx = db.transaction([SESSIONS_STORE], 'readonly')
    const rows = await tx.store(SESSIONS_STORE).getAll() as unknown[]
    signal?.throwIfAborted()
    return (rows as SessionRow[]).map(row => ({
      header: structuredClone(row.header),
      revision: this.revisionOf(row.sessionId as SessionId, row),
    }))
  }

  /** Close the database handle after the coordinator's disposal drain. */
  async close(): Promise<void> {
    await this.dbPromise.then(
      db => db.close(),
      () => {},
    )
  }
}

export default IndexedDbPersistence
