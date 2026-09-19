# Agent Note: New sessions default to full access

Status: implemented

English | [中文](2026-09-19-default-full-access.zh.md)

## Problem

A new session folded to `ask-change`, so every change-class browser action — typing, navigating, opening tabs, scripts — paused for approval first. For this extension's core loop, an agent driving pages on the user's behalf, the out-of-box experience was a constant stream of approval cards the user did not want: their explicit request was to default to 完全访问.

## Decision

`DEFAULT_PERMISSION_MODE` is `full`: a session with no `permission/mode` event acts without asking, for page interactions and file changes alike. Everything else is unchanged — the three-mode matrix, the shield-chip switcher, per-session log durability, and the plan-mode file-write deny (which is independent of the mode and still blocks writes until a plan is approved). Subagent sessions share the fold, so they act without asking by default too.

## Alternatives considered

- **A persisted global default setting.** Rejected: the knob already persists per session once the user switches it; a second, storage-level default would create two sources of truth for the same posture.
- **`ask-always` as the default.** Rejected: maximal prompting is the opposite of the user's explicit ask; the mode remains one chip away for anyone who wants it.

## Consequences

- Out of the box the agent is trusted to act; restoring confirmations is one switcher pick, durable for that session, and `ask-always`/`ask-change` behavior is unchanged when selected.
- Coverage: the gate spec sets modes explicitly on every ask-path test and pins the no-event fold to `full`; the bridge spec pins the cold-session read returning `full`.
