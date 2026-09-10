# OpenBrowserHarness

English | [中文](README.zh.md)

OpenBrowserHarness is an open-source **browser-agent extension** (Chrome/Edge MV3): a full agent harness runs inside the browser and drives real pages for you — navigating, scrolling, filling forms, extracting content — with humanized input and a visible cursor, under your approval.

**This project is based on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)**, an open-source agent harness by DeepSeek AI. It is an independent fork that repackages the dsh engine as a browser extension and extends it with a browser-automation capability layer. See [Relationship with upstream](#relationship-with-upstream) for details.

## What it does

- **Agent in the sidebar** — chat with an agent in the Edge/Chrome side panel; it plans, calls tools, tracks todos, and reports back.
- **Humanized browser control** — Bezier-curve mouse moves with speed jitter, per-keystroke typing, inertial scrolling, landing-point jitter. Driven through `chrome.debugger` (CDP), no OS-level automation.
- **Visible virtual cursor** — a neon comet cursor, motion trail, click shockwaves, and keystroke/scroll pulses render in the page so you can watch every action.
- **Deep page reading** — snapshots pierce Shadow DOM and iframes; screenshot tool for multimodal models; in-page evaluation for verification.
- **Bring your own model** — DeepSeek, 智谱 BigModel / GLM Coding Plan, and any OpenAI-compatible, Anthropic-protocol, or local Ollama endpoint. Keys stay in local extension storage.
- **You stay in control** — three permission tiers (ask every action / ask on changes / full access), per-action approval cards, session logs exportable for audit.
- **dsh feature set** — skills, plan mode, goals/todos, subagents, session persistence — inherited from the harness (see [docs](docs/)).

## Status

Early developer preview. Expect breaking changes.

## Install from source

Requirements: Node.js ^22.19 or ≥24, pnpm.

Build the workspace libs the extension bundles first, then the extension itself:

```sh
git clone <this-repository> openbrowserharness
cd openbrowserharness
pnpm install
pnpm run build:lib
pnpm run build:extension
```

Then in Chrome/Edge: open `edge://extensions` (or `chrome://extensions`), enable **Developer mode**, **Load unpacked**, and select `apps/extension/dist`. Open the side panel, pick a provider in Settings, and paste your API key.

## Repository layout

The dsh monorepo layout is preserved — see [AGENTS.md](AGENTS.md) for the map. The extension lives in [`apps/extension`](apps/extension/README.md); everything under `packages/` and `vendor/` is the inherited harness.

## Relationship with upstream

- Forked from [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) at `0.1.0-rc.5`; upstream is tracked as the `upstream` remote.
- Internal workspace packages keep their inherited `@deepseek-ai/dsh-*` names (identifiers only — nothing here is published to npm by this project).
- Upstream modifications made for the extension host are logged in [vendor/README.md](vendor/README.md) (vendored Cordis) and the `.agents/notes/` tree.

## License

[MIT](LICENSE) — with third-party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Privacy notes for the extension: [PRIVACY.md](PRIVACY.md).
