---
description: "Consumer of the browser capability: the model-facing tabs_*/page_* tool schemas, config groups, prompt guidance, and result presentation over ctx.browser."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-browser

English | [中文](README.zh.md)

The model-facing browser tools: seventeen `tabs_*` / `page_*` tools over the `ctx.browser` capability seam, plus the system-prompt guidance that makes their snapshot-first addressing discipline usable.

## Summary

The model-facing browser tools: seventeen `tabs_*` / `page_*` tools over the `ctx.browser` capability seam, plus the system-prompt guidance that makes their snapshot-first addressing discipline usable.

## What it does

| Tool | Arguments | Summary |
|---|---|---|
| `tabs_list` | — | Lists every tab (id, title, URL, active marker). |
| `tabs_switch` | `tab_id` | Makes a tab active. |
| `tabs_open` | `url`, `active?` | Opens a new tab. |
| `tabs_close` | `tab_id` | Closes a tab. |
| `page_navigate` | `tab_id`, `url` | Navigates a tab; the render reminds the model to re-snapshot. |
| `page_back` | `tab_id` | Steps one entry back in the tab's session history (`navigated:false` at the boundary). |
| `page_forward` | `tab_id` | Steps one entry forward in the tab's session history (`navigated:false` at the boundary). |
| `page_snapshot` | `tab_id` | Header (title/URL/viewport) plus one line per element, capped at 40. |
| `page_click` | `tab_id`, `index` or `selector` | Resolves the element and clicks it, falling back to coordinates. |
| `page_type` | `tab_id`, `selector`, `text`, `submit?` | Types text into an input, optionally submitting. |
| `page_press_key` | `tab_id`, `key` | Enter/Tab/Escape/Backspace/arrows only. |
| `page_scroll` | `tab_id`, `direction`, `amount_px?` | Scrolls up or down. |
| `page_wait_for` | `tab_id`, `selector`, `timeout_ms?` (≤30000) | Waits for a selector to appear. |
| `page_extract_text` | `tab_id`, `selector?` | `innerText` of the page or one element, truncated at 4000 chars. |
| `page_evaluate` | `tab_id`, `expression` | Evaluates JavaScript in the page context and returns the value; the render JSON caps at 4000 chars. |
| `page_screenshot` | `tab_id`, `full_page?` | Captures the tab as PNG, commits it through the attachment service, and returns an image block; requires an image-capable model route. |
| `page_attach_screenshot` | `tab_id`, `selector`, `attachment_id?`, `filename?` | Writes a previously captured screenshot into a page file input and dispatches `input`/`change`; the bytes travel extension → page, never through the model. |

Both screenshot tools register only while an attachment store is mounted (`ctx.inject(['attachments'])`).

## Table of Contents

- [What it does](#what-it-does)
- [Addressing discipline](#addressing-discipline)
- [Configuration](#configuration)
- [Presentation](#presentation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Addressing discipline

`page_click` accepts either a snapshot `index` or a CSS `selector` (never both). The index path takes a FRESH `page_snapshot` and resolves the element; the selector path clicks directly, and on failure re-resolves through a snapshot. Either way, an element whose `selector` is empty (open shadow roots, same-origin iframes) — or whose selector click throws — is clicked by viewport `center` coordinates, and the canonical value reports which mode ran and why. `page_type` and `page_wait_for` are selector-only (they address inputs, not snapshot rows). Argument checks the JSON-schema layer cannot express throw Chinese errors, for example ``page_click 的 index 与 selector 只能提供一个``.

## Configuration

`tabs` and `page` toggle the two tool groups independently (both default `true`); disabling a group removes exactly its tools. The prompt section is registered unconditionally so the guidance matches whichever groups are visible.

## Presentation

Every tool renders a compact Chinese summary (the snapshot render is the exact ``[index] <tag> selector="..." text="..." center=(x,y)`` line format, with ``(shadow/iframe→用坐标)`` marking unaddressable elements) and contributes a generic pending card (`kind` picks the icon: `fetch` for navigation, `read` for snapshots/extract, `execute` for clicks/keys/evals, `edit` for typing, `delete` for closing). Read-only tools (`tabs_list`, `page_snapshot`) declare `isConcurrencySafe`; everything that mutates tab or page state does not — `page_evaluate` stays sequential because arbitrary page script may mutate anything.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`tabs_*`/`page_*` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-browser) — seventeen tools under the default config with an attachment store mounted; the screenshot pair is absent without one.

#### Token effect

Fixed schema cost on every request where the tools are visible; a config-disabled group removes exactly its slice.

#### KV Cache effect

Prefix-stable while definitions and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from these schemas.

### Browser operation system prompt

#### What the model sees

One system-prompt section, `tool:browser` (order 113), always registered with the plugin:

##### Guidance text

```markdown
你可以通过 tabs_*/page_* 工具操作用户的浏览器。操作准则：
(1) 快照优先：操作一个页面前先调用 page_snapshot 获取元素列表；导航、点击、输入等可能改变页面的操作之后，页面结构会变化，必须重新 page_snapshot 再继续，旧的 index/selector 不可再信。
(2) 元素定位：page_click 优先使用最近一次快照中的 index；元素也可用 CSS selector 定位（page_type / page_wait_for 只接受 selector）。
(3) 坐标回退：快照中 selector 为空（元素位于 shadow DOM 或 iframe 内）或 selector 点击失败时，page_click 会自动回退为按 center 视口坐标点击，无需你换工具。
(4) 提取文本用 page_extract_text；等待动态内容出现用 page_wait_for（给一个合理的 timeout_ms，默认由实现决定）；沿会话历史后退/前进一步用 page_back / page_forward（返回 navigated:false 表示已到边界，页面未变）。
(5) 跨页取证：需要到外部站点核实或搜集信息时（例如某名称不确定，要到 Google Maps 交叉核对），用 tabs_open 在新标签页打开来源站检索（可在 URL 中带搜索参数），用 page_snapshot / page_extract_text 提取候选结果（可能有多个，逐一记录名称、地址等关键字段），然后必须用 tabs_switch 切回原工作标签页继续任务，收尾用 tabs_close 关闭取证标签页。不要在取证标签页里遗留任务。
(6) 留证截图：需要保留页面证据时用 page_screenshot 截图，图片会返回到你的上下文中，回答时注明它来自哪个页面（写明 URL）；跨页取证的关键结论配截图更有说服力。需要把截图作为证据交给网页表单（<input type="file"> 文件输入框）时，用 page_attach_screenshot 提供 page_screenshot 结果里的 attachment_id 和该输入框的 selector（先 tabs_switch 回表单所在标签页）。
```

#### Token effect

Fixed cost while the plugin is loaded; the section is registered even when a tool group is disabled.

#### KV Cache effect

Prefix-stable; loading or disposing this plugin shifts the request prefix by exactly this section.

### Tool-call history and result

#### What the model sees

Each call logs its arguments (a `page_snapshot` argument list is just `tab_id`). Successes render the compact Chinese summaries — the snapshot render caps at 40 element lines plus a truncation note, and `page_extract_text` / `page_evaluate` cap at 4000 characters plus a truncation hint. Stable failures are the seam's Chinese provider errors and this package's defensive checks, for example ``page_click：快照中没有 index 为 99 的元素（共 2 个）——页面可能已变化，请重新 page_snapshot``.

#### Token effect

Growth scales with snapshot sizes (≤40 lines), extracted text (≤4000 chars), and evaluated results (≤4000 chars); both caps bound one call's contribution.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **`page_attach_screenshot` is selector-only and engine-lifetime** — it addresses top-frame `<input type="file">` elements (no shadow/iframe targeting, shared with `page_type`) and draws on an in-memory capture cache that an engine restart empties; the miss refuses with re-capture guidance rather than silently re-shooting the wrong page.
- **`page_extract_text` cannot cross shadow/iframe boundaries** — it evaluates one `document.querySelector` in the top frame; shadow-scoped extraction is deferred to a provider-side deep-query API.
- **No iframe/tab-tree-aware snapshot pagination** — the 40-element cap truncates without rank-ordering interactive elements; smarter filtering (interactive-first) is deferred.
- **Prompt and render text is Chinese-first** — matching this package's Chinese error contract; localized prompt variants are deferred with the harness's broader i18n of model-facing text.
- **`page_wait_for` cannot cancel mid-wait** — the provider contract takes no `AbortSignal`, so outer call cancellation surfaces only after the provider wait settles.

### Dev Note

Tool names and schemas live only here — the seam never grows model-facing surface. The screenshot pair is attachments-conditional, so catalog harvests mount the seam marker store (see `gen-tool-catalog`). Every mutating tool withholds `isConcurrencySafe`; keep it that way when adding tools. Agreed deferrals live in [Known Limitations and Deferred Work](#known-limitations-and-deferred-work).
