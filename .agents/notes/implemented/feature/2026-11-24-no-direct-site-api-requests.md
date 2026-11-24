# Agent Note: No direct site API requests

Status: implemented

English | [中文](2026-11-24-no-direct-site-api-requests.zh.md)

## Problem

The first rule ([website tasks through real page operations](2026-11-24-website-tasks-through-page-operations.md)) closed the exit a model writes itself — a page script that calls the site's API — and left three others to the prompt rule alone: a tab opened on an API address, `web_fetch` pointed at one, and the `video_index` index action, which requests Bilibili's video, subtitle, and audio endpoints with the user's login state. The reason for the rule is sharper than that note stated. A site can tell a request its own page did not make — a missing signature, a navigation where an XHR belongs, a machine's pace — and answers with risk control; on an account the user logs into, that can end in a ban. A prompt line does not protect an account: the model that breaks it once has already sent the request. One prompt line was also working against the rule: the `page_network` description taught the model to find data endpoints and then fetch them with `page_evaluate`.

## Decision

A site's API is never requested directly by anything the agent triggers, unless the user turned the one switch on.

The tool gate (`chrome-tool-gate`, the `tools/pre-execute` waterfall) refuses every such call before it runs, under every permission mode:

- agent-authored code that names a request primitive, or that spells out an API address — assigning it to `location.href`, opening it, setting it as an element's `src`: the first rule's lexical check, extended;
- a call whose address is an API address: `tabs_open`, `page_navigate`, a `navigate` step of `page_batch_actions`, `web_fetch`;
- the `video_index` action `index`.

An address is an API address when the first host label names an API host — `api`, `apis`, or a label carrying either as a whole token (`open-api`, `h5api`, `api2`) — unless that subdomain is a documentation site (`api.flutter.dev`, `api.dart.dev`, `api.jquery.com`, `api.rubyonrails.org`, `api.wordpress.org`, `api.kde.org`); or the first path segment is an API root on any site (`api`, `apis`, `ajax`, `graphql`); or it is the API root a site family keeps under its page hosts (`x` under `bilibili.com`). Anything else is a page address and passes. The classifier is `isSiteApiUrl` in `shared/script-network.ts`.

`video_index` keeps a page-operation path for videos without an index: `zoom` accepts a video page URL in place of an index key. It opens the page, drives the real player to the timestamp, and captures the frame, with local OCR of burned-in subtitles; no request leaves for Bilibili's API. `query`, `status`, `list`, and `remove` read the stored index and are not gated.

The `page_network` description no longer teaches the endpoint route. The tool is described as a passive capture of what the page itself requested, for understanding the page; the captured addresses are not for the agent to request.

The switch is the built-in capability 直接请求站点接口; the storage key `dsh-capability-script-network` keeps the name it was given when the capability covered page scripts only, so a stored choice survives. The switch's description states the risk, every refusal states it, and the `site-api-crawl` skill — the one skill that needs the switch — tells the model to put the risk to the user before anything runs.

### Outside the rule

Passive observation is not a request: `page_network` reads what the page itself sent, and a page the agent opens makes its own API calls with its own signatures — that is a person opening the page. Page addresses are not gated, including a page that embeds API responses. `/learn-site` fetches same-origin page sources itself; it requests pages, not APIs. The tools of an MCP server the user configured are the user's own and are not gated.

## Alternatives considered

**Keep navigation and `web_fetch` under the prompt rule** — the first note's decision. A model that learned the route ignores the line, and the tab navigation is the exit that carries the user's cookies under an unusual `Sec-Fetch-Dest`. Too costly against a ban.

**A host rule without the documentation exception.** `api.flutter.dev` and `api.jquery.com` are documentation sites people read; refusing them would push users toward the one switch that turns the protection off. Six hosts are exempt. A seventh documentation host is a refusal with a clear message, not a request sent.

**A path rule per site for every platform** (`/aweme/` on Douyin, `/h5/` on Taobao). Each entry is a guess about a site's routing that breaks silently at its next redesign. The host rule and the generic path roots cover the spellings a model writes; Bilibili's `x` root is kept because it is this fork's primary target site.

**The check inside each tool** — `web_fetch` reading its own URL, `video_index` reading the switch. The rule would then live in four places with four refusals. One listener owns the rule, the refusal, and the switch.

**Remove `video_index` indexing.** The channel is the only way to a full-transcript index without on-device audio capture, and a user who wants it can accept the risk knowingly. It stays behind the switch; `zoom` by URL is the page-operation path.

**Passive response bodies as the replacement for API data** — `page_network` extended with `Network.getResponseBody`, giving the agent data the page's own requests produced. Not built: the capture layer returns a request list today, and which bodies are kept, for how long, and what the model may read is a decision of its own. It is the next step to take if users miss API data under this rule.

## Consequences

Cost: `video_index` indexing is off until the user turns the switch on — the main action of a shipped feature now needs an opt-in, and the store copy says so. An address classifier is a heuristic: a platform API under a path root nobody listed passes the gate (the prompt rule still forbids it, and nothing else does). A documentation site served from an `api` host outside the six is refused, with a message that names the switch. A page script that spells out an API address is refused whatever it meant to do with it — one that reads the resource timing of the page's own API requests, for instance; `page_network` is the tool for that.

Bought: no exit by which the agent triggers a site's API stays open by default, including the one this fork shipped itself. The reason — risk control and the account — is stated in the guidance, in every refusal, and in the switch's description, so a user who lifts the rule does it knowingly.

Testing: `tests/script-network.spec.ts` pins the address classifier (API hosts, token labels, path roots, the documentation exception, page addresses, non-HTTP schemes), the three refusals, and the switch label's parity with the panel; `tests/tool-gate.spec.ts` pins the gate over every exit, the calls that pass, and the switch; `tests/video-index-zoom.spec.ts` pins `zoom` by URL with no index; the real-device probe `script-gate-probe` runs the exits through the real engine composition with a mock model.
