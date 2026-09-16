---
description: "IndexedDB PersistenceBackend for browser and extension hosts over the shared PersistenceCoordinator."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-indexeddb

English | [中文](README.zh.md)

## Summary

Persists event-sourced sessions in IndexedDB for browser/extension hosts: one database (default `dsh-sessions`) with a `sessions` store (keyPath `sessionId`, header + revision + createdAt) and an `events` store (keyPath `[sessionId, seq]`, append-only rows). It implements the `PersistenceBackend` hooks over the shared `PersistenceCoordinator`, so buffering, adoption, crash-repair sequencing, and dispose quiescence behave exactly like the JSONL/SQLite backends.

## Table of Contents

- [Storage and durability mapping](#storage-and-durability-mapping)
- [Configuration and injection](#configuration-and-injection)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Storage and durability mapping

| Concern | Mapping |
|---|---|
| Materialize + first batch | One `readwrite` transaction writes the sessions row AND the first event batch — a crash between them cannot leave a materialized-but-empty session. |
| Appends | One transaction per batch; the row's `revision` counter bumps on commit. |
| Torn tail | IndexedDB has no torn bytes. A torn tail is "rows the committed prefix does not cover": the first malformed row or seq gap ends the prefix; `loadStored` returns only the prefix plus `tornMarker: { truncateFromSeq }`. |
| Repair | `commitRepair` deletes event rows with `seq >= truncateFromSeq` by key range (the IDB equivalent of the JSONL byte truncate) and writes the synthetic closers in one transaction. |
| Revisions | `SessionPersistenceRevision("indexeddb:<dbName>:<id>:<n>")` — stable while unchanged, moved by every durable write; source-qualified by database name. |
| Seeks | The events store is keyed by seq, so `loadStoredFrom` reads only `seq >= fromSeq` (the coordinator's suffix path, like SQLite). |

Reads (`loadStored`) return `structuredClone`d graphs — headers and events are detached from the stored rows, so preparation can freeze and publish them in place.

## Configuration and injection

`Config` accepts `dbName` (default `dsh-sessions`) plus the coordinator policy knobs `preparedSessionCacheSize` and `writeBatchMaxDelayMs` (defaults shared with the other coordinator backends). `locate(meta)` names the storage key prefix — `{ kind: 'indexeddb', path: '<dbName>/sessions/<id>' }` — without touching the database. All IndexedDB access funnels through one injectable `openDatabase` factory (default: the page/worker `indexedDB` global, schema version 1 creates both stores), and where no global exists every storage call fails with ``session-persistence-indexeddb：当前环境没有可用的 indexedDB 全局对象``. Tests drive the backend through an in-memory structural adapter over the same `StructuredDatabase` surface.

## Dev Note

This package is a fork addition evolving with the extension release cadence; keep the page contents and the table of contents in sync when the surface changes.

## Model Experience

None, as the backend only stores and serves durable session state — the coordinator's synthetic closers and retryable tool errors remain the only log changes, and no prompt, schema, or stream is registered.

#### KV Cache effect

No direct invalidation; persistence never alters an assembled request prefix. Resume/history reads through this backend feed whatever the composed agent already renders.

## Known Limitations and Deferred Work

- **No cross-origin or multi-profile story** — one database name per composition; partitioned extension contexts that must not share history need distinct `dbName` values, and no migration merges them.
- **No quota-pressure handling** — IndexedDB eviction or quota failures surface as storage errors from the append path; a retention/GC policy for old sessions is deferred.
- **No `readRaw`** — `supportsRawArtifacts` is `false`: rows are structured clones, not one verbatim per-session artifact, so raw-artifact consumers fall back to the logical views.
- **Schema version 1 only** — future store changes must bump `DATABASE_VERSION` with an upgrade path; none is shipped because no older layout exists.
