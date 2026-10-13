# Agent Note: 智能体质量批次——点击命中校验、index 寻址、快照预处理与反思守护

Status: implemented

[English](2026-10-13-agent-quality-reflection-guard.md) | 中文

## 问题

审计暴露三个质量缺口：点击会静默落空（被遮挡/视口外的目标回退成裸坐标点击，点在同一遮挡物上却报告成功）；index 寻址信任的每标签页快照缓存从不因显式导航失效；agent 没有执行中反思——回合可能带着未满足的目标收尾，或对着失败工具空转而不换路。

## 决策

一个合并批次，按三个已评审切片实施：

- **点击命中校验 + 诚实失败**：`page_click` 派发前探针目标（`hitOk`/`hitReason`），未命中抛 `点击未命中目标（原因）…请先滚动或重新快照`。标记（`HIT_MISS_MARKER`）跨 provider 缝传递，两处 selector→坐标回退对其原样上抛，不再静默点同一遮挡物；真正的寻址失败（元素移动/移除）仍回退坐标。
- **带漂移校验的 index 寻址**：`provider.resolve(tabId, index)` 在页面上重找缓存元素（deepQuery + tag/text 校验，漂移抛 `快照已过期`）；显式导航时失效每标签页缓存。`PageSnapshot` 增加 `prepActions`，`BrowserProvider` 增加必需方法 `resolve`（`PROVIDER_METHODS` 同步）。
- **快照预处理管线**：单次页内 evaluate 在能力开关后执行 冻结动画 / 横幅遮罩清理 / 懒加载触发，用每文档 token 跳过（cached 快速路径采纳页面已验证的旧 token 而非新 token——否则清扫隔次全量重跑）。快照精简丢弃超 40 字的被动文本。
- **导航智能等待**：`Page.navigate`/历史导航在短暂盲等（覆盖旧文档换页窗口）后轮询 `readyState`（≤3 秒预算）。
- **反思守护插件（`chrome-reflect-guard`）**：`tools/post-execute` 把工具失败折叠为反思上下文（失败链在连续未命中后建议换路），`agent/pre-step` 每步重置折叠，`agent/turn-stopping` 对照用户目标检查助手收尾文本——单薄或零行动的收尾获得完成度提示（plan-mode 豁免；预算封顶防循环）。

## 备选方案

**selector 未命中一律静默坐标回退。** 拒绝：它把「元素不可达」变成「点了未知点并报告成功」——正是命中校验要消灭的静默失败类。

**反思做进 packages/core/agent-loop。** 拒绝：仓库约定不改核心；组合扩展点（瀑布事件、`agent.inject`）足以承载。

**无条件采纳新 prep token。** 拒绝：违背 token 本意（页内 cached 路径从不写入新 token）。

## 后果

未命中现在以模型可行动的错误浮出（滚动、重快照），而非静默空点；导航后的 index 点击响亮地以 `快照已过期` 失败。快照预处理有界（横幅点击 ≤3、懒加载跳 ≤20）且 cached 路径跳过。反思提示预算封顶且 plan-mode 豁免，不会把回合拖入循环、也不会卡住计划审批。
