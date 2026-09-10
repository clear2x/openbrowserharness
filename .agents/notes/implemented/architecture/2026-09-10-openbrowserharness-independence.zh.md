# Agent Note：OpenBrowserHarness——确立 fork 为独立项目

Status: implemented

[English](2026-09-10-openbrowserharness-independence.md) | 中文

## 问题

OpenBrowserHarness 扩展（Chrome/Edge MV3 宿主、浏览器能力包、拟人化 CDP 输入、可视化虚拟光标）此前只存在于一台机器上的未跟踪文件中，仓库根目录仍呈现为上游 DeepSeek Harness。没有任何信息告诉访问者这个 fork 是什么、它基于 dsh、如何安装，或者它对上游的有意偏离登记在哪里。扩展中流动的数据（页面内容发往用户配置的 LLM 端点、密钥存于 `chrome.storage.local`）也没有任何声明。

## 决策

OpenBrowserHarness 是一个**独立项目**：基于 dsh 的浏览器智能体扩展（fork 自 `0.1.0-rc.5`），不是上游 monorepo 的插件，也不跟随其发布节奏。关系在根 README（"与上游的关系"章节）声明，并由三条边界约束：(1) **继承核心** —— `packages/`、`vendor/`、`apps/cli`、`apps/web` 保留上游布局与 `@deepseek-ai/dsh-*` 包名（仅标识符；本项目不向 npm 发布任何包）；(2) **扩展宿主** —— `apps/extension` 是本项目的产品：挂载于 Chrome/Edge MV3 的 dsh 引擎（offscreen + sandbox + 侧边栏）及浏览器能力包（`packages/browser`、`fs-opfs`、`session-persistence-indexeddb`）；(3) **有意的上游修改** —— 对继承代码的每一处修改都有登记：vendored Cordis 的改动在 `vendor/README.md`，扩展时期对 `packages/*` 的改动在本目录的 Agent Notes 树。

配套变更：根 README 面向项目本身并开头声明"基于 dsh"；LICENSE 在上游版权行之上加 fork 版权行；PRIVACY.md 与 SECURITY.md 声明扩展的数据流与报告策略；git remote 更名 `origin` → `upstream`；包标识为 `openbrowserharness-root` / `openbrowserharness-extension`，继承的 `@deepseek-ai/dsh-*` 内部包名保留；Dependabot 大版本忽略 js-yaml（vendored `!!js` 方言基于 v4 自定义类型 API）、react/@types/react（侧边栏样式经 vendored @appica/ui-react patch 钉在 React 18）、vite（大版本属配置迁移）。

## 备选方案

将所有 `@deepseek-ai/dsh-*` 包重命名为项目自有 scope：否决——会重写所有跨包导入和未来每次上游合并，零功能收益；README 记录继承关系即可。向上游贡献扩展而非 fork：现阶段否决——上游发布节奏与企业 runner CI 假设了不同的生命周期；本 fork 发布的是自带部署链的浏览器扩展。文档仅从继承的上游站点提供：否决——浏览器 seam 是本 fork 的产品面，应有自己的子系统页；精简 docs workflow 自带部署。

## 影响

全新 GitHub clone 即完整项目：`pnpm install`、`pnpm run build:lib`、`pnpm run build:extension` 可产出可加载的扩展（已从推送仓库的全新 clone 端到端验证）。未来每次 `merge` 上游都要重战已登记的偏离——这正是偏离登记在修改所在处而非独立追踪文件的原因。docs 站点部署由 `DOCS_PAGES_ENABLED` 仓库变量门控：免费计划对 private 仓库不提供 Pages；仓库转公开后翻转该变量即为全部启用步骤。

## 相关

- [DeepSeek Harness 上游](https://github.com/deepseek-ai/deepseek-harness)
- [PRIVACY.md](../../../../PRIVACY.md)、[SECURITY.md](../../../../SECURITY.md)
