# Agent Note: the first send after a reload paid cold resume inside a 10 s RPC

Status: implemented

English | [中文](2026-09-20-rpc-cold-resume-budget.zh.md)

## Problem

`session.prompt` is the first RPC that touches the persisted session: it ensures the agent, and ensuring a cold session resumes it — which on a repair-armed profile also runs the one-time legacy repair pass over the whole stored log. The panel's rpc client cut every call off at a fixed 10 s, so on a long-lived real profile the first send (and a model switch) after every extension reload died with `发送失败：dsh-api RPC 超时` while the engine was still mid-resume; the repair finished afterwards, so the retry worked — training the user to click 重试 on a failure the system creates itself. Nothing warms the agent at mount: the boot-time RPCs (`session.list`, `session.history`, `session.status`, `session.permission.get`) all read state without ensuring the agent.

## Decision

Three coordinated moves. The rpc client takes a per-call timeout (default still 10 s). The bridge gained `session.warm` — `ensureAgent(sessionId)` with a boolean result — and the panel fires it for the active session right after mount with a 60 s budget, moving the resume (and the one-time repair) into idle time; concurrent senders join the same in-flight resume through the existing `ensuring` map. The call sites that can legitimately pay cold resume — `session.prompt` and both `session.selectModel` paths — carry 60 s budgets, so a send racing the warm-up waits for the resume instead of failing; everything else keeps the 10 s posture. A timed-out send is never auto-retried: the engine may still complete the late RPC, and a blind retry would append the message twice.

## Alternatives considered

- **Raise the global timeout to 60 s.** Rejected: the 10 s cap is what keeps a dead offscreen document from hanging every UI action; only the cold-path call sites need the longer budget.
- **Auto-retry the send once on timeout.** Rejected: an RPC that timed out client-side can still settle server-side after the resume completes, so a retry risks a duplicated user message.
- **Warm in the background service worker at boot.** Rejected: the SW does not know which session the panel considers active, and a warming resume for an unopened panel wastes the resume work; the panel knows its session and warms exactly that.

## Consequences

- Reload → open → send now works on a long-lived profile: the mount warm absorbs the resume, and a send that still races it holds the connection for up to 60 s instead of dying at 10 s.
- The repair keeps running at most once per stored generation; after the first warm (or first send) the session is live and every later RPC is fast again.
- Coverage: the bridge spec drives `session.warm` (not-found refusal for an unknown session, live-agent registration for a real one); the real-device harness seeds a legacy-shaped log, opens the panel, and sends immediately with zero wait — the send joins the cold resume and the turn completes with no error card.
