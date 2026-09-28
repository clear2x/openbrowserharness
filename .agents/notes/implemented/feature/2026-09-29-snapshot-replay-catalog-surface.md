# Agent Note: snapshot corpus Class A was a replay-catalog under-declaration, not an engine continuation bug

Status: implemented

English | [中文](2026-09-29-snapshot-replay-catalog-surface.zh.md)

## Problem

`test:snapshot` carried 85–88 red failures whose dominant class asserted
`request/header #1 diverged from the pinned … header` — the pinned header
carrying `config.maxTokens`/`config.reasoningEffort` and
`adapterDefaults: { reasoningEffort: true, maxTokens: true }`, the replayed
header carrying provider/model only. The working hypothesis (see the
[2026-09-28 classification](../../../.agents/reports/snapshot-corpus-classification-2026-09-28.md))
blamed the approval/resume continuation path for losing the first request's
adapter surface and gated the corpus re-record on an engine fix.

## Diagnosis — the hypothesis was wrong about the mechanism

Single-scenario replay instrumentation in `prepareRequest` never printed the
`NO_ADAPTER` fallback, and the `cancel` scenario's own recording turned out
to carry a bare header while its class pin (from `escalation-approved`)
carried the full surface. The real split: **every** `llm-replay` fixture
catalog declared bare model ids, so `ReplayAdapter.resolveModel` produced no
`defaultMaxTokens` and no reasoning efforts, `resolveCallWithInfo` filled
nothing, and every replayed header — initial or continuation — lost the
surface. The escalation trio passed their header pins only because their
stdout comparison failed first and aborted before the header assertions ran.

The replay fixture vocabulary already supported this
(`ReplayModelConfig.defaultMaxTokens`, `reasoningEfforts`,
`defaultReasoningEffort` — documented as "replay reconstructs the request
header a live catalog produced"); the 44 `cordis.snapshot.yml` files simply
never declared it.

## Fix

All replay catalogs now declare the surface the live deepseek catalog
resolves (`defaultMaxTokens: 256000`,
`reasoningEfforts: [off, low, high, max]`, `defaultReasoningEffort: max` on
each `deepseek-v4-*` model), followed by the corpus convergence loop:
`test:snapshot:refresh` (script scenarios) → `test:snapshot:record` (live
scenarios) → replay verification. Result: **19 red | 112 green**, with the
residue re-classified in the
[2026-09-29 report](../../../.agents/reports/snapshot-corpus-classification-2026-09-29.md):
18 failures are the explicit-effort flag class (a suite pin-policy decision,
not refreshable) and 1 is a session-array field drift.

## Alternatives considered

**Engine change making the continuation preserve the first request's
explicit surface.** Rejected: the first request never carried explicit
values — the adapter defaults produced them, and the flag protocol exists
precisely so replay can reconstruct that. There is no engine defect here.

**Per-scenario catalog surfaces matched to each class pin (bare where the
pin is bare).** Rejected: it would freeze the stale bare recordings in as
the expected state. The full surface is what the live adapter resolves, and
the record/refresh passes bring every fixture to it.

## Consequences

Keyless replay now reconstructs request headers a live catalog produces, so
future adapter-surface changes need only the catalog files, and assertion
ordering no longer masks header pins behind stdout mismatches in the
escalation trio. Two operational facts worth keeping: record mode aborts at
its first assertion failure after writing fixtures but before refreshing
workspace/writer oracles (convergence needs record → refresh → replay), and
model-authored workspace expectations (`.expected/` text files) are
inherently trailing-newline-nondeterministic — four were realigned this
pass.
