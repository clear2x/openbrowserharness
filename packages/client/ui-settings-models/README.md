---
description: "Models settings and product-onboarding plugin: the ZCode-style provider rail and form plus the versioned internal-testing notice."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-models

English | [中文](README.zh.md)

The rail has two groups. 官方 lists the single shipped preset (DeepSeek); 自定义供应商 lists every hand-declared route stored in the `llm-pi-ai` namespace; a ghost 「+ 添加供应商」 chip closes it. Each row paints its key state as an 8px status dot: green when the provider can serve requests — its named credential is stored, or its profile names no reference and the route is live (provider-native authentication owes no key) — and gray otherwise. A settled 测试连接 verdict repaints the selected row green for the session, and a red failure text stays beside the form; a whole-section route's key reference comes from its namespace's base layer and its configured fact from the namespace's secret envelope. Below 560px of section width (a container query — the settings panel is 380–800px wide) the rail becomes a horizontally scrolling chip strip above the form.

The right pane renders one of three forms. The official DeepSeek form is a single write-only **API key** input stored through `credentials.set` under `DEEPSEEK_API_KEY`, plus 「测试连接」, which asks `llm.discoverModels` about the endpoint the settings join reports (the public endpoint unless a deployment overrode it) with the typed key; a green verdict reads `✓ 可用 · N 个模型` and a failure shows the host's message in red. A declared route's form keeps the **route id readonly** — it is the settings key, the credential stem, and the name every logged session references — and edits the profile in place: display name, Base URL, API key, wire protocol as three selectable cards (`Anthropic Messages (/v1/messages)` ↔ `anthropic`, `Chat Completions (/chat/completions)` ↔ `openai`, `Responses (/responses)` ↔ `openai-responses`, choices read from the namespace's own schema), and custom request headers as one `headersText` textarea. Edits land as minimal `settings.mutate` path ops, so profile fields the form does not show survive. The add-supplier wizard derives the route id from the display name (`slugOfName`), and gates every create field locally — route-id shape and uniqueness, public-HTTP Base URL, at least one model — so the refusal names the field in Chinese while the user is still looking at it; custom headers are deliberately an edit-panel field, not a wizard one. Models are drafted through an inline 「+ 添加模型」 mini-dialog (model ID, context window defaulting to 1,000,000, max output tokens defaulting to 128,000, and the input modality toggles — text fixed-checked, image optional, the declaration storing `input: ["text", "image"]`; output is text-only and displayed as fixed; a bad row is judged in place) and commit with the form: one `settings.mutate` writes the whole profile at `providers.<route>`, then the typed key travels through `credentials.set` under the derived `<ROUTE>_API_KEY` reference, which the profile records as `apiKeyEnv` only when a key was typed. A keyless route therefore keeps provider-native authentication.

Every settings write carries the panel's current `revision`, so a concurrent write from another tab or an external `settings.yaml` edit is refused as `settings-conflict`; a route declared with the key left blank materializes no credential reference at all. A typed API key is judged on its own field: after trimming, every character must be printable ASCII (`[\x21-\x7E]`), the twin of `normalizeApiKey` in `@deepseek-ai/dsh-llm`, mirrored here because the source-plane split forbids importing it; a pasted `NAME=value` environment line or a quoted value is refused as the same format failure, and a whitespace-only field fails rather than being silently dropped. 测试连接 is refused locally while the key field holds nothing usable, so the page never spends a round trip to be told what the field already says. For a declared route the host attaches the route's stored custom headers to the interrogation, so it travels the way a real request will. Deletion of a declared route requires confirmation and removes a configured, writable credential only when the profile names the page's derived `<ROUTE>_API_KEY` target, then unsets the profile; both operations are idempotent, and a partial failure remains in the confirmation dialog for retry. Once loaded, the page subscribes directly to forwarded `settings/document-updated`, `credentials/updated`, and `llm/adapters-updated` owner events, plus local `connection/reset`, so an external edit or a second tab converges without polling.

The notice step owns its exact copy and version in `src/onboarding-copy.ts`. On loopback it compares and writes `ui-onboarding.welcomeNoticeVersion` through the existing settings API; only an explicit Continue records the current version. A non-loopback browser cannot use that Host-only namespace, so acknowledgement is process-local and the notice returns after reload.

## Summary

Models settings and product-onboarding plugin. The same client Cordis plugin registers the Models page — a provider manager laid out like ZCode's: a left rail of providers beside the selected provider's form — plus the versioned internal-testing notice. The Models plane joins three wire domains into one shared snapshot — `llm.providers` (the configurable-provider directory with each route's live/dormant state), `settings.describe` (serialized schemas, layered redacted values, secret slots), and `credentials.describe` (value-free configured/source/writable badges) — and renders the selection in one form at a time, without presenting route liveness as provider status.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Dev Note

This package is a fork addition evolving with the extension release cadence; keep the page contents and the table of contents in sync when the surface changes.

## Model Experience

None, as the section renders a browser configuration UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Only the fields the forms show are editable on the page** — the official route's Base URL and model catalog, reasoning effort, and other advanced fields remain in `settings.yaml`. A profile's hidden fields survive edits because writes are path ops, but there is no control for them here.
- **The wire protocol cards are only a chooser** — the availability probe always interrogates the OpenAI-compatible `GET {baseURL}/models` shape (the host's one listing format), so an Anthropic-protocol gateway that cannot answer it reports failure even when chat would work; models are entered by hand through the mini-dialog.
- **headersText drafts are not probed** — the host attaches a declared route's STORED headers to an interrogation, so an edited-but-unsaved header line reaches the endpoint only after Apply.
- **Credential cleanup is intentionally narrow** — deleting a route removes the configured, writable credential only when its reference is the exact `<ROUTE>_API_KEY` target this page derives. Custom references, environment credentials, and unidentifiable targets are retained because the row cannot prove ownership of them.
- **Only pi-ai routes can be hand-declared** — the wizard writes into `llm-pi-ai`, the one namespace whose profiles describe a whole provider. A `llm-deepseek` route is a composition fact, not something this page can create.
- **Undeclared live routes render nowhere** — a route registered without a configurable-provider declaration has no settings address; it stays visible in pickers but not on this page's rail.
