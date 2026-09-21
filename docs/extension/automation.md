# Browser automation

English | [中文](automation.zh.md)

The agent drives real pages through the Chrome DevTools Protocol (`chrome.debugger`). There is no OS-level automation: input dispatches into the page, and the browser shows its "started debugging" banner while the agent works.

## What the agent can do on a page

- **Navigate and read** — open URLs, follow links, and read structured page snapshots.
- **Click and type** — per-keystroke typing, key combinations, and clicks with humanized pacing: Bézier mouse paths with speed jitter and landing-point jitter.
- **Scroll** — inertial scrolling with settle verification, so "scrolled to the bottom" means the page is actually there.
- **Screenshot** — capture the tab for multimodal models, or attach an image straight into a page's file input without routing it through the model.
- **Verify in-page** — run a short script in the page (async supported) and read the result back.

## Whole-browser surface

Beyond a single page the agent manages tabs — open, list, switch, close, reload, pin, mute, duplicate, move, reopen recently closed — and focuses browser windows. It also tracks todos, keeps skills, sets goals, and can delegate subtasks to subagents.

## Deep page reading

Snapshots pierce **Shadow DOM and iframes**: elements inside them appear in the same structured listing, with coordinates. When a selector cannot address an element, the agent falls back to its coordinates and verifies the click landed by reading the page state back.

## The virtual cursor

CDP input moves no OS pointer, so every gesture also renders an overlay in the page: a cursor with a comet trail tracking the exact dispatched coordinates, click shockwaves, and keystroke or scroll pulses. The overlay appears while the agent works and fades away after. It lives in the top frame — gestures into same-origin iframes dispatch correctly, and the drawn cursor is their top-viewport projection.

## Boundaries

- The extension attaches only to the tab a task targets.
- Browser-internal pages (`chrome://`, `edge://`, the extension stores) refuse CDP attachment by design.
- Typing has no direct path into inputs inside shadow roots or iframes; the agent works around it by focusing the element and dispatching keystrokes, or by setting the value with an in-page script.
