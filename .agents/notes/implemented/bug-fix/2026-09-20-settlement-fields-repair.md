# Agent Note: pre-v2 assistant settlements bricked resume — repaired in place at write open

Status: implemented

English | [中文](2026-09-20-settlement-fields-repair.zh.md)

## Problem

Once the isSeeded header heal landed, the next legacy layer surfaced on the user's real profile: sending any message failed with `seed assistant/message at index 67 has invalid settlement fields`. Format v2 embedded the assistant stream in every settlement, and the seed validator demands non-negative safe-integer `turn`/`step` plus an array `stream`; builds from the deployment's first weeks wrote settlements without `stream`. Event adoption (`adoptSessionEvent` inside `validateStoredEvents`) validates the message body but never the settlement fields, so such a log sails through the storage contract and only the resume seed validation refuses it — the panel renders history fine and then every send dies at `ensureAgent`. Marking the event `ignorable` is not an option: the seed loop validates every event and requires contiguous seqs, so the payload must actually be valid.

## Decision

`@deepseek-ai/dsh-session` now exports `assistantSettlementFieldsValid` — the exact predicate the seed validator enforces — and the IndexedDB repair shares it instead of restating the contract. The repair pass (`repairLegacyUnknownArtifact`) normalizes known-type settlements in place: each invalid `turn`/`step` carries forward from the previous settlement (keeping the lifecycle sequence plausible), a non-array `stream` becomes the empty record, and every other data member rides untouched. The (b) write-open trigger fires on the settlement scan as well as unhealthy headers and foreign types, so a current-format generation with era settlements repairs on the first resume; adoption still refuses any message-body shape normalization cannot repair honestly, and that failure quarantines the generation through the existing catch. The original rows always archive verbatim, and a repaired generation passes the trigger on later opens (no re-repair).

## Alternatives considered

- **Mark the invalid event `ignorable`.** Rejected: the seed loop validates every seed event and requires contiguity, so the flag changes nothing for a known type with a bad payload.
- **Truncate the log at the first invalid event.** Rejected: the invalid settlement sits mid-log in a live session — truncation would discard every newer, valid event with it.
- **Re-run the full migration chain on the current generation.** Rejected: the chain owns adjacent-version movement; payload normalization for this deployment's own era drift belongs in the armed repair, like the header and foreign-type rescues before it.

## Consequences

- A resume no longer dies on era settlements: the first send repairs the generation in place (archive keeps the originals) and the turn proceeds.
- The settlement contract has one definition, shared by the seed validator and the repair.
- Coverage: the exported predicate is unit-tested against the seed validator's refusal matrix; the IndexedDB suite drives a 68-event current-format log with a pre-v2 settlement through write open — normalized settlements, verbatim archive, idempotent reopen — and the real-device reproduction harness seeds exactly that log, sends the user's message, and watches the turn complete with no error.
