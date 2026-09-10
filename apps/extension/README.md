# OpenBrowserHarness (openbrowserharness-extension)

English | [中文](README.zh.md)

Chrome MV3 extension host for DeepSeek Harness: the full dsh agent loop (Cordis microkernel, event-sourced sessions, tool runtime, LLM adapter) runs **entirely inside the browser**, long-lived in an Offscreen document — no Node process required.

## What this is

- **Extension-form dsh** — the same plugin packages as the Node host, booted browser-style (`new Context()` + Loader with a static module map, no yml files).
- **Long-running** — the engine lives in the Offscreen document; sessions are event-sourced into IndexedDB (`dsh-session-persistence-indexeddb`) with crash repair, and the preconfigured `main` agent carries a stable session identity, so an Offscreen recreation resumes the same conversation. A Service-Worker alarm watchdog re-creates the Offscreen host if Chrome reclaims it.
- **Browser capabilities as dsh tools** — `dsh-tool-browser` exposes `tabs_*` / `page_*` tools over the `ctx.browser` seam; the extension provider drives `chrome.debugger` (CDP) with humanized input: cubic-Bézier mouse paths, randomized keystroke timing, Shadow-DOM/iframe-piercing page snapshots.
- **Visible virtual cursor** — CDP input moves no OS pointer, so every gesture also renders an in-page overlay: a cursor arrow tracking the exact dispatched coordinates, a fading trail, and click ripples (see the [virtual-cursor Agent Note](../../.agents/notes/implemented/feature/2026-08-20-visible-virtual-cursor.md)).

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

- **Model route is DeepSeek-only** — the chrome-llm plugin registers the `deepseek-official` adapter (fetch + SSE); other providers need their own extension plugin over `ctx.llm`.
- **Model/base-URL changes apply to newly created agents** — the preconfigured `main` agent captures its route at composition.
- **Node-only tool families are not mounted** (bash/fs/shell/subagent/workflow/…) — the browser closure composes the loop, todo, and browser tools only.
- **Approvals/interactive questions are not surfaced** — no approval loop is wired into the SidePanel yet.
- **The SidePanel IS the dsh web UI** — the full client stack boots statically against the offscreen engine over a Port carrier; host-only surfaces (directory pickers, goal/preset authoring, content search) answer structured `not-available-in-extension` errors instead of rendering. Chrome ≥134 required (`using` declarations in the mounted closure).
- **The virtual-cursor overlay lives in the top frame** — gestures into same-origin iframes dispatch correctly, but the drawn cursor is the top-viewport projection.
