# Agent Note: stale provider route self-heal — boot validates the persisted route against the adapter universe

Status: implemented

English | [中文](2026-09-12-stale-provider-route-self-heal.zh.md)

## Problem

The engine composes its `main` agent with the persisted `provider` from engine settings. `syncCustomProviders` keeps the adapter registry in sync with the DECLARED custom profiles — when a profile is deleted, its adapter is withdrawn. If the stored route still names that deleted profile, every model request fails with `no adapter registered for provider "…"` (NO_ADAPTER) across all restarts, and the only recovery is a manual model switch in the panel. Real-machine trigger: a restart after the route's custom profile was removed left the extension dead-on-arrival ("ds-gw" route, adapter gone).

## Decision

- `resolveActiveProvider(persisted, presetIds, declaredRoutes)` in `settings-store.ts` validates the persisted route against the adapter universe — preset ids plus declared custom routes — BEFORE the engine composes. A route outside that set falls back to `DEFAULT_PROVIDER` (`deepseek`) with `corrected: true`.
- The offscreen boot calls it before `compositionRows`, persists the correction via `writeEngineSettings`, and logs a loud warning naming the dropped route. A stale pointer therefore self-heals across one restart instead of stranding every turn.

## Alternatives considered

- **Post-composition rebind of the running agent's route**: rejected for now — the agent route is frozen into the request header replay for resumed sessions, and rebinding needs the selection-ref mechanism the bridge installs per agent; the boot-time guard prevents the state instead, with the panel switch remaining the manual recovery.
- **Fall back to the first registered adapter at request time (LLM service)**: rejected — silently rerouting inside the request path hides a config/store mismatch the boot guard surfaces with a named warning, and a request-path fallback would mask future registration bugs.

## Consequences

- Deleting a custom profile whose route is active no longer bricks the engine: the next restart composes with the stock provider and persists the correction; the panel shows the stock model instead of failing every turn.
- The correction is one-way per boot (stale route → stock default); the user's preferred provider must be re-picked once if its profile was the deleted one — the warning names the dropped route so the cause is visible.
- Covered by `resolveActiveProvider` table tests in `settings-profiles.spec.ts` (preset/custom keep, deleted-route heal, absent/blank passthrough).
