# Agent Note：扩展适配器把流中断的传输失败漏过了重试执行器

Status: implemented

[English](2026-09-20-sse-midstream-transport-classification.md) | 中文

## 问题

`dsh-llm-retry` 从扩展第一个版本就挂载着，LLM 连接中断本应触发有界自动重试而不是终止回合。但它只重试带可识别机器码的失败（`TRANSPORT`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`EMPTY_RESPONSE`）。扩展为供应商预设自带的两只适配器（`anthropic-adapter.ts`、`responses-adapter.ts`）把「请求前 fetch 失败」和「带内 SSE error 事件」都归类为带码的 `TRANSPORT` `LlmError`，但消费响应体时没有包装：流中途断开时浏览器以裸 `TypeError: network error` 拒绝 body reader，这个错误未带码地逃出生成器。重试执行器认不出码、原样放行，回合以手动重试错误卡收场。真实使用正好踩在 GLM anthropic 协议路由上：每次夜间网络抖动都要人点一次「重试」。

姊妹路由没有这个缺口：`DeepSeekAdapter` 把整个流循环包进 try/catch 并把未知失败映射为 `TRANSPORT`；`llm-pi-ai` 家族按消息文本分类（`network`、`terminated`、`premature close` → `TRANSPORT`）。

## 决策

两只适配器改为迭代 `sseWithTransport(...)`：一个包住同一 SSE 解析器的薄生成器，调用方中止原样重抛，其余流中断失败一律重抛为 `Anthropic API（<baseURL>）流传输中断：<detail>` / `Responses API（<baseURL>）流传输中断：<detail>`、码 `TRANSPORT`。已挂载的重试执行器随即把它当普通传输失败处理——普通档默认 5 次指数退避重试、写持久 `llm/retry` 事件、在同一打开回合内重跑该步。其余一律未动：解析器、事件翻译、中止语义不变。

## 考虑过的替代

- **在适配器内自做重试。** 否决：重试策略属于持久 agent-step 边界上的执行器；适配器层重试会重发一个部分输出已被循环消费的请求。
- **给消费端 `for await` 循环包 try/catch。** 否决：每只适配器要为同样的保证重缩进约 120 行；包装迭代器把传输分类收进一个有名辅助函数，事件翻译循环一行不动。

## 后果

- 流中连接中断现在经 `dsh-llm-retry` 自动恢复（默认 5 次退避），不再要求手动点击；彻底失败或不可重试失败仍出手动重试卡。
- 不可恢复的流中断报错现在带码且带来源（`…流传输中断：network error`），不再是裸 TypeError。
- 覆盖：两只适配器 spec 各新增「一条有效事件后流中断」用例，断言拒绝值为带码 `TRANSPORT` 的 `LlmError`；扩展全量 346 绿、typecheck 双面、lint 0/0。
