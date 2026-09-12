/**
 * Backend-mechanics spec for the IndexedDB session-persistence service over
 * the in-memory structural double, plus the shared live-write-path contract
 * every session-persistence backend must satisfy.
 * @module @deepseek-ai/dsh-session-persistence-indexeddb/tests/indexeddb
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionStore } from '@deepseek-ai/dsh-session'
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
  }
}

/** One non-surface marker event at `seq` (carries no surface-op obligation). */
function markerEvent(seq: number): SessionEvent {
  return { seq, time: 1_700_000_000_000 + seq, type: 'turn/start', data: { turn: seq } }
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
    const holder = globalThis as { indexedDB?: IDBFactory }
    const previous = holder.indexedDB
    holder.indexedDB = undefined
    try {
      const persistence = new IndexedDbPersistence(new Context(), { dbName: 'unopenable' })
      await expect(persistence.list()).rejects.toThrow(/indexedDB/)
    } finally {
      holder.indexedDB = previous
    }
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
