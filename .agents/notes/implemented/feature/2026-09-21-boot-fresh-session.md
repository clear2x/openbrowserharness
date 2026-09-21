# Agent Note: the panel opens on a fresh session; running sessions and history are explicit picks

Status: implemented

English | [中文](2026-09-21-boot-fresh-session.zh.md)

## Problem

Every panel open adopted the NEWEST persisted session — always `session-main` — so users were dropped back into an old, often heavy conversation they never asked for. The `＋ 新会话` button existed, but the default flow fought the natural expectation: open → start something new; continue an old conversation only by explicit choice. Compounding it, that auto-resume is exactly what paid the cold-resume (and one-time repair) cost on every reload.

## Decision

The shell boots on a sentinel fresh-session id (`session-new`, shaped so `mintSessionId`'s `session-<uuid>` output can never collide). Boot no longer adopts the newest session: `session.list` is consulted only to adopt a session that is still RUNNING at boot, so live work is never stranded behind the switcher. The sentinel session is purely client-side — nothing is minted server-side until the first send, when `promptSend` runs `session.create`, adopts the minted id (transcript, retry chip, and switcher key on it), and delivers the prompt. Opening the panel therefore never litters the switcher with empty rows: a fresh view that never receives a message leaves zero trace. Warm-up skips the sentinel (nothing persisted to warm), and per-session reads (history, usage, permission, status) degrade to their empty/default postures exactly as they do for any unknown id.

## Alternatives considered

- **Mint a real session at boot.** Rejected: every panel open would add an untitled row to the switcher — clutter with no upside when the user sends nothing.
- **Keep auto-resume but make it fast.** Rejected: the user asked for the behavior change, not just for speed; the fresh start also removes the automatic cold-resume cost from every open.
- **Drop the running-adoption branch.** Rejected: it is four lines of safety net. In practice a panel reload aborts the in-flight turn (client-gone abort is the engine's standing semantics), so the branch rarely fires, but a turn that outlives a quick reopen must stay visible.

## Consequences

- Open → fresh conversation with the welcome examples; old conversations are reachable only through the switcher, by explicit choice.
- First send materializes exactly one real session; empty fresh opens leave no trace in the session list.
- Coverage: the real-device harness seeds an old persisted conversation, opens the panel (old transcript absent), sends on the fresh view (turn completes; IndexedDB gains exactly one new session row besides the seeded one), reloads mid-turn (panel still opens fresh; the interrupted conversation stays persisted for a manual pick). Full extension suite, typecheck, and lint stay green.
