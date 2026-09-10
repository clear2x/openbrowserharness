# Agent Note: Humanized gestures render a visible virtual cursor with trail

Status: implemented

English | [中文](2026-08-20-visible-virtual-cursor.zh.md)

## Problem

The extension drives pages with CDP-synthesized input (`Input.dispatchMouseEvent`). Those events carry the full humanization — Bézier trajectories, eased timing, arrival pauses — but CDP never moves the OS pointer: to anyone watching the browser, hover states light up and clicks land with **no visible cursor at all**. The gesture realism was invisible, and pages comparing pointer position against event coordinates see nothing where a pointer should be.

## Decision

Gesture visibility is rendered **in-page, in lockstep with the input stream**, by a virtual-cursor overlay:

- `apps/extension/src/background/virtual-cursor.ts` injects an idempotent installer into the **top frame** (`Runtime.evaluate`): a fixed full-viewport root with `pointer-events: none` and max z-index holding a canvas plus a cursor arrow (SVG in a div).
- Before each move gesture, the SW calls `showGesture(tabId, path, durationMs)` with **the same path points and duration** the `Input.dispatchMouseEvent` stream will use, then starts dispatching. Both timelines start at the same kickoff, so the drawn pointer tracks the dispatched coordinates within one evaluate roundtrip; the page interpolates the path by normalized time in a rAF loop.
- The trail is a fading polyline on the canvas (700 ms tail, newer = thicker/bluer); clicks draw an expanding ripple on the same canvas (`showClick`, fired right after `mousePressed`, un-awaited so press/release timing stays pure).
- The overlay uses only CSSOM property writes and canvas drawing — no `<style>`, no `@keyframes`, no inline handlers — so strict page CSP cannot block it, and it removes itself visually (opacity fade + cleared canvas) after gestures go idle.

Everything is best-effort: overlay helpers swallow all errors; a page that rejects the evaluate must never break the real gesture.

## Alternatives considered

- **Dispatch a DOM-synthesized event stream instead of CDP** (real `MouseEvent`s with coordinates the page can observe) — rejected: loses the CDP-level fidelity that drives hover/focus natively and is trivially distinguishable from trusted input.
- **Per-event position sync** (one evaluate per `mouseMoved`) — rejected: 12–30 extra roundtrips per gesture stretch the press cadence; one kickoff with a shared timeline is visually indistinguishable.
- **Chrome extension cursor APIs / OS-level pointer control** — no such API for extensions; DevTools-protocol-only alternatives were out of scope.

## Consequences

- Watching the browser during automation now shows a moving cursor, its trail, and click ripples that track the actual input coordinates.
- The overlay lives in the top frame only: gestures into same-origin iframes still dispatch correctly, but the drawn cursor is the top-viewport projection (coordinates match; the iframe content itself has no second cursor).
- Keyboard input needs no visual counterpart: per-key `Input.dispatchKeyEvent` already manifests as visibly typed text.
- A page navigating mid-gesture destroys the overlay with its document; the next gesture reinstalls it (installer is idempotent per document).
