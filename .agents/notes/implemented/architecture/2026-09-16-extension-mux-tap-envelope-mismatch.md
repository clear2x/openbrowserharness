# Agent Note: Extension approval cards — the mux tap envelope mismatch

Status: implemented

English | [中文](2026-09-16-extension-mux-tap-envelope-mismatch.zh.md)

## Problem

The user reported approval cards never render in the SidePanel under the `变更确认` permission mode, and the panel DevTools showed a wall of errors. Real-machine reproduction (off/on deploy, AX-driven composer injection) showed `tabs_open`/`page_navigate` approvals either settling `'cancelled'` within seconds or parking forever with no card, while chat over the same Port worked.

## Decision

`PortApiClient.handleMessage` handed the RAW mux wire frame (`{ type: 'approval/requested', … }`) to `onMuxEnvelope`, but the `InteractionStore.handleMuxEnvelope` tap reads `envelope.payload.type` — the `{ rpcId, payload }` contract envelope shape that `tapStream` yields. Every mux delivery therefore threw `TypeError: Cannot read properties of undefined (reading 'type')` inside the Port listener, which:

1. killed the store update (no approval/question cards, ever), and 2. aborted `handleMessage` before the stream-queue fan-out, so every runtime mux consumer starved too — the resulting churn restarted Port generations, and each "last port disconnected" fired the api bridge's fail-closed `cancelInteractions()`, cancelling parked approvals mid-wait.

The interaction-cards unit tests feed the store pre-built envelopes and never exercise the Port tap, so the seam mismatch was invisible to the suite.

## Fixes

1. **Tap envelope repair** (`port-api-client.ts`): the mux tap now parses the wire frame against `muxFrameSchema` and delivers `{ rpcId: fresh client id, payload }` — the same envelope the stream generator yields; malformed frames are dropped loudly. 2. **Disconnect grace** (`api-bridge.ts`): the last-port-disconnect sweep arms a 15 s timer instead of cancelling immediately; a reconnecting panel disarms it. Pending waits survive transient port churn and panel reloads. 3. **Frame re-announce** (`chrome-ask-bridge.ts`): parked approval/question waits re-broadcast their request frame every 5 s (cleared on every settle path), so a panel that connects mid-wait still receives the card; the interaction store's idempotent upsert makes repeats safe. 4. **Field-triage ring** (`chrome-ask-bridge.ts`, `chrome-tool-gate.ts`): park/abort/cancel-hook/gate-outcome entries land in a `chrome.storage.local` ring (`dsh-askbridge-diag`, best-effort) plus `console.warn`, giving cancel-cause evidence on real hardware without DevTools.

## Verification

- 6 ask-bridge cases (round-trip, re-announce + settle-stop, reconnect-within- grace survival, grace-expiry fail-closed) and the new tap-envelope boot case; 316 extension tests green; both tsc faces clean. - Real machine (Edge, off/on deploy): approval card renders, 允许一次 AXPress resolves the wait, the gated tool executes, the turn continues to completion.

## Residuals

- Cold v0 sessions containing `permission/mode` refuse historical migration by design (the alpha historical-event decision owns the bounded refusal); the session list degrades them to header facts, fail-soft, every boot. - Chain B streams: resolved in [the Remote-stream parking note](2026-09-16-extension-remote-stream-parking.md) — the connection module now implements `rpc.open`, so the WebSocket fallback never dials and the retry loop is gone.

## Alternatives considered

**Suppress the WebSocket dial or retry loop only.** Rejected: the retry storm was a symptom; the envelope mismatch would still have kept every card from rendering.

**Make the interaction store accept raw wire frames.** Rejected: the store's envelope contract (echo the per-delivery rpcId, read `payload`) matches the `tapStream` generator's yields — loosening it would fork the frame shape between the two producers.

**Rely on the fail-closed cancel as-is.** Rejected: a panel reload (the documented workaround for a stuck card) would keep cancelling the very approvals the user needed to answer.

## Consequences

Approval and question cards render on the real panel, survive port churn within the grace window, and re-deliver after a mid-wait reconnect; the cancel-hook sweep still fails closed when no panel returns. The storage diag ring adds a small write per park/cancel — best-effort, and a field-triage surface that has already paid for itself (it separated "frames broadcast, no card" from "wait cancelled").
