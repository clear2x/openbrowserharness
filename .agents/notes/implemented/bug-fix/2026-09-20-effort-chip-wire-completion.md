# Agent Note: the effort chip never worked on the extension — three broken links, verified at the wire

Status: implemented

English | [中文](2026-09-20-effort-chip-wire-completion.zh.md)

## Problem

Reasoning-effort switching, the batch-96 fix, never actually worked for a real user. Three links in the chain were broken at once, and each hid the next:

1. **No metadata.** The extension's Anthropic adapter returned no `reasoning` from `resolveModel`, and no preset model declared efforts — so on the zhipu-coding GLM route (the composer's reasoning-chip enablement keys on resolved reasoning metadata) the chip rendered permanently disabled. The batch-96 gate "no metadata → disabled chip" was faithfully implemented over data that never existed.
2. **Wire gap.** Even with metadata, the Anthropic adapter's request builder never wrote a `thinking` member — a picked level changed nothing on the wire for the whole anthropic-protocol route.
3. **Type mismatch.** The composer derived the effort menu by filtering the catalog row's `efforts` entries as STRINGS, but the wire view (ModelReasoningView) carries `{id, name}` objects — every derivation filtered to empty and fell back to the fixed four-level menu, so even models with real metadata showed levels they refuse. The same string filter sat in the boot self-heal and the model-switch carry, breaking both.

## Decision

Preset models gain an optional `reasoningEfforts` declaration (zhipu-coding's GLM models declare `['off', 'high']` — their thinking is binary). The Anthropic adapter surfaces declared levels through `resolveModel` — the same resolved path desktop adapters expose reasoning through — and maps the requested effort to wire `thinking` for models that declare it: `'off'` → `{type:'disabled'}`, any other level → `{type:'enabled'}`, no level requested → no member at all (the provider default stands). No budget rides the enabled form: the preset's provider accepts bare enabled thinking. The composer now unwraps effort ids from the wire objects through one shared helper at all three sites. An undeclared model stays effort-less even if a stale caller sends a level, so the loud-refusal contract is unchanged.

## Alternatives considered

- **Declare off/low/high/max for GLM.** Rejected: the provider's thinking is binary; advertising granular levels the wire cannot distinguish would be dishonest metadata.
- **Attach `budget_tokens` to the enabled form.** Rejected for now: the preset route accepts bare enabled thinking and unknown members inside `thinking` risk hard refusals; a real-Anthropic route with effort declarations would add budgets with its own declaration.
- **Fix only the composer string filter.** Rejected: it would have enabled the chip for nothing — the GLM route still lacked metadata and wire mapping, the actual user-visible break.

## Consequences

- The effort chip is live end to end on the GLM zhipu-coding route: enabled chip, per-model menu (默认/关/高 — no 低/中), and the picked level verifiable at the wire (thinking enabled/disabled captured on the tool-bearing request).
- Models with metadata on the openai route now derive their menus correctly too — DeepSeek's declared off/low/high/max no longer masks behind the fallback list.
- Coverage: adapter specs assert the thinking mapping (off/enabled/absent, undeclared model stays effort-less) and the resolved reasoning levels; composer specs drive the per-model menu from wire-shaped `{id, name}` rows; the real-device harness seeds the zhipu-coding route against an anthropic-wire mock, switches 高 then 关, captures both wire bodies, restarts the extension, and verifies the clean fresh open with the 关 posture restored.
