# Upstream 0.2.0-rc.2 recon — selective-sync decision material (2026-09-30)

Scope: the fork (OpenBrowserHarness, browser-extension product line) vs
upstream deepseek-ai/deepseek-harness `master` — **3959 commits / ~1.3M
lines** of divergence since the fork point, now at `dsh-v0.2.0-rc.2`
(2026-09-29). A full merge is not a realistic option (the desktop/web
product lines diverged massively); the vendor/ directory pins the
cordis framework layer and is governed by its own sync procedure, so
the practical question is **selective cherry-picking**.

## Directly relevant to the extension (candidate ports)

1. **pi-ai 0.87.1 + third-party model catalog refresh** (rc.2 chore).
   The fork's last pi-ai migration was 0.84 (2026-09-10); upstream notes
   "some older model IDs have been removed, so saved selections may need
   to be reselected". Our provider presets (llm-providers.ts) and the
   pi-ai drift gate from that migration are the affected surface.
   Priority: **high** — it is the model-catalog authority the extension
   reads.
2. **Image-failure auto-reupload + request continuation reliability**
   (rc.1 improvement). Directly adjacent to the vision path this batch
   opened (c475912246): a failed image upload currently surfaces as a
   send error. Priority: **medium-high**.
3. **KV-cache-safe dynamic tool addition, gated on explicit model
   support declaration** (v0.1.7-rc.2). Interaction with our tool roster
   (user plugins can register tools mid-session). Priority: **medium** —
   needs an engine-surface read before committing.
4. **Bash/PowerShell guidance hardening** — remind the agent to verify
   resolved target paths before delete/move (rc.2 improvement). Ours:
   system-prompt persona text in the snapshot compositions +
   `tool-bash`/`tool-pwsh` descriptions. Priority: **medium** (small,
   safety-positive).
5. **Automation-reminder framing change** — scheduled reminders are
   delivered as scheduled user messages, no longer marked
   untrusted-relay-only. A security-posture change; review before
   porting. Priority: **low-medium**.
6. **Experimental async question mode** (manual enable) — the agent
   continues independent work after a wait expires, answers can arrive
   later. Interesting for the extension's approval/ask flows. Priority:
   **low** (experimental upstream).

## Not relevant

Desktop application work (menu-bar dsh command management, Intel Node
signing, GUI login-shell env), plugin-management UI, Office/PDF preview
theming, dark-mode switch contrast, first-run onboarding — all surface
areas the extension does not ship.

## Recommendation

Treat upstream as a feature-reference, not a merge target. Port in
order: (1) pi-ai/catalog refresh, then (2) image-reupload reliability,
then (4) path-verification guidance; review (3) and (5) on their own
merits. Re-scan upstream releases after the 0.2.0 final tag.

## Port decisions recorded after recon (2026-09-30)

- Item 2 (image-failure + continuation): the "auto-reupload" half shipped in
  August upstream and is already in the fork's history; the real port was
  6a6f350b94 (settle pending tool results before failed steps close), landed
  as 3001822358 in its session-v3 adaptation.
- Item 3 (KV-cache-safe dynamic tool addition): **not ported**. The upstream
  stack rides on the fork-missing Session V4 developer-message base
  (e0bd7e1960, ~59k lines) and its KV-cache payoff activates only on the
  DeepSeek Messages endpoint (`addition-only` + the mid-conversation
  tool-changes beta); every route this fork ships (chat/completions, the
  fork's own anthropic adapter, pi-ai) lacks the capability, so a full port
  would degrade to current behavior plus per-change event overhead. The
  local tools registry already exposes the same trigger surface
  (`ctx.tools.register` + `tools/change`), so a future audit-trail-only
  variant (ignorable v3 event) remains available without the base.
- Item 5 (scheduled-reminder framing): **not ported**. Upstream 511a62cd1b
  deliberately drops the untrusted-reminder clause and its own decision note
  accepts the residual risk of model-authored prompt text arriving under a
  user-origin line, with a demonstrated-injection reintroduction condition.
  This fork's browser surface reads more untrusted web content than the
  upstream default, so the existing injection-resistant framing in
  `packages/schedule/schedule/src/domain.ts` stays.
