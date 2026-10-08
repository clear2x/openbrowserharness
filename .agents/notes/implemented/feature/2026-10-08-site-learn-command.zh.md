# Agent Note: `/learn-site` 指令——机械式站点学习固化为用户插件

Status: implemented

[English](2026-10-08-site-learn-command.md) | 中文

## 问题

在熟悉站点上的每个浏览器任务都在重放同样的探索：导航、`page_snapshot`、读 DOM、猜选择器、再来一轮——几十次工具调用与模型 token 花在重新推导 agent 早已学过的事实，且下个会话再花一遍。逆向出来的知识（哪个表单字段是哪个、哪个选择器稳定、子页面地图长什么样）随会话结束而蒸发。

## 决策

`/learn-site`（`chrome-site-learn` 插件，`apps/extension/src/offscreen/site-learn.ts`）把站点学习交付为一条用户指令，学习路径零模型调用：

1. **爬取** —— 命令解析活动 http(s) 标签页，开一个专用学习标签页（`active: false`；用户的标签页只是 URL 来源，结束后按 id 尽力切回），从提取到的链接出发对同源页面做广度优先爬取。二进制扩展名、非 http 协议、带凭据 URL、跨源链接在队列口过滤（`normalizeLearnUrl` / `sameOrigin`）；页数上限默认 12（`/learn-site <n>` 在配置上限内夹紧）。
2. **提取** —— 每页一条固定页内表达式（`pageExtractExpression`，`readyState` 等待后的 `awaitPromise` CDP evaluate）：标题/h1、带字段与 action 的表单、表单外输入、关键按钮、同源链接地图——每个控件给最佳紧凑 CSS 选择器（`#id` → `[data-testid]` → `[aria-label]` → `[name]` → 唯一类名组合 → 短 nth-of-type 路径）。两个被序列化的函数闭包自由并导出；jsdom 测试直接跑同一函数对象，spec 里的子串同一性断言把线上表达式钉在它们身上。
3. **落盘** —— 凝练出的按主机速查表（`buildSiteDigest`，字节预算、尾部截断）经 `UserPluginHost.writeKnowledge` 写成名册记录 `site-<主机名>`，携带 `knowledge` 载荷。知识记录存 `code: ''`、永不触碰沙箱（`activate()` 短路）；重新学习按同名整体替换并清掉同主机的其他知识记录。模型的 `user_plugin_write` 通道造不出知识记录（其输入没有该字段）。
4. **注入** —— `ctx.systemPrompt.context`（`chrome:site-knowledge`，新增集中分配的 `SITE_KNOWLEDGE` order 125）渲染命中主机的速查，新学习在前，至多两站点与字节预算。provider 必须同步，因此由 effect 挂钩的轮询（默认 1.5s）刷新插件内缓存的各窗口活动标签页主机与已启用知识记录；学习完成立即刷新。无命中主机 → 空串 → 其他站点与会话零成本。

两处 composer 修复随行，因为它们挡着本命令的入口：`commands/execute` 获得 120s 传输预算（handler 按设计跑到结算；10s 默认会把活着 的 handler 误读为服务失败、把命令行当普通消息发给模型）；新会话起点（`session-new`）上输入的命令现在先经新增的可选 `SendActions.ensureSession` 铸造并收养会话——此前新面板的第一条 `/` 行总是回退成普通发送。

与[站点炼化](2026-09-30-site-distillation-network-and-skill.zh.md)的定位：炼化是 LLM 执行的配方，逆向 XHR 端点成 fetch 配方（agent 主动调用的技能）；`/learn-site` 是机械、零模型的扫描，映射页面、表单与选择器，并在该主机是活动标签页时自动注入。两者可叠加：炼化的端点技能加学习的选择器速查，覆盖站点操作的两半。

## 备选方案

**让模型写用户插件**（`user_plugin_write`）。拒绝：沙箱通道是事件监听工厂，没有提示词注入面；知识需要 system-prompt 缝，只有被组合的插件能注册。名册扩展保持一个存储键、一个开关语义，而非平行存储。

**每回合注入全部已学站点。** 拒绝：为用户没在操作的站点付 token。活动标签页主机匹配让注入有条件，轮询周期限定陈旧度。

**独立的站点知识存储键 + 名册空转镜像。** 拒绝：两个事实源，enabled 标志会漂移；面板开关会撒谎。扩展 `UserPluginRecord` 让 toggle、list、boot、失败策略都归既有宿主所有。

**在用户标签页里爬、爬完恢复 URL。** 拒绝：最后一次 `navigate` 回去会整页重载、毁掉 SPA 状态。专用学习标签页结束时关闭，原标签页按 id 重新激活。

## 后果

学习由用户命令发起、只读加导航：显式的 `/learn-site` 行即同意，爬取的导航发生在自己的标签页里（工具权限闸门不参与——命令不是工具）。学习成本是机械的一次性成本；速查搭乘持久化 runtime-context 快照（模型可见⟺已落日志；文本未变化时不重复物化，变更时按缝的既有语义追加「supersedes」新快照、旧快照作为历史保留——与审批策略变更同款，稳定期零追加），名册开关关闭后至多一个轮询周期内，最新快照不再携带速查——已在真机经 mock-LLM 请求体验证。子页面覆盖受页数上限与页面自身链接暴露范围约束；登录墙后的页面只按该 profile 会话所见捕获。无键录制的会话快照不受影响：没有知识记录与标签页时该 context 渲染为空。
