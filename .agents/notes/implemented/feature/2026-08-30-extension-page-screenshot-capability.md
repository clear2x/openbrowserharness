# Agent Note: page_screenshot evidence capture as an opt-in capability plugin

Status: implemented

English | [中文](2026-08-30-extension-page-screenshot-capability.zh.md)

## Problem

The agent had no way to capture page evidence. The user's scenario: while correcting a POI on some platform, the agent should jump to Google Maps, search the uncertain name, collect candidate POIs (often several), and return to the original page — keeping screenshots as evidence. Two gaps: no screenshot tool existed anywhere in the seam, and evidence gathering across tabs had no prompt-level discipline. The screenshot capability also had to be user opt-in, presented like a checkable plugin.

## Decision

**The seam grows a read-only `screenshot` method.** `BrowserProvider` (dsh-browser) gains `screenshot(tabId, {fullPage?}) → {data: Uint8Array, mediaType: 'image/png', width, height}`, added to `PROVIDER_METHODS` so registration validates it. The chrome provider forwards it as a new `screenshot` CdpOp; the background SW attaches the debugger, reads `Page.getLayoutMetrics` (`cssVisualViewport` or `cssContentSize` for full page), and captures with `Page.captureScreenshot` (`captureBeyondViewport` for full page). The wire carries base64 (runtime messages are JSON); the provider decodes once at the seam edge.

**The tool is the `read_image` pattern for live pages.** `tool-browser` registers `page_screenshot` inside `ctx.inject(['attachments'])` — no durable store, no tool. Execution gates on the attachment service, the PNG media acceptance, the per-message byte cap, and the strict image-modality route gate (a tool result enters durable history, so a text-only model refuses before any capture). The PNG is committed through `attachments.saveImage` and returned as `{tabId, url, captured, image}` whose render is a text envelope plus an `ImageBlock` — the screenshot enters model context like `read_image` output, and nested dispatches get the same content via `deferContext`.

**Opt-in lives at the provider, presented as a built-in plugin row.** The capability flag is a chrome.storage key (`dsh-capability-screenshot`, default OFF) read per call by the chrome provider's `screenshot` — a disabled capture refuses with 「网页截图能力未启用：请在侧栏「用户插件」面板中勾选开启」, so a toggle applies to the next tool call without an engine reload, and a storage outage fails the nicety closed rather than breaking dispatch. The UserPluginPanel renders a 内置能力 section (same switch affordance as user plugins) backed by `capability.screenshot.get/set` bridge RPCs.

**Cross-page evidence workflow is prompt guidance, not new machinery.** The shared browser guidance (`BROWSER_GUIDANCE_TEXT`) gains two clauses: (5) 跨页取证 — research on external sites in a `tabs_open` tab, extract candidates with `page_snapshot`/`page_extract_text`, then `tabs_switch` back to the work tab and `tabs_close` the research tab; (6) 留证截图 — capture with `page_screenshot` and cite the page URL. The primitives (multi-tab, snapshot, extract) already existed; the guidance teaches the choreography.

## Alternatives considered

- **A sandboxed user plugin registering the tool.** Rejected: the user-plugin lane is event-subscription only and its sandbox cannot reach chrome.debugger; building sandbox tool registration plus a host-capability bridge for one first-party capability is a larger feature than the need.
- **Putting the opt-in flag in the tool (tool-browser).** Rejected: tool-browser is host-agnostic; chrome.storage is extension-owned. The provider layer is the extension boundary, so the policy lives there.
- **JPEG by default for size.** Rejected: evidence value is UI text legibility; PNG stays under the attachment caps for viewport captures, and the full-page byte overflow refuses with an actionable message instead of silently degrading.

## Consequences

Model-visible screenshots now ride the durable attachment lifecycle end to end: capture → validated commit → content-addressed reference in the tool result → image block in the model request → panel readback via the existing `session.attachment`. The capability is invisible until the user opts in and refuses loudly (with the enable hint) when invoked while off. A capture never changes page state, so it sits outside the permission-mode matrix by design.

The debugger banner (「已开始调试此浏览器」) appears while a capture is in flight — the same notice every CDP operation already produces; screenshots add no new permission surface.

## Testing

- `packages/browser/tool-browser/tests/tool-browser.spec.ts` (page_screenshot describe): provider call recorded, durable commit with declared media type, value provenance (tabId/url/captured), full-page scope passthrough, and the text-only-model refusal before any provider call.
- `packages/browser/browser` spec doubles updated for the new required provider method (compile-time contract enforcement).
- `apps/extension/tests/composer-bar.spec.tsx` unchanged behavior pinned; the panel row + flag RPCs are covered by the existing panel spec harness shape (injectable rpc double).
- Verified live: the 内置能力 row toggles and persists in the panel, and the permission gate's approval card still fires for change-class tools around it.
