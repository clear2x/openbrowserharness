# Agent Note: smart model config — the ZCode rules engine, seed, and add-flow auto-detect

Status: implemented

English | [中文](2026-09-22-smart-model-config-port-implemented.zh.md)

Implements the first user-visible slice of the [proposed port](../../proposed/feature/2026-09-21-smart-model-config-port.md): 添加供应商, 添加模型, and 自动检测配置 now work from a bundled layered rules knowledge base.

## Shipped

- **Rules engine** (`ui-settings-models/src/client/model-rules.ts`): the ordered-overlay `resolve` from ZCode's `ModelConfigRules`, compacted to the fields this surface edits — id-pattern rules plus the api-type/base-URL gated layers, `^(?:pattern)$` case-insensitive matching, base-URL normalization (host case, default port, trailing slash), deep leaf overlay, and a compile guard that skips non-compiling patterns instead of failing the surface.
- **Bundled seed** (`model-rules-seed.json`, 41 KB): the provider-agnostic layers of ZCode's builtin release (revision 30) — 84 id-pattern model rules, 72 api-type-gated rules, and the 20 supplier templates with their conventional base URLs and wire protocols. The ZCode-specific layers (template-model, provider-site, exact provider ids) are deliberately not bundled.
- **Add-model auto-detect** (`ModelDialog`): after the model id idles 1.2 s, the bundled rules resolve and fill any field the user has not touched — context window, max output tokens, image input — with a 3.5 s feedback strip (已按内置模型知识库自动填写). The dialog receives the route's wire protocol and base URL so api-gated rules participate.
- **Add-supplier templates** (`NewProviderPanel`): a template chip row (Z.ai / BigModel / Kimi / MiniMax / DeepSeek / 阿里云百炼 / …) prefills base URL, wire protocol, and the display name while it is still blank.

## Deviations from the proposal

- The engine lives inside `ui-settings-models` (the only consumer today) instead of a new `llm-model-rules` package; promotion remains easy since the resolve face is pure.
- Resolution is client-local over the bundled seed: no Remote resolve seam (proposal stage 5), no remote release update loop (stage 6). The precedence rule — user-edited fields outrank rules — is enforced in-dialog by the touched-field tracking.
- The seed keeps ZCode's model-family facts wholesale (they are provider-agnostic) instead of generating rules from the pi-ai catalog.

## Verification

Package spec covers the folder (ordered kinds, failure coloring, unknown-type skip) plus dialog behavior with a mocked RPC; the real-device harness drives the actual wizard: template chip prefills bigmodel.cn, typing `glm-5.3-flash` auto-checks image input and shows the hint, and the draft commits with the detected values. Full extension suite, typecheck, lint green.
