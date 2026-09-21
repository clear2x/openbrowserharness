# Agent Note: a model pick on the fresh-session start is the next session's default, not an error

Status: implemented

English | [中文](2026-09-21-selectmodel-unmaterialized-default.zh.md)

## Problem

Moving the panel to a fresh-session start left one hole: switching the model there failed with `会话 session-new 不存在`. `session.selectModel` unconditionally ensured the agent, and ensuring a not-yet-materialized session is a not-found refusal. The failure was user-visible on the exact action the composer's most prominent chip drives, and it also broke the boot-time refused-effort self-heal (which re-sends selectModel for the active session).

## Decision

`session.selectModel` now ensures the agent only when the session exists — live in the registry or persisted (`sessionPersistence.stat`). For a not-yet-materialized session the route pick still persists through `writeEngineSettings`/`writeDefaultReasoningEffort` and returns `{selected}`: the host default IS what the next created session inherits (`ensureSelection` falls back to `engineDefaultSelection`, and the composer's boot pairing reads the same persisted current), so the pick takes effect at creation time without minting a session row for a user who never sends. Per-session selection continues to apply the moment the session materializes.

## Alternatives considered

- **Mint the session on model pick.** Rejected: it re-creates the clutter the fresh-session start removed — a user who only switches models would accumulate empty rows.
- **Teach the bridge the panel's sentinel id.** Rejected: the semantics are right for ANY not-yet-materialized id, not just the sentinel; keying on existence keeps the bridge ignorant of panel state.

## Consequences

- Switching the model (and effort posture) on the fresh-session start works: no error, pick persisted as the host default, no session row minted.
- The boot refused-effort self-heal on the sentinel persists the cleared posture instead of refusing.
- Coverage: an api-bridge spec asserts the pick on an unknown id returns ok, mints no agent, and lands in the persisted engine settings; the real-device harness switches the model on the fresh start (no error card, persisted default updated), sends, and verifies the logged request/header events carry the picked model.
