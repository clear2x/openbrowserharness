# @deepseek-ai/dsh-tool-browser

English | [中文](README.zh.md)

The model-facing browser tools: thirteen `tabs_*` / `page_*` tools over the `ctx.browser` capability seam, plus the system-prompt guidance that makes their snapshot-first addressing discipline usable.

## What it does

| Tool | Arguments | Summary |
|---|---|---|
| `tabs_list` | — | Lists every tab (id, title, URL, active marker). |
| `tabs_switch` | `tab_id` | Makes a tab active. |
| `tabs_open` | `url`, `active?` | Opens a new tab. |
| `tabs_close` | `tab_id` | Closes a tab. |
| `page_navigate` | `tab_id`, `url` | Navigates a tab; the render reminds the model to re-snapshot. |
| `page_snapshot` | `tab_id` | Header (title/URL/viewport) plus one line per element, capped at 40. |
| `page_click` | `tab_id`, `index` or `selector` | Resolves the element and clicks it, falling back to coordinates. |
| `page_type` | `tab_id`, `selector`, `text`, `submit?` | Types text into an input, optionally submitting. |
| `page_press_key` | `tab_id`, `key` | Enter/Tab/Escape/Backspace/arrows only. |
| `page_scroll` | `tab_id`, `direction`, `amount_px?` | Scrolls up or down. |
| `page_wait_for` | `tab_id`, `selector`, `timeout_ms?` (≤30000) | Waits for a selector to appear. |
| `page_extract_text` | `tab_id`, `selector?` | `innerText` of the page or one element, truncated at 4000 chars. |
| `page_evaluate` | `tab_id`, `expression` | Evaluates JavaScript in the page context and returns the value; the render JSON caps at 4000 chars. |

## Addressing discipline

`page_click` accepts either a snapshot `index` or a CSS `selector` (never both). The index path takes a FRESH `page_snapshot` and resolves the element; the selector path clicks directly, and on failure re-resolves through a snapshot. Either way, an element whose `selector` is empty (open shadow roots, same-origin iframes) — or whose selector click throws — is clicked by viewport `center` coordinates, and the canonical value reports which mode ran and why. `page_type` and `page_wait_for` are selector-only (they address inputs, not snapshot rows). Argument checks the JSON-schema layer cannot express throw Chinese errors, for example ``page_click 的 index 与 selector 只能提供一个``.

## Configuration

`tabs` and `page` toggle the two tool groups independently (both default `true`); disabling a group removes exactly its tools. The prompt section is registered unconditionally so the guidance matches whichever groups are visible.

## Presentation

Every tool renders a compact Chinese summary (the snapshot render is the exact ``[index] <tag> selector="..." text="..." center=(x,y)`` line format, with ``(shadow/iframe→用坐标)`` marking unaddressable elements) and contributes a generic pending card (`kind` picks the icon: `fetch` for navigation, `read` for snapshots/extract, `execute` for clicks/keys/evals, `edit` for typing, `delete` for closing). Read-only tools (`tabs_list`, `page_snapshot`) declare `isConcurrencySafe`; everything that mutates tab or page state does not — `page_evaluate` stays sequential because arbitrary page script may mutate anything.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`tabs_*`/`page_*` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-browser) — thirteen tools, registered by the default config.

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
(4) 提取文本用 page_extract_text；等待动态内容出现用 page_wait_for（给一个合理的 timeout_ms，默认由实现决定）。
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

- **No screenshot tool** — the seam is text-snapshot-only this stage; a `page_screenshot` needs an attachment pipeline and is deferred with the extension provider.
- **`page_extract_text` cannot cross shadow/iframe boundaries** — it evaluates one `document.querySelector` in the top frame; shadow-scoped extraction is deferred to a provider-side deep-query API.
- **No iframe/tab-tree-aware snapshot pagination** — the 40-element cap truncates without rank-ordering interactive elements; smarter filtering (interactive-first) is deferred.
- **Prompt and render text is Chinese-first** — matching this package's Chinese error contract; localized prompt variants are deferred with the harness's broader i18n of model-facing text.
- **`page_wait_for` cannot cancel mid-wait** — the provider contract takes no `AbortSignal`, so outer call cancellation surfaces only after the provider wait settles.
