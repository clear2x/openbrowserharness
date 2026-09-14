# 贡献

[English](CONTRIBUTING.md) | 中文

感谢你愿意为 OpenBrowserHarness 作出贡献！Issue 和 PR 都欢迎——这是一个独立项目，接受外部贡献。

## 报告问题

请发起 GitHub issue。安全相关问题请遵循 [SECURITY.md](SECURITY.md)，不要开公开 issue。一份好的报告应包含：浏览器与操作系统版本、所用供应商/模型、导出的会话日志（侧边栏 → *Session log*），以及可复现的确切步骤。

## 提交 PR

1. Fork 后开分支，保持改动聚焦——一个 PR 一个逻辑变更。
2. 本地安装并验证（最后一条命令必须从仓库根目录运行）：

   ```sh
   pnpm install
   pnpm run build:lib
   pnpm run build:extension
   pnpm exec vitest run apps/extension/tests   # from the repository root
   ```

3. Pre-commit 钩子（lefthook）会对暂存文件运行 lint、空白、双语配对、第三方声明等门禁——钩子通过 postinstall 安装；请让它们指引你，而不是绕开它们。
4. 非平凡变更需在同一 PR 中附带一篇 [Agent Note](.agents/notes/README.zh.md)，记录决定了什么、为什么；纯机械改动可豁免。这一约定继承自上游，是本项目的决策日志。
5. 文档为双语（English + 中文）成对文件并带 `.i18n.yaml` 记录；改动配对的一侧时，请把另一侧一并更新，并用 `verify-translation-pairing --write` 重新记录。

## 仓库约定

继承自 harness 的架构与编码规则见 [AGENTS.md](AGENTS.md)——修改 `packages/` 之前请先阅读。简版：一切皆插件、注册即副作用、配置错误要响亮失败、vendored 上游代码的改动必须登记在 [vendor/README.md](vendor/README.md)。

本项目把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 重新打包为浏览器扩展；移植上游变更时，请重新应用登记在 vendor/README.md 与 Agent Notes 中的扩展侧修改。
