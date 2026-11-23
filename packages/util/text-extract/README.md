---
description: "Deterministic extractive text compression for callers that must fit long text into a bounded budget."
kind: "package-library"
---

# dsh-util-text-extract

English | [中文](README.zh.md)

## Summary

One pure function, `compressToBudget`, that keeps the highest-signal blocks of a long text under a character budget instead of cutting a raw prefix. Headings always survive; sentences rank by keyword density, position, and length fit; a redundancy gate drops candidates that mostly repeat already-selected content (site footers, repeated notices). CJK bigrams and Latin words share one scoring path, so Chinese and English pages compress under the same rules. Output is a deterministic function of the input on every surface, which keeps a model-facing render replayable.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

It is a **library, not a service or plugin**: no `ctx`, registers nothing, depends on nothing.

```ts
import { compressToBudget } from '@deepseek-ai/dsh-util-text-extract'

declare const pageText: string // the rendered text of the page

const kept = compressToBudget(pageText, 4000)
```

<a id="api"></a>
## API

- `compressToBudget(text, budget)` — the compressed text, never longer than `budget`; text at or under the budget passes through untouched.
- `scoreBlocks(text)` — the scored block list (index, text, separator, score), exported for callers that want to inspect or reuse the ranking.
- `COMPRESSION_FOOTER` — the fixed English notice callers append after a compressed body; reserve its length from the budget.
- `DEFAULT_EXTRACT_BUDGET_CHARS` — the budget constant callers may reuse for consistency.

## Model Experience

Indirectly, through the tool renders that opt in (`web_fetch`'s `fetchExtractiveCompression` and `page_extract_text`'s `extractTextCompression`), whose compressed output carries the fixed footer telling the model the text is a selection.

#### KV Cache effect

None of its own. The compressed text rides the consuming tool's result turn, and the render stays a deterministic function of the tool result, so replays rebuild identical text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Frequency-based scoring, no language models** — a page whose signal lives in low-frequency proper nouns compresses worse than one whose signal is topical vocabulary; the tail guarantee keeps a sampled slot for a once-stated ending fact, but the selection remains statistical.
- **Fixed sentence terminators** — splitting covers `.` `!` `?` `。` `！` `？` `；` `;`; other terminators pass through inside blocks.

<a id="dev-note"></a>
### Dev Note

`scoreBlocks` is exported so tests and callers can inspect the ranking; the redundancy gate skips candidates whose term overlap with the selection exceeds 0.6, and short fragments (fewer than six terms) stay exempt because they lack the evidence to judge.
