# Changelog

All notable changes to OpenBrowserHarness are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/). Pre-1.0, anything may
change without notice.

## [0.5.7] - 2026-11-10

### Fixed

- **The silently-failed projection-cache row is removed**: 0.5.6 shipped the session projection cache mounted into the extension engine, but its domain open fails against the extension's chrome KV backend (the upstream base routes the domain to the json backend's per-record disk layout, which the browser cannot mirror), so the row has been silently sitting in the FAILED state since 0.5.6 — invisible to every health check because the offscreen engine's loader states were outside their view. The row is now honestly pruned; restoring it needs either a kv-capable route in the chrome backend or a browser-native persistence domain, both tracked for later.

## [0.5.6] - 2026-11-09

### Added

- **Seven engine capabilities the upstream base ships and the fork lacked**, mounted from the systematic engine-composition sweep: the **`/compact` slash command** (manual compaction, alongside the already-mounted compaction-basic); the **compaction enhancers** — image-offload repairs provider `IMAGE_OFFLOAD_REQUIRED` failures in-session and the tool-result pruner keeps long browser sessions' token economy; the **session projection cache** (projection state persists across engine restarts); **tool-subagent-control** (`list_agents` / `wait_agent` / `interrupt_agent` — the model can manage its own concurrent children); and the **agent-team pair with Team mode on by default** — every new session gets the shared task board (`team_task_create/list/get/update`) and the TEAM_POLICY guidance, so model-side team orchestration works out of the box. The always-on default is a deliberate fork choice: upstream defaults Team off because its desktop settings plane offers a per-session toggle, and the extension carries no settings UI for it.

## [0.5.5] - 2026-11-09

### Added

- **The update check runs itself**: the plugin panel reopens onto its cached outcome (a newer release shows in the 关于 row immediately, no click needed) and auto-checks at most once a day; the user-plugin trigger in the header grows an amber dot while a newer release exists, and its label says so. Timeout failures of the check now say the current network may not reach GitHub instead of a raw signal error.

## [0.5.4] - 2026-11-08

### Added

- **An 关于 row with a release update check** in the user-plugin panel: unpacked installs never auto-update, so the panel now compares its manifest version against the latest published release tag (read-only GitHub API, no token) and links to the release page when a newer zip exists. The comparison lives panel-side — the offscreen page has no `chrome.runtime.getManifest`.

### Fixed

- The engine roster's `backgroundMode` config key removed: 0.2.2's tool-subagent schema has no such field (unknown keys are stripped silently), and no mounted tool starts background jobs — so the earlier ui-jobs prune stays permanent.

## [0.5.3] - 2026-11-08

### Fixed

- **The transcript no longer renders time-context sampling injections as user bubbles**: the time-context plugin's per-turn time reading is a model-visible context injection (`user/message` with the `time-context` source kind), but the panel's transcript drew it as the user's own blue bubble. It joins the runtime-context and skill-catalog kinds in the session-history filter, so the transcript and the `/export` markdown hide it through the same read. A capability-panel seat sweep (real turn, rendered slot tree, console capture) verified the newly activated session-scoped seats render with zero slot errors and walked the 对话/轨迹 views clean.

## [0.5.2] - 2026-11-08

### Changed

- **Upstream synced to 0.2.2-rc.1**: 260 commits absorbed — the 0.2.2 release candidate itself, vendor upgrades (cordis 4.1.0, cosmokit 1.9.0), the web prompt-retry fix, an inspector crash fix, and the desktop channel-policy work. The upstream session-log export header restructured onto the context-menu registry (the extension carries that module since 0.5.1, so the export gestures ride it unchanged); the settings-models panel's provider directory reads the now-synchronous llm surface. The fork's persistence acknowledgements were re-recorded through the official `--update` flow so the fork's browser-source record descends from the upstream retry record honestly (the two had been siblings claiming the same predecessor across the merge).

## [0.5.1] - 2026-11-08

### Fixed

- **Every capability-panel row activates again**: the boot audit's eleven inactive entries are gone. The shell's layout stub covers the whole 0.2.2 `ILayout` face (`panelInfo`, `selectPanel`, `beginNavigation`, `openRightbar`/`closeRightbar`) with single-panel semantics, so `ui-sidebar-right` stops crashing on the missing `panelInfo.subscribe` and its `sidebarRight`/`sidebarRightTabs` services unblock the eight rows waiting on them (plan, schedule, skill, subagent, reference, deliverables, sidebar files, document preview). `ui-file-drag` is carried with its `ui-layout` edge pruned — its `fileDrag` service unblocks the attachment strip and document preview. `ui-jobs` (and with it `api-job-controller`) is pruned honestly: it renders from `job/list`/`job/follow` typert streams, and the connection's stream leg parks every endpoint but `$events`, so the row could never activate here — background-queue visibility stays with the shell's own queue dock.
- **The session export surface works again on the 0.2.2 base**: the capability panel's session header renders once more (the shell now retains the selected session under the `mainView` label upstream's ui-workspace navigation owned, so session-scoped seats leave the hero phase), the 0.2.2 header no longer crashes on its missing `useContextMenu` hook (`dsh-client-ui-context-menu` is carried; only its `ui-layout` edge is pruned), the header's 下载/复制 Markdown gestures read the durable log over the bridge RPC through a new `sessionLogExportOverrides` carrier seam (an extension page has no HTTP host behind the plugin's `/api/session.*` routes), the root overlay seat (copy toast, context-menu root) renders, and the export read follows the 0.2.2 `session.history` page shape (`{ events: [{ event }] }`) — the composer's `/export` had silently gone empty under the pre-sync shape.

## [0.5.0] - 2026-11-08

### Changed

- **Upstream base synced 0.1.5 → 0.2.2**: the engine and package corpus absorbed two months of upstream work — a new browser-operation stack (browser-use, computer-use, CUA drivers), the PTC runtime replacing the code-runtime/e2b pair, SSH remote sessions, the plugin market and manager, the official agent-team, telemetry/OTel, speech-to-text and voice input, the DeepSeek account family, and roughly thirty new settings panels — while every fork capability (the self-built browser stack, the OPFS/apiproxy/IndexedDB extension base, the extension panels, the landing site) is preserved on top. The session format moved to v4; the reflection guard, tool-gate, and slash-menu contracts all follow the 0.2.2 shapes.

### Added

- **Approval waits reach outside the sidebar**: a pending approval or question no longer dies silently after the sidebar closes — the wait holds with no time bound, announces itself with a toolbar badge and a system notification, and the notification route reopens the panel to answer. Long-running composer slash commands report "running in the background" instead of misreading the timeout as a dead service (and the command text is no longer fed to the model), a first-install panel gets the slash menu back (discovery falls back to the global command registry), the welcome card teaches the real Enter-to-send shortcut, and pasting or dragging images into the composer attaches them directly. See `.agents/notes/implemented/feature/2026-10-27-extension-wait-visibility-and-composer-feedback.md`.
- **Accuracy, speed, and reflection batch**: `page_click` verifies hit quality before dispatching (occluded/off-viewport targets fail with the reason instead of a silent coordinate re-click), index addressing resolves and validates the cached element on-page (stale snapshots fail loudly; navigation invalidates the cache), snapshots gain a prep pipeline (动画冻结/横幅清理/懒加载, token-skipped on unchanged documents) plus 快照精简, navigation settles on `readyState` after a swap-window gap, and a new 反思守护 plugin injects failure-reflection context and a completion check so thin turn endings get one goal-directed nudge (plan-mode exempt, budget-capped).
- **Ten more built-in capability switches** (the 内置能力 section now holds 15): 快照精简 (drop long passive text from snapshots — token saver), 横幅遮罩清理 (auto-accept consent banners before snapshots), 懒加载触发 (pre-snapshot scroll sweep), 动画冻结 (kill animations for deterministic clicks), 链接净化 (strip utm_*/fbclid/gclid tracking params on navigation, default ON), 导航智能等待 (readyState settle after navigate, default ON), 禁媒体加载 (block image/video loads on attached tabs), 埋点屏蔽 (no-op navigator.sendBeacon), 危险操作确认 (danger-word clicks require approval even under full access), and 自动提交拦截 (page_type never presses Enter — the user submits manually).

### Fixed

- Browser operations stop failing silently at their edges: scroll-settle timeouts re-read the actual scroll position instead of assuming zero movement (no more double scrolls), the first CDP command waits for an in-flight debugger attach instead of racing the virtual pointer, `type_text` deadlines scale with text length × humanized pacing (long inputs no longer hit a fixed 30-second wall), read-back for skipped elements checks the focused element instead of reporting blind success, and wait/settle/scroll polling checks immediately instead of paying one idle interval first. See `.agents/notes/implemented/bug-fix/2026-10-27-extension-browser-op-correctness.md`.
- The reflection guard now fires in real browsing flows: consecutive-failure counting resets per tool bucket with witness read tools transparent (a suggested `page_snapshot` no longer washes the count), completion checks steer at most once per distinct evidence (recovered failures and honestly-reported blockers no longer loop the nudge until the budget burns), an honest "unrecoverable" turn ending counts as complete, and the guard's wiring (plan exemption, abort short-circuit, budget exhaustion, block branch) is pinned by a loaded-wiring spec. See `.agents/notes/implemented/bug-fix/2026-10-27-extension-reflect-guard-composition.md`.
- The landing screenshots' tab selector no longer shows mojibake: the fixture site behind the panel shots served UTF-8 pages without a charset declaration, so the browser sniffed a legacy CJK encoding for the tab title baked into the captures. The fixture now declares `<meta charset="utf-8">` and all three panel shots were re-captured.
- The documentation site's dark/light appearance switch now works on the landing page: the home route had pinned its dark palette unconditionally, so the toggle changed nothing there. Landing colors moved into a per-mode `--landing-*` token layer — dark mode unchanged, a new light surface (white ground, ink hairlines, indigo accents) added — and the hero orbit artwork re-palettes with the mode. See `.agents/notes/implemented/feature/2026-10-12-landing-follows-appearance-toggle.md`.

## [0.4.0] - 2026-10-09

### Added

- **Site learning (`/learn-site`)**: one slash command mechanically learns the current tab's site — a dedicated learning tab crawls same-origin sub-pages (zero model calls), condensing paths, forms, and stable CSS selectors into a per-host cheat sheet saved as a user plugin (`site-<host>`, toggleable). While a learned host is the active tab, the sheet is injected as model context, so the agent operates by known selectors instead of repeated snapshot exploration. See the browser-automation guide's 站点学习 section.
- **Clear-all sessions**: the recent-sessions menu gains a two-step 清空全部会话 footer (running sessions block with one actionable notice), and the per-row rename/delete affordances rest half-visible instead of hover-only.

### Changed

- **Trajectory view redrawn**: a left timeline spine with per-card node dots, white bordered cards with colored type pills, tool call and result merged into one card (`参数 → 结果` + duration + failure coloring), 仅工具调用 assistant slots kept as dimmed cards, a 轮次/调用/时长 chip toolbar, and an 输入/模型/工具 swimlane strip folded from event timings.
- **Composer dropdowns span the panel width**: the model, reasoning-effort, usage, permission-mode, and preset popovers drop their fixed width caps and share one left/right alignment with the composer capsule.
- The documentation site's landing page is redrawn with a generative orbit-pointer hero artwork and a full content arc (stats, how-it-runs, three design rows, preset gallery, closing call to action).

### Fixed

- Machine-input injections no longer render as chat bubbles: the skill catalog reminder is filtered from the panel history face (the durable log and model path are untouched), and a loaded skill's instruction body folds into a collapsed SKILL row instead of a raw `<skill_content>` message.
- Slash commands work from the fresh-session start: the menu opens there (discovery borrows the most recent existing session) and executing a picked line mints the session first instead of falling back to a plain model send.
- Long-running slash commands no longer get misread as a failed service at the 10-second transport timeout and sent to the model as plain text (`commands/execute` now carries a 120-second settlement budget).

## [0.3.0] - 2026-10-07

### Added

- **Site distillation (炼化)**: a new `page_network` tool captures a tab's network requests (start/read with URL and resource-type filters), so the agent can discover a site's data endpoints instead of reverse-engineering every interaction through the DOM. The extension seeds a 炼化站点 recipe skill on boot: a four-phase pipeline (explore → condense → write a site skill → verify against the live site) that turns repeated site tasks into one-call fetch recipes.
- **Timed questions**: `ask_user_question` ships the timed mode in the extension composition (120-second default window) — a question whose answer window expires settles as a pending result while the agent keeps working, the SidePanel card clears automatically, and a late answer arrives as a new turn. The blocking behavior remains one config row away.

## [0.2.2] - 2026-09-28

### Changed

- The packaged manifest description and the toolbar tooltip carry the product name (OpenBrowserHarness) instead of the internal "dsh" shorthand, matching the store listings.

## [0.2.1] - 2026-09-28

### Added

- **Delete historical sessions from the conversation switcher**: a session can be removed in place from the switcher, and its local IndexedDB log is cleaned up with it.

### Fixed

- A model pick on the fresh-session start view persists as the default instead of erroring.
- The panel opens on a fresh session; opening an old session is an explicit pick from history.
- Reasoning-effort switching works end to end — metadata, wire thinking, and composer unwrapping.
- The active session is warmed at mount and send RPCs are sized for cold resume.
- Pre-v2 assistant settlements in old session logs are repaired at open.

The fixes above were already part of the `extension-v0.2.0` release zip; they are documented here for completeness.

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
