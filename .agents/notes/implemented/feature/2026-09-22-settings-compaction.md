# Agent Note: settings surface compaction + the describe wire the permission section needed

Status: implemented

English | [中文](2026-09-22-settings-compaction.zh.md)

## Problem

The settings surface rendered desktop-scale inside the 420 px SidePanel, and the rhythm jumped between extremes: the appearance theme cubes (figma 276×82, `flex: 1 1 180px` with wrap) stacked into three huge cards filling half the panel while the adjacent 字号大小 input stayed tiny — and the 权限 section showed its raw refusal text (`此方法在扩展宿主中不可用：settings/describe`) with a dead 不可用 dropdown. The refusal was the same vocabulary gap as the agentPresets one: the settings UI drives documents through slash-style remote names, and only the dot-style handlers existed.

## Decision

Two levers. The bridge registers slash-style aliases over the settings document handlers — `settings/describe`, `settings/update`, `settings/replace`, `settings/mutate`, `settings/openSettingsDocument` — so the permission section (and any future document reader) resolves the real descriptor instead of an unavailability refusal. The shell adds a SidePanel-width compaction block, targeting the theme package's own stable class stems by attribute (`[class*="cubeRow"]`, `[class*="themeCube"]`): cubes collapse to one equal-width row with small padding and 12 px type. Attribute stems survive the css-module hash; the shell-side guard that forbids `[class*="overlay"/"panel"]` forks of the settings sheet chrome stays satisfied (those sheet-level styles belong to ui-settings-general itself).

## Alternatives considered

- **Patch ui-theme's AppearanceRow.module.css directly.** Rejected: desktop layouts rely on the wrap-at-180px cube row; forking the shared stylesheet changes every host. The override lives with the host that has the narrow constraint.
- **Hide the permission section.** Rejected: the describe alias makes the real control render; hiding working settings would be a regression of a different kind.

## Consequences

- The 通用设置 tab reads as one consistent rhythm: compact theme row, evenly sized selects and inputs, no error cards.
- The permission-presets section now receives the real descriptor; its mode control renders from live settings data.
- Coverage: the existing caps-css guard (no `[class*="overlay"/"panel"]` in SHELL_CSS) plus the full extension suite, typecheck, and lint stay green; the device screenshot loop captures all four settings tabs at SidePanel width for visual confirmation.
