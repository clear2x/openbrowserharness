---
description: "浏览器能力包族：提供方无关的 ctx.browser seam、扩展 CDP 提供方，以及面向模型的标签页/页面工具。"
kind: "package-group"
---

# browser/ — 浏览器能力族

[English](README.md) | 中文

## Summary

本能力族给 harness 一双在真实浏览器里的眼睛和手：提供者中立的 `ctx.browser` seam、由扩展组装的 CDP provider，以及消费该 seam 的模型侧工具。

| 包 | 角色 | ctx key |
|---|---|---|
| [`browser/`](browser/README.zh.md) | Service Definition：provider 注册表、选择策略、线路词汇 | `ctx.browser` |
| [`tool-browser/`](tool-browser/README.zh.md) | 消费者：模型侧 `tabs_*` / `page_*` 工具 | registers on `ctx.tools` |

拆分沿用 [`web/`](../web/README.zh.md) 能力族的模式：provider 注册能力；工具包持有全部模型侧名称、schema 与呈现。CDP provider 随应用打包发布，不在 `packages/` 内。

## Related documentation

- [浏览器子系统](../../docs/subsystems/browser.zh.md)——本能力族实现的操作门面、快照词汇、拟人输入与 seam/provider/consumer 拆分。
