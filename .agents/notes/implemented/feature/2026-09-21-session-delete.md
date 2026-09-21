# Agent Note: session deletion — persistence rows, listing tombstones, and a two-step confirm

Status: implemented

English | [中文](2026-09-21-session-delete.zh.md)

## Problem

Historical sessions could be renamed but never deleted, so the switcher only ever grew. The user asked for deletion explicitly after the fresh-session boot change made old conversations purely optional history.

## Decision

Three layers, each doing only its own job:

- **Persistence** gains `SessionPersistence.delete(id)`: one atomic transaction removing the identity row, the event range, and any archived generation. Unknown ids are a no-op (a retried delete stays correct). The base-class default refuses, so a backend declares support by implementing it — only the IndexedDB backend does today, which is also the only backend the extension mounts.
- **Bridge** gains `session.delete`: a RUNNING session refuses (interrupt first — deleting under a live turn would race the turn's own appends); everything else deletes the persisted rows and adds the id to an in-memory tombstone set. Disposing a live agent is the creating owner's handle capability (config-created agents like session-main are loop-fiber-owned by design and never expose a handle), so a deleted-but-still-live session lingers in memory — the tombstone set hides it from `session.list`/`session.search` for this engine lifetime, and a restart finds no persisted rows behind it.
- **Panel switcher**: every row gets a delete affordance with a two-step confirm (first click arms and turns it danger-red, second click deletes; any other interaction disarms). Deleting the active session falls back to the fresh-session sentinel, and the sentinel's history read now clears the transcript instead of keeping the previous conversation's text (the refused-read-keeps-text rule would otherwise leak the deleted content on screen).

## Alternatives considered

- **Dispose the live agent on delete.** Rejected: disposal is the owner's handle capability; config-created agents never expose one, and a registry-level dispose would cut across the documented ownership model for one UI feature. The tombstone achieves the user-visible result without it.
- **Confirm through a modal dialog.** Rejected: the switcher already uses inline affordances (rename pencil); the two-step in-place confirm matches that idiom without new overlay plumbing.

## Consequences

- Deleting a session removes it from the switcher immediately and from IndexedDB durably (identity, events, and archive). Deleting the active session lands on a fresh start.
- A running session refuses loudly instead of racing its own event stream.
- Coverage: the IndexedDB suite asserts full row removal plus idempotence; the real-device harness seeds two sessions, deletes a non-active one (gone from the switcher and disk), then deletes the active one (panel falls back to the fresh start, tombstone keeps it unlisted, disk clean).
