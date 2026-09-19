/**
 * Backend-mechanics spec for the IndexedDB session-persistence service over
 * the in-memory structural double, plus the shared live-write-path contract
 * every session-persistence backend must satisfy.
 * @module @deepseek-ai/dsh-session-persistence-indexeddb/tests/indexeddb
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence'
import IndexedDbPersistence, { DEFAULT_DB_NAME, LIVE_WRITE_BATCH_MAX_DELAY_MS, scanEventRows } from '../src/index.ts'
import { createMemoryDatabase } from './memory-idb.ts'
import { runLiveWritePathContract } from '../../session-persistence/tests/live-write-contract.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

/** One header for tests: minimal, current-format, owned by `id`. */
function headerOf(id: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1_700_000_000_000,
    isSeeded: false,
  }
}

/** One non-surface marker event at `seq` (carries no surface-op obligation). */
function markerEvent(seq: number): SessionEvent {
  return { seq: SessionSeq(seq), time: 1_700_000_000_000 + seq, type: 'turn/start', data: { turn: seq } }
}

/** Build a plugin-mountable backend class bound to one memory database. */
function memoryBackendClass(memory: ReturnType<typeof createMemoryDatabase>) {
  return class MemoryIndexedDbPersistence extends IndexedDbPersistence {
    constructor(ctx: Context, config: { dbName?: string } = {}) {
      super(ctx, config, { openDatabase: memory.open })
    }
  }
}

/** Mount one fresh service over one shared in-memory storage scope. */
async function mount(db = createMemoryDatabase()): Promise<{ persistence: IndexedDbPersistence; db: typeof db }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(memoryBackendClass(db), { dbName: DEFAULT_DB_NAME })
  return { persistence: ctx.sessionPersistence as IndexedDbPersistence, db }
}

describe('IndexedDbPersistence: backend mechanics', () => {
  it('create appends and reads back detached events; caller mutation cannot reach stored rows', async () => {
    const { persistence, db } = await mount()
    const handle = await persistence.create(headerOf('roundtrip'))
    await handle.append([markerEvent(0), markerEvent(1)])
    const reader = await persistence.open(SessionId('roundtrip'), 'read')
    const first = await reader.read()
    expect(first.eventState).toBe('detached')
    expect(first.events.map(event => event.seq)).toEqual([0, 1])
    ;(first.events[0] as { data: { text: string } }).data.text = 'mutated'
    expect((await reader.read()).events[0]).toMatchObject({ seq: 0 })
    await reader.close()
    await handle.close()
    expect(db.state.sessions.has('s:roundtrip')).toBe(true)
  })

  it('a session closed before any write never existed: unmaterialized birth records die with the handle', async () => {
    const { persistence, db } = await mount()
    const handle = await persistence.create(headerOf('pending'))
    const statWhilePending = await persistence.stat(SessionId('pending'))
    expect(statWhilePending).toBeDefined()
    expect(db.state.sessions.has('s:pending')).toBe(false)
    await handle.close()
    expect(db.state.sessions.has('s:pending')).toBe(false)
    await expect(persistence.stat(SessionId('pending'))).resolves.toBeUndefined()
    // The identity is claimable again.
    await expect(persistence.create(headerOf('pending'))).resolves.toBeDefined()
  })

  it('create refuses an occupied identity, live or stored', async () => {
    const { persistence } = await mount()
    const first = await persistence.create(headerOf('occupied'))
    await expect(persistence.create(headerOf('occupied'))).rejects.toBeInstanceOf(SessionAlreadyExistsError)
    await first.flush() // materialize, so the occupation outlives the handle
    await first.close()
    await expect(persistence.create(headerOf('occupied'))).rejects.toBeInstanceOf(SessionAlreadyExistsError)
  })

  it('the seeded/cut pairing is refused on mismatch', async () => {
    const { persistence } = await mount()
    const seeded = { ...headerOf('seeded'), isSeeded: true } as SessionHeader
    await expect(persistence.create(seeded)).rejects.toBeInstanceOf(TypeError)
    await expect(persistence.create(seeded, { inheritedEventCount: SessionLogOffset(3) })).resolves.toBeDefined()
    const plain = headerOf('plain')
    await expect(persistence.create(plain, { inheritedEventCount: SessionLogOffset(3) })).rejects.toBeInstanceOf(TypeError)
  })

  it('open write claims single ownership; a second claim rejects until close', async () => {
    const { persistence } = await mount()
    const first = await persistence.create(headerOf('owned'))
    await expect(persistence.open(SessionId('owned'), 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await first.flush()
    await first.close()
    await expect(persistence.open(SessionId('owned'), 'write')).resolves.toBeDefined()
  })

  it('open read never claims ownership and refuses mutations', async () => {
    const { persistence } = await mount()
    const writer = await persistence.create(headerOf('readonly'))
    await writer.append([markerEvent(0)])
    const reader = await persistence.open(SessionId('readonly'), 'read')
    await expect(reader.append([markerEvent(1)])).rejects.toBeInstanceOf(SessionReadOnlyError)
    await expect(reader.flush()).rejects.toBeInstanceOf(SessionReadOnlyError)
    await reader.close()
    // The read handle closed; the writer's claim is untouched.
    await expect(persistence.open(SessionId('readonly'), 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await writer.close()
  })

  it('operations on a closed handle refuse, and close is idempotent', async () => {
    const { persistence } = await mount()
    const handle = await persistence.create(headerOf('closed'))
    await handle.close()
    await handle.close()
    await expect(handle.append([markerEvent(0)])).rejects.toBeInstanceOf(SessionHandleClosedError)
    await expect(handle.read()).rejects.toBeInstanceOf(SessionHandleClosedError)
    await expect(handle.flush()).rejects.toBeInstanceOf(SessionHandleClosedError)
  })

  it('a garbage row past the committed prefix is excluded from reads and truncated by a write open', async () => {
    const { persistence, db } = await mount()
    const writer = await persistence.create(headerOf('torn'))
    await writer.append([markerEvent(0), markerEvent(1)])
    await writer.close()
    // Inject a torn third row: a seq-2 row exists but is not a valid continuation.
    db.state.events.set(db.eventKey('torn', 2), {
      key: ['torn', 2],
      value: { sessionId: 'torn', seq: 2, event: { type: 'garbage' } },
    })
    const reader = await persistence.open(SessionId('torn'), 'read')
    expect((await reader.read()).events.map(event => event.seq)).toEqual([0, 1])
    await reader.close()
    expect(db.state.events.has(db.eventKey('torn', 2))).toBe(true) // reads never repair
    const repair = await persistence.open(SessionId('torn'), 'write')
    expect(db.state.events.has(db.eventKey('torn', 2))).toBe(false) // write-open truncates
    await repair.close()
  })

  it('a write open resumes at the stored end: the next append continues the seq', async () => {
    const { persistence } = await mount()
    const first = await persistence.create(headerOf('resume'))
    await first.append([markerEvent(0)])
    await first.close()
    const second = await persistence.open(SessionId('resume'), 'write')
    await second.append([markerEvent(1)])
    const reader = await persistence.open(SessionId('resume'), 'read')
    expect((await reader.read()).events.map(event => event.seq)).toEqual([0, 1])
    await reader.close()
    await second.close()
  })

  it('read slices by offset and length', async () => {
    const { persistence } = await mount()
    const handle = await persistence.create(headerOf('slices'))
    await handle.append([markerEvent(0), markerEvent(1), markerEvent(2)])
    const reader = await persistence.open(SessionId('slices'), 'read')
    expect((await reader.read(1)).events.map(event => event.seq)).toEqual([1, 2])
    expect((await reader.read(0, 2)).events.map(event => event.seq)).toEqual([0, 1])
    expect((await reader.read(9)).events).toEqual([])
    await reader.close()
    await handle.close()
  })

  it('the stored revision is stable while unchanged and moves on append', async () => {
    const { persistence } = await mount()
    const handle = await persistence.create(headerOf('revisions'))
    await handle.append([markerEvent(0)])
    const first = await persistence.stat(SessionId('revisions'))
    const second = await persistence.stat(SessionId('revisions'))
    expect(first?.revision).toBe(second?.revision)
    await handle.append([markerEvent(1)])
    const third = await persistence.stat(SessionId('revisions'))
    expect(third?.revision).not.toBe(first?.revision)
    await handle.close()
  })

  it('the inherited cut survives storage and reaches reopened handles', async () => {
    const { persistence } = await mount()
    const seeded = { ...headerOf('forked'), isSeeded: true } as SessionHeader
    const handle = await persistence.create(seeded, { inheritedEventCount: SessionLogOffset(7) })
    await handle.flush() // materialize the stored cut
    await handle.close()
    const reopened = await persistence.open(SessionId('forked'), 'read')
    expect(reopened.inheritedEventCount).toBe(SessionLogOffset(7))
    await reopened.close()
  })

  it('list includes pending and stored sessions without duplicates', async () => {
    const { persistence } = await mount()
    const pendingHandle = await persistence.create(headerOf('listed-pending'))
    const storedHandle = await persistence.create(headerOf('listed-stored'))
    await storedHandle.flush()
    await storedHandle.close()
    const ids = (await persistence.list()).map(snapshot => snapshot.header.id)
    expect(ids.filter(id => id === SessionId('listed-pending'))).toHaveLength(1)
    expect(ids.filter(id => id === SessionId('listed-stored'))).toHaveLength(1)
    await pendingHandle.close()
  })

  it('open read of an unknown session refuses with not-found', async () => {
    const { persistence } = await mount()
    await expect(persistence.open(SessionId('absent'), 'read')).rejects.toThrow(/not found/)
  })

  it('the default opener fails with a Chinese error where no indexedDB global exists', async () => {
    const holder = globalThis as { indexedDB?: IDBFactory | undefined }
    const previous: IDBFactory | undefined = holder.indexedDB
    holder.indexedDB = undefined
    try {
      const persistence = new IndexedDbPersistence(new Context(), { dbName: 'unopenable' })
      await expect(persistence.list()).rejects.toThrow(/indexedDB/)
    } finally {
      holder.indexedDB = previous
    }
  })
})

describe('IndexedDbPersistence: historical-format migration', () => {
  /** The stored logical header of a pre-0.1.5 (format v1) row. */
  function v1HeaderOf(id: string): SessionHeader {
    return { version: 1, id: SessionId(id), createdAt: 1_700_000_000_000, isSeeded: false } as unknown as SessionHeader
  }

  /** A valid released-v1 event log: one turn whose assistant text arrives as streamed chunks. */
  function v1Events(): Array<Record<string, unknown>> {
    const time = 1_700_000_000_000
    return [
      { type: 'turn/start', seq: 0, time, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: time + 1, data: { turn: 1, step: 1 } },
      { type: 'assistant/chunk', seq: 2, time: time + 2, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'he' } } },
      { type: 'assistant/chunk', seq: 3, time: time + 3, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'llo' } } },
      { type: 'assistant/chunk', seq: 4, time: time + 4, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } } },
      { type: 'step/end', seq: 5, time: time + 5, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 6, time: time + 6, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
  }

  /** Seed one historical row pair directly into the storage scope. */
  function seedLegacy(db: ReturnType<typeof createMemoryDatabase>, id: string): void {
    db.state.sessions.set(`s:${id}`, {
      key: id,
      value: {
        sessionId: id,
        header: v1HeaderOf(id),
        revision: 3,
        createdAt: 1_700_000_000_000,
      },
    })
    for (const [seq, event] of v1Events().entries()) {
      const key = db.eventKey(id, seq)
      db.state.events.set(key, { key: [id, seq], value: { sessionId: id, seq, event } })
    }
  }

  it('a write open publishes the migrated current format and archives the original verbatim', async () => {
    const { persistence, db } = await mount()
    seedLegacy(db, 'legacy')
    const handle = await persistence.open(SessionId('legacy'), 'write')
    const read = await handle.read()
    // Every migrated event type is current (validateStoredEvents enforced that
    // during the migration); the streamed chunks folded away.
    expect(read.events.some(event => (event.type as string) === 'assistant/chunk')).toBe(false)
    // The migrated view continues the log at the MIGRATED length, and the
    // appended current-format event lands after it.
    const next = read.events.length
    await handle.append([{ seq: SessionSeq(next), time: 1_700_000_010_000, type: 'turn/start', data: { turn: 2 } }])
    expect((await handle.read()).events.length).toBe(next + 1)
    await handle.close()
    // The live row is current-format; the original v1 generation is archived.
    const upgradedRow = db.state.sessions.get('s:legacy')?.value as { header: { version: number }; revision: number }
    expect(upgradedRow.header.version).toBe(SESSION_FORMAT_VERSION)
    // The upgrade bumps the revision once, and the test's append bumps it again.
    expect(upgradedRow.revision).toBe(5)
    const archived = db.state.archive.get('s:legacy')?.value as {
      storedVersion: number
      row: { header: { version: number }; revision: number }
      events: Array<{ event: { type: string } }>
    }
    expect(archived.storedVersion).toBe(1)
    expect(archived.row.header.version).toBe(1)
    expect(archived.row.revision).toBe(3)
    expect(archived.events.map(entry => entry.event.type)).toContain('assistant/chunk')
  })

  it('a read-only open migrates in memory and never rewrites the stored rows', async () => {
    const { persistence, db } = await mount()
    seedLegacy(db, 'legacy-ro')
    const reader = await persistence.open(SessionId('legacy-ro'), 'read')
    const read = await reader.read()
    expect(read.events.some(event => (event.type as string) === 'assistant/chunk')).toBe(false)
    expect(read.events.length).toBeGreaterThan(0)
    await reader.close()
    // Storage keeps the historical generation untouched.
    const storedRow = db.state.sessions.get('s:legacy-ro')?.value as { header: { version: number } }
    expect(storedRow.header.version).toBe(1)
    expect(db.state.archive.has('s:legacy-ro')).toBe(false)
    expect([...db.state.events.values()].filter(entry => (entry.value as { sessionId: string }).sessionId === 'legacy-ro')).toHaveLength(7)
  })

  it('a refused historical log fails the open loudly instead of reading past it', async () => {
    const { persistence, db } = await mount()
    seedLegacy(db, 'refusing')
    const first = db.state.events.get(db.eventKey('refusing', 0))?.value as { event: Record<string, unknown> }
    first.event = { type: 'external/unknown', seq: 0, time: 1, data: null }
    await expect(persistence.open(SessionId('refusing'), 'write')).rejects.toThrow(/unknown event type/)
  })

  describe('legacyUnknownEventRepair', () => {
    /** A stored v0-era header (pre-0.1.5 fork base stamped format 0). */
    function v0HeaderOf(id: string): SessionHeader {
      return { version: 0, id: SessionId(id), createdAt: 1_700_000_000_000, isSeeded: false } as unknown as SessionHeader
    }

    /**
     * A mixed historical log: released types in current shapes, one
     * repository-known type the frozen v0 edge predates (`permission/mode`),
     * and one dead out-of-repository type (`dsh-approval-card-expand`).
     */
    function mixedLegacyEvents(): Array<Record<string, unknown>> {
      const time = 1_700_000_000_000
      return [
        { type: 'turn/start', seq: 0, time, data: { turn: 1 } },
        { type: 'permission/mode', seq: 1, time: time + 1, data: { mode: 'ask-on-change' } },
        { type: 'dsh-approval-card-expand', seq: 2, time: time + 2, data: { approvalId: 'a1', expanded: true } },
        { type: 'turn/end', seq: 3, time: time + 3, data: { turn: 1, reason: { kind: 'completed' } } },
      ]
    }

    function seedMixedLegacy(db: ReturnType<typeof createMemoryDatabase>, id: string): void {
      db.state.sessions.set(`s:${id}`, {
        key: id,
        value: { sessionId: id, header: v0HeaderOf(id), revision: 1, createdAt: 1_700_000_000_000 },
      })
      for (const [seq, event] of mixedLegacyEvents().entries()) {
        db.state.events.set(db.eventKey(id, seq), { key: [id, seq], value: { sessionId: id, seq, event } })
      }
    }

    it('default config keeps the released refusal', async () => {
      const { persistence, db } = await mount()
      seedMixedLegacy(db, 'mixed-default')
      await expect(persistence.open(SessionId('mixed-default'), 'write')).rejects.toThrow(/unknown historical event type/)
    })

    it('armed repair rescues the log: known types carry verbatim, unknown types become ignorable, originals archive', async () => {
      const ctx = new Context()
      contexts.push(ctx)
      const db = createMemoryDatabase()
      await ctx.plugin(memoryBackendClass(db), { dbName: DEFAULT_DB_NAME, legacyUnknownEventRepair: true })
      const persistence = ctx.sessionPersistence as IndexedDbPersistence
      seedMixedLegacy(db, 'mixed-rescued')

      const handle = await persistence.open(SessionId('mixed-rescued'), 'write')
      const read = await handle.read()
      const byType = (type: string) => read.events.filter(event => (event.type as string) === type)
      expect(handle.header.version).toBe(SESSION_FORMAT_VERSION)
      expect(byType('permission/mode')).toHaveLength(1)
      const expanded = byType('dsh-approval-card-expand')
      expect(expanded).toHaveLength(1)
      expect(expanded[0]?.ignorable).toBe(true)
      expect(byType('turn/start')).toHaveLength(1)
      await handle.close()

      // The live row is current-format; the original v0 generation is archived verbatim.
      const upgradedRow = db.state.sessions.get('s:mixed-rescued')?.value as { header: { version: number } }
      expect(upgradedRow.header.version).toBe(SESSION_FORMAT_VERSION)
      const archived = db.state.archive.get('s:mixed-rescued')?.value as {
        storedVersion: number
        events: Array<{ event: { type: string; ignorable?: boolean } }>
      }
      expect(archived.storedVersion).toBe(0)
      expect(archived.events.map(entry => entry.event.type)).toEqual([
        'turn/start',
        'permission/mode',
        'dsh-approval-card-expand',
        'turn/end',
      ])
      expect(archived.events.some(entry => entry.event.ignorable === true)).toBe(false)
    })

    it('armed repair also downgrades released chunk types the current vocabulary refuses', async () => {
      // The user-facing shape: a v1 log whose assistant/chunk rows the
      // v1→v2 embed folds away, plus one out-of-repository type that breaks
      // the v3 restore — the repair must degrade BOTH to ignorable instead
      // of keeping the chunk verbatim for validateStoredEvents to refuse.
      const ctx = new Context()
      contexts.push(ctx)
      const db = createMemoryDatabase()
      await ctx.plugin(memoryBackendClass(db), { dbName: DEFAULT_DB_NAME, legacyUnknownEventRepair: true })
      const persistence = ctx.sessionPersistence as IndexedDbPersistence
      seedLegacy(db, 'chunk-rescued')
      const foreign = { type: 'dsh-approval-card-expand', seq: 7, time: 1_700_000_000_007, data: { approvalId: 'a2', expanded: false } }
      db.state.events.set(db.eventKey('chunk-rescued', 7), {
        key: ['chunk-rescued', 7],
        value: { sessionId: 'chunk-rescued', seq: 7, event: foreign },
      })

      const handle = await persistence.open(SessionId('chunk-rescued'), 'write')
      const read = await handle.read()
      const chunks = read.events.filter(event => (event.type as string) === 'assistant/chunk')
      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.every(event => event.ignorable === true)).toBe(true)
      const foreignRow = read.events.find(event => (event.type as string) === 'dsh-approval-card-expand')
      expect(foreignRow?.ignorable).toBe(true)
      await handle.close()
    })

    it('a current-format generation carrying foreign types repairs in place on write open', async () => {
      // A pre-0.2.1 publish could write current-format rows verbatim BEFORE
      // the repair learned to mark foreign types ignorable: header already
      // current, so the historical gate never runs and the first open must
      // repair in place instead of refusing at the first read.
      const ctx = new Context()
      contexts.push(ctx)
      const db = createMemoryDatabase()
      await ctx.plugin(memoryBackendClass(db), { dbName: DEFAULT_DB_NAME, legacyUnknownEventRepair: true })
      const persistence = ctx.sessionPersistence as IndexedDbPersistence
      db.state.sessions.set('s:current-foreign', {
        key: 'current-foreign',
        value: {
          sessionId: 'current-foreign',
          header: { version: SESSION_FORMAT_VERSION, id: SessionId('current-foreign'), createdAt: 1_700_000_000_000, isSeeded: false },
          revision: 2,
          createdAt: 1_700_000_000_000,
        },
      })
      const events: Array<Record<string, unknown>> = [
        { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 1 } },
        { type: 'dsh-approval-card-expand', seq: 1, time: 1_700_000_000_001, data: { approvalId: 'a1', expanded: true } },
        { type: 'turn/end', seq: 2, time: 1_700_000_000_002, data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      for (const [seq, event] of events.entries()) {
        db.state.events.set(db.eventKey('current-foreign', seq), {
          key: ['current-foreign', seq],
          value: { sessionId: 'current-foreign', seq, event },
        })
      }

      const handle = await persistence.open(SessionId('current-foreign'), 'write')
      const read = await handle.read()
      const foreignRow = read.events.find(event => (event.type as string) === 'dsh-approval-card-expand')
      expect(foreignRow?.ignorable).toBe(true)
      expect(handle.header.version).toBe(SESSION_FORMAT_VERSION)
      await handle.close()
    })
  })
})

describe('scanEventRows', () => {
  it('preserves a contiguous run and reports the first hole as the truncation point', () => {
    const rows = [
      { sessionId: 's', seq: 0, event: { seq: 0, type: 'system/message', time: 1, data: {} } },
      { sessionId: 's', seq: 1, event: { seq: 1, type: 'system/message', time: 2, data: {} } },
      { sessionId: 's', seq: 3, event: { seq: 3, type: 'system/message', time: 3, data: {} } },
    ]
    const { preserved, tornFrom } = scanEventRows(rows, 0)
    expect(preserved.map(row => row.seq)).toEqual([0, 1])
    expect(tornFrom).toBe(2)
  })

  it('bases contiguity on the requested suffix offset', () => {
    const rows = [
      { sessionId: 's', seq: 2, event: { seq: 2, type: 'system/message', time: 1, data: {} } },
    ]
    const { preserved, tornFrom } = scanEventRows(rows, 2)
    expect(preserved).toHaveLength(1)
    expect(tornFrom).toBeUndefined()
  })
})

runLiveWritePathContract('indexeddb', LIVE_WRITE_BATCH_MAX_DELAY_MS, async () => {
  const db = createMemoryDatabase()
  const mount = async (): Promise<Context> => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(memoryBackendClass(db), { dbName: DEFAULT_DB_NAME })
    return ctx
  }
  return { ctx: await mount(), remount: mount }
})
