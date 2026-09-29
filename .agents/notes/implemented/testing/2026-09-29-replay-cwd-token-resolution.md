# Agent Note: Replay resolves the cwd token in tool arguments

Status: implemented

English | [中文](2026-09-29-replay-cwd-token-resolution.zh.md)

## Problem

A replay fixture stores `{{cwd}}` as a portable token for the scenario working directory. The header path already resolved it — `normalizeProjectedHeader` rewrites the header cwd into the `/dsh-snapshot-cwd` virtual path — but token occurrences inside tool arguments did not. A `write` tool call replayed with the literal argument `{{cwd}}/escalated.md`, and the filesystem resolve then treated the unresolved token as a relative segment, producing the double-prefixed display path `<snap-cwd>/{{cwd}}/escalated.md`. The `fs-escalation` scenario's recorded `<path>` lines therefore diverged between live recordings and replays, and every fixture that touched a file through a tool argument could not replay to the recorded state. The same gap sat inside bash commands (`mkdir -p {{cwd}} && printf … > {{cwd}}/note.txt`), so a replayed bash scenario wrote its files into a literal `{{cwd}}` directory.

## Decision

`packages/test-support/llm-replay` resolves the token at the entry level: a new `resolveCwdToken` step replaces every `{{cwd}}` occurrence in string leaves of a materialized `ReplayEntry` with `process.cwd()` before the entry reaches the scripted-entry resolution. Fixtures keep the token form — it is the portable representation shared with live captures — and resolution stays a runtime concern of the replay layer, next to the existing `{{session:<id>}}` materialization.

Two corpus alignments rode along with the fix:

- `ReplayAdapter.resolveModel` derives effort names and descriptions from a `REASONING_EFFORT_META` table instead of echoing bare ids, matching the live DeepSeek provider surface. The `fs-escalation` config options then agree between a live recording (named efforts) and a replay.
- The `escalation-approved` ACP catalog mirrors the live `deepseek-v4-flash-vision-exp` entry, so the recorded three-model catalog list replays verbatim.

The `persistent-tools` workspace expectation had drifted from its fixture during the bash/pwsh guidance port: the fixture's `str_replace` step replaces one line of a three-line file, so the final workspace is `alpha / replaced line / omega`, and the stale single-line `workspace.expected/note.txt` is realigned to that scripted result.

## Alternatives considered

**Absolute paths inside fixtures.** Rejected: fixtures would stop being portable across checkouts and live captures would no longer share the token representation.

**Resolving the token in the header projection layer.** Rejected: that layer owns the header cwd rewrite; tool arguments are consumed by tool implementations, and the replay layer is the only place that sees a fixture entry whole.

**Synthesizing a usage chunk in the assistant replay branch.** Tried and reverted: `expandAssistantStream` already expands the recorded stream's usage chunk, so a second insertion duplicated usage on every replay and broke 47 llm-replay cases.

## Consequences

Every string leaf of a replay entry now resolves `{{cwd}}`, so a fixture cannot express a literal `{{cwd}}` in tool arguments or file content; no current scenario needs that, and a future one would need an escape token first. `pnpm run test:snapshot` runs 131 cases green, from 17 failures at the start of the batch.
