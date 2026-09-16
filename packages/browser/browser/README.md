---
description: "Service Definition of the browser capability: the ctx.browser provider registry, selection policy, and the PageSnapshot/TabInfo/BrowserProvider wire vocabulary."
kind: "package-reference"
---

# @deepseek-ai/dsh-browser

English | [中文](README.zh.md)

The **`BrowserRuntime`** (`ctx.browser`) defines WHAT browser automation the harness has — tab management, page navigation, DOM snapshots, humanized input — over registered providers, without binding the model contract to one environment's API shape. This package owns the Service Definition role of the browser capability family:

## Summary

The **`BrowserRuntime`** (`ctx.browser`) defines WHAT browser automation the harness has — tabs, navigation, snapshots, humanized input — over registered providers, never binding the model contract to one environment's API shape. This package is the family's Service Definition:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-browser` (this) | Service Definition: the service, provider registry, selection policy, vocabulary |
| `@deepseek-ai/dsh-tool-browser` | Consumer: the model-facing `tabs_*` / `page_*` tool schemas over `ctx.browser` |
| apps/extension's CDP provider | Service Provider: drives real Chrome tabs via the debugger |

Providers register **capabilities**, not tools: model-facing names, schemas, and presentation live only in `dsh-tool-browser`.

## Table of Contents

- [Service API (`ctx.browser`)](#service-api-ctxbrowser)
- [Selection](#selection)
- [Vocabulary](#vocabulary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Service API (`ctx.browser`)

| Member | Semantics |
|---|---|
| `register(provider)` | Register a provider. Throws on a duplicate id, a malformed id, or a provider missing required function members. Returns a disposer; disposed with the calling fiber. Every set change emits `browser/provider-updated`. |
| `provider` | Resolve and return the active provider at access time. Throws a Chinese `Error` when resolution fails (see Selection). |
| `providerIds` | Registered ids in registration order — a diagnostic/invariant surface; execution always goes through `provider`. |

## Selection

Selection never depends on registration order. The seam takes an explicit provider id (config `defaultProviderId`), or auto-selects when exactly one provider is registered:

| Situation | Execution |
|---|---|
| configured id registered | runs that provider |
| configured id not registered | throws（配置的 defaultProviderId 未注册） |
| no id, exactly one registered provider | runs it |
| no id, none registered | throws（尚未注册任何浏览器 provider） |
| no id, several registered providers | throws（歧义，列出候选并要求配置 defaultProviderId） |

The current stage ships one provider per composition, so the id routing stays a skeleton until a second provider exists; the resolution rules above are already final.

## Vocabulary

`BrowserProvider` is the environment contract: `tabs`/`switchTab`/`openTab`/`closeTab` for tab lifecycle, `navigate`/`snapshot` for page state, `clickSelector`/`clickPoint`/`typeText`/`pressKey`/`scroll` for humanized input, `waitFor` for readiness, and `evaluate` for page-script reads. All coordinates are viewport CSS pixels. A `PageSnapshot` carries the tab header, viewport, and one `PageElementInfo` per interactive element, each with a best-effort top-document CSS `selector` — elements inside open shadow roots or same-origin iframes carry an empty `selector` and must be addressed by `center` (position click). Provider methods throw `Error` with human-readable messages on failure; structured data comes back as return values. The package invariant companion exports `validatePageSnapshot`/`validatePageElementInfo` wire-shape validators for provider authors and checks the `browser/provider-updated` event contract.

## Model Experience

### Capability availability

#### What the model sees

Nothing directly: this registry contributes no prompt or schema. Model-visible effects belong to `dsh-tool-browser`, whose twelve tools stay registered (and fail with the seam's Chinese `Error`, for example ``browser：尚未注册任何浏览器 provider，无法执行浏览器操作``) whenever this seam has no provider, so provider availability never adds or removes tool-catalog entries.

#### Token effect

Zero direct token effect; the named consumer owns every schema and prompt token.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Single-provider stage** — `defaultProviderId` routing exists but no composition registers two providers yet; multi-provider semantics (availability ordering, per-capability splits like the web seam's search/fetch) are deferred until a second real provider motivates them.
- **No cancellation surface** — `BrowserProvider` methods take no `AbortSignal`; long waits are bounded only by the tool-call timeout policy wrapping the consumer's tools, not by the seam.
- **Snapshot trust is caller-side** — the seam does not revalidate provider snapshots on the hot path; `validatePageSnapshot` ships as an invariant/diagnostic tool for providers and tests instead.
- **No network interception or download surface** — request blocking, harvesting, and file downloads are out of scope of this seam and named deferred work for the extension provider.

### Dev Note

Selection is order-independent by design and stays fail-loud (Chinese `Error`) on ambiguity or absence; prefer extending `BrowserProvider` over weakening those checks. Snapshot validation ships as the invariant companion (`validatePageSnapshot`/`validatePageElementInfo`) rather than a hot-path revalidation, so provider authors — not the seam — own wire-shape bugs. See [Known Limitations and Deferred Work](#known-limitations-and-deferred-work) for the agreed deferrals.
