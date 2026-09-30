# Agent Note: Site distillation — network capture and the shipped recipe skill

Status: implemented

English | [中文](2026-09-30-site-distillation-network-and-skill.zh.md)

## Problem

Every browser task on a familiar site replays the same exploration: navigate, snapshot, click, read, guess where the data lives — dozens of tool calls and model tokens spent re-deriving facts an agent has already learned before. The reverse-engineered knowledge (which XHR endpoint backs the search box, which payload the filter uses, which selector survives) evaporates when the session ends.

## Decision

Site distillation ships in two pieces:

**`page_network` tool** (`@deepseek-ai/dsh-tool-browser` + the chrome provider). The tool starts and reads a CDP Network-domain capture per tab: `action:"start"` clears the buffer and enables the Network domain on the existing debugger session; `action:"read"` returns the buffered exchanges (method, URL, status, resource type, MIME type, trimmed POST body, response bytes) with case-insensitive URL/resource-type filters and an optional stop. The Service-Worker recorder (`apps/extension/src/background/network.ts`) merges CDP events by requestId — a redirect hop stays one entry — keeps 400 exchanges per tab with a drop counter, and trims URLs to 600 chars and POST bodies to 4000. The seam grows two `BrowserProvider` methods (`startNetworkCapture`, `readNetworkCapture`), so any provider can back the tool; the tool is read-only and concurrency-safe.

**The shipped `site-distill` skill** (炼化站点). The extension seeds the recipe into the chrome.storage skill roster on boot (`ensureShippedSkills`, revisioned: bump the revision to re-seed, user deletions stick until then). The recipe is a four-phase pipeline the agent runs with existing tools:

1. 勘探 — start the capture, operate the target features like a user, read the captured XHR/fetch exchanges, and verify each candidate endpoint with a one-shot `page_evaluate` fetch.
2. 综合 — condense the evidence into a one-page capability list: endpoint table, DOM fallback recipes, preconditions.
3. 锻件 — write a `site-<domain>` skill via `skill_write`, each capability carrying a copy-pasteable fetch snippet; credentials never enter the content.
4. 回炉 — re-run every fetch recipe against the live site, fix or degrade to DOM steps, and report what was distilled.

The speedup is the endpoint fast path: a distilled capability executes as one `page_evaluate` call instead of a multi-step DOM exploration.

## Alternatives considered

**A plugin that registers site-specific tools.** Rejected: user plugins are event-listener factories (`{events, on}`) with no tool-registration surface; the skill's fetch recipes deliver the same fast path without an engine change.

**Automatic crawling inside the tool** (depth/breadth loops). Rejected for now: the agent already composes exploration from `tabs_*`/`page_*` primitives, and a crawler needs site-specific judgment (login walls, infinite scroll) the model supplies better than a fixed loop. The skill frames the crawl; a dedicated crawling tool can come later.

**Putting the recipe in the system-prompt browser guidance.** Rejected: the guidance is pinned by snapshot goldens and paid on every request; the recipe only matters when distilling a site, which is exactly what skills are for.

## Consequences

Network capture is engine-lifetime state: an SW restart drops the buffers and the next read reports an empty inactive capture — the agent re-records after `action:"start"`, which the tool's empty-read guidance names. The recorder only ingests events for tabs with an active capture, so the Network domain stays off outside distillation. The seeded skill is model- and user-invocable; `skill_write` with the same name updates it like any other skill.
