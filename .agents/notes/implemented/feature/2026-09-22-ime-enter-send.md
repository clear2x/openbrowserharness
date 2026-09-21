# Agent Note: Enter sends; the IME composition guard keeps candidate commits from firing

Status: implemented

English | [中文](2026-09-22-ime-enter-send.zh.md)

## Problem

The composer only sent on Cmd/Ctrl+Enter; bare Enter always inserted a newline. For Chinese input that means: type pinyin, press Enter to commit the candidate, keep typing, finish, then reach for the cursor to click 发送 — the natural final Enter did nothing. The user asked for the ChatGPT convention: Enter sends; while an IME composition is live, Enter commits the candidate and must not send.

## Decision

The textarea keydown now sends on Enter without Shift (bare Enter, Cmd+Enter, and Ctrl+Enter all send; Shift+Enter stays a newline), guarded by an IME composition check with two signals: the keydown event's `isComposing` plus a `compositionstart`/`compositionend` ref pair that covers engines where the commit-Enter keydown races the compositionend event. While either signal is live, Enter falls through untouched (the IME commits the candidate; no newline is inserted by the composer). Esc-interrupt keeps its composition guard. The placeholder and the composer hint copy updated to 「Enter 发送，Shift+Enter 换行」. The inline-menu key handler already had the same pass-through and is unchanged.

## Alternatives considered

- **Keep Cmd/Ctrl+Enter as the only send.** Rejected: that is the behavior the user explicitly asked to change; the IME guard removes the only reason bare Enter was unsafe.
- **Send on keyup instead of keydown for IME robustness.** Rejected: keydown with `isComposing` plus the composition ref is the standard robust pair on Chromium; keyup sends feel laggy and break the Esc/interrupt symmetry.

## Consequences

- English typing: Enter sends immediately; Shift+Enter inserts a newline.
- Chinese typing: Enter commits the candidate (the IME handles it, nothing sends); once the composition is done, the next Enter sends.
- Coverage: the real-device harness synthesizes a composition session (compositionstart → Enter keydown with `isComposing=true` → compositionend) and asserts no request reaches the mock LLM, then presses a plain Enter and asserts the prompt sends and the reply returns. Full extension suite, typecheck, and lint stay green.
