# Agent Note: GoalBar dock — the native shell never declared the `main` slot

Status: implemented

English | [中文](2026-09-28-goalbar-dock-main-slot-declaration.zh.md)

## Problem

The capability panel (goal bar, todo strip, queue — the docked conversation slot family) never rendered in the extension: a model-executed `create_goal` succeeded, yet `[data-goal-bar]` never appeared and `.dshx-caps` stayed unmounted. The lone console clue was the long-standing `cannot get required service "sessions" in inactive context` rejection from `AgentPresetSeatController`, which earlier batches had written off as harmless.

## Decision

The extension shell's root registration declares the missing slot. The desktop root frame (`ui-layout`) declares `'main': { kind: 'keyed', scope: 'root' }` among its children; `ui-conversation` gates its whole conversation slot family behind `slots.inject('main', …)` — that prepare registers `main.conversation`'s children table, which is where `conversation.input.dock` (and the goal/todo/queue docks) get declared. The native shell replaced the frame with its own `root` register whose children table omitted `main`, so the injection waited forever on a declaration that would never come: `registerConversationRoot()` never ran, `conversation.input.dock` was never declared, `ui-goal`'s dock prepare never fired, and every dock stayed dark while the engine-side goal worked.

The fix is the one-line declaration in the shell's root children table plus a comment explaining the frame-replacement history. `ConversationPanel` (the desktop `main` occupant) intentionally stays unrendered — the shell renders `ConversationRoot` directly, and ConversationRoot places the input.dock docks itself (`renderSlot('conversation.input.dock', zone)`).

## Root-cause method (kept for the next dead-slot investigation)

Instrument-and-reproduce through the real-device harness (`~/obh-test/goalbar-probe.mjs`): mock-driven `create_goal`, then read the slots system through console instrumentation in `ui-goal` and `ui-renderer/registry.ts`. The decisive trace: `conversation.input.dock declared: false` three times at boot (ui-goal's inject effect waiting), then — with the declaration added — `declared: true` and `PREPARE RAN — registering input.dock occupant`. Fiber-state dumps through the shell proved the plugins were ACTIVE all along, which killed the earlier "boot activation race" hypothesis from the first investigation round.

Two measurement traps produced false "absent" readings on the way: the diagnostic `console.info` lines were removed from source while the probe still grepped for them, and the probe's piped stdout buffered everything until exit. Instrumentation assertions must be re-checked against the built bundle (`grep` the dist chunk) and probes must write their logs to a file as they run.

## Alternatives considered

**Fixing the loader's activation semantics for `immediately: false` plugins.** Rejected for now: the plugins were ACTIVE (fiber state 2, no waiting services) — activation was never the problem, so loader changes would have been surgery on vendored/upstream semantics with no effect.

**A shell-side retry that re-registered the dock occupant.** Rejected: the shell cannot re-run another plugin's prepare (the goal dock's verbs bind ui-goal's own sessions/remote faces), and retrying a slots.inject whose effect is alive is a no-op by design.

**Rendering GoalBar directly from the shell.** Rejected: the goal bar's verbs (edit/pause/resume/clear with CAS refs) are ui-goal's injected business face; a shell copy would fork that wiring and diverge from the desktop's dock contract.

## Consequences

The capability panel now renders (the collapsed 能力面板 strip appears above the composer), and the docks light up with data: a model-created goal showed the goal system running rounds in the probe. GoalBar intentionally renders nothing for a completed goal — the probe's mock (repeat-last) drove the goal to its round cap, so the bar's absence at the captured moment is the designed empty state, not a defect. The `sessions` inactive-context rejection from `AgentPresetSeatController` still fires during boot; it is now known to be cosmetic for this surface, and its own root cause remains open. The `main` declaration also means `ConversationPanel` has a registrable occupant key that the shell deliberately never renders — anyone wiring `renderSlot('main')` later must reconcile with the shell's direct ConversationRoot rendering.
