# Agent Note: the extension mux carried projections but dropped queue frames — three seams to restore the queue dock

Status: implemented

English | [中文](2026-09-29-mux-queue-frames.zh.md)

## Problem

The extension's QueueDock never rendered: a message sent while an agent turn was running was accepted (local echo, no error), the engine durably spliced it into the inbox and claimed it — but the queue strip never lit. The desktop web UI gets queue rows from the typert control stream; the extension's transport never carried them.

## Diagnosis

Frame-level tap inventory on the real device: the mux stream delivered `session/projection` frames in volume (todos/goal/plan/title/inbox) but **zero `session/queue` frames**. The engine side was healthy — `agent/inbox/spliced` events showed insert+claim pairs in the durable log. Three independent seams each dropped or starved the queue arm:

1. **The SW-side projection bridge emitted projections only.** `chrome-api-bridge` fans `sessionProjections.onChanged` out as `session/projection` frames; the inbox projection (which is the queue-frame trigger in `SessionControlController` parity) produced no `session/queue` frame, and the `MuxFrame` union did not even declare one.
2. **The panel tap routed projections only.** `connection-module` normalized `session/projection` to the control-frame arm and dropped `session/queue`/`session/jobs` on the floor.
3. **The client manager used the raw map for queue dispatch.** `handleControlFrame`'s queue branch called `this.sessions.get(id)?.handleControlFrame(frame)` — a bare `Map.get` that misses when the frame arrives before the session instance exists (the projection arm sidesteps this with a create-on-demand store). A queue frame racing the session bridge therefore updated `manager.queues` but never the instance's mirror the dock reads.

## Decision

- `chrome-api-bridge`: the inbox projection now also emits a `session/queue` frame (wire `QueuedInboxItem` items folded from the live inbox view — next-turn queued, user next-step steering), and `MuxFrame` declares the arm.
- `connection-module`: the tap normalizes all three wire arms (`session/projection`, `session/queue`, `session/jobs`) to their `SessionControlFrame` tags and emits one `mux/control` event.
- `ISessions` gains `applyControlFrame` (delegating to `manager.handleControlFrame`); the shell's mux listener switches to it.
- The manager's queue branch lazy-builds the session instance (`this.get(id)`) instead of the raw map read.

## Verification

Real-device probe with an instrumented apply: the second message's queue frame arrives, applies, and the instance snapshot reads `rows=1 placements=["queued"]` — the data path is end to end. The dock's visible window is inherently sub-second in the mock scenario (the running turn claims the followup at its next step boundary and an empty-replacement frame follows immediately), so the probe asserts the applied snapshot, not a DOM count. Frame typing hazard kept from the projection batch: field types derive from `Extract<SessionControlFrame, …>` arms — importing them from the engine face would flip the `Context.sessions` augmentation merge.

## Consequences

The queue dock and any jobs surface now receive live frames. The dual dispatch (port tap + stream iterator both hand over mux envelopes) was collapsed in the follow-up batch (the pump drains instead of re-dispatching). A real-device plan-chip re-verification is pending: the probe environment's Edge launch degraded mid-batch (unrelated to code); the plan projection rides the same projection channel this batch verified end to end.

## Alternatives considered

**Proxy the queue arm only when a dock is mounted.** Rejected: the frames are the authoritative live state for the queue dock and any jobs surface, and conditional subscription would reintroduce the "mounted but dark" failure this fix closes — an always-on arm costs a few small frames per mutation.

**Extend `applyProjectionFrame` to accept all control-frame arms instead of adding `applyControlFrame`.** Rejected: the projection method's contract is the per-session value store (higher-seq-wins); overloading it with queue/jobs semantics would blur two dispatch behaviors behind one name. `applyControlFrame` delegates straight to `manager.handleControlFrame`, which already owns the full frame dispatch.
