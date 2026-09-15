# Agent Note: 扩展面板的 Remote 流面——park，而不是拨 WebSocket

Status: implemented

[English](2026-09-16-extension-remote-stream-parking.md) | 中文

## Problem

侧栏的替代 connection 模块只提供 `rpc.call`，于是 0.1.5 gateway 客户端（`ClientRemoteService`）把每条 Remote 流都视为无法在进程内拨通，转而对其 WebSocket mux 发起连接——目标 `ws://<扩展origin>/api/remote.mux` 是扩展 origin 永远无法服务的端点。结果是控制台里永不停歇的重试风暴（`Remote stream WebSocket failed to open`）、每个 generation 一条 `session-controller` 控制流失败日志，以及下游惰性模块的连带错误（来自 `AgentPresetSeatController` 的 `cannot get required service "sessions" in inactive context`——其 provider fiber 在扩展静态模块注册表下的顺序问题仍在调查，boot 的 unhandled-rejection 栈日志器现已能点名抛出位置）。

## Decision

`createPortRpc` 现在实现了 `open`，采用显式的两段策略：

- **`$events` 就引擎实际广播的内容而言被忠实服务。** 端口的 host 流本就把白名单 host 事件扇出为 `host/remote-event` 帧；opener 合成事件泵所需的 `ready` 握手（全新 client id、`home: ''`），并把那些帧整形成 `emit` 帧。引擎不发出 waterfall 请求、也不发出 `api-session/*` typert 事件，所以对应的监听器保持惰性——与死掉的 WebSocket 路径功能等价，只是不再有噪音。
- **其余每个端点一律 park**：生成器只在调用方 signal 中止时结束，每个端点仅警告一次（而非每次重试），永不产出。一个安静的等待保持了这些消费者打开前的现状（`session/control`、`workspace/follow`），而不是喂养一场重连风暴。

`open` 定义之后，gateway 永远不再启动其 WebSocket mux（`streams.start()` 由 `rpc.open === undefined` 门控）——风暴从结构上消失，而不只是被调低音量。

boot 期的 `unhandledrejection`/`error` 日志器会打印原因及前几个栈帧（分行输出——多行 console 值在 shell 的错误面上会被截断）：正是它把 seat controller 的访问器定位为 inactive-context 的抛出点。

## Alternatives considered

**为 mux 上的 `session/control` / `workspace/follow` 建立忠实适配器。** 否决：follow 契约需要快照分页、assistant 流修订基线与 projection ack，而引擎的 mux 帧不携带这些；建它们是一个专项，不是噪音修复。

**对未知端点抛错。** 否决：抛错的流会让消费者所在 generation 失败并重新进入重试循环——比 WebSocket 刷屏安静，但依然是churn。

**在 gateway 包里抑制 WebSocket 拨号。** 否决：那是上游代码；而扩展恰恰是那个 carrier 无法服务回退的部署形态，carrier 的取舍应留在 carrier 自己的模块里。

## Consequences

绑定到引擎转发 host 事件的 remote-event 监听器（设置与凭据失效）现在经 Port 收到实时帧。无法服务的流的消费者惰性挂起、各留一条 console 行。若未来引擎构建在 api bridge 上服务更多 Remote 流，其端点在 `createPortRpc` 中实现后即可移出 parked 集合。

## Residuals

- boot 时的 `AgentPresetSeatController` inactive-context rejection：栈已捕获（seat 访问器读取 `scope.sessions`）；怀疑原因是扩展静态模块注册表下的 provider-fiber 顺序。每次 boot 一条 rejection，扩展 shell 背后没有受影响的功能面（其预设芯片直接走 chain A）。
- 含 `permission/mode` 的冷 v0 会话按设计拒绝历史迁移（alpha historical-event 决定拥有该有界拒绝）；会话列表将其降级为 header facts，fail-soft，每次 boot。
