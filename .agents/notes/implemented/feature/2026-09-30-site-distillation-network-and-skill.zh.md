# Agent Note: 站点炼化——网络捕获与预置配方技能

Status: implemented

[English](2026-09-30-site-distillation-network-and-skill.md) | 中文

## 问题

在熟悉站点上的每个浏览器任务都在重放同样的探索：导航、快照、点击、读文本、猜数据在哪——几十次工具调用与模型 token 花在重新推导 agent 早已学过的事实。逆向出来的知识（搜索框背后是哪个 XHR 端点、筛选用的是哪个 payload、哪个选择器仍然有效）随会话结束而蒸发。

## 决策

站点炼化以两件套交付：

**`page_network` 工具**（`@deepseek-ai/dsh-tool-browser` + chrome provider）。工具按标签页启停 CDP Network 域捕获：`action:"start"` 清空缓冲并在既有调试会话上启用 Network 域；`action:"read"` 返回缓冲的请求清单（方法、URL、状态码、资源类型、MIME、截断的 POST body、响应字节），带大小写不敏感的 URL/资源类型过滤与可选 stop。Service Worker 记录器（`apps/extension/src/background/network.ts`）按 requestId 合并 CDP 事件——一次重定向跳转保持一条——每标签页保留 400 条并带丢弃计数，URL 截到 600 字符、POST body 截到 4000。seam 新增两个 `BrowserProvider` 方法（`startNetworkCapture`、`readNetworkCapture`），任何 provider 都能支撑该工具；工具只读且并发安全。

**预置 `site-distill` 技能**（炼化站点）。扩展在启动时把配方种子写入 chrome.storage 技能名册（`ensureShippedSkills`，带修订号：改配方后升号即重新种子，用户删除在升号前一直生效）。配方是 agent 用现有工具执行的四段流水线：

1. 勘探——开始捕获，像用户一样操作目标功能，读取捕获的 XHR/fetch 请求，用一次式 `page_evaluate` fetch 验证每个候选端点。
2. 综合——把证据浓缩成一页能力清单：端点速查、DOM 兜底配方、前置条件。
3. 锻件——用 `skill_write` 写一个 `site-<域名>` 技能，每个能力携带可直接复制的 fetch 片段；凭据绝不写入内容。
4. 回炉——对真站重跑每个 fetch 配方，修正或降级为 DOM 步骤，并汇报炼化结果。

提速来自端点快路径：一个炼化后的能力用一次 `page_evaluate` 执行，取代多步 DOM 探索。

## 备选方案

**注册站点专属工具的插件。** 拒绝：用户插件是事件监听工厂（`{events, on}`），没有工具注册面；技能的 fetch 配方在不动引擎的前提下交付同样的快路径。

**工具内自动爬取**（深度/广度循环）。暂缓拒绝：agent 已经能用 `tabs_*`/`page_*` 原语组合探索，而爬虫需要站点特定判断（登录墙、无限滚动），模型比固定循环做得更好。配方负责编排爬取，专用爬取工具可以日后再做。

**把配方放进系统提示词的浏览器指引。** 拒绝：指引被快照 golden 钉死且每个请求都要付费；配方只在炼化站点时有价值，这正是技能的用途。

## 后果

网络捕获是引擎生命周期状态：SW 重启丢弃缓冲，下一次读取返回空且未激活的捕获——agent 在 `action:"start"` 后重新录制，工具的空读指引写明了这一点。记录器只摄取有活动捕获的标签页事件，Network 域在炼化之外保持关闭。种子技能对模型和用户均可调用；`skill_write` 同名写入即可像其他技能一样更新它。
