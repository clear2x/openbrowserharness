# Changelog

All notable changes to OpenBrowserHarness are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/). Pre-1.0, anything may
change without notice.

## [Unreleased]

First public cut of the project as an independent fork of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`,
forked at `0.1.0-rc.5`). Everything below is relative to that upstream point.

### Added

- **Browser extension host** (`apps/extension`): the full dsh engine runs
  long-lived in the Chrome/Edge MV3 Offscreen document, driven from a side
  panel (tab selector, native transcript, composer with model / thinking
  effort / permission controls, capability panel with todo/goal/queue
  surfaces, interaction cards for approvals and questions).
- **Browser capability layer** (`packages/browser`): `tabs_*` / `page_*`
  tools over `chrome.debugger` (CDP) with humanized input — Bezier mouse
  trajectories with speed jitter and landing-point jitter, per-keystroke
  typing, inertial scrolling with closed-loop residual correction,
  snapshots that pierce Shadow DOM and iframes, text-leaf collection,
  screenshots for multimodal models, and an in-page `page_evaluate`.
- **Visible virtual cursor**: CSP-safe canvas overlay rendering a neon
  comet cursor with motion trail, afterimages, click shockwaves, and
  keystroke/scroll pulses, synchronized with the input stream.
- **Extension storage seams**: OPFS filesystem provider (`packages/fs/fs-opfs`)
  and IndexedDB session persistence
  (`packages/session/session-persistence-indexeddb`) with stable session
  identity recovery and a watchdog against service-worker eviction.
- **Provider presets**: DeepSeek, Zhipu BigModel, and GLM Coding Plan
  (Anthropic-protocol with Bearer auth), plus hand-declared custom routes
  (OpenAI-compatible / Anthropic / OpenAI-Responses) with header and modality
  validation; per-preset user-added model rows.
- **Permission tiers**: ask-every-action / ask-on-changes / full access,
  per-action approval cards, and a plan-mode exit chip.
- **User plugins**: sandboxed user-authored plugins (manifest-sandboxed page,
  `new Function` confined there) with activation-failure persistence and
  last-error surfacing.
- **Skills storage** and Bilibili-style login-state probes as reusable
  snippets; time-context readings (model-facing clock/elapsed context) with
  chat-flow concealment.

### Changed

- Settings surfaces consolidated for the narrow side panel (full-bleed flat
  layout; the models editor folded into one panel set).
- `tool-catalog` regenerated for the browser tool schemas, including combo-key
  (`Ctrl+A`-style) `page_press_key` support.
- Vendored Cordis loader: `!js` YAML expressions evaluate lazily — required by
  MV3 page CSP (logged in `vendor/README.md`, modification #19).

### Fixed

Highlights of the fork-era fixes retained on top of upstream (full detail in
`.agents/notes/`): `awaitPromise` in page evaluation (async snippets used to
return unresolved); embedded tool-result images lifted to wire image parts
(screenshot → multimodal bridging); scroll gesture drop/animation-midpoint
residual correction; shadow-host snapshot coverage; iframe coordinate
addressing; `time`/`date` input structured-value fallback; session history
repair for interrupted tool calls.
