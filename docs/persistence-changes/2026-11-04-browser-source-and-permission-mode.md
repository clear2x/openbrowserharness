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
## Compatibility

Readers switch on source kind and fall through unknown kinds, so records carrying source kind tool-browser stay readable for every existing reader, and readers that never emit tool-browser keep producing records the current tree accepts. Writers of acknowledged history never emitted the tool-browser kind or permission/mode events, so every committed record remains valid unchanged. Both transitions stay inside the current Session format version with safe reader behavior; the permission/mode root addition follows the same-version allowed rule.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/session/tests/canonical-envelopes.spec.ts packages/core/session/tests/message-projections.spec.ts: 217 tests passed. pnpm exec vitest run packages/session/session-persistence-jsonl/tests: 765 passed, 1 skipped. pnpm exec vitest run packages/subagent/subagent-codex/tests packages/subagent/subagent-claude-code/tests: 125 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
