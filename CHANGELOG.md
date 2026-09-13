# Changelog

All notable changes to OpenBrowserHarness are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/). Pre-1.0, anything may
change without notice.

## [Unreleased]

## [0.2.0] - 2026-09-13

First public cut of the project as an independent fork of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`,
forked at `0.1.0-rc.5`). Everything below is relative to that upstream point.

### Added (0.1.5 sync & shell redesign)

- **Upstream 0.1.5-rc.2 convergence**: the full upstream delta merged and
  made green — unit suite 22,818 passing, typecheck clean on both compiler
  faces, and the CI lint gate at zero errors.
- **Extension boot graph rebuilt for the 0.1.5 loader**: the
  `__ModuleLoader__` bootstrap facade installed from the panel entry, one
  application batch per staged bundle, static shell/connection rows
  registered through the live loader, the connection module rebuilt on the
  generation-source contract, and a `ctx.uiWorkspace` stub keeping the
  0.1.5 conversation inject satisfiable without desktop workspace chrome.
- **Roster rebuild**: 45-module browser roster regenerated from the 0.1.5
  `dsh.client` metadata (adds approval/attachment/session/reference/
  sidebar-right/schedule/resources and the `api-*` controller rows; drops
  the removed `client-runtime` in favor of `ui-renderer`).
- **Welcome redesign**: vertically centered empty state with an ambient
  brand wash, 56px gradient brand glyph, icon-tiled suggestion cards with
  hover arrow affordance, kbd-capped shortcut hint, a primary new-session
  pill, and a gradient send button — light and dark themes verified on
  device.

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
- **Session-history navigation**: `page_back` / `page_forward` step a tab's
  session history and report an honest `navigated:false` at the boundary.
- **Pierce selectors**: elements inside shadow roots and same-origin iframes
  carry `seg >>> seg` selectors in snapshots; `page_type`, `page_click`,
  `page_wait_for`, clearing, and the structured-value fallback resolve them
  through one shared deep resolver (shadow-root / iframe-document descent),
  with iframe-descended rects converted to top-viewport coordinates.
- **Screenshot attachment**: `page_attach_screenshot` writes a previously
  captured screenshot into a page file input — bytes travel extension → page
  directly, never through the model; `attachment_id` defaults to the most
  recent capture.
- **Visible virtual cursor idle presence**: after a gesture the cursor rests
  at its landing point (dimmed, slow-breathing halo) for 8 s instead of
  vanishing with the tail.
- **Stale provider route self-heal**: engine boot validates the persisted
  provider against the adapter universe; a route whose custom profile was
  deleted falls back to the stock provider (persisted, loudly logged)
  instead of failing every request with `NO_ADAPTER`.
- **Goal parked-goal guardrails**: model guidance states a paused/blocked
  goal is never acted on unprompted, and the goal bar dims parked phases so
  "won't run on its own" reads at a glance.

### Changed

- Settings surfaces consolidated for the narrow side panel (full-bleed flat
  layout; the models editor folded into one panel set).
- `tool-catalog` regenerated for the browser tool schemas, including combo-key
  (`Ctrl+A`-style) `page_press_key` support and the screenshot-attach pair.
- Dark theme: the user message bubble uses a brand-tinted deep blue
  (contrast 9.5:1) instead of near-black.
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
