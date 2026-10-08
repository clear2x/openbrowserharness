# Agent Note: the `/learn-site` command — mechanical site learning as a user plugin

Status: implemented

English | [中文](2026-10-08-site-learn-command.zh.md)

## Problem

Every browser task on a familiar site replays the same exploration: navigate, `page_snapshot`, read the DOM, guess selectors, repeat — dozens of tool calls and model tokens spent rediscovering facts the agent has already learned once, and re-spent again in the next session. The reverse-engineered knowledge (which form field is which, which selector is stable, what the sub-page map is) evaporates when the session ends.

## Decision

`/learn-site` (the `chrome-site-learn` plugin, `apps/extension/src/offscreen/site-learn.ts`) delivers site learning as one user-typed command with zero model calls in the learning path:

1. **Crawl** — the command resolves the active http(s) tab, opens a dedicated learning tab (`active: false`; the user's tab is only the URL source and is re-activated by id afterwards, best-effort), and breadth-first crawls same-origin pages discovered from extracted links. Binary extensions, non-http schemes, credentialed URLs, and cross-origin links are filtered at the queue (`normalizeLearnUrl` / `sameOrigin`); the page cap defaults to 12 (`/learn-site <n>` clamps to the configured max).
2. **Extract** — one fixed in-page expression per page (`pageExtractExpression`, `awaitPromise` CDP evaluate after a `readyState` wait): title/h1, forms with fields and actions, standalone inputs, key buttons, and the same-origin link map — each control addressed by the best compact CSS selector (`#id` → `[data-testid]` → `[aria-label]` → `[name]` → unique class combo → short nth-of-type path). The two serialized functions are closure-free and exported; jsdom tests exercise the same function objects, and substring identity in the spec pins the shipping expression to them.
3. **Persist** — the condensed per-host cheat sheet (`buildSiteDigest`, byte-budgeted with tail truncation) is written by `UserPluginHost.writeKnowledge` as a roster record `site-<host>` carrying a `knowledge` payload. A knowledge record stores `code: ''` and never touches the sandbox (`activate()` short-circuits); a re-learn replaces the same-name record and purges any other knowledge record for the same host. The model's `user_plugin_write` lane cannot fabricate knowledge records (its input has no such field).
4. **Inject** — `ctx.systemPrompt.context` (`chrome:site-knowledge`, new centrally allocated `SITE_KNOWLEDGE` order 125) renders the matched hosts' digests, newest learn first, capped at two sites and the byte budget. The provider must be synchronous, so an effect-owned poll (1.5s default) refreshes a plugin-local cache of every window's active-tab hosts plus enabled knowledge entries; a completed learn refreshes the cache immediately. No learned host active → empty string → zero cost for other sites and sessions.

Two composer fixes ride along because they gate this command's entry path: `commands/execute` gets a 120s transport budget (handlers run to settlement; the 10s default misread a live handler as a failed service and sent the command line to the model as plain text), and a command typed on the fresh-session start (`session-new`) now mints and adopts a session first via a new optional `SendActions.ensureSession` — previously the first `/`-line of a fresh panel always fell back to a plain send.

Positioning against [site distillation](2026-09-30-site-distillation-network-and-skill.md): distillation is the LLM-run recipe that reverse-engineers XHR endpoints into fetch recipes (a skill the agent invokes); `/learn-site` is the mechanical, model-free sweep that maps pages, forms, and selectors, and injects them automatically while the host is the active tab. They compose: a distilled endpoint skill plus a learned selector cheat sheet cover both halves of site operation.

## Alternatives considered

**A user plugin authored by the model** (`user_plugin_write`). Rejected: the sandbox lane is an event-listener factory with no prompt-injection face; knowledge needs a system-prompt seam, which only a composed plugin can register. The roster extension keeps ONE storage key and one switch semantic instead of parallel stores.

**Inject every learned site on every turn.** Rejected: pays tokens for sites the user is not operating. The active-tab host match makes the injection conditional and the poll cadence bounds staleness to the configured interval.

**A dedicated site-knowledge storage key + a no-op roster mirror.** Rejected: two sources of truth whose enabled flags can drift; the panel's switch would lie. Extending `UserPluginRecord` keeps toggle, list, boot, and failure policy owned by the existing host.

**Crawl in the user's tab and restore the URL.** Rejected: a final `navigate` back reloads the page and destroys SPA state. The dedicated learning tab is closed at the end and the original tab re-activated by id.

## Consequences

Learning is user-commanded and read-only-plus-navigation: the explicit `/learn-site` line is the consent, and the crawl's navigations happen in its own tab (the tool permission gate is not consulted — commands are not tools). Learning cost is mechanical and one-time; the cheat sheet rides the durable runtime-context snapshot (model-visible ⟺ logged; unchanged text is not re-materialized, and a change appends a new "supersedes" snapshot while the earlier one stays as history — the seam's existing semantics, same as approval-policy changes, with zero appends in steady state), and turning the roster switch off stops the digest in the latest snapshot within one poll interval — verified on a real device through the mock-LLM request bodies. Sub-page coverage is bounded by the page cap and by what the pages' own links expose; login-walled pages are captured only as the profile's session sees them. Keyless recorded-session snapshots are unaffected: the context renders empty without knowledge records and tabs.
