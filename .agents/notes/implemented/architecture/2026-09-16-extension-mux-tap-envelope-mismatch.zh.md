# Agent Note: 扩展审批卡——mux tap 封套失配

Status: implemented

[English](2026-09-16-extension-mux-tap-envelope-mismatch.md) | 中文

## Problem

用户报告在 `变更确认` 权限档位下审批卡永远不在侧栏渲染，且面板 DevTools 满屏报错。真机复现（off/on 部署、AX 驱动的 composer 注入）显示 `tabs_open`/`page_navigate` 审批要么数秒内以 `'cancelled'` 结束、要么永久挂起且无卡，而同一条 Port 上的对话始终正常。

## Decision

`PortApiClient.handleMessage` 把裸 mux 线上帧（`{ type: 'approval/requested', … }`）直接递给 `onMuxEnvelope`，而 `InteractionStore.handleMuxEnvelope` tap 读取的是 `envelope.payload.type`——即 `tapStream` 产出的 `{ rpcId, payload }` 契约封套形状。于是每一次 mux 投递都在 Port 监听器内抛出 `TypeError: Cannot read properties of undefined (reading 'type')`，后果有二：

1. store 永不更新（审批/提问卡永不渲染）； 2. 异常在 stream-queue 分发之前中断 `handleMessage`，所有 runtime mux 消费者随之饿死——由此产生的端口抖动不断重启 Port generation，而每次「最后一个端口断开」都触发 api bridge 的 fail-closed `cancelInteractions()`，把挂起中的审批在等待途中取消。

interaction-cards 单测给 store 喂的是预构建封套、从不经过 Port tap，因此这条缝的失配对测试套件不可见。

## 修复

1. **tap 封套修复**（`port-api-client.ts`）：mux tap 现按 `muxFrameSchema` 解析线上帧并投递 `{ rpcId: 新客户端 id, payload }`——与流生成器产出同一封套；坏帧响亮丢弃。 2. **断连宽限**（`api-bridge.ts`）：最后一个端口断开的 sweep 改为先起 15 秒定时器而不是立即取消；重连的面板会解除它。挂起等待可在瞬时端口抖动与面板重载中存活。 3. **帧重广播**（`chrome-ask-bridge.ts`）：挂起的审批/提问等待每 5 秒重播其请求帧（所有 settle 路径清除定时器），中途才连上的面板也能收到卡；interaction store 按 approvalId 的幂等 upsert 保证重发安全。 4. **现场分诊环**（`chrome-ask-bridge.ts`、`chrome-tool-gate.ts`）：park/abort/cancel-hook/gate-outcome 条目写入 `chrome.storage.local` 环（`dsh-askbridge-diag`，尽力而为）并镜像 `console.warn`，无需 DevTools 即可拿到真机上的取消原因证据。

## 验证

- ask-bridge 6 用例（round-trip、重广播 + settle 后停止、宽限内重连存活、宽限过期 fail-closed）与新的 tap 封套 boot 用例；316 个扩展测试全绿；双 tsc face 干净。 - 真机（Edge，off/on 部署）：审批卡渲染、允许一次 AXPress 使等待落定、被门禁的工具真实执行、回合继续至完成。

## Residuals

- 含 `permission/mode` 的 v0 冷会话按设计拒绝历史迁移（alpha historical-event 决定拥有该有界拒绝）；会话列表每次 boot 将其 fail-soft 降级为 header facts。 - Chain B 流：已在[Remote 流 parking 笔记](2026-09-16-extension-remote-stream-parking.zh.md)中解决——connection 模块实现了 `rpc.open`，WebSocket 回退不再拨号，重试循环消失。

## Alternatives considered

**只抑制 WebSocket 拨号或重试循环。** 否决：重试风暴只是症状，封套失配仍会让所有卡无法渲染。

**让 interaction store 接受裸线上帧。** 否决：store 的封套契约（回显每次投递的 rpcId、读取 `payload`）与 `tapStream` 生成器的产出一致——放宽它会让帧形状在两个生产者之间分叉。

**维持 fail-closed 取消不变。** 否决：面板重载（卡死时的既定应急手段）会持续取消用户正要回答的审批。

## Consequences

审批卡与提问卡在真实面板上渲染、在宽限窗口内扛住端口抖动、并在中途重连后重新投递；无面板回来时 cancel-hook sweep 仍然 fail closed。存储诊断环在每次 park/取消时增加一次小写入——尽力而为，而且这个现场分诊面已经回本（它把「帧在广播、卡不渲染」与「等待被取消」区分开来）。
