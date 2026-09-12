# Agent Note: virtual cursor idle presence — the pointer survives between gestures

Status: implemented

English | [中文](2026-09-12-virtual-cursor-idle-presence.zh.md)

## Problem

The neon-comet cursor rendered only DURING a humanized gesture: a click flight lasts 0.15–0.6 s, the tail dissipates in 1.4 s, and then `hideAt` zeroed the cursor's opacity and stopped the rAF loop. An agent turn is mostly read operations (search, extract, snapshot — no pointer by design) punctuated by sub-second writes, so a watching user saw a flash at best and an inert page between operations. The visibility complaint was structural, not cosmetic.

## Decision

- After any gesture the cursor rests at its landing point for `IDLE_MS` (8 s): opacity 0.6, a slow-breathing halo (sin period 520 ms vs 180 ms active), dimmed head knot.
- Every entry point (`move`/`click`/`key`/`scroll`) extends `idleUntil`; the rAF loop stays alive across the idle window and only fades the cursor out after it.

## Alternatives considered

- **Longer flight animations**: rejected — the flash length was never the gap; the vanish-between-operations was.
- **A persistent forever-cursor**: rejected — a permanently pinned fake pointer on a page the user may also touch reads as a bug; the idle window keeps the presence without claiming the page.

## Consequences

- The overlay's rAF now runs for the idle window (two gradient fills per frame) — bounded, cheap, and it stops with the same drain condition as before, extended by `idleUntil`.
- Agent presence on the page is continuous: operations burst, pauses breathe, and 8 s after the last operation the pointer fades as before.
