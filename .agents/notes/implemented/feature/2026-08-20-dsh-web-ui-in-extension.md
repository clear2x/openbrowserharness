# Agent Note: The real dsh Web UI runs in the extension SidePanel

Status: implemented

English | [中文](2026-08-20-dsh-web-ui-in-extension.zh.md)

## Problem

The extension host shipped with a purpose-built minimal SidePanel: a functional chat surface, but not the DeepSeek Harness experience — no sidebar workspace management, no markdown/code rendering pipeline, no settings surfaces, none of the ~33 browser UI plugins. The prior architecture note had rejected reusing the `dsh-client-*` stack for v1 because the client boot expects a server-pushed plugin graph; that rejection left the experience gap.

## Decision

**The unmodified dsh client stack boots in the SidePanel against a static composition, connected to the offscreen engine over a chrome.runtime Port carrier.**

- Boot is the `AppWebEntry` path with a self-built `__DSH_BOOT__` manifest (36 rows: the web-app browser roster plus typert-registry / api-gateway / session-log-export, minus client-hmr). Plugin bundles are the packages' own `lib/client.js` artifacts, copied verbatim into `dist/plugins/<pkg>/client.js` at build and loaded with the default same-origin `<script>` transport — no eval anywhere (MV3 CSP compliance).
- Platform externals (react, cordis, ui-primitives, …) are statically imported so every bundle sees one instance; the connection plugin is replaced via `ClientModuleSystem.registerStatic` with a twin of the official client whose `WebApiClient` is swapped for `PortApiClient extends AbstractApiClient` — unary calls override `callUnary` (the base response schema's closed RpcError-code union would mangle host-specific codes), streams override `openMux/openHost` into generators fed by Port frames parsed with the real apiproxy zod schemas.
- The engine side answers on `dsh-api` ports (`chrome-api-bridge`): the apiproxy method surface over the mounted services, two event streams (mux with since-watermark replay from persistence, host with a fixed single-workspace baseline), structured `not-available-in-extension` refusals for host-only surfaces, and a generic settings-namespace blob store (chrome.storage) so browser UI plugins persist their own state (onboarding acknowledgement et al.).
- **Three environment facts forced hardening, each fixed at the root:**
  1. the vendored loader constructed its `!!js` expression evaluator (`new Function`) at module top level — importing the loader crashed MV3 pages outright; the evaluator construction is now lazy in `vendor/loader` (compositions without yml expressions never build it);
  2. offscreen documents receive no `chrome.storage` API bindings (observed `chrome = {loadTimes, csi, runtime}`); all storage access routes through a `dsh-storage` message channel served by the service worker, with change events rebroadcast;
  3. the mounted closure's `using` declarations (explicit resource management) set the floor at Chrome 134 — the vite target and `minimum_chrome_version` moved together.

## Alternatives considered

- **`loadBundle` eval seam** (assembled-boot test fixture style) — rejected: MV3 forbids `unsafe-eval`; static files + the default script transport keep the official bundle/CSS-injection mechanics untouched.
- **WebSocket/SSE carriers** (the stock `WebApiClient` downlinks) — unusable as-is: `chrome-extension://` origin makes the WS protocol derivation produce `ws:` and relative fetch resolve against the extension origin; the port carrier is the only transport that exists in every extension context.
- **Keep the minimal SidePanel and iterate it toward parity** — rejected: it re-implements a 33-plugin surface forever; the carrier seam exists precisely for this.

## Consequences

- The SidePanel is pixel-for-pixel the `dsh web` interface (sidebar, workspace, settings, onboarding, model picker), fed by the same event-sourced engine data; fixture mode (`sidepanel.html?fixture`) boots the UI with no engine for smoke tests.
- Headless-Chrome smoke (playwright + bundled Chromium; branded Chrome ≥137 ignores `--load-extension`) now gates the build: boot render, onboarding persistence across reload, and port RPC round-trips are asserted against the real bundle.
- `apps/extension` became a dual-face project (`tsconfig.json` host / `tsconfig.client.json` browser UI), registered in both root aggregates — one program still never sees both cordis Context faces.
- The old hand-rolled SidePanel was deleted; the legacy `ui-bridge` stays mounted only because offscreen boot's session-restore hook (`restoreLatest`) lives there — folding it into the api-bridge is noted cleanup debt.
