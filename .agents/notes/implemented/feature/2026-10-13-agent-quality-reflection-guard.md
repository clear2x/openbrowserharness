# Agent Note: agent quality batch — click hit-check, index resolve, snapshot prep, reflection guard

Status: implemented

English | [中文](2026-10-13-agent-quality-reflection-guard.zh.md)

## Problem
 Three quality gaps surfaced while auditing the extension's browser operations: clicks could silently miss (an occluded/off-viewport target fell back to a bare coordinate click that hit the same occluder, reported as success); index-addressed clicks trusted a per-tab snapshot cache that explicit navigation never invalidated; and the agent had no mid-execution reflection — a turn could end with an unmet goal, or grind on a failing tool without changing course.

## Decision
 One combined batch, implemented as three reviewed slices:

- **Click hit verification with honest failure**: `page_click` probes the target before dispatching (`hitOk`/`hitReason`); a miss throws `点击未命中目标（原因）…请先滚动或重新快照`. The marker (`HIT_MISS_MARKER`) crosses the provider seam and both selector→coordinate fallbacks re-throw it instead of silently clicking the same occluder. Genuine addressing failures (element moved/removed) still fall back to coordinates.
- **Index addressing with drift validation**: `provider.resolve(tabId, index)` re-finds the cached element on-page (deepQuery + tag/text validation, `快照已过期` on drift); the per-tab cache is invalidated on explicit navigation. `PageSnapshot` gains `prepActions` and `BrowserProvider` gains the required `resolve` method (`PROVIDER_METHODS` synced).
- **Snapshot prep pipeline**: one in-page evaluate runs 冻结动画 / 横幅遮罩清理 / 懒加载触发 behind capability switches, skipping via a per-document token (adopting the page-verified token on the cached fast path — not the fresh one, which would re-run the sweep every other snapshot). 快照精简 drops passive text beyond 40 chars.
- **Navigation settle**: `Page.navigate`/history moves poll `readyState` (≤3s budget) after a short blind gap that covers the old-document swap window.
- **Reflection guard plugin (`chrome-reflect-guard`)**: `tools/post-execute` folds tool failures into reflection context (failure chains suggest a course change after repeated misses), `agent/pre-step` resets the fold per step, and `agent/turn-stopping` compares the assistant's final text against the user goal — thin or zero-action endings get a completion nudge (plan-mode exempt; budget-capped so the nudge can't loop).

## Alternatives considered
 **Silent coordinate fallback for every selector miss.** Rejected: it converts "element unreachable" into "clicked an unknown point and reported success" — the exact silent-failure class the hit check exists to kill. **Reflection inside packages/core/agent-loop.** Rejected: repo convention keeps loop changes out; the composition extension points (waterfall events, `agent.inject`) carry it. **Adopting the fresh prep token unconditionally.** Rejected as it defeats the token's purpose (page-side cached path never writes the fresh token).

## Consequences
 A miss now surfaces as an error the model can act on (scroll, re-snapshot) instead of a silent empty click; index clicks on a navigated page fail loudly as `快照已过期`. Snapshot prep is bounded (banner clicks ≤3, lazy hops ≤20) and skips on the cached path. The reflection nudge is budget-capped and plan-mode exempt, so it cannot loop a turn or stall plan approval.
