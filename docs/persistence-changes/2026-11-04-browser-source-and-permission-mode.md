---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-04-browser-source-and-permission-mode

English | [中文](2026-11-04-browser-source-and-permission-mode.zh.md)

## Summary

Records the merged tree's message-source extension and the new permission-mode event root: the merge-extensible MessageSourceMap gains the browser tools' tool-browser kind, which extends the source union of user/message, developer/message, agent/inbox/spliced inserted[] entries, and session/title-llm-request messages[], and the known event inventory gains permission/mode.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-04-browser-source-and-permission-mode
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "9f6d48b3e6f030c6fee6d3669e909ba45954ccd3bf70dfe95482c079d28cd558"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "9f97339aafe9b38589ed1b0f48420053ce899a5e16d42cb98f7531ec940d5cd0"
    decision: same-version
  - root: "event:permission/mode"
    previous: null
    after: "aeb07120dc699841c9edc0f91a52aea1203e4181f304063cbfb52ed98f13b63f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "dc0bd567f57b63665032e7b7ac4cb436d02471136888477e3e2c12e0b5a97803"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "94cc511fdb6d29a0572341456e72ac9a200c38ca4d1dbc536097921641a327c2"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Readers switch on source kind and fall through unknown kinds, so records carrying source kind tool-browser stay readable for every existing reader, and readers that never emit tool-browser keep producing records the current tree accepts. Writers of acknowledged history never emitted the tool-browser kind or permission/mode events, so every committed record remains valid unchanged. Both transitions stay inside the current Session format version with safe reader behavior; the permission/mode root addition follows the same-version allowed rule.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/session/tests/canonical-envelopes.spec.ts packages/core/session/tests/message-projections.spec.ts: 217 tests passed. pnpm exec vitest run packages/session/session-persistence-jsonl/tests: 765 passed, 1 skipped. pnpm exec vitest run packages/subagent/subagent-codex/tests packages/subagent/subagent-claude-code/tests: 125 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
