# Agent Note: extension adapters leaked mid-stream transport failures past the retry executor

Status: implemented

English | [中文](2026-09-20-sse-midstream-transport-classification.zh.md)

## Problem

`dsh-llm-retry` has been mounted since the first extension build, so a dropped LLM connection should schedule bounded automatic retries instead of ending the turn. It only retries failures that carry a machine code it recognizes (`TRANSPORT`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `EMPTY_RESPONSE`). The two adapters the extension ships for its provider presets (`anthropic-adapter.ts`, `responses-adapter.ts`) classified the pre-stream fetch failure and in-band SSE error events as coded `TRANSPORT` `LlmError`s, but consumed the response body unwrapped: a mid-stream drop rejects the body reader with the browser's bare `TypeError: network error`, which escaped the generator uncoded. The retry executor saw no recognized code, delegated, and the turn ended on the manual-retry error card. Real usage hit exactly this on the GLM `anthropic`-protocol route: every transient nightly blip needed a human click on 重试.

The sibling routes did not have the gap: `DeepSeekAdapter` wraps its whole stream loop and maps unknown failures to `TRANSPORT`, and the `llm-pi-ai` family classifies by message text (`network`, `terminated`, `premature close` → `TRANSPORT`).

## Decision

Each adapter now iterates `sseWithTransport(...)` instead of `ssePayloads(...)`: a thin generator around the same SSE parser that rethrows caller aborts unchanged and rethrows every other mid-stream failure as `Anthropic API（<baseURL>）流传输中断：<detail>` / `Responses API（<baseURL>）流传输中断：<detail>` with code `TRANSPORT`. The mounted retry executor then treats the step like any other transport failure — normal mode schedules five retries with exponential backoff, writes the durable `llm/retry` events, and re-runs the step in the same open turn. Nothing else moved: the parser, event translation, and abort semantics are unchanged.

## Alternatives considered

- **Retry inside the adapters.** Rejected: retry policy belongs to the executor at the durable agent-step boundary; an adapter-level retry would re-issue a request whose partial output the loop had already consumed.
- **Wrap the consuming `for await` loop in try/catch.** Rejected: re-indents ~120 lines per adapter for the same guarantee; wrapping the iterator keeps the transport classification in one named helper and leaves the event-translation loop untouched.

## Consequences

- A mid-stream connection drop now auto-recovers through `dsh-llm-retry` (five backoff attempts by default) instead of demanding a manual click; the manual-retry card remains for genuinely exhausted or non-retryable failures.
- The error message for an unrecoverable mid-stream drop is now coded and carries the source (`…流传输中断：network error`) instead of a bare TypeError.
- Coverage: both adapter specs gained a case that errors the response body mid-stream after one valid event and asserts the rejection is a coded `TRANSPORT` `LlmError`; full extension suite 346 green, typecheck both faces, lint 0/0.
