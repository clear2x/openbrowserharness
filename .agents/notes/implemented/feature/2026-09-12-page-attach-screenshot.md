# Agent Note: page_attach_screenshot — screenshots enter web forms without a model round-trip

Status: implemented

English | [中文](2026-09-12-page-attach-screenshot.zh.md)

## Problem

`page_screenshot` delivers a capture to the model as an image block, but a browser agent regularly needs the opposite direction: hand the screenshot BACK to a page — upload evidence to a form's `<input type="file">`, attach a map pin to a correction form. Nothing in the tool surface moved bytes page-ward, and the architecture made the obvious path impossible: the model receives an image, not data, so it cannot re-emit the bytes it sees, and a natural-language instruction ("paste the screenshot into the platform") fails no matter how well the model plans.

## Decision

- `page_screenshot` caches the capture bytes in memory at execute time, keyed by the durable `attachmentId` (LRU, 4 entries; `rememberScreenshotBytes`).
- A sibling tool `page_attach_screenshot { tab_id, attachment_id?, selector, filename? }` loads the cached bytes and injects a script through the browser seam that builds `atob → Uint8Array → File → DataTransfer`, assigns `input.files`, and dispatches `input`/`change`. **The bytes travel extension → page directly and never through the model** — the model only cites the id.
- `attachment_id` is optional: omitted means "the most recent capture" (`readNewestScreenshot`, insertion order). This matches the model's natural instinct — real-machine runs showed it inventing `attachment_id: "latest"` twice — and turns that instinct into the supported path. A cited id that misses the cache, or an empty cache, fails loud with re-capture guidance instead of silently re-shooting the wrong page.
- Both screenshot tools register only under `ctx.inject(['attachments'])`; the tool-catalog generator's browser block mounts the same catalog attachment-store marker so the pair is harvested (fixing `page_screenshot`'s earlier absence from the catalog).

## Alternatives considered

- **Model relays the bytes**: rejected — the capture is hundreds of KB of base64; routing it through tokens is wasteful, lossy, and a prompt-injection surface.
- **CDP `DOM.setFileInputFiles`**: rejected — it needs a file path on disk, which the MV3 host does not own for in-memory captures; the DataTransfer path works purely in the page.
- **Require the full `ImageAttachmentRef` echo in args and read from the durable store**: rejected — the model would echo metadata it can hallucinate; the in-memory cache fails loud on a miss with recovery guidance instead.

## Consequences

- Attach is selector-only (top-frame `<input type="file">`, shared with `page_type`) and engine-lifetime (a restart empties the cache; the miss message says so).
- The tool writes page state, so it is never parallelized; the injected script runs under the page's own CSP — no injected `<style>`, no synthetic clicks.
- Real-machine verified end-to-end: Amap pin capture → attach (453 KB and 1.59 MB PNGs) → page thumbnail render → submission echo carrying the screenshot name.
