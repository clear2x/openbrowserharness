# Agent Note: projection docks end to end — four gaps between the engine fold and the dock light

Status: implemented

English | [中文](2026-09-29-projection-dock-wiring-chain.zh.md)

## Problem

After the `main` declaration landed (see [2026-09-28-goalbar-dock-main-slot-declaration](2026-09-28-goalbar-dock-main-slot-declaration.md)), the capability panel mounted but stayed empty: a model-executed `todo_write` committed to the session log, the mux tap showed `session/projection` frames arriving, and `[data-testid="todo-panel"]` still never appeared. Probes also surfaced a second, unrelated defect: the whole SidePanel re-rendered thousands of times per second.

## Decision

Four gaps, in the order they broke:

**1. The shell rendered the wrong slot.** The shell rendered a `conversation` anchor that has no occupant; the conversation panel registers at the `main` keyed slot under key `conversation` (desktop `ui-layout` renders it via `renderSlot('main', {}, { entryKey })`). The shell's two dock mounts now call `renderSlot('main', {}, { entryKey: 'conversation' })`, and its own `SlotMap` augmentation declares `'main': { kind: 'keyed'; scope: 'root' }` — the declaring registrar owns the contract, and importing `ui-layout`'s augmentation is not an option (that package is deliberately absent from the extension roster). Typing note: the register overload composes `keyof ChildrenDecl & keyof SlotMap`, so the component may not declare `renderSlot('main')` until the augmentation exists in the extension's program.

**2. The workspace share seat was missing.** `ConversationRoot` reads `useWorkspaces` from the root hooks seat that desktop `ui-workspace` installs; the roster excludes `ui-workspace`, so `main.conversation` crashed with `useWorkspaces is not a function`. The shell now provides the seat itself from the `workspaces` service its inject already declares: `ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })`.

**3. The wire tag never matched the sessions contract.** The mux carries `session/projection`; `ClientSessions.handleControlFrame` dispatches on `projection` — the raw frame fell through to the queue branch and died silently. The connection module's tap now normalizes the frame to the control-frame arm before emitting `mux/projection`. Related hazard: typing that frame from `@deepseek-ai/dsh-session` imports would add that module's conflicting `Context.sessions` augmentation (`SessionStore`) to the client program and flip which augmentation wins the merge — the frame's field types now derive from `Extract<SessionControlFrame, { type: 'projection' }>` instead.

**4. The session bridge assumed a push leg that never runs.** `useSessionBridge` waited for the freshly created session id to appear in `sessions.list` "via the host stream" — the extension does not run the host stream, and the service's own pull (`refresh()`) resolves without landing rows through its typert remote. The bridge now feeds the plain `session.list` rpc rows through `handleSessionAdded` (the same handler remote notifications use) and then calls `open(id)`; without a current session, every session-scoped slot stays unresolved and the docks never mount.

## The render storm was a separate, pre-existing loop

Instrumented render counters showed `ExtensionShell` re-rendering 2–4k times per second from boot — before any dock mounted. Root cause: `useTabs` re-created `refresh` every render, the effect keyed on it re-ran every commit, and each run's `queryTabs().then(setTabs)` handed back a fresh array — a self-sustaining loop paced by the rpc round-trip. `refresh` is now `useCallback`-stable. The dock's own render rate fell from ~108,882 renders between value changes to 9. The capability panel mounting is what exposed this; the loop predates the docks entirely.

## Alternatives considered

**Keep rendering the bare `conversation` anchor and have the shell register occupants into it directly.** Rejected: the docks' verbs (goal edit/pause, todo collapse) bind ui-goal/ui-conversation's injected faces; re-registering them from the shell would fork that wiring and diverge from the desktop dock contract.

**Drive the client sessions list by polling instead of the one-shot feed.** Rejected: the shell header already polls `session.list` on a 20 s cadence for its own menu; duplicating that into the bridge would double the rpc traffic for state the bridge only needs once per selection.

**Leave the render storm for a dedicated perf batch.** Rejected: at 2–4k renders/s the mounted docks re-rendered uselessly between every projection frame, muddying every render-count measurement this investigation relied on; the one-line `useCallback` fix was cheaper than measuring around it.

## Verification

Real-device probes (`~/obh-test/todo-probe.mjs`, `goalbar-final.mjs`): mock-driven `todo_write` → `[todo-panel count] 1` + `PASS TodoDock rendered`; mock `create_goal` → `[goal-bar count] 1` + `PASS GoalBar rendered with goal`, with the capability body carrying the objective text. Measurement trap worth keeping: the engine's `todos` fold clears at the NEXT `turn/start` (turn/end keeps the finished checklist), so a probe that resends before sampling reads an empty dock by design — sample inside the live turn window.

## Consequences

The dock family (goal bar, todo strip) renders from live projections end to end. Remaining known noise: every mux frame is delivered twice (the port dispatch tap and the stream iterator both hand it over) — idempotent for stores by seq, but worth collapsing; `AgentPresetSeatController`'s inactive-context rejection still fires during boot and remains open. The unit-suite failures in corner-shape pairing, tool-catalog drift, and typert catalog coverage reproduce on a clean tree and belong to the catalog debt, not this change.
