---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-05-timeline-priority-notice

English | [中文](zh/2026-11-05-timeline-priority-notice.md)

## Summary

Records a Timeline notice when the user adds or removes urgent priority.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing messages keep their source and meaning. Timeline notices carry ordinary text and a source label, and the acknowledged splice payload also carries the source kind added by the parallel browser-source acknowledgement that precedes this record, so readers that switch on source kind fall through unknown kinds unchanged. Readers without Timeline can keep the unknown source and read the text without applying a task update. Timeline stores task trees, reports, and discussions in the session log as ignorable plugin:timeline/* records; readers without Timeline skip these records. Both transitions stay inside the current Session format version with safe reader behavior.

<a id="verification"></a>
## Verification

Timeline's priority tests check that only user edits to urgent priority enqueue a notice. The process recovery test checks that Timeline state survives an interrupted writer. After the upstream 0.2.2-rc.3 merge re-derived this acknowledgement on top of the parallel fork record, pnpm run verify-persistence-changes validates the linearized chain and confirms this tip's digests match the current tree.

<a id="dev-note"></a>
## Dev Note

None.
