# Agent Note: 扩展等待可见性与 composer 命令反馈

Status: implemented

[English](2026-10-27-extension-wait-visibility-and-composer-feedback.md) | 中文

## 问题

四个审计发现共享同一个面（extension-shell.tsx + api-bridge.ts）：审批等待会在面板关闭 15 秒后静默自我取消——浏览器自动化产品的核心时刻「等人确认」被一个暂时离开的受众摧毁；`/learn-site` 这类 handler 合理超过 120 秒的命令被误报为失败，且原始命令行被当作普通消息投喂给模型；首启面板完全打不开斜杠菜单（`commands/list` 对从未铸出的会话直接拒绝）；粘贴截图需要手动三步。

## 决策

- **挂起无时间上界（对 fail-closed 契约的有意反转）。** api bridge 的 15 秒宽限现在只用于抑制面板瞬时重载的误报；到期后不产生任何取消。挂起仅由三类显式出口终结：用户应答、ask 自身 abort 信号（回合被中断）、插件 dispose（引擎关停）。面板外提醒移交 Service Worker：ask bridge 在 claim/withdraw 点把实时的审批+提问挂起计数喂给 api bridge，后者在四个时机（连接建立、最后连接断开、宽限清扫重观察、计数结算）计算「挂起>0 且无面板连接」，经新 `dsh-interaction-alert` 通道（shared/protocol.ts）上报状态迁移——其中最后连接断开只布防清扫，上报推迟到 15 秒后的重观察，窗口内的重载不会触发告警；SW 侧布防工具栏角标 `!` 与常驻通知（点击 → `chrome.sidePanel.open`），重连或清零时撤防。`teardownConnection` 的宽限清扫不再调用 `cancelInteractions`——该调用只保留在插件 dispose 路径上。
- **反转为何成立（watchdog 互动作证）。** 审批挂起期间引擎处于回合中（`running=true`），而后台 watchdog（background/main.ts:148-170）对 `ENGINE_RUNNING_GRACE_MS=180s`（main.ts:43）内报告过 running 的引擎永不重建文档——所以插件 dispose 并不是事实上的时间上界。引擎真死时，挂起随 offscreen 文档一起蒸发：`cancelAllPending` 在那条路上根本不执行，不存在资源泄漏路径，只留下产品本意的状态「回合停在等人」（挂起的回合不烧算力）。5 秒 `REANNOUNCE_INTERVAL_MS` 重播以可忽略成本维持重连面板的可应答性。反转成立的前提是召回信号——角标+通知——本片已经补上；没有它，无上界等待就只是无声挂死。
- **composer 超时区分。** `rpc-client.ts` 的本地超时拒绝在 error 上加 `timedOut: true`（线上形状不动）；composer 的命令路径显示「命令仍在后台执行，结果稍后会出现在会话中」且不再重发该行——api bridge 的 `commands/execute` handler 本就跑到结算为止，重发会双重执行，投喂模型更糟。真实拒绝与未知命令维持「按普通消息发送」回退。
- **首启斜杠菜单。** `commands/list` 遇 `session-not-found` 时回退到任一在册 agent（注册表全局；零会话返回空数组）而非拒绝；欢迎卡新增「输入 / 查看命令，如 /learn-site 学习当前站点」，并把快捷键教学改为真实绑定（Enter 发送 · Shift+Enter 换行——旧提示写着 ⌘↵，而 textarea 实际是 Enter 发送）。
- **粘贴/拖拽入口。** `composer-attachments.tsx` 导出纯函数 `pickImageFiles`（光栅白名单、静默丢弃）；shell 的 textarea 把 `clipboardData`/`dataTransfer` 的文件经它接入既有 `addFiles`，5MB 上限与错型拒绝提示保持在 addFiles 单一归属。边界：仓库没有任何挂载 shell JSX 的 spec（composer-attachments.spec 挂的是本地 hook；extension-shell 挂载 harness 不存在），故粘贴/拖拽接线只在 `pickImageFiles` 单元级钉住，不新建 shell 挂载 harness。

## 备选方案

**给挂起等待设时间上限（ask bridge 的 Config 字段）。** 本批拒绝：任何上限终会取消一个用户仍打算应答的等待，且 watchdog 证据表明 dispose 本就不是上界。未来的上限应作为 ask bridge 的 Config 字段另行设计。**只做 ask bridge 的纯推送通道、不加 api-bridge 注册面。** 拒绝：受众状态（`connections`）归 api bridge 所有，计数必须进入其闭包——`setInteractionPendingListener`（消费者注册）+ `notifyInteractionPendingCount`（ask bridge 的推送点）正是让两侧各管各的状态的缝。**把超时命令文本投喂模型「让它知道」。** 拒绝：双重执行风险，且耐久的 `command/run`/`command/done` 节点已把结果呈现进会话流。

## 后果

审批期间关面板不再杀死回合；角标/通知召回用户，重连（哪怕一小时后）仍能应答挂起的卡片。超时的长命令不再伪装成失败、也不再抵达模型。manifest 新增 `notifications` 权限（permissions.md 记录为仅等待确认时使用）。旧 fail-closed 清扫的既有消费者：扩展 spec 之外没有，spec 现在钉住新语义。
