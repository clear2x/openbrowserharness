# Agent Note: the settings surface's Agent 预设 tab spoke desktop wire names the bridge never answered

Status: implemented

English | [中文](2026-09-21-agentpresets-desktop-aliases.zh.md)

## Problem

The settings surface's Agent 预设 management tab failed on every open with `此方法在扩展宿主中不可用：agentPresets/list`, while the composer's preset chip listed the identical roster correctly. The two surfaces speak different wire vocabularies: the composer's panel code calls the bridge's dot-style methods (`agentPreset.list` …), but the dsh settings UI (shared with the desktop) drives the plural slash-style remote names (`agentPresets/list`, `agentPresets/read`, `agentPresets/select`, `agentPresets/copy`, `agentPresets/deletePreset`) with the desktop payload keys — and two adjacent settings calls (`settings/canOpenAgentPresetDirectory`, `settings/openAgentPresetDirectory`) were equally unimplemented. Everything the tab needs already existed server-side; only the names differed.

## Decision

The bridge registers slash-style aliases right after the handler table: `list`/`read`/`select` forward verbatim; `copy` and `deletePreset` remap the desktop's `id` payload key onto the composer's `agentPreset` key through one alias helper (fail-loud if the target ever disappears). The dot-style `agentPreset.list` view gains `modeSelectionEnabled: true` — the composer does expose preset selection for new/blank sessions, the same fact the settings mode toggle gates on. The roster view already carried the full `AgentPresetRow` shape (`id`/`trust`/`isDefault`/`name`/`description`/`broken`), and the settings page's default-preset write (`settings.update` on the `agent-presets` namespace) already round-trips into `storedDefaultPresetId`, so the default picker works end to end with no further bridge work. `settings/canOpenAgentPresetDirectory` answers `false` (no native filesystem — the reveal affordance stays hidden) and `settings/openAgentPresetDirectory` forwards to the existing reveal-path handler.

## Alternatives considered

- **Rename the composer's methods to the desktop names.** Rejected: the panel code, its specs, and the seat/label stores all key on the dot-style names; renaming trades one churn for a larger one and risks the reverse breakage.
- **Implement the slash methods with duplicated roster logic.** Rejected: two copies of the roster assembly drift silently; aliases keep one implementation with payload-key adapters only.

## Consequences

- The settings Agent 预设 tab loads the real roster (shipped rows, 默认, user copies), supports copy/delete through the desktop names, and its default-preset write round-trips into new-session composition.
- Coverage: the full extension suite, typecheck, and lint stay green, and the real-device harness opens the settings surface, switches to the Agent 预设 tab, and asserts the roster renders (网页研究员/购物比价员/页面调试手/默认) with no unavailability refusal.
