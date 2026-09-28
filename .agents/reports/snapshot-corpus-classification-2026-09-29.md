# Snapshot corpus debt — second classification (2026-09-29)

Scope: `pnpm run test:snapshot` at ff316afe97 + this batch's corpus update.
Supersedes the failure classes of [2026-09-28](snapshot-corpus-classification-2026-09-28.md):
that report's Class A read ("the continuation request loses the adapter
surface") was wrong about the mechanism — the divergence is not
continuation-specific at all.

## What the 09-28 Class A actually was

The replay provider catalogs under-declared the model surface. The live
deepseek adapter resolves `defaultMaxTokens` (256000) and the connection's
reasoning-effort default (`max`) for every call, so a recorded header carries
`config.maxTokens`/`config.reasoningEffort` plus
`adapterDefaults: { reasoningEffort: true, maxTokens: true }`. Every
`llm-replay` catalog declared bare model ids, so `ReplayAdapter.resolveModel`
returned no defaults, `resolveCallWithInfo` filled nothing, and **every
replayed request header — first or continuation — came out
provider/model-only**. The escalation trio's recordings (full surface) passed
their own pin by accident of assertion ordering: the stdout comparison failed
first and masked the header assertion.

The catalog already supported this (`ReplayModelConfig.defaultMaxTokens`,
`reasoningEfforts`, `defaultReasoningEffort` — "replay reconstructs the
request header a live catalog produced"); 44 fixture files just never
declared it. Fix: all `cordis.snapshot.yml` replay catalogs now declare the
surface the live catalog resolves, then `test:snapshot:refresh` (script
scenarios) and `test:snapshot:record` (live scenarios) regenerated the corpus
against the faithful replay.

## Result

85–88 red → **19 red | 112 green**.

## Remaining class D — explicit-effort requests cannot match a parent-derived pin (18)

Every remaining failure except one asserts the same field:
`adapterDefaults.reasoningEffort` present in the pin, absent in the replay,
with `config.reasoningEffort` explicitly carried. Mechanism: delegation and
workflow agents inherit the parent's reasoning effort EXPLICITLY since the
0.84-era effort wiring (model-selection waterfall adds
`selected.reasoningEffort` to the child request), so the request correctly
carries no adapter-default flag — while the class-pin policy
(`verifyHeaders` in both suites) requires every session's headers, child
sessions included, to equal the parent scenario's pin. The invariant
"child headers == parent pin" held only while children resolved effort from
the adapter default.

This is a test-support policy decision, not a fixture refresh: either the
suites grow per-session header pins (the `childToolSchemas`/
`childSystemPrompts` pattern extended to headers), or the class pin grows an
explicit-inheritance variant. Recording cannot fix it — a fresh recording of
a member scenario still fails its own class assertion.

## Remaining class E — persistent-tools session-array field drift (1)

`sessions: expected [ Array(1) ] to deeply equal [ Array(1) ]` — field-level
expansion still pending; classify after class D's policy lands.

## Fix-up notes from the passes

- Workspace `.expected/` files are model-output-dependent: three fs scenarios
  and acp fs-escalation-approved recorded a trailing newline this pass and
  their committed expectations were aligned to the recordings. These remain
  inherently model-nondeterministic; a future flake here is the same class.
- Record mode aborts at the first assertion failure AFTER writing fixtures
  but BEFORE refreshing workspace/writer oracles, so a red record pass leaves
  a mixed tree; the convergence loop is record → refresh → replay.
