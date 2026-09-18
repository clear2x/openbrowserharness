# Agent Note: 品牌图标单一源——开口轨道标志、生成式派生物、构建门禁

Status: implemented

[English](2026-09-18-brand-icon-single-source.md) | 中文

## 问题

扩展同时带着两套已漂移的图标资源：`apps/extension/public/icons/`（manifest 引用的那套）和 `apps/extension/icons/`（过时的第二套，其 preview.md 仍声称 manifest 尚未接线）。网站 favicon 是第三份字节副本，且没有任何同步机制。PNG 靠手工栅格化，两处文档各说一套工具（一处注释写 `rsvg-convert`，另一处写临时安装 `@resvg/resvg-js`），改了 SVG 后 PNG 悄悄变旧。标志本身——玻璃质感蓝底加大号系统光标——与产品扁平 UI 并排显得过时，在 16px 工具栏尺寸下也丢了形状。

## 决策

单一矢量源，处处同一标志：`apps/extension/public/icons/icon.svg` 是唯一的品牌图形源。标志是开口轨道加驱动页面的指针——圆环提供 OpenBrowserHarness 的 O，指针占据圆环右上的缺口，两个图形在 16px 下读作同一个手势。它天生扁平：`#172554` 底板、`#67E8F9` 轨道、`#F8FAFC` 指针，无渐变、无滤镜、无玻璃效果，几何按工具栏尺寸反推（8px 描边在 16px 下恰好 1px）。

- `apps/extension/scripts/generate-icons.mjs` 用锁文件钉死的 `@resvg/resvg-js` 开发依赖渲染提交在库内的派生物（`icon16/32/48/128.png`），并把 `website/public/favicon.svg` 重写为源文件的字节副本。`generate:icons` 负责写出，`check:icons`（`--check`）在任何漂移上失败，扩展 `build` 脚本先跑 `check:icons`。
- SidePanel 欢迎页 glyph 以 `<img>` 渲染同一个文件；独立的内联 `OrbitPointerIcon` 图稿删除，面板、工具栏、扩展管理页与文档站共享同一标志。
- 已漂移的 `apps/extension/icons/` 目录删除；旧图稿由 git 历史保留。

覆盖：`apps/extension/tests/brand-assets.spec.ts` 钉住 manifest 的图标映射、四份 PNG 头（尺寸、8 位 RGBA）、favicon 与源文件字节相等，以及构建门禁接线；`caps-css.spec.ts` 跟随欢迎 glyph 改为图稿（暗色墨色翻转现在只覆盖发送按钮）。

## 备选方案

- **沿用旧 SVG 注释中的 `rsvg-convert` 作为文档化渲染器。** 否决：它不是声明过的依赖，Windows 与多数 CI runner 上不存在；锁文件钉死的渲染器让提交的字节处处可复现。
- **保留第二个 `icons/` 目录作为设计历史。** 否决：它的 preview.md 与已接线的 manifest 矛盾，且没有任何机制能发现后续漂移；git 历史已经保存旧图稿。
- **manifest 图标只用 SVG。** 否决：Chromium 的扩展图标表面期望栅格尺寸，四档 PNG 集合就是 manifest 与商店已采用的契约。
- **为网站另设 favicon 源。** 否决：第二个源正是这次发生的漂移；favicon 是再生的字节副本，永不手工维护。

## 后果

- 改了 SVG 却不跑 `generate:icons` 时，扩展构建与 brand-assets 测试会以派生物过期报错，而不是把旧图稿发出去。
- `@resvg/resvg-js` 只是开发依赖；发布扩展包的种类不变，manifest 继续引用同样的四个 PNG 路径。
- 欢迎 glyph 的前景不再参与暗色墨色翻转（它是图稿，不是 `currentColor` 图形），其容器只提供一层宿主侧的柔和阴影。
- `docs/assets/sidepanel-welcome.png` 已用真实 `SHELL_CSS` 标记加新标志重拍；今后改标志走同一文件，欢迎 UI 无需重拍，但露出底板的截图会随品牌老化。
