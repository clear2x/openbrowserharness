# Agent Note: OpenBrowserHarness — establishing the fork as an independent project

Status: implemented

English | [中文](2026-09-10-openbrowserharness-independence.zh.md)

## Problem

The OpenBrowserHarness extension (Chrome/Edge MV3 host, browser capability packages, humanized CDP input, visible virtual cursor) lived only as untracked files on one machine, with no README of its own — the repository root still presented as upstream DeepSeek Harness. Nothing told a visitor what the fork is, that it is based on dsh, how to install it, or where its deliberate deviations from upstream are logged. Data flowing through the extension (page content to user-configured LLM endpoints, keys in `chrome.storage.local`) was stated nowhere.

## Decision

OpenBrowserHarness is an **independent project**: a browser-agent extension based on dsh (forked at `0.1.0-rc.5`), not a plugin of the upstream monorepo and not on its release train. The relationship is declared in the root README ("Relationship with upstream") and bounded by three seams: (1) **inherited core** — `packages/`, `vendor/`, `apps/cli`, `apps/web` keep the upstream layout and `@deepseek-ai/dsh-*` package names (identifiers only; this project publishes nothing to npm); (2) **extension host** — `apps/extension` is the product: the dsh engine mounted in Chrome/Edge MV3 (offscreen + sandbox + side panel) plus the browser capability packages (`packages/browser`, `fs-opfs`, `session-persistence-indexeddb`); (3) **deliberate upstream modifications** — every edit to inherited code is logged where the modification lives (vendored Cordis changes in `vendor/README.md`, extension-era `packages/*` changes in this tree).

Supporting changes: the root README is project-facing and says "based on dsh" up front; LICENSE carries the fork copyright over upstream's; PRIVACY.md and SECURITY.md state the extension's data flow and reporting policy; the git remote is renamed `origin` → `upstream`; package identities are `openbrowserharness-root` / `openbrowserharness-extension` while inherited `@deepseek-ai/dsh-*` inner names stay; Dependabot majors are ignored for js-yaml (the vendored `!!js` dialect is built on the v4 custom-type API), react/@types/react (the SidePanel styling pins React 18 via the vendored @appica/ui-react patch), and vite (majors are config migrations).

## Alternatives considered

Renaming all `@deepseek-ai/dsh-*` packages to a project-owned scope: rejected — it would rewrite every cross-package import and every future upstream merge for zero functional gain; the README documents the inheritance instead. Contributing the extension to upstream instead of forking: rejected for now — the upstream release train and enterprise-runner CI assume a different lifecycle; this fork ships a browser extension with its own deployment chain. Serving docs only from the inherited upstream site: rejected — the browser seam is this fork's product surface and gets its own subsystem page; the lean docs workflow carries its own deploy.

## Consequences

A fresh GitHub clone is the complete project: `pnpm install`, `pnpm run build:lib`, `pnpm run build:extension` produce a loadable extension (verified end-to-end from a fresh clone of the pushed repo). Every future `merge` from upstream re-fights the recorded deviations — which is why they are logged where the modifications live rather than in a tracker that can drift. The docs site deploy is gated on the `DOCS_PAGES_ENABLED` repository variable because the free plan has no Pages for private repositories; flipping the variable after the repo goes public is the entire enablement.

## Related

- [DeepSeek Harness upstream](https://github.com/deepseek-ai/deepseek-harness)
- [PRIVACY.md](../../../../PRIVACY.md), [SECURITY.md](../../../../SECURITY.md)
