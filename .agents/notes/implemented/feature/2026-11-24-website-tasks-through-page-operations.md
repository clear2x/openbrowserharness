# Agent Note: Website tasks through real page operations

Status: implemented

English | [中文](2026-11-24-website-tasks-through-page-operations.zh.md)

## Problem

When a task touches a website — search on it, open a video, load more comments, follow an account — the agent is expected to work the way a person does: navigate, click, type, scroll, and read what the page then shows. Models take a different route: they read the answer out of the site's own XHR endpoints with a `page_evaluate` script (`fetch('https://api.…/x/…')`), or request an API URL with `web_fetch`. The route looks efficient and fails in ways the user cannot see: the endpoints need signatures and cookies the page manages, they change without notice, they return data the page never shows the user, and an operation done this way is not the operation the user asked to watch happen. A prompt line did not hold on its own: the `bili-up-digest` skill text and the tool descriptions still presented the endpoint route as the supported one.

## Decision

Partly superseded on the same day by [No direct site API requests](2026-11-24-no-direct-site-api-requests.md): the tab-navigation and `web_fetch` exits are gated as well, the `video_index` index action is refused by default, and the switch is now named 直接请求站点接口. The prompt rule and the lexical check recorded below are unchanged.

The rule is stated where every turn reads it. The first item of the shared browser guidance (`BROWSER_GUIDANCE_TEXT` in `dsh-tool-browser`) says that a task on a site is completed through real page operations; `page_evaluate` reads state the page already presents or restyles a page at the user's request; `web_fetch` reads pages and documents, not a site's API endpoints; a tab is not opened on an interface address to read its response. The `page_evaluate` and `web_fetch` tool descriptions say the same.

A lexical check backs the prompt rule. The extension's tool gate (`chrome-tool-gate`, the `tools/pre-execute` waterfall) refuses agent-authored code that calls an interface before the permission matrix sees the call, under every permission mode — full access included. It reads the `page_evaluate` expression and the PTC `run_code` program; the program runs in the sandbox page with the page's network globals in reach, and its inner tool calls pass the same waterfall. Detection lives in `shared/script-network.ts`: comments, string contents, and regular-expression bodies are blanked, then the script is matched against the request primitives a page script can use — `fetch` in any read (called, aliased, bracketed), `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, dynamic `import()`, `importScripts`, jQuery `$.ajax` / `$.get` / `$.post` / `$.getJSON` / `$.getScript`, AngularJS `$http`, `axios`, and a `<script>` element built for its `src`. A refusal names the primitive, restates the rule, lists the page tools, and names the switch that lifts it.

The switch is the built-in capability, now named 直接请求站点接口 (`dsh-capability-script-network`), off by default; while it is on the rule rests. It is the explicit opt-in for an interface crawl the user asked for, and the `site-api-crawl` skill names it as a precondition. `site-distill` and `bili-up-digest` were rewritten around page operations; their seed revisions were bumped so existing installations re-seed them.

Superseded: `video_index` indexing was left outside the gate here and is now refused by default (see the note above). `zoom` by video page URL stays available without an index.

### The bilibili assistant preset

`bilibili-assistant` (bilibili助手) is the fifth browser specialty in the shipped roster. It operates B 站 like a person: search in the page's search box, click cards and tabs, scroll to load more, read the text the page presents, drive the player's own controls. A like, coin, favorite, follow, comment, danmaku, repost, or profile change happens only when the user asked for it in the task — the coin count is stated first, and the text of a comment, danmaku, or repost is shown to the user before it is posted; when the task did not ask for it, the agent says what it would do and waits for consent. Login, captcha, and risk control are handed to the user. Selecting it turns on 危险操作确认 (safe-click) and 提交拦截 (submit-guard).

## Alternatives considered

**Prompt only.** The cheapest option, and what the fork had. It loses to a model that has learned the endpoint route, and the failure is silent: the user sees a correct-looking answer produced the forbidden way. The prompt rule stays as the first layer; the gate is the second.

**Deny all `page_evaluate`.** Removes the request route and the tool's legitimate uses with it: reading `window.__INITIAL_STATE__`, scroll positions, computed styles, and the user-requested restyle of `/site-remix`. Too wide.

**A browser-side network block (CDP `Fetch.enable` or `Network.setBlockedURLs`).** Stops requests the page itself makes, or needs a per-site URL allow-list the fork cannot maintain. The gate answers a narrower question: did the agent's code ask for the network?

**Gating navigation to `api.` hosts and `web_fetch` on API URLs.** A host-prefix rule refuses legitimate pages — `api.flutter.dev` and `api.jquery.com` are documentation sites — and "API URL" has no general test. Navigation and `web_fetch` stay under the prompt rule, and the refusal message names both so a model that tries them is corrected at its first refusal. Superseded: both are gated, with six documentation hosts excepted (see the note above).

**Removing `video_index`.** Its subtitle channel is the one way to index a long video without on-device transcription, and it is the extension's own code. It stays; the bilibili assistant asks first. Superseded in part: indexing is refused by default now and runs only behind the switch.

**A JavaScript parser instead of the lexical scanner.** Classifies `fetch` reads exactly (object keys, type positions). The scanner's error is one class — a bare identifier named `fetch` used as an object key is refused — which is rare in page-reading scripts, and the refusal tells the model how to continue. A parser in the gate's execution path is not worth that difference.

## Consequences

Cost: a page script that mentions a network primitive is refused even when it would have sent nothing (a `fetch` object key); a user who wants an interface crawl must find and turn on one switch; the shipped skills lost their endpoint recipes and read what the page presents, which on B 站 depends on selectors that change with the site's redesigns (the skills keep fallbacks and say when they fall back).

Bought: the rule holds under full access and in PTC mode without relying on the model's compliance; a refused call teaches the rule at the moment it is tried, so the model's next step is a page operation; the opt-in is one named switch rather than a per-skill exception.

Testing: `tests/script-network.spec.ts` pins the scanner (reported primitives, let-through reads, comment, string, regular-expression, and template handling); `tests/tool-gate.spec.ts` pins the gate (refusal before any body runs under full and asking modes, read-only scripts untouched, the switch lifting the rule with the permission matrix taking over, `run_code` programs refused or delegated); an owner-local real-device probe outside the repository runs the same paths through the real engine composition with a mock model.
