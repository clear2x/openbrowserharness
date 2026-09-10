# Agent Note: Sandbox postMessage must target the opaque origin with '*'

Status: implemented

English | [中文](2026-08-29-sandbox-postmessage-opaque-target-origin.zh.md)

## Problem

`user_plugin_write` and `user_plugin_toggle` reported `沙箱运行响应超时（45000ms）` on essentially every call, yet the plugin was in fact written and (for toggle) activated — `user_plugin_list` confirmed the record each time. The long-standing "timeout ≠ failure" reading treated the 45s window as a cold-start budget and was widened twice (15s → 45s) without touching the failure.

The mechanism: host→sandbox direction postMessages (`run`, `emit`, `unload`) addressed the iframe window with the **extension origin** as `targetOrigin`. A page declared under `manifest.sandbox.pages` runs at an **opaque ("null") origin**, and per the HTML specification a concrete origin can never match an opaque target — the user agent silently drops the message. The outbound code even sat beside an inbound comment stating "Sandboxed frames report an opaque origin"; the inbound direction (`ready`, run replies) used `parentTarget()` (ancestor origins, else `'*'`) and therefore always delivered, which is why the 10s ready handshake kept succeeding while every run burned the full 45s.

"Timeout ≠ failure" had a structural reason too: `write`/`toggle` persist the plugin record *before* activating it in the sandbox, so the durable half of the operation completed while only the activation half hung. The user-visible result was an error naming a timeout beside a list that showed the plugin present.

## Decision

Every host→sandbox post targets `'*'` (`SANDBOX_TARGET_ORIGIN`), with a comment stating the opaque-origin constraint at the constant. Sender identity never relied on `targetOrigin`: both directions verify `event.source` against the retained frame reference strictly, so `'*'` widens who may *attempt* to post the frame, not who is believed.

Two adjacent defects fixed in the same change:

- **A rejected `readyPromise` was cached forever.** A handshake timeout poisoned every later operation with the stale rejection, contradicting `start()`'s own comment that the first plugin operation retries. The timeout path now clears the cached promise and waiter, removes the dead frame, and the next `ensureReady()` rebuilds.
- The 45s `RUN_TIMEOUT_MS` is retained with its stuck-pipe-guard comment: it is a hang detector, not a performance budget.

`sandbox/main.ts` and `user-plugin-tools.ts` needed no change — the reply direction already delivered.

## Alternatives considered

- **Dropping the `manifest.sandbox.pages` sandbox so both sides share the extension origin.** Rejected: the sandbox is the isolation boundary that lets untrusted user-plugin code be evaluated at all; removing it to fix a messaging detail trades a correctness fix for the extension's security posture.
- **Keeping a concrete `targetOrigin` and discovering the sandbox's real origin at runtime.** There is none to discover — the whole point of an opaque origin is that it is not addressable. `iframe.contentWindow.origin` inside a sandboxed frame reports `"null"`; there is nothing to compare against.
- **Raising `RUN_TIMEOUT_MS` further.** Twice-done already (15s → 45s); the persistence-before-activation ordering means success was invisible under any budget. The timeout is a hang guard and stays one.

## Consequences

Writes and toggles return promptly with their real outcome: success is fast, and a genuinely failed activation now surfaces as an error that means failure rather than a timeout beside a success. The `'*'` target means any document could post *at* the sandbox window, but the sandbox's inbound handlers and the host's reply handlers both match `event.source` against the retained frame, so forged postings are ignored rather than trusted.

A handshake failure is recoverable: the dead frame is torn down and the next operation rebuilds one, where previously the first timeout poisoned the host until reload.

## Testing

`apps/extension/tests/user-plugins.spec.ts` pins the mechanism red-green: run requests go out with `'*'`; replies match by id (boot mount, two concurrent runs, out-of-order replies, unknown id ignored); the 45s guard reports precisely and ignores a late reply; a handshake timeout is recoverable on the next operation; emit/unload share the `'*'` target.
