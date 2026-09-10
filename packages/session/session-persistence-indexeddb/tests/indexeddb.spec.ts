/**
 * IndexedDB backend coverage: the shared persistence and coordinator contract
 * suites driven by an in-memory structural IDB double, plus backend-owned
 * mechanics — torn-tail mapping (key-range delete), revision tokens, detached
 * graphs, suffix seeks, locators, and the missing-global open failure.
 * @module @deepseek-ai/dsh-session-persistence-indexeddb/tests/indexeddb
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import IndexedDbPersistence, { defaultOpenDatabase, scanEventRows } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { createMemoryDatabase } from './memory-idb.ts'
import type { MemoryDatabase } from './memory-idb.ts'
import { meta, oneTurnLog, runPersistenceContract } from '../../session-persistence/tests/contract.ts'
import { runCoordinatorContract } from '../../session-persistence/tests/coordinator-contract.ts'
import type { CoordinatorFixture } from '../../session-persistence/tests/coordinator-contract.ts'

/** Test-only mutable view of one stored prefix (the shipped types are readonly). */
type MutableStoredPrefix = {
  meta: { -readonly [K in keyof SessionHeader]: SessionHeader[K] }
  events: SessionEvent[]
  tornMarker?: { truncateFromSeq: number }
}

/** Build a plugin-mountable backend class bound to one memory database. */
function memoryBackendClass(memory: MemoryDatabase) {
  return class MemoryIndexedDbPersistence extends IndexedDbPersistence {
    constructor(ctx: Context, config: Config) {
      super(ctx, config, { openDatabase: memory.open })
    }
  }
}

/** Mount SessionStore plus one memory-backed backend on a fresh context. */
async function mount(memory = createMemoryDatabase(), config: Config = { dbName: 'spec-sessions' }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(memoryBackendClass(memory), config)
  return { ctx, persistence: ctx.sessionPersistence as IndexedDbPersistence, fiber, memory }
}

// The shared backend-agnostic contract over the in-memory structural double.
runPersistenceContract('indexeddb-memory', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(memoryBackendClass(createMemoryDatabase()), { dbName: 'contract-sessions' })
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => {
      await fiber.dispose()
    },
  }
})

// The coordinator orchestration suite (write path, adoption, HMR reload, torn
// repair) over one shared storage scope, like two extension mounts of one origin.
runCoordinatorContract('indexeddb-memory', async (): Promise<CoordinatorFixture> => {
  const memory = createMemoryDatabase()
  const MemoryBackend = memoryBackendClass(memory)
  return {
    mount: async ctx => ctx.plugin(MemoryBackend, { dbName: 'coord-sessions' }),
    corruptTail: async (id) => {
      // A never-committed row past the committed region: the KEY exists but the
      // payload is garbage, mirroring a torn final JSONL record.
      const nextSeq = [...memory.state.events.keys()]
        .filter(key => key.startsWith(`a:${String(id)}:`))
        .reduce((max, key) => Math.max(max, Number(key.split(':').at(-1) ?? '-1')), -1) + 1
      memory.state.events.set(memory.eventKey(String(id), nextSeq), {
        key: [String(id), nextSeq],
        value: { sessionId: String(id), seq: nextSeq, event: null },
      })
    },
    cleanup: async () => {},
  }
})

describe('IndexedDbPersistence: backend mechanics', () => {
  it('loadStored returns detached graphs: caller mutation cannot reach stored rows', async () => {
    const { persistence, fiber } = await mount()
    try {
      const header = meta('detached', '/work')
      await persistence.create(header)
      await persistence.append(header.id, oneTurnLog())

      const stored = await persistence.loadStored(header.id) as unknown as MutableStoredPrefix
      expect(stored?.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
      expect(stored?.tornMarker).toBeUndefined()
      // Mutate every returned graph: the stored rows must be unaffected.
      stored.meta.cwd = '/mutated';
      (stored.events[0] as { data: unknown }).data = { turn: 999 }
      const reread = await persistence.loadStored(header.id) as unknown as MutableStoredPrefix
      expect(reread?.meta.cwd).toBe('/work')
      expect((reread?.events[0]!.data as { turn: number }).turn).toBe(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('a garbage row past the committed prefix becomes a torn marker deleted by key range', async () => {
    const memory = createMemoryDatabase()
    const { persistence, fiber } = await mount(memory)
    try {
      const header = meta('torn-garbage', '/work')
      await persistence.create(header)
      await persistence.append(header.id, oneTurnLog())

      memory.state.events.set(memory.eventKey('torn-garbage', 6), {
        key: ['torn-garbage', 6],
        value: { sessionId: 'torn-garbage', seq: 6, event: '半条记录' },
      })
      const torn = await persistence.loadStored(header.id) as unknown as MutableStoredPrefix
      expect(torn?.events).toHaveLength(6)
      expect(torn?.tornMarker).toEqual({ truncateFromSeq: 6 })

      // load commits the repair: the torn row is GONE from the store.
      await persistence.load(header.id)
      expect(memory.state.events.has(memory.eventKey('torn-garbage', 6))).toBe(false)
      // And the repaired prefix reads clean with no marker left.
      const repaired = await persistence.loadStored(header.id) as unknown as MutableStoredPrefix
      expect(repaired?.tornMarker).toBeUndefined()
      expect(repaired?.events).toHaveLength(6)
    } finally {
      await fiber.dispose()
    }
  })

  it('a seq gap marks the missing position as the truncation point', async () => {
    const memory = createMemoryDatabase()
    const { persistence, fiber } = await mount(memory)
    try {
      const header = meta('torn-gap', '/work')
      await persistence.create(header)
      await persistence.append(header.id, oneTurnLog())
      // A well-formed event written at seq 8 leaves a gap at 6-7: the committed
      // prefix ends at 5 and everything from 6 on is a never-committed tail.
      const orphan = oneTurnLog()[5]!
      memory.state.events.set(memory.eventKey('torn-gap', 8), {
        key: ['torn-gap', 8],
        value: { sessionId: 'torn-gap', seq: 8, event: { ...orphan, seq: 8 } },
      })
      const torn = await persistence.loadStored(header.id) as unknown as MutableStoredPrefix
      expect(torn?.tornMarker).toEqual({ truncateFromSeq: 6 })
      await persistence.load(header.id)
      expect(memory.state.events.has(memory.eventKey('torn-gap', 8))).toBe(false)
    } finally {
      await fiber.dispose()
    }
  })

  it('revisions are stable while unchanged and move on append and repair', async () => {
    const memory = createMemoryDatabase()
    const { persistence, fiber } = await mount(memory)
    try {
      const header = meta('revisions', '/work')
      await persistence.create(header)
      await persistence.append(header.id, oneTurnLog())
      const first = await persistence.readStoredRevision(header.id)
      expect(await persistence.readStoredRevision(header.id)).toBe(first)

      await persistence.append(header.id, [
        { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
        { type: 'turn/end', seq: 7, time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
      ])
      const second = await persistence.readStoredRevision(header.id)
      expect(second).not.toBe(first)

      // An interrupted open turn plus a torn row: load repairs, and the repair
      // is another durable change.
      await persistence.append(header.id, [{ type: 'turn/start', seq: 8, time: 9, data: { turn: 3 } }])
      memory.state.events.set(memory.eventKey('revisions', 9), {
        key: ['revisions', 9],
        value: { sessionId: 'revisions', seq: 9, event: 42 },
      })
      await persistence.load(header.id)
      expect(await persistence.readStoredRevision(header.id)).not.toBe(second)
    } finally {
      await fiber.dispose()
    }
  })

  it('readFrom returns exactly the stored suffix without mutating the log', async () => {
    const { persistence, fiber } = await mount()
    try {
      const header = meta('suffix', '/work')
      await persistence.create(header)
      await persistence.append(header.id, oneTurnLog())
      const suffix = await persistence.readFrom(header.id, 3)
      expect(suffix.meta.id).toBe(header.id)
      expect(suffix.events.map(event => event.seq)).toEqual([3, 4, 5])
      const whole = await persistence.loadStored(header.id) as unknown as MutableStoredPrefix
      expect(whole?.events).toHaveLength(6)
    } finally {
      await fiber.dispose()
    }
  })

  it('locate names the database, store, and session key prefix', async () => {
    const { persistence, fiber } = await mount(undefined, { dbName: 'locator-db' })
    try {
      expect(persistence.locate(meta('loc', '/w'))).toEqual({
        kind: 'indexeddb',
        path: 'locator-db/sessions/loc',
      })
    } finally {
      await fiber.dispose()
    }
  })

  it('list lists materialized sessions with per-session snapshot revisions', async () => {
    const { persistence, fiber } = await mount()
    try {
      expect(await persistence.list()).toEqual([])
      const lazy = meta('lazy', '/work')
      await persistence.create(lazy) // created-but-never-appended stays absent
      const stored = meta('stored', '/work')
      await persistence.create(stored)
      await persistence.append(stored.id, oneTurnLog())

      expect((await persistence.list()).map(header => header.id)).toEqual([stored.id])
      const snapshots = await persistence.listSnapshots()
      expect(snapshots.map(snapshot => snapshot.header.id)).toEqual([stored.id])
      expect(snapshots[0]!.revision).toBe(await persistence.readStoredRevision(stored.id))
    } finally {
      await fiber.dispose()
    }
  })

  it('close closes the connection; later storage calls surface the closed-handle error', async () => {
    const memory = createMemoryDatabase()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new IndexedDbPersistence(ctx, { dbName: 'close-db' }, { openDatabase: memory.open })
    try {
      const header = meta('closed', '/work')
      await backend.create(header)
      await backend.append(header.id, oneTurnLog())
      await backend.close()
      await expect(backend.loadStored(header.id)).rejects.toThrow('memory-idb: database is closed')
    } finally {
      await backend.close()
    }
  })

  it('the default opener fails with a Chinese error where no indexedDB global exists', async () => {
    if ((globalThis as { indexedDB?: unknown }).indexedDB !== undefined) return
    await expect(defaultOpenDatabase('nowhere', 1)).rejects.toThrow('当前环境没有可用的 indexedDB 全局对象')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new IndexedDbPersistence(ctx, { dbName: 'nowhere' })
    try {
      await expect(backend.loadStored(SessionId('missing'))).rejects.toThrow('indexedDB')
    } finally {
      await backend.close()
    }
  })
})

describe('scanEventRows', () => {
  it('preserves a contiguous run and reports the first hole as the truncation point', () => {
    const row = (seq: number): unknown => ({
      sessionId: 's',
      seq,
      event: { type: 'turn/start', seq, time: 1, data: { turn: 1 } },
    })
    expect(scanEventRows([row(0), row(1), row(2)])).toEqual({ preserved: [row(0), row(1), row(2)] })
    expect(scanEventRows([row(0), row(1), 'garbage', row(3)]).tornFrom).toBe(2)
    expect(scanEventRows([row(0), row(2)]).tornFrom).toBe(1)
    expect(scanEventRows([row(1)], 1).preserved).toHaveLength(1)
    // Key/payload disagreement is corruption, not a continuation.
    expect(scanEventRows([{ sessionId: 's', seq: 1, event: { type: 'turn/start', seq: 0, time: 1, data: {} } }], 0).preserved).toHaveLength(0)
  })
})
