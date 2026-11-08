---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-04-browser-source-and-permission-mode

[English](2026-11-04-browser-source-and-permission-mode.md) | 中文

## 概述

记录合并后树的消息来源扩展与新的 permission-mode 事件根：可合并扩展的 MessageSourceMap 新增浏览器工具的 tool-browser 来源类别，扩展了 user/message、developer/message、agent/inbox/spliced 的 inserted[] 条目与 session/title-llm-request messages[] 的 source 联合类型；已知事件清单新增 permission/mode。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-04-browser-source-and-permission-mode
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "294383a5996b0faa39329847bae5d3ed4a222c331a324f4ac2c46ffec75a8ebe"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "a5712919e2bcaa44ea67bd2c2c824727da2728f2e4148bd4c1c9fae2798a1f4c"
    decision: same-version
  - root: "event:permission/mode"
    previous: null
    after: "aeb07120dc699841c9edc0f91a52aea1203e4181f304063cbfb52ed98f13b63f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "b4acf860f955ca500ec7fe254b34d87776e6c64b41002ea3cf0aa14e2f0ce3dc"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "4ceced67e715d7361a7a73982d5edf1d593ac4e07e04510ae18b3be59a0f441e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

读取方按 source kind 分派并对未知类别直接放行，因此携带 tool-browser 来源类别的记录对所有既有读取方保持可读；从不产出 tool-browser 的读取方继续写出当前树可接受的记录。已确认历史中的写入方从未产出 tool-browser 类别或 permission/mode 事件，所有既有记录保持原样有效。两项转换都保持在当前 Session format 版本内且读取行为安全；permission/mode 根新增适用同版本允许规则。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/session/tests/canonical-envelopes.spec.ts packages/core/session/tests/message-projections.spec.ts：217 个测试通过。pnpm exec vitest run packages/session/session-persistence-jsonl/tests：765 通过、1 跳过。pnpm exec vitest run packages/subagent/subagent-codex/tests packages/subagent/subagent-claude-code/tests：125 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
