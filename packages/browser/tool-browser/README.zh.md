# @deepseek-ai/dsh-tool-browser

[English](README.md) | 中文

模型侧浏览器工具：基于 `ctx.browser` 能力 seam 的十三个 `tabs_*` / `page_*` 工具，以及让「快照优先」寻址纪律可用的系统提示指引。

## 它做什么

| 工具 | 参数 | 摘要 |
|---|---|---|
| `tabs_list` | — | 列出全部标签页（id、标题、URL、活动标记）。 |
| `tabs_switch` | `tab_id` | 把某标签页设为活动。 |
| `tabs_open` | `url`、`active?` | 打开新标签页。 |
| `tabs_close` | `tab_id` | 关闭标签页。 |
| `page_navigate` | `tab_id`、`url` | 导航标签页；渲染会提醒模型重新快照。 |
| `page_snapshot` | `tab_id` | 头部（标题/URL/视口）加每元素一行，上限 40 行。 |
| `page_click` | `tab_id`、`index` 或 `selector` | 解析元素并点击，坐标回退。 |
| `page_type` | `tab_id`、`selector`、`text`、`submit?` | 在输入框输入文本，可选提交。 |
| `page_press_key` | `tab_id`、`key` | 仅接受 Enter/Tab/Escape/Backspace/箭头。 |
| `page_scroll` | `tab_id`、`direction`、`amount_px?` | 上/下滚动。 |
| `page_wait_for` | `tab_id`、`selector`、`timeout_ms?`（≤30000） | 等待 selector 出现。 |
| `page_extract_text` | `tab_id`、`selector?` | 页面或单个元素的 `innerText`，4000 字符截断。 |
| `page_evaluate` | `tab_id`、`expression` | 在页面上下文中执行 JavaScript 并返回结果值；渲染 JSON 上限 4000 字符。 |

## 寻址纪律

`page_click` 接受快照 `index` 或 CSS `selector`（二者只能选一）。index 路径会取一次**新的** `page_snapshot` 解析元素；selector 路径直接点击，失败时经快照重新解析。无论哪条路径，`selector` 为空的元素（开放 shadow root、同源 iframe）或 selector 点击抛错的元素，都会按视口 `center` 坐标点击，canonical value 会报告实际使用的模式与原因。`page_type` 与 `page_wait_for` 只接受 selector（它们寻址输入框而非快照行）。JSON-schema 层无法表达的参数检查抛出中文错误，例如 ``page_click 的 index 与 selector 只能提供一个``。

## 配置

`tabs` 与 `page` 分别开关两组工具（默认都为 `true`）；关闭一组恰好移除该组工具。prompt 小节无条件注册，使指引与可见工具组保持一致。

## 呈现

每个工具渲染一段紧凑的中文摘要（快照渲染就是 ``[index] <tag> selector="..." text="..." center=(x,y)`` 行格式，用 ``(shadow/iframe→用坐标)`` 标注不可寻址元素），并贡献一个通用 pending 卡片（`kind` 决定图标：导航为 `fetch`，快照/提取为 `read`，点击/按键/执行脚本为 `execute`，输入为 `edit`，关闭为 `delete`）。只读工具（`tabs_list`、`page_snapshot`）声明 `isConcurrencySafe`；所有改变标签页或页面状态的操作都不声明——`page_evaluate` 保持串行，因为任意页面脚本可能改动任何状态。

## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`tabs_*`/`page_*` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-browser)——默认配置注册十三个工具。

#### Token 影响

工具可见的每个请求承担固定 schema 开销；配置关闭一组恰好移除其份额。

#### KV Cache 影响

定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使这些 schema 的复用失效。

### 浏览器操作系统提示

#### 模型看到什么

一个系统提示小节 `tool:browser`（order 113），随插件始终注册：

##### 指引文本

```markdown
你可以通过 tabs_*/page_* 工具操作用户的浏览器。操作准则：
(1) 快照优先：操作一个页面前先调用 page_snapshot 获取元素列表；导航、点击、输入等可能改变页面的操作之后，页面结构会变化，必须重新 page_snapshot 再继续，旧的 index/selector 不可再信。
(2) 元素定位：page_click 优先使用最近一次快照中的 index；元素也可用 CSS selector 定位（page_type / page_wait_for 只接受 selector）。
(3) 坐标回退：快照中 selector 为空（元素位于 shadow DOM 或 iframe 内）或 selector 点击失败时，page_click 会自动回退为按 center 视口坐标点击，无需你换工具。
(4) 提取文本用 page_extract_text；等待动态内容出现用 page_wait_for（给一个合理的 timeout_ms，默认由实现决定）。
```

#### Token 影响

插件加载期间固定开销；即使关闭了某个工具组，该小节也照样注册。

#### KV Cache 影响

前缀稳定；加载或销毁本插件恰好以这一小节移动请求前缀。

### 工具调用历史与结果

#### 模型看到什么

每次调用记录其参数（`page_snapshot` 的参数只有 `tab_id`）。成功渲染紧凑中文摘要——快照渲染上限 40 行元素加截断提示，`page_extract_text` / `page_evaluate` 上限 4000 字符加截断提示。稳定失败是 seam 的中文 provider 错误与本包的防御检查，例如 ``page_click：快照中没有 index 为 99 的元素（共 2 个）——页面可能已变化，请重新 page_snapshot``。

#### Token 影响

增长与快照规模（≤40 行）、提取文本（≤4000 字符）和执行结果（≤4000 字符）成正比；两个上限约束单次调用的份额。

#### KV Cache 影响

仅追加；新可见内容跟在可复用请求前缀之后，不会使既有 KV-cache 条目失效。

## 已知限制与遗留工作

- **没有截图工具** —— 本阶段 seam 只有文本快照；`page_screenshot` 需要附件管线，随扩展 provider 一并推迟。
- **`page_extract_text` 不能穿越 shadow/iframe 边界** —— 它在顶层帧执行一次 `document.querySelector`；shadow 内提取推迟到 provider 侧深查询 API。
- **快照没有按 iframe/标签树分页** —— 40 元素上限截断时不做可交互优先排序；更聪明的过滤（interactive 优先）推迟。
- **Prompt 与渲染文本以中文为先** —— 与本包的中文错误契约一致；模型侧文本的本地化变体随 harness 更广的 i18n 推迟。
- **`page_wait_for` 不能中途取消** —— provider 契约不接受 `AbortSignal`，外层调用取消只能在 provider 等待结束后浮现。
