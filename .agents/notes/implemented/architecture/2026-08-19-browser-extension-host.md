# Agent Note: dsh agent loop shipped inside a Chrome MV3 extension host

Status: implemented

English | [中文](2026-08-19-browser-extension-host.zh.md)

## Problem

dsh ran its agent loop only inside the Node host (`dsh web` / `dsh --profile headless`): the browser side was a UI client. Running the harness *as a browser extension* — engine in the page process, browser tabs as the automation surface, no Node process — required deciding how the Node-shaped closure maps onto a browser runtime, and where the extension's long-running guarantees come from.

## Decision

**`apps/extension` boots the workspace plugin packages browser-style; Node surface is bridged by bundler shims, not by patching packages.**

- Boot mirrors the web client's pattern (`packages/client/web/src/boot.tsx`): `new Context()` → `ctx.plugin(Loader)` → a **static module map** (package name → namespace import) replaces `app-boot`'s yml-file composition. No `cordis.yml`, no `!!js`.
- The mounted closure is the headless-equivalent loop: timer, llm, llm-retry, session, session-persistence-indexeddb, session-checkpoint-policy, token-meter, compaction-basic, tools, system-prompt, agent, agent-default-model, agent-loop, tool-todo, tool-browser, plus four extension-native plugins (`chrome-credentials`, `chrome-llm`, `chrome-browser-provider`, `ui-bridge`).
- The handful of `node:` imports inside that closure (`async_hooks` AsyncLocalStorage for initiator attribution, `node:crypto` randomUUID, `node:path` isAbsolute, `node:util`(types) deep-equal, `node:module` createRequire, the `process` global) are satisfied by **vite aliases to minimal shims** under `apps/extension/src/shims/`. ALS degrades to a no-op store (attribution falls back to "unknown initiator"); the rest have exact browser equivalents.
- **LLM**: the `llm-deepseek` *plugin* entry drags two Node-side peers (launch-environment, anonymous-user-id), so the extension registers `DeepSeekAdapter` directly from its `src/adapter.ts` subpath with `resolveApiKey` reading the `DEEPSEEK_API_KEY` credential from `chrome.storage` via a `CredentialProvider` implementation — per-request resolution semantics preserved.
- **Long-running**: sessions persist through a new `PersistenceBackend` over IndexedDB (`packages/session/session-persistence-indexeddb`) under the shared `PersistenceCoordinator`, inheriting torn-tail repair and synthetic closers; the preconfigured `main` agent carries a stable `sessionId` so a remounted Offscreen resumes the materialized session; a `chrome.alarms` watchdog in the SW recreates the Offscreen document when a ping times out.
- **Browser capabilities** follow the seam/provider/consumer split: `packages/browser/browser` (ctx.browser), `packages/browser/tool-browser` (12 model tools), provider implemented in the extension (`chrome.runtime` messaging → SW `chrome.debugger` CDP with humanized Bézier/keystroke input and Shadow-DOM/iframe-piercing snapshots).

## Alternatives considered

- **Patch `core/agent` to remove AsyncLocalStorage** — rejected: bundler-level shims keep the transform zero-touch on shipped packages; attribution loss is acceptable and reversible.
- **Port `app-boot` (yml reading, profile composition) into the browser** — rejected: the static module map is a smaller, auditable surface; profiles are a Node-launch concept.
- **Reuse the `dsh-client-*` React stack and connection carrier for the SidePanel** — initially rejected (the client boot expects the server-pushed `__DSH_BOOT__` plugin graph); superseded the next day by a static boot manifest plus a Port-carrier connection replacement: see [the dsh Web UI in the SidePanel](../feature/2026-08-20-dsh-web-ui-in-extension.md).
- **Extension as a thin client to a local Node host** (Native Messaging / WS) — rejected: the goal is a serverless extension; the loop closure fits the browser once shimmed.

## Consequences

- The extension bundle (`apps/extension/dist/`) is self-contained: ~385 KB offscreen engine, 26 KB SW, 162 KB SidePanel.
- Every new `node:` import added to a *mounted* package breaks the extension build loudly at bundle time — the shim list is the compatibility contract (documented in `apps/extension/src/shims/`).
- Node-only tool families (bash/fs/shell/subagent/workflow) are absent by composition, not by stubbing; adding one requires a browser provider behind the same seams.
- DeepSeek is the only registered LLM provider; others need their own extension plugin over `ctx.llm`.
