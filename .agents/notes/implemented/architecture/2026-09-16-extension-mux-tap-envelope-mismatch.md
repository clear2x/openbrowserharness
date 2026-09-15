# 2026-09-16 — Extension approval cards: the mux tap envelope mismatch

## Context

The user reported approval cards never render in the SidePanel under the
`变更确认` permission mode, and the panel DevTools showed a wall of errors.
Real-machine reproduction (off/on deploy, AX-driven composer injection) showed
`tabs_open`/`page_navigate` approvals either settling `'cancelled'` within
seconds or parking forever with no card, while chat over the same Port worked.

## Root cause

`PortApiClient.handleMessage` handed the RAW mux wire frame
(`{ type: 'approval/requested', … }`) to `onMuxEnvelope`, but the
`InteractionStore.handleMuxEnvelope` tap reads `envelope.payload.type` — the
`{ rpcId, payload }` contract envelope shape that `tapStream` yields. Every
mux delivery therefore threw `TypeError: Cannot read properties of undefined
(reading 'type')` inside the Port listener, which:

1. killed the store update (no approval/question cards, ever), and
2. aborted `handleMessage` before the stream-queue fan-out, so every runtime
   mux consumer starved too — the resulting churn restarted Port generations,
   and each "last port disconnected" fired the api bridge's fail-closed
   `cancelInteractions()`, cancelling parked approvals mid-wait.

The interaction-cards unit tests feed the store pre-built envelopes and never
exercise the Port tap, so the seam mismatch was invisible to the suite.

## Fixes (this batch)

1. **Tap envelope repair** (`port-api-client.ts`): the mux tap now parses the
   wire frame against `muxFrameSchema` and delivers
   `{ rpcId: fresh client id, payload }` — the same envelope the stream
   generator yields; malformed frames are dropped loudly.
2. **Disconnect grace** (`api-bridge.ts`): the last-port-disconnect sweep arms
   a 15 s timer instead of cancelling immediately; a reconnecting panel
   disarms it. Pending waits survive transient port churn and panel reloads.
3. **Frame re-announce** (`chrome-ask-bridge.ts`): parked approval/question
   waits re-broadcast their request frame every 5 s (cleared on every settle
   path), so a panel that connects mid-wait still receives the card; the
   interaction store's idempotent upsert makes repeats safe.
4. **Field-triage ring** (`chrome-ask-bridge.ts`, `chrome-tool-gate.ts`):
   park/abort/cancel-hook/gate-outcome entries land in a `chrome.storage.local`
   ring (`dsh-askbridge-diag`, best-effort) plus `console.warn`, giving
   cancel-cause evidence on real hardware without DevTools.

## Verification

- 6 ask-bridge cases (round-trip, re-announce + settle-stop, reconnect-within-
  grace survival, grace-expiry fail-closed) and the new tap-envelope boot case;
  316 extension tests green; both tsc faces clean.
- Real machine (Edge, off/on deploy): approval card renders, 允许一次 AXPress
  resolves the wait, the gated tool executes, the turn continues to completion.

## Residuals

- `session-main` refuses migration (`permission/mode` at seq 159602 unknown to
  the harness, `even when ignorable`): the extension's own event type is not
  registered in the session event map the migration path consults — the
  engine falls back to degraded reads for that session. Follow-up: register
  the extension events there or start a fresh session.
- Chain B (0.1.5 runtime `$events` over WS `remote.mux`) still fails by
  design in-extension; the panel runtime should stop attempting it (or the
  connection module should implement `rpc.open` in-process) to silence the
  retry loop.
