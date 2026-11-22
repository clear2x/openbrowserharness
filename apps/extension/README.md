# OpenBrowserHarness (openbrowserharness-extension)

English | [中文](README.zh.md)

Chrome MV3 extension host for DeepSeek Harness: the full dsh agent loop (Cordis microkernel, event-sourced sessions, tool runtime, LLM adapter) runs **entirely inside the browser**, long-lived in an Offscreen document — no Node process required.

## What this is

- **Extension-form dsh** — the same plugin packages as the Node host, booted browser-style (`new Context()` + Loader with a static module map, no yml files).
- **Long-running** — the engine lives in the Offscreen document; sessions are event-sourced into IndexedDB (`dsh-session-persistence-indexeddb`) with crash repair, and the preconfigured `main` agent carries a stable session identity, so an Offscreen recreation resumes the same conversation. A Service-Worker alarm watchdog re-creates the Offscreen host if Chrome reclaims it.
- **Browser capabilities as dsh tools** — `dsh-tool-browser` exposes `tabs_*` / `page_*` tools over the `ctx.browser` seam; the extension provider drives `chrome.debugger` (CDP) with humanized input: cubic-Bézier mouse paths, randomized keystroke timing, Shadow-DOM/iframe-piercing page snapshots.
- **Visible virtual cursor** — CDP input moves no OS pointer, so every gesture also renders an in-page overlay: a cursor arrow tracking the exact dispatched coordinates, a fading trail, and click ripples (see the [virtual-cursor Agent Note](../../.agents/notes/implemented/feature/2026-08-20-visible-virtual-cursor.md)).
- **Scenario presets out of the box** — the preset switcher ships six system-trust presets (web research, price comparison, video-account operations, form filling, page monitoring, developer probing): each keeps the full tool set and your model route, and encodes its working discipline as a prompt addendum (cross-source verification, confirmation before irreversible actions, read-only bounds). New sessions start in the full-access permission mode; the shield chip restores per-change or per-action approval at any time.
- **Accurate, honest operations** — clicks verify hit quality (occluded/off-viewport targets fail with a reason instead of silently clicking through), typed text is read back from the page, and a reflection guard nudges the agent when a turn ends thin or tools keep failing. Fifteen built-in capability switches (snapshot lean/masking/prep, tracking-param cleanup, navigation settle, media blocking, submit interception…) tune all of it from the user-plugin panel.
- **Site learning (`/learn-site`)** — one slash command mechanically crawls the current tab's site (same-origin sub-pages, in a dedicated learning tab) and condenses it into a per-host cheat sheet — paths, forms, and stable selectors — saved as a user plugin (`site-<host>`). While that host is the active tab, the cheat sheet is injected as model context, so the agent addresses the site by known selectors instead of rediscovering them through repeated snapshots (see the [site-learn Agent Note](../../.agents/notes/implemented/feature/2026-10-08-site-learn-command.md)).
- **Video intelligence (`video_index` / `sense_now`)** — a subtitle-first long-video index: `index` pulls a Bilibili video's official/AI subtitles over allowlisted API lanes (zero-download indexing; a companion MCP server unlocks the FFmpeg/ASR-grade engine), `query` answers with cited, timestamped evidence lines (`[mm:ss–mm:ss] 台词 (EVID_x)`), and `zoom` seeks the real player and captures the frame at any timestamp (durably cited in the index's frame-evidence store). `sense_now` companion-watches the active window: bounded sampling rounds, diff-based frame keeping at three paces, and one montage sheet committed as evidence per round.
- **On-device AI (all models ≤1 GB, CPU-first)** — the「本地 AI」panel installs per-task models that run entirely inside a dedicated AI worker: PP-OCRv4 reads burned-in subtitles off captured frames (works with no GPU), SmolVLM2-256M describes frames (WebGPU), Whisper-base transcribes subtitle-less video audio into the index (`index` falls back to it automatically, ≤8-minute videos), and multilingual-e5-small powers `page_find_related` — semantic ranking of page elements by task, so large pages are addressed by relevance instead of truncated snapshots. Fetch/render compression (extractive, deterministic) trims oversized page text before it reaches the model. Every capability self-tests on install; a missing model degrades its lane honestly instead of failing the tool.
- **Batch page actions** — `page_batch_actions` runs a whole selector-addressed plan (click/type/press/scroll/wait/navigate) in one call instead of several page-tool round-trips: the plan is validated before anything runs, the first failing step stops it with a per-step progress report, and mutating steps settle page readiness so a click-triggered navigation cannot race the next action.

See the [architecture Agent Note](../../.agents/notes/implemented/architecture/2026-08-19-browser-extension-host.md) for the decision record (shim strategy, rejected alternatives).

## Layout

| Path | Role |
| --- | --- |
| `src/background/` | Service Worker: CDP controller (Bézier mouse, typed keyboard, piercing snapshot), tab ops, message router, Offscreen watchdog |
| `src/offscreen/` | Engine host: browser boot + plugin composition + auto-resume |
| `src/chrome/` | Extension-native dsh plugins: `chrome-credentials`, `chrome-llm` (DeepSeek adapter over `chrome.storage`), `chrome-browser-provider`, `ui-bridge` |
| `src/sidepanel-dsh/` | The REAL dsh web UI boot (static manifest, platform seeds, PortApiClient carrier) |
| `src/sidepanel/` | Thin entry mounting the dsh web shell into `#root` |
| `src/shims/` | Minimal browser shims for the node: builtins the mounted closure touches (`async_hooks` ALS no-op, `crypto`, `path`, `util`, `module`, `process` globals) |
| `src/shared/protocol.ts` | Cross-context message contract (UI port, CDP channel, agent channel) |

## Build & run

```sh
# from repo root (workspace libs must be fresh)
pnpm install
pnpm run build:lib
pnpm run build:extension
```

Load `apps/extension/dist/` as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked). Click the toolbar icon to open the SidePanel, set your DeepSeek API key in settings, and talk to the agent. First automation on a tab attaches `chrome.debugger` — the browser's "started debugging" infobar is inherent to that API.

## Known Limitations and Deferred Work

- **Model/base-URL changes apply to newly created agents** — the preconfigured `main` agent captures its route at composition.
- **Node-only tool families are not mounted** (bash/fs/shell/subagent/workflow/…) — the browser closure composes the loop, todo, and browser tools only.
- **The SidePanel IS the dsh web UI** — the full client stack boots statically against the offscreen engine over a Port carrier; host-only surfaces (directory pickers, goal/preset authoring, content search) answer structured `not-available-in-extension` errors instead of rendering. Chrome ≥134 required (`using` declarations in the mounted closure).
- **The virtual-cursor overlay lives in the top frame** — gestures into same-origin iframes dispatch correctly, but the drawn cursor is the top-viewport projection.
