# Agent Note: extension-only docs site and the branded landing page

Status: implemented

[English](2026-09-28-extension-only-docs-site-and-branded-landing.md) | 中文

## Problem

文档站投影了整个继承的 dsh 语料，Chrome Web Store 审核员点进隐私政策看到的是扩展并不具备的上游 CLI 文档——Python SDK、GitHub 评审会话、还有一张「DeepSeek Harness」首页。默认 VitePress 首页读起来像裸文档索引，第一轮品牌化（亮色页面上的一条深色 hero 带）又留下白色搜索框和浅色卡片，与 hero 视觉割裂。商店提交需要第一眼就毫无歧义地是本产品的页面。

## Decision

站点现在只发布扩展自己的语料，首页路由是一张品牌化产品页：

- **发布清单缩减**（`website/docs.ts`）：两个 `layout: home` locale 首页（`docs/extension/index.md`/`.zh.md`）、五篇指南（快速上手、配置模型、浏览器自动化、权限与安全、用户插件）、以及 Policies 侧边栏分组下 `reference/privacy` 的隐私政策。上游语料（Cordis 教程、子系统、SDK、开发手册）保留在仓库中但不再投影；`zh-develop`/`en-develop` 集合及其导航项移除。
- **落地页构图为纯 frontmatter 内容**：渐变字标 hero、经 `home-hero-actions-after` 插槽注入的供应商芯片、经 `home-hero-image` 插槽（`LandingLayout.vue`）的三张重拍面板截图拼贴、经 `home-features-after` 的「如何工作」区块、以及替换 emoji 的内联描边 SVG 特性图标（每图标独立渐变 id）。
- **全页沉浸式深色**在 `theme/custom.css` 的 `body:has(.VPHome)` 下重声明整套 `--vp-c-*` 加 `--vp-local-search-*` 与 `--vp-nav-bg-color`，铺在生成的极光背景上（用户 `gpt-image-2.5` 端点，发布为 102 KB JPEG），遮罩渐变与图同尺寸。
- **动效仅加载时**：hero、芯片、拼贴、特性卡依次入场，拼贴后卡缓慢漂移，`prefers-reduced-motion` 下全部关停。

### 内容依赖的投影机制

`sidebar: null` 页面就是 locale 首页：投影器只发布其 frontmatter，所以首页内容全部放 YAML，正文只留 H1 加语言切换行（配对 gate 要求切换行紧跟 H1）。指南页里的仓库相对链接由投影器改写为站点路由；frontmatter 里的链接不会被改写（YAML 对 mdast 改写器不透明），所以 hero 链接直接写站点形态。

### 深色主题的变量规则

自定义属性在 `:root` 处求值，继承下来的 `--vp-local-search-bg: var(--vp-c-bg)` 携带的是已解析的浅色值；body 作用域必须重声明派生变量它们才会在深色调色板上重新求值。这就是只覆盖 body 级 `--vp-c-bg` 时搜索弹窗仍是白色的原因。

## Alternatives considered

**用自定义 Vue 首页组件替换 `VPHome`。** 否决：插槽面加 frontmatter 即可完成构图，零组件维护成本，双语配对 gate 继续作用于源 markdown，VitePress 升级不受影响；完整替换等于分叉默认主题的 home 布局。

**在仓库之外建独立商店微站。** 否决：GitHub Pages 管线已存在（public 仓库、部署 workflow），素材与代码同库版本化，一个隐私政策 URL 同时服务仓库与商店列表。

**上游语料保留在站上并做清晰分区。** 否决：商店审核员离政策页只有一次点击；同域名下的任何上游内容都会招致材料包要防止的「错产品」误读。

**纯 CSS hero 光斑而非生成图。** 第一版品牌化被读作平庸后否决：生成的极光用 102 KB 给了画面真实的纵深，而生图端点正是为此提供的。

## Consequences

站点不再服务上游开发者文档——那些文档在 GitHub 上读，站点的职责是扩展产品。主题多出两个文件和一个 `vue` devDependency（仅类型；都被 pre-push typecheck 抓出来过）。落地页文案按 locale 在 frontmatter 中成对维护，配对 gate 本就管辖。回报：商店 listing 的第一次点击落在一个毫无歧义的产品页上，两种配色下都是深色整面，并且每轮落地页改动都走同一条截图自检流程（构建、Playwright 五态截图、部署后线上复查）。
