# Snapshot corpus debt — failure classification (2026-09-28)

Scope: the 85 replay failures in `pnpm run test:snapshot` at HEAD
(6ba0e90fdf + skill-write strand), after a full `test:snapshot:record`
pass. Classification per failure mode, with the root-cause read for the
largest class.

## Class A — request-header pinning failure (majority, ~38+)

Assert: `request/header #1 diverged from the pinned <scenario> header`.
Field-level diff (acp/escalation-approved): the recorded fixture's header
carries `config.maxTokens: 256000`, `config.reasoningEffort: "max"`, and
`adapterDefaults: { reasoningEffort: true, maxTokens: true }`; the replayed
second request carries none of them (model/provider only).

Read: **not stale expectations**. The replay re-drives the engine over the
recorded fixture, and the engine's *continuation request* (after approval /
resume) genuinely omits the first request's maxTokens/reasoningEffort and
adapter-defaults flags. Re-recording cannot fix this class — the new
recording itself contains the intra-session inconsistency. Suspected root
cause: the approval/resume continuation path rebuilds the LLM request from a
route re-resolution that no longer carries the effort/maxTokens the original
turn used (timeline hint: the 0.84 pi-ai migration and the reasoning-effort
wire work both touched this area). Needs an engine-side fix first
(continuation must preserve the turn's adapter surface), then re-record.

## Class B — system-prompt drift (handful)

Assert: `system prompt #N diverged from <scenario>/system-prompt.expected.md`.
The prompt text differs (model-config strand's system-prompt changes).
Re-recordable once Class A's engine fix lands — the record pass already
updates these files, and their diffs are prompt-copy only.

## Class C — SDK session-array mismatches (several)

Assert: `sessions: expected [ Array(1) ] to deeply equal [ Array(1) ]`
(bash-tool, persistent-tools, ptc-turn, subagent-*). Underlying diff not yet
field-expanded; likely a mix of Class A header drift inside the session logs
and prompt drift. Classify per-case after Class A is fixed.

## Why the earlier partial re-record was reverted

`user_skill_write` (skill strand) added a tool schema, which alone turns
every pinned request header red — that class is a normal record-and-review.
The reverted partial record mixed that legitimate class with Class A's
engine inconsistency; committing it half-green would have baked the
inconsistency into pinned baselines. The skill-schema class is exactly what
the current record pass already fixed.

## Order of operations

1. Engine: make the approval/resume continuation request carry the same
   adapter surface (maxTokens, reasoningEffort, adapterDefaults) as the
   original request — verify with a single-scenario replay.
2. `test:snapshot:record` full pass; review diffs: expect Class A gone,
   B/C to be copy-level changes.
3. Commit the corpus update with the engine fix in one PR.
