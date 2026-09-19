# Agent Note: tabs_reopen on Edge — sessions permission and stale window ids

Status: implemented

English | [中文](2026-09-19-tabs-reopen-edge-sessions.zh.md)

## Problem

The tabs_reopen tool crashed on Edge with "Cannot read properties of undefined (reading 'getRecentlyClosed')": the tool calls `chrome.sessions.getRecentlyClosed`, but the manifest never declared the `sessions` permission, so `chrome.sessions` is undefined in the service worker — the tool has never worked. With the permission added, Edge exposed a second trap: `getRecentlyClosed` reports stale `windowId: 0` for closed sessions, and `chrome.tabs.create({ windowId: 0 })` refuses with "No window with id: 0".

## Decision

The manifest declares the `sessions` permission, and reopenClosedTab creates the restored tab with the recorded window first and falls back to the default window when that window id is refused — the recorded ids from Edge's sessions API are advisory, not authoritative.

## Alternatives considered

- **Rebuild the closed tab from the extension's own session log instead of chrome.sessions.** Rejected: chrome.sessions is the platform source for recently-closed state and also covers tabs the user closed outside the agent; a log-based rebuild would miss those.
- **Drop tabs_reopen from the extension surface.** Rejected: undo-close is part of the tabs-family parity the tool surface promises, and the fix is two lines of fallback.

## Consequences

- tabs_reopen works on Edge and Chrome; a stale recorded window id degrades to opening the restored tab in the current default window.
- Coverage: the comprehensive real-device harness exercises tabs_reopen after tabs_close and verifies a new tab id for the restored URL appears.
