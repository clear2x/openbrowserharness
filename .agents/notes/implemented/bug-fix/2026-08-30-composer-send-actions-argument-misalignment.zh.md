# Agent Note：composer 发送缝在 session-id 参数错位后收敛为单参

状态：已实现

[English](2026-08-30-composer-send-actions-argument-misalignment.md) | 中文

## 问题

扩展 composer 发出的每条消息，模型收到的都是裸会话 id。真机连续三次发送——一次 mention 回退、一次 subagent 任务、一次普通复读测试——模型全部回复「只收到一个 session ID」，而 composer 输入框里明明是正文。持久化 transcript 证实：`user/message` 气泡本身就是 `session-<uuid>` 字符串。

机制是发送路由引入时的参数错位。`SendActions` 声明 `prompt(sessionId: string, text: string): void`，`dispatchSendLine` 调 `actions.prompt(sessionId, line)`——但壳层实现是 `const promptSend = (text: string): void => ...`，单参函数。TypeScript 在该赋值处接受参数更少的函数（回调参数双变），错位静默编译通过；运行时实现读它唯一的参数——被路由填成了 sessionId——并把它当作消息正文发送。所有回退路径（`//` 逃逸、未知命令、未解析 mention、投递失败的子代理）都汇入同一条缝，所以 composer 的每次发送都受影响：可见的输入框内容与实际载荷毫无关系。

## 决策

缝收敛为单参：`prompt(line: string): void`。路由本来就持有会话——`dispatchSendLine(sessionId, line, actions)` 接收它并用于 `subagent.prompt` 与 `commands/execute` 载荷——再把它传给 prompt action 是冗余信息，而这份冗余恰恰使错位成为可表达的错误。单参之后没有可误读的位置；实现保留原来的 `(text: string)` 签名，两侧按构造即一致。

接口注释记录了这次事故，让下一次「扩成两参」的提议把代价一起考虑进去。

## 已考虑的替代方案

- **改实现的签名（`(sessionId, text)`）。** 这是第一版上线方案，能用，但隐患还在：下一个单参实现者会重新引入同样的静默错位，TypeScript 依旧抓不到。收窄接口是移除第二个参数，而不是把它写进注释。
- **运行时断言 `text !== sessionId`。** 对静态接口已无法表示的值做敌意输入防护；本仓库的运行时校验保留给真实边界，不做同进程调用缝。

## 后果

composer 发送把正文逐字带到 `session.prompt`，四条路由回退（逃逸、未知命令、游离 mention、投递失败）共用同一个 action，因此一并继承修复后的缝。这类 bug——回调缝的实现读的参数比路由给的少——正是修复落在接口而非实现的原因；未来确实需要会话 id 的缝，应当在每个实现里用具名的独立参数承接，而不是靠位置追加。

`/export`（`exportLog(sessionId)`）同批审计：其实现的唯一参数就是会话，与单参调用一致，从未错位。

## 测试

`apps/extension/tests/composer-bar.spec.ts` 以单参钉住路由契约：`//` 逃逸、`/export json` 回退、未知命令回退、游离 mention 回退、子代理投递失败回退，以及静默的普通文本用例，全部断言 `prompt` 只以正文调用。错位本身编译全绿是因为壳层没有被任何 spec 用 jsdom 挂载——路由测试 mock 了 `SendActions`，缝的两侧只能靠签名审查保持一致；现在接口让正确签名成为唯一可表达的签名。
