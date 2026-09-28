# Agent Note: smart model config — the ZCode rules engine, seed, and add-flow auto-detect

Status: implemented

English | [中文](2026-09-22-smart-model-config-port-implemented.zh.md)

## Problem

Adding a model to a provider route is fully manual: the pi-ai catalog supplies defaults only for exact ids it happens to know, so renamed upstreams, gateway aliases, and beta suffixes need `contextWindow`, `maxTokens`, modalities, and reasoning efforts typed by hand, and the editor gives no notion of a recommended value (the [proposed port](../../proposed/feature/2026-09-21-smart-model-config-port.md) states the full case). This note ships the port's first user-visible slice: 添加供应商, 添加模型, and 自动检测配置 now work from a bundled layered rules knowledge base.

## Decision

- **Rules engine** (`ui-settings-models/src/client/model-rules.ts`): the ordered-overlay `resolve` from ZCode's `ModelConfigRules`, compacted to the fields this surface edits — id-pattern rules plus the api-type/base-URL gated layers, `^(?:pattern)$` case-insensitive matching, base-URL normalization (host case, default port, trailing slash), deep leaf overlay, and a compile guard that skips non-compiling patterns instead of failing the surface.
- **Bundled seed** (`model-rules-seed.json`, 41 KB): the provider-agnostic layers of ZCode's builtin release (revision 30) — 84 id-pattern model rules, 72 api-type-gated rules, and the 20 supplier templates with their conventional base URLs and wire protocols. The ZCode-specific layers (template-model, provider-site, exact provider ids) are deliberately not bundled.
- **Add-model auto-detect** (`ModelDialog`): after the model id idles 1.2 s, the bundled rules resolve and fill any field the user has not touched — context window, max output tokens, image input — with a 3.5 s feedback strip (已按内置模型知识库自动填写). The dialog receives the route's wire protocol and base URL so api-gated rules participate.
- **Add-supplier templates** (`NewProviderPanel`): a template chip row (Z.ai / BigModel / Kimi / MiniMax / DeepSeek / 阿里云百炼 / …) prefills base URL, wire protocol, and the display name while it is still blank.

## Deviations from the proposal

- The engine lives inside `ui-settings-models` (the only consumer today) instead of a new `llm-model-rules` package; promotion remains easy since the resolve face is pure.
- Resolution is client-local over the bundled seed: no Remote resolve seam (proposal stage 5), no remote release update loop (stage 6). The precedence rule — user-edited fields outrank rules — is enforced in-dialog by the touched-field tracking.
- The seed keeps ZCode's model-family facts wholesale (they are provider-agnostic) instead of generating rules from the pi-ai catalog.

## Alternatives considered

**A new `llm-model-rules` package for the engine.** Lost for now: `ui-settings-models` is the only consumer today, and the resolve face is pure, so promotion into a package remains a mechanical move when a second consumer appears.

**The proposal's Remote resolve seam and remote release update loop (stages 5 and 6).** Lost for this slice: resolution runs client-local over the bundled seed, which ships no update path — the trade is recorded under Consequences.

**Generating the seed from the installed pi-ai catalog.** Lost: the seed keeps ZCode's model-family facts wholesale because they are provider-agnostic, whereas catalog-generated rules would only restate the exact-id knowledge the catalog already ships.

## Consequences

The knowledge base moves at rebuild speed, not npm-release or remote-update speed: the seed is frozen at ZCode builtin revision 30 until someone regenerates it, and the ZCode-specific layers (template-model, provider-site, exact provider ids) do not apply. The user-edited-fields-outrank-rules precedence lives in the dialog's touched-field tracking rather than a server-side rule. The bundle carries the 41 KB seed. In exchange, the three manual-config gaps close for the bundled providers, and the precedence contract is testable entirely client-side.

## Verification

Package spec covers the folder (ordered kinds, failure coloring, unknown-type skip) plus dialog behavior with a mocked RPC; the real-device harness drives the actual wizard: template chip prefills bigmodel.cn, typing `glm-5.3-flash` auto-checks image input and shows the hint, and the draft commits with the detected values. Full extension suite, typecheck, lint green.
