# Agent Note: five browser-operation correctness and wait-efficiency fixes

Status: implemented

English | [中文](2026-10-27-extension-browser-op-correctness.zh.md)

## Problem

Five independent correctness/efficiency defects on the extension's browser-operation surface, each with a user-visible failure mode:

- **scroll settle timeout double-scrolled.** When the in-page settle poll hit its 2.5s budget (resolve null), `scroll()` fell back to `settled = before` — treating unknown movement as zero. A gesture that had partially scrolled kept running past the budget, and the full-amount top-up landed on top of the partial movement (double scroll).
- **CDP send during an in-flight attach failed spuriously.** `send()` skipped the attach join whenever `attaching` already held the tab, firing the command into the window before the debugger session existed — Chrome rejects it with Not attached, translated to the misleading 「调试会话已断开」 and reported to the model as a broken session.
- **type_text raced a flat 30s deadline.** The provider's per-call deadline was a flat 30s; humanized typing costs up to one maxDelay (150ms) per character, so ~200+ characters could legitimately outlive the cap and be misreported as 浏览器操作超时 while typing was proceeding normally.
- **skip readback passed as success.** When the type target selector resolved to a wrapper (not a text-entry element), the value readback returned `skip` and `ensureInputValue` treated it as verified — while the keystrokes had actually landed on `document.activeElement` (possibly nowhere). Silent misdirected typing.
- **Every satisfied poll paid one interval tick.** `pollUntilExpression` registered `setInterval` before ever calling `check()`, so an already-satisfied condition (element already present, page already complete) always waited one full cadence — paid by waitFor (200ms), scroll settle (150ms), and settleNavigation (120ms) on every fast-path call.

## Decision

- **scroll (mouse.ts):** a settle timeout now counts as unknown movement: ONE plain `window.scrollY` re-read recomputes the residual from the actual position; only when that read also fails (page navigated away, context destroyed) does the operation degrade to zero movement. Residual computation, the ±1 tolerance, and the batch-39/40 semantics for dropped/partial/inverted gestures are unchanged.
- **CDP attach (cdp.ts):** `send()` now calls `attach(tabId)` unconditionally when not attached — `attach()` is already idempotent and hands back the in-flight task, so concurrent sends share one attach and commands wait for the session to exist. `handleDetached` keeps the in-flight `attaching` entry (an onDetach notification cannot cancel the running `doAttach`; deleting the entry would push joiners into a second, rejected attach). A genuine detach after a completed attach keeps the original 调试会话已断开 error unchanged.
- **type_text deadline (browser-provider.ts):** the deadline is `30s + codePointCount × maxDelayMs` for `type_text` when the 拟人化输入 capability is on, with `maxDelayMs` read from the op params (default 150, the same default ops.ts and keyboard.ts apply). Humanize off, or a text that cannot be read from the op params, keeps the flat 30s. No provider→SW cancellation signal is added — after a deadline the SW side keeps typing; the fix only stops the model being misinformed.
- **skip fallback (keyboard.ts):** a `skip` readback now validates `document.activeElement` — the element the keystrokes actually reached — with the same separator-insensitive matching as the requested-element readback, but no writeback (that element was never named by the model; a silent repair could write into an unrelated field). A still-uneditable focus throws 目标不是可输入元素; an editable focus holding a different value throws the standard length-carrying mismatch error.
- **poll first shot (dom-snapshot.ts):** the poll body moved into the exported closure-free `pollUntilBody` (called once synchronously before the interval is registered; a hit resolves immediately), and `pollUntilExpression` became a one-line serializer of that body — the same shipped expression shape, now unit-testable without dynamic execution. waitFor / scroll settle / settleNavigation consumers are untouched and inherit the fast path.

Test locks updated in the same change: the old 「degrades to safe defaults」 scroll case is rewritten to the new semantics (timeout → re-read → actual position; zero movement only after the re-read also fails), a 超时但已部分滚动 no-double-scroll case is added, the new `cdp-attach.spec.ts` pins the 60ms-attach race window and the handleDetached mid-flight guarantee, `keyboard-error-passthrough.spec.ts` pins the wrapper-skip validate/throw pair, `browser-provider.spec.ts` pins the widened deadline and the 30s fallbacks, and `navigation-settle.spec.ts` pins the satisfied-condition zero-interval behavior. Affected JSDoc contracts were updated in the same edits (send/handleDetached, ensureInputValue, scroll, and the provider deadline bullets).

## Alternatives considered

- **Provider→SW cancellation signal so a timed-out type_text actually stops.** Rejected for this batch: it needs a new wire message and per-op plumbing; the deadline widening removes the user-visible misfire, and cancellation is a mid-term item.
- **Writing the typed text back to `document.activeElement` on a skip-branch mismatch.** Rejected: the focused element was never named by the model — repairing it silently could overwrite an unrelated field; validation-only keeps the failure loud and attributed.
- **Testing the poll via `new Function` over the serialized expression.** Rejected: the repo's injection-safety gate blocks dynamic execution; extracting `pollUntilBody` tests the identical semantics directly while the serializer keeps one expression shape.

## Consequences

- A settle timeout no longer double-scrolls; partial gestures are topped up by exactly the missing remainder, and a fully-unreadable page degrades to zero movement as before.
- Two commands racing a slow attach both succeed instead of one reporting a broken debug session; a mid-flight detach notification cannot fork the attach task.
- Long humanized typing no longer reports 浏览器操作超时 while it is still typing; short/fast paths keep the 30s cap.
- Wrapper-selector typing is either verified against the actually-focused element or reported as 目标不是可输入元素 — no more silent misdirected input.
- Every fast-path poll answers without an interval tick (waitFor −200ms, scroll settle −150ms, settleNavigation −120ms on the happy path).
