# Agent Note: Extension-side subagent @-mentions and agent-preset authoring

Status: implemented

English | [中文](2026-08-29-extension-subagent-mention-and-agent-preset-authoring.zh.md)

## Problem

Two desktop wire surfaces were still dead ends in the MV3 extension, each for a different reason:

- The composer had no way to address a subagent. The extension bridge already implemented the `subagent.*` RPC family (list/history/prompt/interrupt), but nothing in the UI produced a `subagent.prompt` — desktop reaches it through an input-trigger menu wired into the client module system, which the extension shell does not compose.
- The settings page's Agent 预设 tab rendered whatever the `agentPreset.*` wire surface returned, and the bridge rejected every method. The desktop implementation (`@deepseek-ai/dsh-agent-presets`) discovers presets by scanning a filesystem directory and dynamically importing plugin modules from it (`node:fs/promises`, `dsh-home-paths`, `cordis-plugin-include`); an MV3 page has no filesystem, CSP forbids dynamic code, and the extension's loader is a static module map. The UI was permanently empty through no fault of its own.

## Decision

**@-mentions route through the existing slash pipeline.** `dispatchSendLine` (composer-bar) already owns send-line interpretation (`/` commands, `//` escape); it now also recognizes a leading `@名字 ` token. `useSubagents` fetches `subagent.list` lazily on first `@` keystroke and caches per session; the popup lists only continuable candidates (finished children with a resumable transcript). A match sends `subagent.prompt {parentSessionId, childSessionId, content}`; no match falls through to the main session with a notice, so `@` typed by accident degrades to an ordinary message rather than an error.

**Agent presets become a chrome-storage roster, not a ported filesystem.** The bridge implements the six wire methods against a `chrome.storage.local` key (`dsh-agent-presets`): `list` (builtin `default` row plus user rows, broken rows kept visible), `copy` (the one authoring write — validates the id, reserves `default`, inherits the source definition), `read`, `openDocument` (builtin rejects read-only; user rows answer `{opened:false, path}` naming the storage key, mirroring desktop's "edit the file afterwards" with a storage path), `remove` (rejects builtin; clears a dangling default), and `select` (blank-session-only, otherwise `agent-preset-locked`; appends `agent-preset/selected`, declared locally against the session type catalog — no cast). Consumption happens where the desktop one does: `session.create` resolves the explicit or stored default preset into the session header, applies `provider`/`model` overrides through the existing selections mechanism, and registers the `systemPrompt` section via `agentCtx.systemPrompt.section()`; cold restore replays the header plus the last `agent-preset/selected` event. The definition subset (`provider`/`model`/`systemPrompt`) is the desktop field set minus what a static module map cannot carry (per-preset plugin rows, `tools`).

The default-selection field itself was already a settings `agent-presets.default` string — the old list code misread it as boolean; the fix also corrects that.

## Alternatives considered

- **Porting `dsh-agent-presets` behind a Node shim.** Rejected: the loader's dynamic `import()` of preset directories is exactly what MV3 CSP forbids; shimming `node:fs` to IndexedDB would still leave no way to load per-preset plugin code, so the port would implement discovery for a feature that cannot activate.
- **A composer popup independent of the slash pipeline.** Rejected: the pipeline already owns send-line interpretation and the `//` escape; a second interpreter would fork the escape and fallback semantics for no behavioral gain.

## Consequences

The settings tab and hero chip work against real data with zero UI changes — they were already sending these calls. Authoring depth matches desktop's copy-and-edit-outside-model: copy reproduces the source definition, and editing happens through the documented storage path since there is no composition editor in-extension. Presets carry no plugin rows and no `tools` subset; the extension composes one fixed plugin assembly, so those fields have nothing to select from.

The `@` menu stays empty in sessions without continuable children — absence of candidates is the designed quiet state, not a failure.

## Testing

`apps/extension/tests/composer-bar.spec.ts` covers menu assembly, word-boundary triggering, multi-word label parsing, and send routing (mention → `subagent.prompt`, no-match → fallback + notice). `apps/extension/tests/api-bridge.spec.ts` pins the preset lifecycle end to end: copy rejection/success → read → dangling broken row → makeDefault → `session.create` consumption (model override visible, system-prompt section in `assemble`) → select on a blank session and `agent-preset-locked` on a started one → remove rejection for builtin and dangling-default cleanup.
