# Agent Note: the 轨迹 view now works — a native history-fold view replaces the unmountable desktop plugin path

Status: implemented

English | [中文](2026-09-21-native-trajectory-view.zh.md)

## Problem

The SidePanel's 对话/轨迹 view strip never showed: `useTrajectoryAvailable` gated the strip on the `conversation.view` slot entry that the shipped ui-trajectory plugin contributes lazily — and nothing in the extension consumes the desktop's hidden view ring, so the lazy contribution never materialized. Fixing the gate exposed the deeper wall: the shipped TrajectoryView reads its assembled ledger through `uiConversation.binding(id).target('trajectory')`, and the runtime session window behind that binding never materializes in the extension — the session-controller's live channel (`session/control`) has no engine Remote stream on an extension origin (the gateway WebSocket fallback cannot connect). The ledger is structurally unmountable here, independent of gates or ordering.

## Decision

The SidePanel ships a native trajectory view built straight from `session.history` — the same durable log the transcript reads, already proven to work over the bridge. `buildTrajectoryRows` folds the log in order into rows: turn separators (第 N 轮), user prompts, assistant texts, tool calls (name + arguments), tool results (with failure coloring), and system rows; unknown event types stay in the conversation transcript only. The toolbar carries turn/call counts and a case-insensitive text filter; the list follows the transcript's refresh cadence (refreshSeq bump + poll). The fresh-session sentinel renders an explicit empty state without any RPC. The ui-trajectory plugin, its slot contribution, and the shell's scope plumbing for it are no longer part of the mount path.

## Alternatives considered

- **Fix the desktop plugin path** (materialize the slot entry, implement the `session/control` stream). Rejected for now: the live channel is a wire-transport feature, not a view fix, and the ledger's session-window dependency reaches through api-session-controller's whole activation model. The native view delivers the same user-visible surface from data the extension already serves.
- **Keep the slot-entry availability gate and only relax it.** Rejected: a gate flipped to true would mount a view that can never bind a session — a permanent 轨迹加载中.

## Consequences

- The 轨迹 tab is always present and renders the selected session's full turn timeline: counts, search, and per-turn grouped rows matching the desktop's information layout.
- The conversation transcript remains the complete surface (the trajectory fold intentionally skips non-surface bookkeeping types).
- Coverage: the spec pins the row folder (ordered kinds, failure coloring, unknown-type skipping), the toolbar counts, the search filter, and the sentinel empty state; the real-device harness seeds a full turn and verifies the strip, the empty state, and the rendered rows and toolbar on the selected session.
