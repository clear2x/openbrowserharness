---
description: "浏览器能力包族：提供方无关的 ctx.browser seam、扩展 CDP 提供方，以及面向模型的标签页/页面工具。"
kind: "package-group"
---

# browser/ — 浏览器能力族

[English](README.md) | 中文

本能力族给 harness 一双在真实浏览器里的眼睛和手：提供者中立的标签页与页面自动化 seam（`ctx.browser`）、由 `apps/extension` 组装的 Chrome 扩展 CDP provider，以及消费该 seam 的模型侧工具。

| 包 | 角色 | ctx key |
|---|---|---|
| [`browser/`](browser/README.md) | Service Definition：provider 注册表、选择策略，以及 `PageSnapshot`/`TabInfo`/`BrowserProvider` 线路词汇 | `ctx.browser` |
| [`tool-browser/`](tool-browser/README.md) | 消费者：模型侧 `tabs_*` / `page_*` 工具与「快照优先」的浏览器指引 | registers on `ctx.tools` |

seam/provider/consumer 的拆分沿用 [`web/`](../web/README.md) 能力族的模式：provider 在唯一的选择策略所有者上注册能力（而非工具），工具包持有全部模型侧名称、schema、prompt 小节与呈现。扩展的 CDP provider 位于 `packages/` 之外，因为它随应用打包发布而非库。
