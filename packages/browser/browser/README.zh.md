---
description: "浏览器能力的 Service Definition：ctx.browser provider 注册表、选择策略，以及 PageSnapshot/TabInfo/BrowserProvider 线路词汇。"
kind: "package-reference"
---

# @deepseek-ai/dsh-browser

[English](README.md) | 中文

**`BrowserRuntime`**（`ctx.browser`）定义 harness 拥有哪些浏览器自动化能力——标签页管理、页面导航、DOM 快照、拟人化输入——运行在注册的 provider 之上，而不把模型契约绑定到某一个环境的 API 形状。本包拥有 browser 能力族的 Service Definition 角色：

## 概述

**`BrowserRuntime`**（`ctx.browser`）定义 harness 拥有哪些浏览器自动化能力——标签页管理、页面导航、DOM 快照、拟人化输入——运行在注册的 provider 之上，而不把模型契约绑定到某一个环境的 API 形状。本包拥有 browser 能力族的 Service Definition 角色：

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-browser`（本包） | Service Definition：服务、provider 注册表、选择策略，以及 `PageSnapshot`/`TabInfo`/`BrowserProvider` 线路词汇 |
| `@deepseek-ai/dsh-tool-browser` | 消费者：基于 `ctx.browser` 的模型侧 `tabs_*` / `page_*` 工具 schema |
| apps/extension 的 CDP provider | Service Provider：通过扩展的 debugger 面操作真实 Chrome 标签页 |

Provider 注册的是**能力**，不是工具。`dsh-tool-browser` 是模型侧名称、描述、prompt 指引、JSON schema 与呈现的唯一所有者。

## 目录

- [服务 API（`ctx.browser`）](#服务-apictxbrowser)
- [选择](#选择)
- [词汇](#词汇)
- [模型体验](#模型体验)
- [已知限制与遗留工作](#已知限制与遗留工作)
- [开发备注](#开发备注)

## 服务 API（`ctx.browser`）

| 成员 | 语义 |
|---|---|
| `register(provider)` | 注册一个 provider。id 重复、id 非法或缺少必需函数成员时抛错。返回注销器，随调用 fiber 一同销毁。每次集合变化都会发出 `browser/provider-updated`。 |
| `provider` | 在访问时解析并返回当前 provider。解析失败时抛出中文 `Error`（见「选择」）。 |
| `providerIds` | 按注册顺序返回已注册 id——诊断/不变量视图；执行始终走 `provider`。 |

## 选择

选择永不依赖注册顺序。seam 接受显式 provider id（配置 `defaultProviderId`），或在恰好注册一个 provider 时自动选择：

| 情形 | 行为 |
|---|---|
| 配置的 id 已注册 | 运行该 provider |
| 配置的 id 未注册 | 抛错（配置的 defaultProviderId 未注册） |
| 无配置 id，恰好注册一个 provider | 运行它 |
| 无配置 id，没有任何 provider | 抛错（尚未注册任何浏览器 provider） |
| 无配置 id，注册了多个 provider | 抛错（歧义，列出候选并要求配置 defaultProviderId） |

当前阶段每个组合只搭载一个 provider，因此 id 路由仍是骨架，直到出现第二个 provider；上面的解析规则已经是终态。

## 词汇

`BrowserProvider` 是环境契约：`tabs`/`switchTab`/`openTab`/`closeTab` 负责标签页生命周期，`navigate`/`snapshot` 负责页面状态，`clickSelector`/`clickPoint`/`typeText`/`pressKey`/`scroll` 负责拟人化输入，`waitFor` 负责就绪等待，`evaluate` 负责页面脚本读取。所有坐标都是视口 CSS 像素。`PageSnapshot` 携带标签页头部、视口与每个可交互元素的一条 `PageElementInfo`，各含一个尽力而为的顶层文档 CSS `selector`——位于开放 shadow root 或同源 iframe 内的元素 `selector` 为空，必须用 `center`（坐标点击）寻址。Provider 方法失败时抛出带人类可读消息的 `Error`；结构化数据通过返回值带回。本包的 invariant 伴侣为 provider 作者导出 `validatePageSnapshot`/`validatePageElementInfo` 线路形状校验器，并检查 `browser/provider-updated` 事件契约。

## 模型体验

### 能力可用性

#### 模型看到什么

没有直接可见内容：本注册表不贡献任何 prompt 或 schema。模型可见效果属于 `dsh-tool-browser`——其十二个工具始终保持注册（并在本 seam 没有 provider 时以 seam 的中文 `Error` 失败，例如 ``browser：尚未注册任何浏览器 provider，无法执行浏览器操作``），因此 provider 可用性不会增删 tool-catalog 条目。

#### Token 影响

零直接 token 影响；由上述消费者持有全部 schema 与 prompt token。

#### KV Cache 影响

没有直接失效；由上述消费者持有任何请求前缀变化。

## 已知限制与遗留工作

- **单 provider 阶段** —— `defaultProviderId` 路由已存在，但尚无组合注册两个 provider；多 provider 语义（可用性排序、类似 web seam 的 search/fetch 按能力拆分）推迟到第二个真实 provider 出现时再做。
- **没有取消面** —— `BrowserProvider` 方法不接受 `AbortSignal`；长等待只受消费侧工具外围的工具调用超时策略约束，而非 seam 自身。
- **快照信任在调用方** —— seam 不在热路径上重校验 provider 快照；`validatePageSnapshot` 以 invariant/诊断工具的形式提供给 provider 与测试。
- **没有网络拦截或下载面** —— 请求拦截、抓取与文件下载不在本 seam 范围内，是扩展 provider 的既名遗留工作。

## 开发备注

选择与注册顺序无关，且在歧义或缺失时保持 fail-loud（中文 `Error`）；优先扩展 `BrowserProvider`，而不是放宽这些检查。快照校验以不变式伴随插件（`validatePageSnapshot`/`validatePageElementInfo`）提供，而非热路径重校验，因此线路形状问题由 provider 作者而非 seam 负责。既定延期项见[已知限制与遗留工作](#已知限制与遗留工作)。
