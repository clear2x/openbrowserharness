# Agent Note: Composer send seam collapsed to one argument after the session-id misalignment

Status: implemented

English | [中文](2026-08-30-composer-send-actions-argument-misalignment.zh.md)

## Problem

Every message sent from the extension composer reached the model as the bare session id. Three consecutive real-device sends — a mention fallback, a subagent task, a plain echo test — all produced model replies like "I received only a session ID", while the composer textarea visibly held the real text. The durable transcript confirmed it: the `user/message` bubbles themselves contained `session-<uuid>` strings.

The mechanism was an argument misalignment introduced with the send router. `SendActions` declared `prompt(sessionId: string, text: string): void`, and `dispatchSendLine` called `actions.prompt(sessionId, line)` — but the shell's implementation was `const promptSend = (text: string): void => ...`, a single-parameter function. TypeScript accepts a fewer-parameter function at that assignment (parameter bivariance for callbacks), so the mismatch compiled silently; at runtime the implementation read its one parameter, which the router had filled with the session id, and sent it as the message body. Every fallback path (`//` escape, unknown command, unresolved mention, refused subagent delivery) funneled through the same seam, so every composer send was affected — the visible textarea and the actual payload had nothing to do with each other.

## Decision

The seam collapsed to one argument: `prompt(line: string): void`. The router already owns the session — `dispatchSendLine(sessionId, line, actions)` received it and uses it for `subagent.prompt` and `commands/execute` payloads — so re-passing it to the prompt action was redundant information, and the redundancy is exactly what made the misalignment expressible. With one parameter there is no position to misread; the implementation keeps its original `(text: string)` signature and the two now agree by construction.

The interface comment records the incident so the next widen-to-two-arguments proposal carries the cost with it.

## Alternatives considered

- **Fixing the implementation's signature instead (`(sessionId, text)`).** This is what was shipped first, and it works, but it leaves the hazard in place: the next single-parameter implementer reintroduces the same silent misalignment, and TypeScript still cannot catch it. Narrowing the interface removes the second argument rather than documenting it.
- **A runtime assertion that `text !== sessionId`.** A hostile-input guard against a value the static interface now makes unrepresentable; the codebase reserves runtime validation for real boundaries, not same-process call seams.

## Consequences

Composer sends carry the typed body verbatim to `session.prompt`, and the four router fallbacks (escape, unknown command, stray mention, refused delivery) all inherit the corrected seam because they share the one action. The subclass of bugs — callback seams whose implementation reads fewer parameters than the router supplies — is the reason the fix lands on the interface instead of the implementation; any future seam that genuinely needs the session id should take it as a distinct named parameter on every implementation, not as a positional extra.

`/export` (`exportLog(sessionId)`) was audited in the same pass: its implementation's single parameter is the session, matching a single-argument call, so it was never misaligned.

## Testing

`apps/extension/tests/composer-bar.spec.ts` pins the router contract single-argument: the `//` escape, `/export json` fallback, unknown-command fallback, stray-mention fallback, refused-subagent fallback, and the silent plain-text cases all assert `prompt` called with the line alone. The misalignment itself compiled green because the shell is not jsdom-mounted in any spec — the router tests mock `SendActions`, so the seam's implementations agree only by signature review; the interface now makes the correct signature the only expressible one.
