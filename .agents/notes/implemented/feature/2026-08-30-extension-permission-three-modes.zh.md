# Agent Note: 扩展三档权限模式（每次确认 / 变更确认 / 完全访问）

Status: implemented

[English](2026-08-30-extension-permission-three-modes.md) | 中文

## 问题

扩展的 `chrome-tool-gate` 行为是写死的：`page_evaluate` 和 `page_navigate` 永远询问，其余永不询问。没有面向用户的姿态控制——无法表达「每次点击都先问我」「只在改动东西时问我」「完全不用问」，而桌面版 `dsh-permission-presets` 包不能直接组合：它要求一个受约束的 `ctx.shell`（bash 沙箱），浏览器宿主没有；它的审批策略旋钮（`ask`/`never`）里的 `never` 语义是「不问且拒绝」，不是「不问且放行」。

## 决策

**由扩展自持一个会话级、可记日志的 `permission/mode` 旋钮。** 新引擎插件 `permission-mode`（offscreen）声明 `permission/mode` 会话事件（整值替换、最后一条生效、组合默认 `ask-change`），用 `effectivePermissionMode()` 折叠，并暴露 `ctx.permissionMode` 服务（`effectiveOf(agent)` / `set(agent, mode)`）。侧栏开关通过 `session.permission.get/set` 桥 RPC 读写；重复选择同档是 no-op，日志不会堆积冗余事件。

**三档，作用于浏览器操作与文件变更**（`shared/permission-mode.ts` 是两个 bundle 共用的纯词汇表）：

| 档位 | 浏览浏览（点击/滚动） | 浏览器变更（输入/按键/导航/脚本/开关标签页） | 文件写改 |
|---|---|---|---|
| `ask-always`（每次确认） | 询问 | 询问 | 询问 |
| `ask-change`（变更确认，默认） | 放行 | 询问 | 询问 |
| `full`（完全访问） | 放行 | 放行 | 放行 |

闸门在 pre-execute 时按矩阵裁决每个受管调用；只读工具不经过闸门。计划模式（引擎 `/plan`，不变）依旧硬拦 `write`/`edit`——做计划需要自由的网页调研、但不需要工作区变更——旋钮不触碰计划状态。

**事件通过放宽生成器扫描范围进入持久化目录。** `KNOWN_SESSION_EVENT_TYPES` 由 `scripts/gen-persistence-catalog.ts` 生成，此前只扫 `packages/*/*/src/**`；声明在 `apps/extension` 里的事件能过 typecheck，但冷恢复读取时会被硬拒（`assertEventsSupported`）。生成器现在同时扫描 `apps/*/src/**`，扩展装配与 package 一样贡献日志词汇。这一步顺带暴露了两个既有冲突：早前 tsc 误发射进 `web-search-deepseek/src` 的杂散 `provider.d.ts`（已删除），以及扩展本地对 `agent-preset/selected` 的重复声明——现改为对 `@deepseek-ai/dsh-agent-presets` 的类型依赖边（已加依赖；应用依旧不组合该插件），事件只剩一处声明。

**UI**：composer 工具条新增盾牌 chip 显示折叠后的档位；菜单列出三档及一行说明、当前档打勾，选择即乐观更新并发 RPC；5 秒轮询兜底（首次成功读取前隐藏）。

## 考虑过的替代方案

- **用桩 shell 组合 `dsh-permission-presets`。** 否决：需要伪造受约束执行器才能过加载期守卫，且其沙箱/审批词汇（workspace-write、danger-full-access）描述不了浏览器宿主。
- **复用审批策略旋钮、把 `never` 改成放行。** 否决：`never` 在服务层确定性拒绝，改语义会破坏桌面契约。
- **四档（含计划模式）。** 用户复核后否决：计划保持为引擎命令（`/plan`），不是权限姿态；旋钮只管问不问。

## 后果

每个受管调用在 pre-execute 时从会话日志折叠档位，切换对下一次工具调用立即生效——包括回合中途——并且免费获得 resume/fork 恢复。开关上线前构建写入的会话没有 `permission/mode` 事件、折叠到 `ask-change`；档位值与开关同批交付，没有旧值迁移。

`page_screenshot`（见姊妹篇）刻意不进这个矩阵：截图是只读取证，只受自己的可选能力开关约束。

## 测试

- `apps/extension/tests/tool-gate.spec.ts`：完整矩阵（默认==ask-change 浏览放行/变更询问、ask-always 全问、full 从不咨询应答器、计划模式提交态与待决态都拦文件写而浏览放行），以及既有审计对行为。
- `apps/extension/tests/api-bridge.spec.ts`：`session.permission.get/set` 端到端——默认折叠、持久事件追加、重复选择 no-op、未知档 `bad-request`。
- `apps/extension/tests/composer-bar.spec.tsx`：开关渲染（三档、勾选）、切换发 `session.permission.set`、首次成功读取前隐藏；模式面板 CSS 钉住。
- 真机验证：默认档下 agent 的 `page_evaluate` 弹出审批卡，`tabs_list`/`page_snapshot` 未询问。
