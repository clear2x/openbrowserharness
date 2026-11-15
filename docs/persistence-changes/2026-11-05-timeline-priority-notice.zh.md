---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-05-timeline-priority-notice

[English](2026-11-05-timeline-priority-notice.md) | 中文

## 概述

在用户加入或移除紧急优先级时记录一条 Timeline 通知。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-timeline-priority-notice
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-04-browser-source-and-permission-mode"
    after: "d569655a770e66fb7ae6a554192b594f6e1be41cae1262a01d155bed23323ab0"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-04-browser-source-and-permission-mode"
    after: "7a2933fd4ba1cd3cee51198af12425a2eb9161d148d2f5d52d150be220c639cc"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-04-browser-source-and-permission-mode"
    after: "cdbcd49bb7c877c3721a9e1ce55a75c03a40dd9dcf6fc79acd475e9238c54c2c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-04-browser-source-and-permission-mode"
    after: "0e7660ee8c18de4713a97f5edbab852f63161c16274209cebdb85a1f4a5ac71d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有消息保持其来源与含义。Timeline 通知携带普通文本与来源标签，且本记录确认的 splice 载荷同时带有前一条并行记录（浏览器来源）加入的来源种类，因此按来源种类分派的读取方对未知种类原样透传、不受影响。没有 Timeline 能力的读取方可以保留未知来源并只读文本、不应用任务更新。Timeline 把任务树、报告与讨论以可忽略的 plugin:timeline/* 记录存入会话日志；没有 Timeline 能力的读取方跳过这些记录。两类迁移都停留在当前 Session 格式版本内，读取行为安全。

<a id="verification"></a>
## 验证

Timeline 的优先级测试验证只有用户对紧急优先级的编辑会入队通知；进程恢复测试验证 Timeline 状态在中断写入后仍可恢复。在上游 0.2.2-rc.3 合并之后，本确认以并行的 fork 记录为前驱重新推导，pnpm run verify-persistence-changes 验证线性化链路并确认本 tip 的摘要与当前树一致。

<a id="dev-note"></a>
## 开发备注

无。
