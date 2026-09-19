# Agent Note: Reasoning-effort selection — model-gated menu, explicit clear, persisted posture

Status: implemented

English | [中文](2026-09-19-reasoning-effort-selection.zh.md)

## Problem

Making the effort control always-visible (the previous dropdown pass) exposed three traps that together read as "思考强度切换不了". On a catalogued model whose wire row carries no reasoning metadata, every level click was silently swallowed — the chip rendered, the click did nothing, no error appeared. The fixed 关/低/中/高 menu offered levels the current model refuses (DeepSeek declares off/low/high/max, no medium), so one wrong pick made every later request fail with `UNSUPPORTED_REASONING_EFFORT`. And the picked effort lived only in an in-memory per-agent map while the persisted engine settings carried just provider/model, so a service-worker restart reset the posture to model-default; the optimistic UI swallowed the RPC failure with an empty catch.

## Decision

The current model's wire row now shapes the whole control. The menu offers exactly the model's declared `reasoning.efforts` (unmapped values render raw; 默认/follow-the-model leads the menu); a catalogued model without reasoning metadata disables the chip (思考：不支持) instead of hosting dead clicks; an uncatalogued model keeps the historic fixed set. The wire call always carries `reasoningEffort` — a value selects, `''` explicitly clears — and the bridge persists the posture engine-wide next to the model route (settings store, top level), restoring it in every fallback selection that has neither a picked value nor a logged request header. A boot self-heal clears a persisted level the target model refuses, reading the catalog from the same `session.models` response instead of the stale mount-time prop. A failed or refused switch rolls the optimistic state back and surfaces the reason in an alert row.

## Alternatives considered

- **Hide the control on unsupported models** (the pre-dropdown behavior). Rejected: the posture is a per-call user control, and hiding it read as a broken feature — the disabled state keeps it visible while stating why it cannot act.
- **Clear by sending no effort field.** Rejected: a stale caller omitting the field must not erase the posture; only an explicit `''` clears.
- **Persist the effort per session.** Rejected: the provider/model route already persists engine-wide, and a posture that silently differs across sessions would surprise; the per-request log header still carries per-session reality once a request runs.

## Consequences

- The runtime's `UNSUPPORTED_REASONING_EFFORT` refusal is no longer reachable from the panel: the menu only offers declared levels and a model switch carries a level only when the target declares it.
- Subagent sessions inherit the engine-wide posture through the same fallback selection; a per-session override still lands via the log header.
- Coverage: the composer spec pins the disabled state, the efforts-derived menu, the explicit-clear wire shape, the rollback-plus-alert path, and the boot self-heal; the bridge spec pins persistence, clearing, and the fallback selection carrying the posture.
