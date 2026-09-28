# Agent Note: 快照语料 Class A 是回放目录欠声明，不是引擎 continuation 缺陷

Status: implemented

[English](2026-09-29-snapshot-replay-catalog-surface.md) | 中文

## Problem

`test:snapshot` 长期 85–88 红，主类断言 `request/header #1 diverged from the pinned … header`——钉面带 `config.maxTokens`/`config.reasoningEffort` 与 `adapterDefaults: { reasoningEffort: true, maxTokens: true }`，回放头只有 provider/model。工作假设（见 [2026-09-28 分类](../../../.agents/reports/snapshot-corpus-classification-2026-09-28.md)）认为是审批/resume 续行丢了首轮 adapter 面，把语料重录门在引擎修复上。

## Diagnosis——假设的机制错了

prepareRequest 的单场景插桩从未打出 `NO_ADAPTER` 回退；且 cancel 场景自己的录制就是裸头，而它的类钉（来自 escalation-approved）是全面。真实分野：**所有** `llm-replay` 夹具目录只声明裸模型 id，`ReplayAdapter.resolveModel` 产不出 `defaultMaxTokens` 与 reasoning efforts，`resolveCallWithInfo` 无默认可填——每一条回放头（首轮或续行）都丢面。升级三兄弟的头 pin 通过纯属断言顺序掩护：stdout 比较先失败，头断言根本没跑。

回放夹具词表本就支持（`ReplayModelConfig.defaultMaxTokens`、`reasoningEfforts`、`defaultReasoningEffort`——文档明说「replay reconstructs the request header a live catalog produced」），只是 44 个 `cordis.snapshot.yml` 从未声明。

## Fix

全部回放目录按 live deepseek 目录的解析结果声明模型面（每个 `deepseek-v4-*` 加 `defaultMaxTokens: 256000`、`reasoningEfforts: [off, low, high, max]`、`defaultReasoningEffort: max`），随后语料收敛环：`test:snapshot:refresh`（script 场景）→ `test:snapshot:record`（live 场景）→ 回放验证。结果 **19 红 | 112 绿**，余量在 [2026-09-29 报告](../../../.agents/reports/snapshot-corpus-classification-2026-09-29.md)重新分类：18 个是显式 effort 旗标类（套件 pin 策略决策、不可靠重录解决），1 个是会话数组字段漂移。

## Alternatives considered

**引擎侧让续行保留首轮显式面。** 否决：首轮从未携带显式值——是适配器默认产出的，旗标协议存在的意义就是让回放可重建。这里没有引擎缺陷。

**逐场景目录面随类钉走（钉裸则目录裸）。** 否决：那会把过期的裸录制冻结成期望态。全面才是 live 适配器的真实解析，record/refresh 会把每个夹具带到那里。

## Consequences

无钥回放现在能重建 live 目录产出的请求头，未来 adapter 面改动只需动目录文件；升级三兄弟的 stdout 失配不再掩护头 pin。两条运维事实值得留存：record 模式在首个断言失败处中止——夹具已写但 workspace/writer 预言未刷新（收敛必须 record → refresh → replay）；模型创作的工作区期望文件天然尾换行不确定——本轮对齐了四处。
