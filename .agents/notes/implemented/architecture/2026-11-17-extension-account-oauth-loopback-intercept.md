# Agent Note: The extension's account OAuth pivots to loopback interception

Status: implemented

English | [中文](zh/2026-11-17-extension-account-oauth-loopback-intercept.md)

## Problem

Bringing DeepSeek account sign-in into the browser extension needed an OAuth callback path. The chosen plan was a docs-site bridge page plus `externally_connectable`: the platform redirects to the site's callback page, which relays code/state back over `chrome.runtime.sendMessage`. While wiring the PKCE exchange, a live probe disproved the plan's premise: the platform's `auth_init` accepts loopback HTTP redirect origins only — `https://clear2x.github.io/oauth/callback` answers `PAYLOAD_SCHEMA_MISMATCH` (50005), while `http://127.0.0.1:<port>` and `http://localhost:<port>` both pass (verified by a curl bisect and an in-panel fetch). The bridge page can never receive the redirect, and a browser host cannot bind a loopback port to receive it either.

## Decision

Drop the bridge page and pivot to loopback interception:

- The redirect URI is the fixed `http://127.0.0.1:47099` (single source in `shared/protocol.ts`).
- The service worker registers one declarativeNetRequest dynamic rule at startup: a regex matches the loopback callback URL and `regexSubstitution` reroutes the navigation onto the bundled `public/oauth-relay.html` (code/state preserved through the query string).
- The relay page reaches the offscreen web-server shim via `chrome.runtime.sendMessage`; the shim re-dispatches the callback over the upstream account host's `webserver/request` waterfall with a synthesized request/response — host/path/timing-safe state validation, the PKCE exchange, and the grant commit all remain upstream code.
- The earlier fork patches (`loginOrigin` extra-origin allowlist and the listener's protocol derivation) and the docs-site bridge page are fully reverted; upstream `packages/credentials/deepseek-account` stays pristine.

## Consequences

- The manifest gains the `declarativeNetRequest` permission (`host_permissions` already carries `<all_urls>`); store review needs a one-line callback-interception justification.
- A DNR rule without `resourceTypes` does not match `main_frame` — navigation interception must declare it explicitly.
- Loader rows mount modules by "namespace plus an `apply` export"; a namespace that only default-exports a class never instantiates (chrome-skill-storage is the template).
- Without `Buffer.concat` in the buffer shim, the upstream response reader's TypeError surfaces as a `stage=parse-json` protocol failure — upstream diagnostics name the stage; when the offscreen console is invisible to a probe, wrapping `console.error` in an owned module and persisting to storage makes it readable (removed after diagnosis).
- api-bridge resolves optional seams lazily (`ctx.get` plus a structured not-mounted error): declaring them in `inject` parks the fiber pending in compositions that omit the row (test fixtures), which the leak assertion catches immediately.
- Port 47099 is fixed and bound to this repo's dist; on conflicts with another local service, the browser navigation is intercepted by DNR first, so the collision surface is only same-path visits.

## Alternatives considered

- **Registering the callback with the platform (un-doing the pivot's premise)**: requires DeepSeek to register a web origin for this client — an external decision with an uncontrollable timeline; even granted, the bridge page keeps an extra external dependency (docs-site availability) over loopback interception.
- **`webRequest`-based interception**: MV3 `webRequest` can observe but not redirect; `declarativeNetRequest` is the only declarative redirect surface.
- **Relaxing upstream `loginOrigin` to accept web origins**: even with the local gate opened, the platform schema still rejects non-loopback redirect URIs — patching upstream does not address the platform constraint and only grows the fork diff.
