# Security Policy / 安全策略

English | 中文（下文）

## English

- To report a vulnerability, open a **private** GitHub Security Advisory on this repository, or contact the maintainers directly. Please do not open public issues for security problems.
- Scope: the browser extension (`apps/extension`), the harness packages it mounts (`packages/`), and the vendored Cordis runtime (`vendor/`).
- Handling expectations: acknowledgement within 7 days; fixes prioritized by exploitability. The agent's tool calls are permission-gated in-product; reports about permission-bypass or debugger-attachment scope are treated as high severity.

## 中文

- 报告漏洞请在本仓库发起**私密** GitHub Security Advisory，或直接联系维护者。安全问题请勿开公开 issue。
- 范围：浏览器扩展（`apps/extension`）、其挂载的 harness 包（`packages/`）、vendored Cordis 运行时（`vendor/`）。
- 处理预期：7 天内确认；按可利用性排期修复。智能体的工具调用在产品内受权限闸门约束；权限绕过或 debugger attach 范围问题按高严重性处理。
