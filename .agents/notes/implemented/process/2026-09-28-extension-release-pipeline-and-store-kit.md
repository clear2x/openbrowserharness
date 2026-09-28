# Agent Note: extension release pipeline and the store submission kit

Status: implemented

English | [中文](2026-09-28-extension-release-pipeline-and-store-kit.zh.md)

## Problem

Store submission needs a reproducible release artifact and paste-ready listing material, and the repository had neither: no release workflow for the extension (the existing `release-publish.yml` publishes npm tarballs), no store listing copy, no privacy-policy page a reviewer can open, and no screenshots. The first released zip (`extension-v0.2.0`) also predated the session-deletion feature, so the store candidate had to be cut from a version that was never built.

## Decision

- **Release workflow** (`.github/workflows/extension-release.yml`): `extension-v*` tag push or manual dispatch; dispatch publishes the version from `apps/extension/package.json`. Each release carries the folder-wrapped zip for Load-unpacked users, a `.webstore.zip` with `manifest.json` at the archive root (what the store upload forms require), and `SHA256SUMS.txt`. The npm sequence keeps its `dsh-v*` tags; plain `v*` stays unused.
- **Store submission kit** (`docs/store/`, deliberately not projected onto the site): bilingual listing copy mapped field-by-field (names, measured-length summaries, detailed descriptions, single purpose), nine per-permission justifications, data-disclosure answers declaring that website content is transferred to the user-configured LLM endpoint, a remote-code statement, reviewer notes, and an asset table.
- **Rendered assets**: zh and en screenshot sets at exactly 1280x800 (branded HTML templates screenshotted per element via Playwright), optional CWS promo tile (440x280) and marquee (1400x560), and the 300x300 Edge logo rendered from the single-source `icon.svg` through resvg.
- **Reviewer notes** document the bundle scan: the only network endpoints are the user-configured providers (api.deepseek.com, open.bigmodel.cn by default), and all five `new Function` sites are Schemastery library paths — one try/catch `allowsEval` probe that degrades to jitless mode under the extension-page CSP, and four string-callback compilation sites double-guarded by `typeof === "string"` plus try/catch (unreachable with the bundled real-function configs). User plugins execute only in the manifest-declared sandbox page.
- **The shipped manifest speaks the product name** (v0.2.2): description and toolbar tooltip dropped the internal "dsh" shorthand a reviewer would see in `chrome://extensions`.

### Release SOP

Bump the version in root `package.json` (feeds the `__DSH_VERSION__` build shim), `apps/extension/package.json` (names the release), and `apps/extension/public/manifest.json` (ships in the package) — all three or none; update `CHANGELOG.md`; commit; push; tag `extension-vX.Y.Z`; push the tag. Verify by downloading the published checksums and the actual zip, not by trusting the run status.

### Smoke test

The published `.webstore.zip` itself loads into a real Edge via `launchPersistentContext` with a throwaway profile: service worker registration, the side-panel page booted to the welcome view, composer rendered. The panel composer is the shell's `textarea`, not a contenteditable — assertions assuming otherwise time out. The one console error (`cannot get required service "sessions" in inactive context`) is the known `AgentPresetSeatController` residual, not introduced by this build.

## Alternatives considered

**Shipping `.crx` files on releases.** Rejected: Chrome/Edge stable block off-store CRX installs on Windows and macOS (enterprise policy or Linux drag-drop aside), and the extension ID is derived from the packing key, so repacking without the persisted `.pepk` changes the ID and splits user data on update. A zip loads unpacked everywhere and is the exact artifact the stores accept.

**One zip only (no `.webstore.zip`).** Rejected: the store upload form wants `manifest.json` at the archive root while users want a folder; building both layouts from the same dist removes a manual re-zip step from every submission.

**A third-party release action (softprops/action-gh-release).** Rejected: `gh release create/upload` with the workflow token keeps the supply chain to first-party actions plus the preinstalled CLI, which matches the repository's release workflows.

**Packaging locally and uploading by hand.** Rejected: a tag-triggered CI build is reproducible and one click, and the local `dist` goes stale — the first smoke run mistakenly targeted the stale local build (still on 0.2.0) before being pointed at the published artifact.

## Consequences

Cutting a release is now one tag push, and the store candidate has been built, published, checksum-verified, and smoke-loaded. The costs: four version locations must move together (the v0.2.2 pass missed the manifest version because the same commit changed its description, and the tag had to be force-moved minutes later — safe for a minutes-old self-owned tag, re-running the workflow with clobbered assets); the kit's counts and copy need re-verification whenever the listing changes; and the reviewer-notes section must be kept honest against future bundle changes.
