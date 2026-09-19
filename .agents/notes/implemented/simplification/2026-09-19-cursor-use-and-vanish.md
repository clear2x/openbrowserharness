# Agent Note: Cursor overlay use-and-vanish — idle fade replaces always-on presence

Status: implemented

English | [中文](2026-09-19-cursor-use-and-vanish.zh.md)

## Problem

The neon-comet pointer was contractually always-on: after a gesture it rested at its landing point for a 24-hour presence horizon, and a 4-second background keep-alive re-parked it after navigations and re-brightened it on every heartbeat. Watching a driven page, the amplified glowing cursor outlived its gesture by minutes, sitting motionless over content it had nothing to do with — the user read the static glow as broken and ugly, not alive.

## Decision

The overlay is use-and-vanish. The show timeline is: bright through the landing (full opacity + bright halo), a ~4.2s dimmed rest with the slow-breathing halo, then the cursor dissolves (0.6s ease-out) and the animation loop drains — the page returns to the user, and the next gesture fades it back in at its path start (snappy 0.18s transition, so the dissolve never softens a re-entry). The presence machinery is deleted outright: no `parkIfIdle`, no `touch()`, no background keep-alive interval, no parked-point bookkeeping — every page call already re-installs the overlay idempotently, so a navigated page needs no heartbeat. The amber activity blip stays as the transient non-pointer reaction; it no longer re-arms the cursor's presence and self-suppresses once no position context remains (a pulse without a position would be an orphan in the viewport corner).

## Alternatives considered

- **Longer rest with a manual dismiss.** Rejected: nothing in the panel can plausibly host a dismiss control for an overlay in the driven page, and the user's ask was that it simply not linger.
- **Keep the keep-alive install heartbeat.** Rejected as redundant: gesture calls (`move`/`click`/`scroll`) and `noteBrowserOperation` already install the overlay when missing, so the 4-second per-tab evaluate loop bought nothing after presence ended — removing it also stops a perpetual RPC drip per driven tab.
- **Fading straight from bright to gone.** Rejected: the dimmed rest is what lets a watcher read where the gesture landed before the show leaves.

## Consequences

- A driven page is visually clean between gestures: nothing renders once trail, effects, and the rest horizon drain, and the canvas stops consuming frames.
- The gesture show itself is unchanged (path, tail, sparks, shockwaves, keystroke caps, scroll streaks) — only the tail-end presence is bounded.
- Coverage: the overlay spec pins the rest-horizon fade branch, the absence of the parked/heartbeat API, the per-entry horizon re-arm, and the asymmetric re-entry/exit transitions.
