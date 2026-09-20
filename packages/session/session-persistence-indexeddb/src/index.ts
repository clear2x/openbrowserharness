/**
 * IndexedDB durable session-persistence backend for browser/extension hosts.
 * Sessions and events live in two object stores of one configurable database;
 * the service implements the handle-based seam directly — one live write owner
 * per session in this process, storage-backed reads for freshness, and one
 * transaction per write for atomicity.
 *
 * Torn-tail mapping: IndexedDB transactions are atomic, so a half-written
 * batch cannot persist. The torn concept still maps onto "rows the committed
 * prefix does not cover" — a first malformed row or seq gap (externally
 * injected, or written by a future multi-transaction mode) marks everything
 * from that seq on as a torn tail; a write open deletes by key range from
 * that seq, which is the IDB equivalent of the JSONL byte truncate.
 *
 * Historical formats: rows written before the 0.1.5 format uplift carry v1/v2
 * logical headers and events (e.g. `assistant/chunk`). Every durable read
 * routes them through the released migration catalog (`dsh-session-format-catalog`)
 * to the current format; the first write open additionally publishes the
 * migrated generation in place after archiving the original rows verbatim in
 * {@link ARCHIVE_STORE} — nothing committed is destroyed.
 * @module @deepseek-ai/dsh-session-persistence-indexeddb
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  SessionPersistence,
  SessionPersistenceRevision,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  assertContiguous,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
  type SessionHandle,
  type SessionAccess,
  type SessionHandleAppendOptions,
  type SessionHandleFlushOptions,
  type SessionHandleReadOptions,
  type SessionHandleReadResult,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
  type SessionPersistenceRevision as PersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  adoptSessionEvent,
  assistantSettlementFieldsValid,
  KNOWN_SESSION_EVENT_TYPES,
} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'

/** Object store holding one row per materialized session. */
export const SESSIONS_STORE = 'sessions'
/** Object store holding one row per stored event, keyed `[sessionId, seq]`. */
export const EVENTS_STORE = 'events'
/**
 * Object store preserving the verbatim pre-upgrade generation of one session
 * (its SessionRow plus the original event rows) so a format upgrade never
 * destroys committed history.
 */
export const ARCHIVE_STORE = 'session-format-archive'
/** Database schema version; v2 adds the format-archive store. */
export const DATABASE_VERSION = 2
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
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('session-persistence-indexeddb：IndexedDB 请求失败')) }
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
          tx.oncomplete = () => { resolve() }
          tx.onabort = () => { reject(tx.error ?? new Error('session-persistence-indexeddb：IndexedDB 事务已中止')) }
          tx.onerror = () => { reject(tx.error ?? new Error('session-persistence-indexeddb：IndexedDB 事务失败')) }
        }),
      }
      return adapted
    },
    close: () => { db.close() },
  }
}

/**
 * The default opener: the page/worker global `indexedDB`.
 * @param dbName - the database name to open.
 * @param version - the schema version to open it at.
 */
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
    if (!db.objectStoreNames.contains(ARCHIVE_STORE)) {
      db.createObjectStore(ARCHIVE_STORE, { keyPath: 'sessionId' })
    }
  }
  request.onsuccess = () => { resolve(adaptDatabase(request.result)) }
  request.onerror = () => { reject(request.error ?? new Error(`session-persistence-indexeddb：打开数据库 "${dbName}" 失败`)) }
  request.onblocked = () => { reject(new Error(`session-persistence-indexeddb：打开数据库 "${dbName}" 被其他连接阻塞`)) }
})

// ─────────────────────────── stored rows ───────────────────────────

/** One `sessions`-store row: the durable header plus the revision counter. */
interface SessionRow {
  readonly sessionId: string
  readonly header: SessionHeader
  /** Monotonic per-session counter; every durable write bumps it. */
  readonly revision: number
  readonly createdAt: number
  /** The session's fork-inherited prefix length; absent (0) on legacy rows. */
  readonly inheritedEventCount?: number
}

/** One `events`-store row carrying the complete event record. */
interface EventRow {
  readonly sessionId: string
  readonly seq: number
  readonly event: SessionEvent
}

/**
 * One `session-format-archive` row: the verbatim pre-upgrade generation of one
 * session — its original SessionRow and the original event rows — preserved
 * exactly as read before the live stores were rewritten in current format.
 */
interface FormatArchiveRow {
  readonly sessionId: string
  /** The stored format version the archived generation was written in. */
  readonly storedVersion: number
  readonly row: SessionRow
  readonly events: readonly EventRow[]
}

/**
 * The torn-tail repair token: delete every event row with
 * `seq >= truncateFromSeq` — the IDB equivalent of the JSONL byte truncate.
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
    preserved.push(row)
  }
  return preserved.length < rows.length ? { preserved, tornFrom: base + preserved.length } : { preserved }
}

// ─────────────────────────── historical-format migration ───────────────────────────

/** One restored Session artifact: the migrated current-format header and events. */
export interface MigratedArtifact {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly inheritedEventCount: number
}

/**
 * The stored header exactly as it exists on disk: raw and unvalidated, possibly
 * carrying retired shapes from builds older than the current vocabulary.
 */
interface RawStoredHeader {
  version?: unknown
  id?: unknown
  createdAt?: unknown
  isSeeded?: unknown
  cwd?: unknown
  delegationDepth?: unknown
  agentPreset?: unknown
}

/**
 * A clean current-format header for salvage paths. Salvage must never spread
 * the stored header: legacy rows (and generations published by builds whose
 * repair kept members verbatim) carry retired shapes — e.g. non-boolean
 * `isSeeded` — that the current vocabulary refuses.
 */
function salvageHeader(row: SessionRow): SessionHeader {
  return salvageHeaderFrom(SessionId(row.sessionId), row.header)
}

/**
 * Construct a clean current-format header from raw stored metadata: known
 * fields coerce, everything else drops. The archive keeps the original
 * generation verbatim, so nothing reconstruction depends on is lost.
 */
function salvageHeaderFrom(id: SessionId, raw: RawStoredHeader): SessionHeader {
  const createdAt = typeof raw.createdAt === 'number' && Number.isSafeInteger(raw.createdAt) && raw.createdAt >= 0
    ? raw.createdAt
    : Date.now()
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt,
    isSeeded: raw.isSeeded === true,
    ...(typeof raw.cwd === 'string' && raw.cwd !== '' ? { cwd: raw.cwd } : {}),
    ...(typeof raw.delegationDepth === 'number' && raw.delegationDepth > 0
      ? { delegationDepth: raw.delegationDepth }
      : {}),
    ...(typeof raw.agentPreset === 'string' && raw.agentPreset !== ''
      ? { agentPreset: raw.agentPreset }
      : {}),
  }
}

/** Cheap stored-header health check: current version with boolean isSeeded. */
function storedHeaderHealthy(header: RawStoredHeader): boolean {
  return header.version === SESSION_FORMAT_VERSION && typeof header.isSeeded === 'boolean'
}

/** Whether one stored settlement index (turn/step) is a current-shape non-negative safe integer. */
function settlementIndexValid(value: unknown): value is number {
  return typeof value === 'number' && !Object.is(value, -0) && Number.isSafeInteger(value) && value >= 0
}

/**
 * The stored header of a historical row as the released codecs expect it.
 * This backend persists the engine's logical header (no `type` marker;
 * `delegationDepth` absent on top-level sessions), while the released v1/v2
 * physical codecs require `type` + `delegationDepth` and encode seeded
 * lineage as `seedLength` — synthesize the physical view without touching
 * any stored field.
 * @param header - the stored logical header exactly as persisted.
 * @param storedCut - the row's stored inherited-event count (`undefined` on
 *   legacy rows and on every unseeded session).
 */
function physicalStoredHeader(header: SessionHeader, storedCut: number | undefined): unknown {
  return {
    type: 'session',
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    ...(header.isSeeded ? { seedLength: storedCut ?? 0 } : {}),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    delegationDepth: header.delegationDepth ?? 0,
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }
}

/**
 * Strip the one retired member a stored CURRENT-format row can still carry
 * after an earlier repair published it: old builds streamed assistant chunks
 * into an assistant/message that cited the chunk seqs via `sourceEventSeqs`,
 * and the current surface fold refuses that provenance member on
 * assistant/message. The message body already embeds the folded text, so
 * dropping the stale citation loses nothing reconstruction depends on.
 */
function sanitizeStoredRow(eventObject: unknown): unknown {
  if (typeof eventObject !== 'object' || eventObject === null) return eventObject
  const record = eventObject as Record<string, unknown>
  if (record['type'] === 'assistant/message' && record['sourceEventSeqs'] !== undefined) {
    const { sourceEventSeqs: _sourceEventSeqs, ...rest } = record
    return rest
  }
  return eventObject
}

/**
 * Migrate one historical stored log to the current Session format in memory.
 * The released catalog decodes the stored v1/v2 rows, streams them through the
 * adjacent migration chain, and validates the current-format artifact; the
 * caller then serves (read-only opens) or publishes (write opens) the result.
 * @param storedHeader - the stored logical header exactly as persisted.
 * @param storedCut - the row's stored inherited-event count (`undefined` on
 *   legacy rows and on every unseeded session).
 * @param eventObjects - the stored event values, ordered from seq 0.
 * @param location - the storage location for refusal messages.
 * @param options - `legacyUnknownEventRepair` arms the deployment rescue for
 *   logs the released v0 edge refuses over out-of-repository event types.
 * @returns the migrated current-format header, events, and inherited cut.
 * @throws {SessionFormatUnsupportedMigrationError} when the stored log cannot
 *   be migrated (a refused historical shape the catalog cannot translate).
 */
export function migrateStoredArtifact(
  storedHeader: SessionHeader,
  storedCut: number | undefined,
  eventObjects: readonly unknown[],
  location: string,
  options: { legacyUnknownEventRepair?: boolean } = {},
): MigratedArtifact {
  try {
    return migrateThroughReleasedCatalog(storedHeader, storedCut, eventObjects, location)
  } catch (error) {
    if (!(error instanceof SessionFormatUnsupportedMigrationError) || options.legacyUnknownEventRepair !== true) {
      throw error
    }
    return repairLegacyUnknownArtifact(SessionId(storedHeader.id), storedHeader, storedCut, eventObjects, location, error)
  }
}

/** Route stored rows through the released catalog (the default migration path). */
function migrateThroughReleasedCatalog(
  storedHeader: SessionHeader,
  storedCut: number | undefined,
  eventObjects: readonly unknown[],
  location: string,
): MigratedArtifact {
  const restore = sessionFormatCatalog.createRestore(physicalStoredHeader(storedHeader, storedCut), {
    recovery: 'recoverable',
    validation: 'transformed',
  })
  for (const eventObject of eventObjects) restore.decodeRow(eventObject)
  const artifact = restore.finish()
  // The catalog's finish() has run the released v3 restorer (version + event
  // type membership verified); the generic SessionFormat* surface narrows to
  // the logical current types here, exactly like the JSONL backend's scan.
  const events = artifact.events as unknown as SessionEvent[]
  const header = artifact.header as unknown as SessionHeader
  validateStoredEvents(header, events, { kind: 'indexeddb', path: location })
  return {
    header,
    events,
    inheritedEventCount: artifact.inheritedEventCount,
  }
}

/**
 * Deployment rescue for a historical log the released v0→v1 edge refuses over
 * out-of-repository event types (the frozen edge refuses every unknown v0
 * type, even an ignorable one — the alpha historical-event decision). Such a
 * log was appended to by builds of THIS deployment after the released
 * inventory froze, so its out-of-repository types split into two classes:
 * repository-known types (added to the vocabulary after v0 froze) carry over
 * verbatim — their stored shape is the current shape because only
 * current-shape builds ever wrote them — and truly unknown types carry over
 * with `ignorable: true`, the documented marker for informational events a
 * reader may skip. Known-type events whose settlement fields predate format
 * v2's embedded stream are normalized in place (turn/step carried forward,
 * stream defaulted to an empty record); the adoption in
 * {@link validateStoredEvents} still refuses any message-body shape that
 * cannot be normalized honestly. The released edge is never weakened:
 * everything routes through {@link validateStoredEvents} at the current
 * format, and the caller archives the original generation verbatim first.
 */
function repairLegacyUnknownArtifact(
  sessionId: SessionId,
  storedHeader: RawStoredHeader,
  storedCut: number | undefined,
  eventObjects: readonly unknown[],
  location: string,
  cause: SessionFormatUnsupportedMigrationError,
): MigratedArtifact {
  const downgraded = new Set<string>()
  let lastTurn = 0
  let lastStep = 0
  const repaired = eventObjects.map((eventObject) => {
    if (typeof eventObject !== 'object' || eventObject === null) return eventObject
    let record = eventObject as Record<string, unknown>
    const type = record['type']
    if (typeof type !== 'string') return eventObject
    if (type === 'assistant/message' && record['sourceEventSeqs'] !== undefined) {
      // Old builds streamed assistant chunks and stored the aggregated
      // assistant/message citing the chunk seqs via sourceEventSeqs. The
      // current surface fold forbids that provenance member on
      // assistant/message — the message body already embeds the folded text,
      // so dropping the stale citation loses nothing reconstruction needs.
      const { sourceEventSeqs: _sourceEventSeqs, ...rest } = record
      downgraded.add('assistant/message[sourceEventSeqs]')
      record = rest
    }
    if (type === 'request/header') {
      // Pre-release builds stamped header.system / header.messagePrefix into
      // request/header; both are retired members the current format refuses.
      // The system prompt is derived content (system-prompt assembly), so
      // stripping the stale member loses nothing reconstruction depends on.
      const data = record['data'] as Record<string, unknown> | undefined
      const header = data !== undefined && typeof data === 'object'
        ? data['header']
        : undefined
      if (header !== null && typeof header === 'object'
        && (('system' in header) || ('messagePrefix' in header))) {
        const { system: _system, messagePrefix: _messagePrefix, ...rest } = header as Record<string, unknown>
        downgraded.add('request/header[system|messagePrefix]')
        return { ...record, data: { ...(data as Record<string, unknown>), header: rest } }
      }
    }
    if ((type === 'assistant/message' || type === 'assistant/attempt') && record['ignorable'] !== true) {
      // Pre-v2 builds wrote assistant settlements without the embedded
      // stream, and era drift can carry malformed turn/step — the seed
      // validator refuses both at resume. Normalize in place: each invalid
      // index carries forward from the previous settlement so the lifecycle
      // sequence stays plausible, and a non-array stream becomes the empty
      // record. Every other data member rides untouched; one that adoption
      // still refuses (no identified message body) quarantines the
      // generation through the caller's catch.
      if (!assistantSettlementFieldsValid(record['data'])) {
        const source = typeof record['data'] === 'object' && record['data'] !== null && !Array.isArray(record['data'])
          ? record['data'] as Record<string, unknown>
          : {}
        const turn = settlementIndexValid(source['turn']) ? source['turn'] : lastTurn
        const step = settlementIndexValid(source['step']) ? source['step'] : lastStep
        downgraded.add(`${type}[settlement]`)
        lastTurn = turn
        lastStep = step
        return {
          ...record,
          data: {
            ...source,
            turn,
            step,
            ...(Array.isArray(source['stream']) ? {} : { stream: [] }),
          },
        }
      }
      const data = record['data'] as Record<string, unknown>
      lastTurn = data['turn'] as number
      lastStep = data['step'] as number
      return record
    }
    if (KNOWN_SESSION_EVENT_TYPES.has(type)) {
      return record
    }
    // Released-v0 vocabulary types (assistant/chunk and kin) pass the
    // disposition check but the current vocabulary refuses them: for the
    // migrated generation they degrade to ignorable, exactly like the
    // out-of-repository types below. The v3 fold skips ignorable rows and
    // the aggregate assistant/message already embeds the folded text.
    downgraded.add(type)
    return { ...record, ignorable: true }
  })
  if (downgraded.size > 0) {
    console.warn(
      `session-persistence-indexeddb: legacy log ${JSON.stringify(storedHeader.id)} carries legacy shapes `
      + `${[...downgraded].map(type => JSON.stringify(type)).join(', ')}; repaired for the migrated generation `
      + `(original rows remain archived). Refusing cause: ${cause.message}`,
    )
  }
  const header = salvageHeaderFrom(sessionId, storedHeader)
  const events = validateStoredEvents(
    header,
    repaired.map(event => adoptSessionEvent(event as SessionEvent)),
    { kind: 'indexeddb', path: location },
  )
  return {
    header,
    events,
    inheritedEventCount: storedCut ?? 0,
  }
}

// ─────────────────────────── the service ───────────────────────────

/** Maximum intentional wait before a routed live session batch starts writing. */
export const LIVE_WRITE_BATCH_MAX_DELAY_MS = 200
/** Upper bound the plugin config may place on the batching window. */
export const MAX_WRITE_BATCH_DELAY_MS = 60_000

/** Plugin config: the database name plus the live batching window. */
export interface Config {
  /**
   * IndexedDB database name. Defaults to `dsh-sessions`; deployments sharing
   * one origin under different profiles use distinct names.
   */
  dbName?: string
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number
  /**
   * Enable the deployment-level rescue for historical logs that mix released
   * events with types this deployment added on top of the repository
   * vocabulary. When the released v0→v1 edge refuses such a log, the backend
   * rebuilds the current-format artifact directly: repository-known events
   * carry over verbatim, truly unknown types are carried with `ignorable:
   * true` (the documented informational-event marker), and the original
   * generation is archived first. Default false: without it the released
   * refusal stands.
   */
  legacyUnknownEventRepair?: boolean
}

/** Extra construction options that never travel through plugin config. */
export interface IndexedDbPersistenceOptions {
  /** Database opener override (tests inject an in-memory adapter). */
  readonly openDatabase?: OpenDatabase
}

/** Created-but-unmaterialized bookkeeping: visible in-process, absent from storage. */
interface PendingSession {
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
}

/**
 * The IndexedDB persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence` and implements the handle seam over two object
 * stores.
 */
export class IndexedDbPersistence extends SessionPersistence {
  override readonly name = 'session-persistence-indexeddb'

  static Config: z<Config> = z.object({
    dbName: z.string().default(DEFAULT_DB_NAME),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(LIVE_WRITE_BATCH_MAX_DELAY_MS),
    legacyUnknownEventRepair: z.boolean().default(false),
  })

  /**
   * The IndexedDB database name this backend opens; the diagnostics path prefix.
   * @internal handle diagnostic path prefix.
   */
  readonly dbName: string
  /**
   * The live-event coalescing window in force (config or default).
   * @internal handle batching window.
   */
  readonly writeBatchMaxDelayMs: number
  /**
   * Whether the legacy-unknown-event rescue is armed (config or default).
   * @internal handle migration fallback gate.
   */
  readonly legacyUnknownEventRepair: boolean
  private readonly dbPromise: Promise<StructuredDatabase>
  /** In-process single-writer claims: at most one live write handle per session. */
  private readonly writers = new Set<SessionId>()
  /** Created-but-unmaterialized sessions, visible to stat/list/open in this process. */
  private readonly pending = new Map<string, PendingSession>()
  /** Live write handles keyed by session id — the flush() barrier's iteration set. */
  private readonly liveWrites = new Map<SessionId, IndexedDbSessionHandle>()

  constructor(ctx: Context, config: Config = {}, options: IndexedDbPersistenceOptions = {}) {
    super(ctx)
    this.dbName = config.dbName ?? DEFAULT_DB_NAME
    this.writeBatchMaxDelayMs = config.writeBatchMaxDelayMs ?? LIVE_WRITE_BATCH_MAX_DELAY_MS
    this.legacyUnknownEventRepair = config.legacyUnknownEventRepair ?? false
    const opening = (options.openDatabase ?? defaultOpenDatabase)(this.dbName, DATABASE_VERSION)
    // Keep the rejection observable to every hook while avoiding an unhandled
    // rejection before the first hook awaits it.
    opening.catch(() => {})
    this.dbPromise = opening
    this.installRouting(ctx)
  }

  /**
   * Install the backend's live session routing and teardown. Persistence
   * enforces one active write handle per id, so the listeners route published
   * sessions' events by id into the active write handle; the teardown effect
   * closes every open handle — close drains the routed buffer — and
   * aggregates failures. Registrations are effects of the current fiber.
   * @param ctx - the backend's context.
   */
  private installRouting(ctx: Context): void {
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.liveWrites.get(session.id)?.enqueueLive(event, (error) => {
        ctx.logger.warn(
          `session-persistence-indexeddb: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`,
        )
      })
    })
    ctx.on('session/flush', (session: Session) => {
      const writer = this.liveWrites.get(session.id)
      if (writer === undefined) return undefined
      return (async () => {
        await writer.drainLive()
        await writer.flush()
      })()
    })
    ctx.on('session/disposed', (session: Session) => {
      const writer = this.liveWrites.get(session.id)
      if (writer === undefined) return
      writer.close().catch((error: unknown) => {
        ctx.logger.warn(`session-persistence-indexeddb: final drain for session "${session.id}" failed: ${String(error)}`)
      })
    })
    ctx.effect(() => async () => {
      const errors: unknown[] = []
      for (const handle of [...this.liveWrites.values()]) {
        try {
          await handle.close()
        } catch (error: unknown) {
          errors.push(error)
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `${this.name} teardown failed to close every write handle`)
      }
    })
  }

  /**
   * The open database handle, awaiting (or replaying) the single opening
   * promise.
   * @param signal - optional caller cancellation checked before the await.
   * @returns the structured database handle.
   * @internal handle transaction source.
   */
  database(signal?: AbortSignal): Promise<StructuredDatabase> {
    signal?.throwIfAborted()
    return this.dbPromise
  }

  /** The source-qualified revision for one row. */
  private revisionOf(id: SessionId, row: SessionRow): PersistenceRevision {
    return SessionPersistenceRevision(`indexeddb:${this.dbName}:${id}:${row.revision}`)
  }

  /** Read one session row (header + revision) without touching events. */
  private async rowOf(id: SessionId, signal?: AbortSignal): Promise<SessionRow | undefined> {
    const db = await this.database(signal)
    const tx = db.transaction([SESSIONS_STORE], 'readonly')
    const row = await tx.store(SESSIONS_STORE).get(id) as SessionRow | undefined
    signal?.throwIfAborted()
    return row
  }

  /**
   * Read one session's event rows from `fromSeq` plus its torn-tail boundary.
   * @param id - the session whose rows are read.
   * @param fromSeq - the first sequence number to return.
   * @param signal - optional caller cancellation.
   * @returns the surviving rows and, when a sequence gap or duplicate marks a
   *   torn tail, the seq the tail starts at.
   * @internal handle read path
   */
  async eventRowsOf(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ rows: EventRow[]; tornFrom?: number }> {
    const db = await this.database(signal)
    const tx = db.transaction([EVENTS_STORE], 'readonly')
    const raw = await tx.store(EVENTS_STORE).getAll(eventRange(id, fromSeq))
    signal?.throwIfAborted()
    const { preserved, tornFrom } = scanEventRows(raw, fromSeq)
    return tornFrom === undefined ? { rows: preserved } : { rows: preserved, tornFrom }
  }

  /**
   * Materialize (or bump) one session row in its own transaction.
   * @param id - the session row's id.
   * @param header - the current logical header.
   * @param inheritedEventCount - the stored inherited-event cut.
   * @internal handle flush path
   */
  async putRow(
    id: SessionId,
    header: SessionHeader,
    inheritedEventCount: SessionLogOffset,
  ): Promise<void> {
    const db = await this.database()
    const tx = db.transaction([SESSIONS_STORE], 'readwrite')
    const existing = await tx.store(SESSIONS_STORE).get(id) as SessionRow | undefined
    await tx.store(SESSIONS_STORE).put({
      sessionId: id,
      header: structuredClone(header),
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? header.createdAt,
      inheritedEventCount,
    } satisfies SessionRow)
    await tx.done
  }

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const snapshot = materializeCreateHeader(header)
    // Fail fast on a seeded/cut mismatch: a seeded header must carry its exact
    // inherited cut; an unseeded one must not carry one at all.
    const cut = options?.inheritedEventCount
    if (snapshot.isSeeded ? cut === undefined : (cut ?? 0) !== 0) {
      throw new TypeError(
        `session "${snapshot.id}": inheritedEventCount must accompany an isSeeded header and be omitted otherwise`,
      )
    }
    const inheritedEventCount = SessionLogOffset(cut ?? 0)
    const stored = await this.rowOf(snapshot.id, options?.signal)
    if (stored !== undefined || this.pending.has(snapshot.id)) {
      throw new SessionAlreadyExistsError(snapshot.id)
    }
    if (this.writers.has(snapshot.id)) throw new SessionAlreadyOwnedError(snapshot.id)
    this.pending.set(snapshot.id, { header: snapshot, inheritedEventCount })
    this.writers.add(snapshot.id)
    const handle = new IndexedDbSessionHandle(
      this, snapshot.id, snapshot, 'write',
      { cursor: 0, materialized: false, inheritedEventCount },
    )
    this.liveWrites.set(snapshot.id, handle)
    return handle
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const pendingSession = this.pending.get(id)
    if (access === 'read') {
      if (pendingSession !== undefined) {
        return new IndexedDbSessionHandle(
          this, id, pendingSession.header, 'read',
          { cursor: 0, materialized: false, inheritedEventCount: pendingSession.inheritedEventCount },
        )
      }
      const row = await this.rowOf(id, options?.signal)
      if (row === undefined) throw new SessionPersistenceNotFoundError(id)
      return new IndexedDbSessionHandle(
        this, id, structuredClone(row.header), 'read',
        { cursor: 0, materialized: true, inheritedEventCount: SessionLogOffset(row.inheritedEventCount ?? 0) },
      )
    }
    // Write: claim first so a concurrent open in this process rejects, then
    // resolve the stored state (the claim releases if resolution fails).
    if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
    this.writers.add(id)
    try {
      if (pendingSession !== undefined) {
        const handle = new IndexedDbSessionHandle(
          this, id, pendingSession.header, 'write',
          { cursor: 0, materialized: false, inheritedEventCount: pendingSession.inheritedEventCount },
        )
        this.liveWrites.set(id, handle)
        return handle
      }
      const db = await this.database(options?.signal)
      const tx = db.transaction([SESSIONS_STORE, EVENTS_STORE], 'readonly')
      const row = await tx.store(SESSIONS_STORE).get(id) as SessionRow | undefined
      if (row === undefined) throw new SessionPersistenceNotFoundError(id)
      const raw = await tx.store(EVENTS_STORE).getAll(eventRange(id))
      options?.signal?.throwIfAborted()
      const { preserved, tornFrom } = scanEventRows(raw)
      if (tornFrom !== undefined) {
        // The write path owns the torn tail: truncate it before the handle's
        // first append, and bump the revision for observers.
        await this.truncateTorn(id, tornFrom)
      }
      let header = structuredClone(row.header)
      let cursor = preserved.length
      let inheritedEventCount = SessionLogOffset(row.inheritedEventCount ?? 0)
      // The stored header's version is only statically pinned to the current
      // format by the logical interface; rows written by older builds carry
      // smaller values, so the upgrade check runs on the widened number.
      const storedVersion: number = header.version
      if (storedVersion !== SESSION_FORMAT_VERSION) {
        // Historical stored format: publish the migrated current-format
        // generation (the original rows are archived verbatim first), then
        // hand the handle a current-format view so every later append and
        // read is ordinary v-current handling.
        try {
          const migrated = migrateStoredArtifact(
            row.header,
            row.inheritedEventCount,
            preserved.map(preservedRow => preservedRow.event),
            `${this.dbName}/${SESSIONS_STORE}/${id}`,
            { legacyUnknownEventRepair: this.legacyUnknownEventRepair },
          )
          await this.publishFormatUpgrade(id, row, preserved, migrated, options?.signal)
          header = migrated.header
          cursor = migrated.events.length
          inheritedEventCount = SessionLogOffset(migrated.inheritedEventCount)
        } catch (error) {
          // Last-resort salvage: when even the armed repair cannot produce a
          // faithfully-readable generation, quarantine the whole legacy log
          // verbatim in the archive and hand back an empty current-format log
          // — a dead extension serves nobody, and the archive keeps every
          // committed row recoverable.
          if (!this.legacyUnknownEventRepair) {
            throw error
          }
          console.warn(
            '[dsh-bg] 无法迁移的历史会话已整体隔离归档（原始行保留在 archive）：',
            String(error),
          )
          const salvaged: MigratedArtifact = {
            header: salvageHeader(row),
            events: [],
            inheritedEventCount: 0,
          }
          await this.publishFormatUpgrade(id, row, preserved, salvaged, options?.signal)
          header = salvaged.header
          cursor = salvaged.events.length
          inheritedEventCount = SessionLogOffset(salvaged.inheritedEventCount)
        }
      } else if (
        this.legacyUnknownEventRepair
        && (!storedHeaderHealthy(header)
          || preserved.some(preservedRow =>
            preservedRow.event.ignorable !== true
            && (!KNOWN_SESSION_EVENT_TYPES.has(preservedRow.event.type)
              || ((preservedRow.event.type === 'assistant/message'
                || preservedRow.event.type === 'assistant/attempt')
                && !assistantSettlementFieldsValid(preservedRow.event.data)))))
      ) {
        // A current-format generation can still carry legacy shapes when an
        // older build published the upgrade before the repair learned to
        // handle them — released-but-currently-unknown types, or assistant
        // settlements predating format v2's embedded stream (the seed
        // validator refuses both at resume): repair in place once (the
        // previous generation archives verbatim) so later reads interpret
        // the log.
        try {
          const repaired = repairLegacyUnknownArtifact(
            SessionId(id),
            row.header,
            row.inheritedEventCount,
            preserved.map(preservedRow => preservedRow.event),
            `${this.dbName}/${SESSIONS_STORE}/${id}`,
            new SessionFormatUnsupportedMigrationError(
              `legacy published generation carries foreign event types or invalid settlement fields (${this.dbName}/${SESSIONS_STORE}/${id})`,
            ),
          )
          await this.publishFormatUpgrade(id, row, preserved, repaired, options?.signal)
          header = repaired.header
          cursor = repaired.events.length
          inheritedEventCount = SessionLogOffset(repaired.inheritedEventCount)
        } catch (error) {
          // The repair cannot clean this generation (a shape normalization
          // cannot repair honestly, deeper corruption): quarantine the whole
          // generation verbatim and hand back an empty log — the alternative
          // is a session whose every open fails and a panel dead to RPCs.
          console.warn('[dsh-bg] 修复当前代日志失败，已隔离归档：', String(error))
          const salvaged: MigratedArtifact = {
            header: salvageHeader(row),
            events: [],
            inheritedEventCount: 0,
          }
          await this.publishFormatUpgrade(id, row, preserved, salvaged, options?.signal)
          header = salvaged.header
          cursor = salvaged.events.length
          inheritedEventCount = SessionLogOffset(salvaged.inheritedEventCount)
        }
      }
      const handle = new IndexedDbSessionHandle(
        this, id, header, 'write',
        {
          cursor,
          materialized: true,
          inheritedEventCount,
        },
      )
      this.liveWrites.set(id, handle)
      return handle
    } catch (error) {
      this.writers.delete(id)
      throw error
    }
  }

  /** Delete one session's torn tail by key range and bump its revision. */
  private async truncateTorn(id: SessionId, truncateFromSeq: number): Promise<void> {
    const db = await this.database()
    const tx = db.transaction([SESSIONS_STORE, EVENTS_STORE], 'readwrite')
    const existing = await tx.store(SESSIONS_STORE).get(id) as SessionRow | undefined
    await tx.store(EVENTS_STORE).delete(eventRange(id, truncateFromSeq))
    if (existing !== undefined) {
      await tx.store(SESSIONS_STORE).put({
        ...existing,
        revision: existing.revision + 1,
      } satisfies SessionRow)
    }
    await tx.done
  }

  /**
   * Publish one session's migrated current-format generation in a single
   * atomic transaction: the verbatim pre-upgrade generation (its SessionRow
   * plus the original event rows) is archived first, then the live stores are
   * rewritten with the migrated current-format header and events. Committed
   * history is never destroyed — the archive store keeps it verbatim.
   * @param id - the session being upgraded.
   * @param row - the stored SessionRow exactly as read.
   * @param preserved - the stored event rows that make up the committed log.
   * @param migrated - the in-memory migration result for this log.
   */
  private async publishFormatUpgrade(
    id: SessionId,
    row: SessionRow,
    preserved: readonly EventRow[],
    migrated: MigratedArtifact,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    const db = await this.database(signal)
    const tx = db.transaction([SESSIONS_STORE, EVENTS_STORE, ARCHIVE_STORE], 'readwrite')
    await tx.store(ARCHIVE_STORE).put({
      sessionId: id,
      storedVersion: row.header.version,
      row,
      events: preserved,
    } satisfies FormatArchiveRow)
    await tx.store(EVENTS_STORE).delete(eventRange(id))
    for (const [seq, event] of migrated.events.entries()) {
      await tx.store(EVENTS_STORE).put({ sessionId: id, seq, event: structuredClone(event) } satisfies EventRow)
    }
    await tx.store(SESSIONS_STORE).put({
      sessionId: id,
      header: migrated.header,
      revision: row.revision + 1,
      createdAt: row.createdAt,
      inheritedEventCount: migrated.inheritedEventCount,
    } satisfies SessionRow)
    await tx.done
  }

  /** Flush every active write handle in one durability barrier. */
  async flush(): Promise<void> {
    const errors: unknown[] = []
    for (const writer of [...this.liveWrites.values()]) {
      try {
        await writer.drainLive()
        await writer.flush()
      } catch (error: unknown) {
        // A handle closed during the sweep counts as flushed: close itself
        // drained the routed buffer durably before refusing this flush.
        if (error instanceof SessionHandleClosedError) continue
        errors.push(error)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `${this.name} flush failed`)
    }
  }

  /** Observe one stored session without reading its event log. */
  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted()
    const pendingSession = this.pending.get(id)
    if (pendingSession !== undefined) {
      return { header: pendingSession.header, revision: this.pendingRevision(id) }
    }
    const row = await this.rowOf(id, options?.signal)
    return row === undefined ? undefined : { header: structuredClone(row.header), revision: this.revisionOf(id, row) }
  }

  /** List every stored session visible to this process, in no promised order. */
  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    const signal = options?.signal
    const snapshots: SessionPersistenceSnapshot[] = []
    const listed = new Set<string>()
    // Pending entries first: create-to-list visibility never has a hole.
    for (const [id, pendingSession] of this.pending) {
      listed.add(id)
      snapshots.push({ header: pendingSession.header, revision: this.pendingRevision(SessionId(id)) })
    }
    const db = await this.database(signal)
    const tx = db.transaction([SESSIONS_STORE], 'readonly')
    const rows = await tx.store(SESSIONS_STORE).getAll()
    signal?.throwIfAborted()
    for (const row of rows as SessionRow[]) {
      if (listed.has(row.sessionId)) continue
      snapshots.push({
        header: structuredClone(row.header),
        revision: this.revisionOf(SessionId(row.sessionId), row),
      })
    }
    return snapshots
  }

  /**
   * The stable in-process revision for a created-but-unmaterialized session:
   * distinct from every stored row revision and constant until materialization.
   */
  private pendingRevision(id: SessionId): PersistenceRevision {
    return SessionPersistenceRevision(`indexeddb:${this.dbName}:${id}:pending`)
  }

  /**
   * Detach one pending entry after its materializing write.
   * @param id - the session whose pending birth record is dropped.
   * @internal handle write path
   */
  clearPending(id: SessionId): void {
    this.pending.delete(id)
  }

  /**
   * The durable write primitive every handle mutation resolves to: ONE
   * readwrite transaction materializes the sessions row (when lazy) and puts
   * every event row, or fails without touching stored state. The transaction
   * is the atomicity + durability boundary — the IDB counterpart of the JSONL
   * temp-file publish.
   * @param header - the session's current logical header.
   * @param events - the batch's events, written as rows.
   * @param isMaterialized - whether the session row is already materialized.
   * @param inheritedEventCount - the stored inherited-event cut.
   * @returns once the transaction commits.
   * @internal contract injection point for retained-batch fault tests.
   */
  async persistBatch(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: SessionLogOffset,
  ): Promise<void> {
    if (events.length === 0 && isMaterialized) return
    const db = await this.database()
    const tx = db.transaction([SESSIONS_STORE, EVENTS_STORE], 'readwrite')
    const sessions = tx.store(SESSIONS_STORE)
    const eventRows = tx.store(EVENTS_STORE)
    const existing = await sessions.get(header.id) as SessionRow | undefined
    await sessions.put({
      sessionId: header.id,
      header: structuredClone(header),
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? header.createdAt,
      inheritedEventCount: existing?.inheritedEventCount ?? inheritedEventCount,
    } satisfies SessionRow)
    for (const event of events) {
      await eventRows.put({ sessionId: header.id, seq: event.seq, event: structuredClone(event) } satisfies EventRow)
    }
    await tx.done
  }

  /**
   * Release one write claim, drop the flush-set entry, and forget any pending
   * birth record.
   * @param id - the session whose claim is released.
   * @param handle - the closing handle; a stale handle is ignored.
   * @internal handle close path
   */
  releaseWrite(id: SessionId, handle: IndexedDbSessionHandle): void {
    if (this.liveWrites.get(id) === handle) this.liveWrites.delete(id)
    this.writers.delete(id)
    // A failed close leaves the session half-born: the identity is claimable
    // again, so the pending birth record of the dead handle must not linger.
    this.pending.delete(id)
  }

  /** Close the database handle. */
  async close(): Promise<void> {
    await this.dbPromise.then(
      (db) => { db.close() },
      () => {},
    )
  }
}

// ─────────────────────────── the handle ───────────────────────────

/** Mutable per-handle cursor state. */
interface HandleState {
  /** The stored next-seq: every append's first event must carry exactly this. */
  cursor: number
  /** Whether the session row exists in storage. */
  materialized: boolean
  readonly inheritedEventCount: SessionLogOffset
}

/**
 * One open channel onto a stored session's IndexedDB log. Appends commit in
 * one transaction per batch (the durability boundary), reads query storage so
 * freshness is automatic, and a write handle's close materializes any pending
 * session row.
 */
export class IndexedDbSessionHandle implements SessionHandle {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly access: SessionAccess
  readonly inheritedEventCount: SessionLogOffset

  private readonly service: IndexedDbPersistence
  private readonly state: HandleState
  private closed = false

  /** Routed live events awaiting their batching window, in arrival order. */
  private buffered: SessionEvent[] = []
  /** The armed batching window; quiet while a previous drain failed. */
  private batchTimer: ReturnType<typeof setTimeout> | undefined
  /** Set when a drain failed; the automatic timer stays quiet until the next drain. */
  private drainPaused = false
  /** Single-flight drain: concurrent callers join the in-flight pass. */
  private draining: Promise<void> | undefined
  /** Single-flight close: the first call owns the drain-and-release settlement. */
  private closing: Promise<void> | undefined

  constructor(
    service: IndexedDbPersistence,
    id: SessionId,
    header: SessionHeader,
    access: SessionAccess,
    state: HandleState,
  ) {
    this.service = service
    this.id = id
    this.header = header
    this.access = access
    this.state = state
    this.inheritedEventCount = state.inheritedEventCount
  }

  /** Closed-handle refusal precedes every other check. */
  private assertOpen(operation: string): void {
    if (this.closed) {
      throw new SessionHandleClosedError(this.id, operation)
    }
  }

  private assertWrite(operation: string): void {
    if (this.access === 'read') {
      throw new SessionReadOnlyError(this.id, operation)
    }
  }

  async read(
    offset = 0,
    length = Number.MAX_SAFE_INTEGER,
    options?: SessionHandleReadOptions,
  ): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(`read offset must be a non-negative safe integer, got ${String(offset)}`)
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError(`read length must be a non-negative safe integer, got ${String(length)}`)
    }
    options?.signal?.throwIfAborted()
    // An unmaterialized write handle owns an empty log; storage has no rows yet.
    if (this.access === 'write' && !this.state.materialized) {
      return { eventState: 'detached', events: [] }
    }
    // The stored header's version is only statically pinned to the current
    // format by the logical interface; rows written by older builds carry
    // smaller values, so the upgrade check runs on the widened number.
    const storedVersion: number = this.header.version
    if (storedVersion !== SESSION_FORMAT_VERSION) {
      // Read-only handle on a historical stored generation: migrate the whole
      // log in memory (write opens publish the migration instead, so a read
      // here can never race a rewritten store) and slice the requested span.
      const { rows } = await this.service.eventRowsOf(this.id, 0, options?.signal)
      const migrated = migrateStoredArtifact(
        this.header,
        this.header.isSeeded ? this.state.inheritedEventCount : undefined,
        rows.map(row => row.event),
        `${this.service.dbName}/${SESSIONS_STORE}/${this.id}`,
        { legacyUnknownEventRepair: this.service.legacyUnknownEventRepair },
      )
      return {
        eventState: 'detached',
        events: migrated.events.slice(offset, offset + length),
      }
    }
    const { rows } = await this.service.eventRowsOf(this.id, offset, options?.signal)
    // Current-format rows may still carry the one retired member an earlier
    // repair published (assistant/message citing its folded chunk seqs); the
    // same deployment switch sanitizes it here so every read stays ordinary.
    const rawEvents = rows.map(row => (this.service.legacyUnknownEventRepair
      ? sanitizeStoredRow(structuredClone(row.event))
      : structuredClone(row.event))) as SessionEvent[]
    const events = validateStoredEvents(
      this.header,
      rawEvents,
      { kind: 'indexeddb', path: `${this.service.dbName}/${SESSIONS_STORE}/${this.id}` },
    ).slice(0, length)
    return { eventState: 'detached', events }
  }

  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen('append')
    this.assertWrite('append')
    options?.signal?.throwIfAborted()
    const batch = materializeAppendBatch(events)
    assertContiguous(this.id, batch, this.state.cursor)
    await this.service.persistBatch(this.header, batch, this.state.materialized, this.state.inheritedEventCount)
    this.state.cursor += batch.length
    this.state.materialized = true
    this.service.clearPending(this.id)
  }

  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen('flush')
    this.assertWrite('flush')
    options?.signal?.throwIfAborted()
    // Every append already committed its own durable transaction; flush is the
    // materialize-if-needed barrier for a session with no appends yet.
    if (this.state.materialized) return
    await this.service.persistBatch(this.header, [], false, this.state.inheritedEventCount)
    this.state.materialized = true
    this.service.clearPending(this.id)
  }

  /** Release the handle: a write handle drains, materializes, then drops its claim. */
  async close(): Promise<void> {
    if (this.closed) return
    if (this.access !== 'write') {
      this.closed = true
      return
    }
    this.closing ??= (async () => {
      let drainFailure: unknown
      try {
        // Close drains durably: run drain passes until one leaves the routed
        // buffer empty; the first failure stops the loop but never wedges the id.
        for (;;) {
          try {
            await this.drainLive()
          } catch (error: unknown) {
            drainFailure = error
            break
          }
          if (this.buffered.length === 0) break
        }
      } finally {
        // Ownership releases no matter how the drain fared: a skipped release
        // would wedge the id in this process behind a dead handle. A session
        // that never materialized keeps never existing — the pending birth
        // record dies with the handle, exactly as it would in a crash.
        this.closed = true
        this.service.releaseWrite(this.id, this)
      }
      if (drainFailure !== undefined) {
        throw drainFailure instanceof Error
          ? drainFailure
          : new Error(typeof drainFailure === 'string' ? drainFailure : JSON.stringify(drainFailure))
      }
    })()
    await this.closing
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  /**
   * Buffer one published live session event and arm the bounded batching
   * window when it is idle. The routing installer is the only caller.
   * @param event - the live event, retained as a persistence-owned copy.
   * @param reportBackgroundFailure - observes a deadline-driven drain failure
   *   (the events stay buffered; the next {@link drainLive} retries loudly).
   */
  enqueueLive(event: SessionEvent, reportBackgroundFailure: (error: unknown) => void): void {
    this.buffered.push(structuredClone(event))
    if (this.batchTimer !== undefined || this.drainPaused) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined
      this.drainLive().catch(reportBackgroundFailure)
    }, this.service.writeBatchMaxDelayMs)
  }

  /**
   * Durably drain the routed live buffer; concurrent callers join one drain,
   * and a failure retains the batch in order so `session/flush` can retry
   * and reject loudly. Close drains through this path while the handle is
   * still open, so no open assertion guards it.
   */
  drainLive(): Promise<void> {
    return this.draining ??= this.drainBuffered().finally(() => {
      this.draining = undefined
    })
  }

  /** One drain pass: every buffered event, oldest first, in ordered batches. */
  private async drainBuffered(): Promise<void> {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer)
      this.batchTimer = undefined
    }
    this.drainPaused = false
    while (this.buffered.length > 0) {
      const batch = this.buffered.splice(0)
      try {
        await this.append(batch)
      } catch (error: unknown) {
        // Retain in order and quiet the automatic path: the next drainLive —
        // session/flush or close — retries the whole retained queue.
        this.buffered = batch.concat(this.buffered)
        this.drainPaused = true
        throw error
      }
    }
  }
}

export default IndexedDbPersistence
