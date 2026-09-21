# Agent Note：对新会话起点切模型=设置下个会话的默认路由，而不是报错

Status: implemented

[English](2026-09-21-selectmodel-unmaterialized-default.md) | 中文

## 问题

面板改为新会话起点后留了个洞：在那里切模型报 `会话 session-new 不存在`。`session.selectModel` 无条件 ensureAgent，而对未落地会话 ensureAgent 就是 not-found 拒绝。这个失败正好落在 composer 最显眼芯片驱动的动作上，还顺带弄坏了启动期拒绝档位自愈（它会对活跃会话重发 selectModel）。

## 决策

`session.selectModel` 现在只在会话存在时——注册表中活跃或已持久化（`sessionPersistence.stat`）——才 ensureAgent。对未落地会话，路由选择照常经 `writeEngineSettings`/`writeDefaultReasoningEffort` 持久化并返回 `{selected}`：宿主默认就是下个创建会话继承的路由（`ensureSelection` 回落到 `engineDefaultSelection`，composer 的启动配对读的也是同一份持久 current），所以选择在创建时生效，而只切模型不发消息的用户不会多出一个会话行。会话一旦落地，按会话选择照常接管。

## 考虑过的替代

- **切模型时铸造会话。** 否决：重新引入新会话起点刚清除的垃圾——只切模型不发消息的用户会积累空行。
- **让桥认识面板的哨兵 id。** 否决：这条语义对任何未落地 id 都成立，不只哨兵；按存在性判断让桥对面板状态保持无知。

## 后果

- 新会话起点上切模型（和思考档位）可用：无报错、选择持久化为宿主默认、不铸造会话行。
- 哨兵上的启动拒绝档位自愈改为持久化清除后的姿态而不是拒绝。
- 覆盖：api-bridge spec 断言对未知 id 的选择返回 ok、不铸造 agent、落入持久化引擎设置；真机装置在新起点切模型（无错误卡、持久默认更新）、发送、并验证日志中的 request/header 事件带着所选模型。
