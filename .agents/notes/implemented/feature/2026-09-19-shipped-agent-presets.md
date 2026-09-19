# Agent Note: Shipped agent presets — six scenario disciplines, system trust

Status: implemented

English | [中文](2026-09-19-shipped-agent-presets.zh.md)

## Problem

The extension's preset face was fully wired — roster RPCs, the composer switcher, per-session apply and cold resume — but a fresh install listed only the implicit `default` row, so there was nothing to switch to. The scenario discipline this extension's real usage needs (research cross-verification, purchase confirmation gates, read-only monitoring, form-filling review) existed nowhere: every session started as the same general-purpose browsing agent.

## Decision

The extension ships six system-trust presets merged into every roster ahead of stored rows: `web-research` (网页研究员), `deal-hunter` (购物比价员), `video-ops` (视频号管家), `form-runner` (表单填写员), `page-monitor` (页面哨兵), and `dev-probe` (页面调试手). Each keeps the full engine tool set and the active model route — the scenario lives entirely in a prompt addendum that encodes its working discipline and hard stop conditions: cross-source verification with cited conclusions, confirmation before any order/payment or externally visible content, per-field read-back before any submit, read-only bounds for monitoring and probing. Shipped ids refuse `remove`/`openDocument` and cannot be taken by a copy, but copy freely into editable user rows; a stored row cannot shadow a shipped id (desktop first-root-wins). The UI needs no change — the switcher renders the roster it already fetched.

## Alternatives considered

- **Seeding chrome.storage on install.** Rejected: seeded rows become deletable user-trust rows, and versioning later preset content means storage migrations; static in-source rows ship with the extension and update with it.
- **Desktop-style plugin-composition presets** (`packages/preset/agent-presets`). Rejected for this host: MV3 has no filesystem to scan and no dynamic import, so per-preset plugin rows cannot mount; the wire vocabulary is already parity-mapped instead.
- **Route overrides per preset** (a preset pinning a specific provider/model). Left empty on purpose: presets follow the user's configured route, and a scenario that hard-depends on one model would break silently when that route disappears.

## Consequences

- A fresh roster lists seven rows (default + six shipped); the composer switcher, `session.create { agentPreset }`, and cold resume all pick them up unchanged.
- Scenario differentiation is prompt-only by design: a scenario needing a different tool set has no extension mechanism (the static module map admits no per-preset plugins), and this note records that limit, not a future promise.
- Coverage: the bridge spec pins the merged roster order and trust values, shipped-id copy/remove refusals, and the addendum reaching prompt assembly (the stored-preset path it already exercised).
