# Agent Note: Edge debugger re-adopt — session-target id ownership probe

Status: implemented

English | [中文](2026-09-19-edge-debugger-ownership.zh.md)

## Problem

The chrome.debugger attach state lives in two places: the browser layer (survives everything short of the tab closing) and the service worker's in-memory `attachedTabs` set (lost on every MV3 SW idle-restart). The self-heal for that split — "another debugger" attach errors are adopted when `chrome.debugger.getTargets()` shows OUR extension as the holder — keyed on `target.extensionId`. On Edge, `getTargets()` omits `extensionId` on every entry, so the probe never recognized our own attach: the first tool call after an SW restart failed with 无法附加调试器：该标签页已被其他调试器占用, and every later tool on that tab kept failing until the tab closed. Real sessions masked it (the open panel keeps the SW alive), but any SW kill under memory pressure bricked all page tools for the rest of the session.

## Decision

Ownership now rides a recorded session-target id. After every successful attach (and after each self-heal adoption), the controller snapshots `getTargets()` and stores the attached target's stable session `id` for that tab in `chrome.storage.session` — which survives the SW restart that loses the in-memory Map. The adopt probe passes when either the Chrome-style `extensionId` matches (still the path on Chrome) or the recorded id identifies the still-attached target; detach and the onDetach event clear the record. In the same pass the composer chips gained the `aria-label`s their menus already had (选择模型 / 上下文用量 / 权限模式 / Agent 预设) — only the effort and send buttons were exposed to assistive tech before, which also made AX-driven verification blind to the rest of the toolbar.

## Alternatives considered

- **Adopt when the only attached debugger target for the tab lacks `extensionId`.** Rejected: a second extension's attach looks identical on Edge, so the loud-error guarantee against foreign debuggers would be lost.
- **Keep the service worker alive instead.** Rejected: the panel already does that incidentally, but the controller must survive an SW restart by design (the same split the watchdog already covers for the offscreen document).

## Consequences

- An SW restart mid-session no longer bricks page tools on Edge: the next tool re-adopts the held session and continues; on Chrome behavior is unchanged.
- Foreign-debugger attaches still fail loud — a different holder presents a different session-target id than the recorded one.
- Coverage: the comprehensive real-device harness drives the shipped build through click/type/scroll/evaluate turns separated by mock restarts longer than the SW idle window; every post-restart tool executed after the fix and failed with the occupancy error before it.
