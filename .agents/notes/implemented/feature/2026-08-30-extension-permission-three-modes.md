# Agent Note: Extension three-tier permission modes (ask-always / ask-change / full)

Status: implemented

English | [中文](2026-08-30-extension-permission-three-modes.zh.md)

## Problem

The extension's `chrome-tool-gate` hard-coded one behavior: `page_evaluate` and `page_navigate` always asked, everything else never did. There was no user-facing posture control — no way to say "ask me before every click", "only ask when something is modified", or "stop asking entirely" — and the desktop `dsh-permission-presets` package could not simply be composed because it requires a confining `ctx.shell` (bash sandbox) the browser host does not have, and its approval-policy knob (`ask`/`never`) means "never ask AND refuse", not "never ask AND allow".

## Decision

**A session-scoped, log-durable `permission/mode` knob owned by the extension.** A new engine plugin `permission-mode` (offscreen) declares the `permission/mode` session event (whole-value replace, last one wins, composition default `ask-change`), folds it with `effectivePermissionMode()`, and exposes a `ctx.permissionMode` service with `effectiveOf(agent)` / `set(agent, mode)`. The SidePanel switcher reads/writes it through `session.permission.get/set` bridge RPCs; repeat selections are no-ops so the log never fills with redundant events.

**Three modes, governing browser operations and file changes** (`shared/permission-mode.ts` is the pure vocabulary both bundles import):

| mode | browser browse (click/scroll) | browser change (type/press_key/navigate/evaluate/tabs_open/close) | fs write/edit |
|---|---|---|---|
| `ask-always` | ask | ask | ask |
| `ask-change` (default) | free | ask | ask |
| `full` | free | free | free |

The gate resolves every gated call through this matrix; read-only tools never consult it. Plan mode (engine `/plan`, unchanged) still denies `write`/`edit` outright regardless of the knob — planning needs free web research but not workspace mutations — and the knob does not touch plan state.

**The event entered the generated persistence catalog by widening the generator scan.** `KNOWN_SESSION_EVENT_TYPES` is produced by `scripts/gen-persistence-catalog.ts`, which previously globbed only `packages/*/*/src/**`; an event declared in `apps/extension` would pass typecheck but hard-refuse on cold resume (`assertEventsSupported`). The generator now also scans `apps/*/src/**`, so the extension assembly contributes log vocabulary exactly like a package. This surfaced two latent collisions: a stray `provider.d.ts` emitted into `web-search-deepseek/src` by an earlier tsc misfire (deleted), and the extension's local `agent-preset/selected` merge — now replaced by a type-only import edge to `@deepseek-ai/dsh-agent-presets` (added as a dependency; the app still never composes the plugin), so the event has exactly one declaration.

**UI**: the composer toolbar gained a shield chip showing the folded mode; the menu lists the three modes with a one-line description each and a checkmark on the current one, picking fires the optimistic switch plus the RPC, and a 5 s poll re-syncs (hidden until the first successful read).

## Alternatives considered

- **Composing `dsh-permission-presets` with a stub shell.** Rejected: it would need a fake confining executor to pass the load-time guard, and its sandbox/approval vocabulary (workspace-write, danger-full-access) does not describe a browser host.
- **Reusing the approval-policy knob with `never` repurposed as allow.** Rejected: `never` deterministically rejects at the service level; changing its meaning would break the desktop contract.
- **Four modes including plan.** Rejected after user review: plan stays an engine command (`/plan`), not a permission posture; the knob governs only ask/don't-ask.

## Consequences

Every gated call now folds the mode from the session log at pre-execute time, so a switch applies to the very next tool call — including mid-turn — and survives resume/fork for free. Sessions logged under the pre-switcher build have no `permission/mode` events and fold to `ask-change`; there are no legacy values to migrate because the knob shipped in the same build as the modes.

`page_screenshot` (see the sibling note) deliberately sits outside this matrix: a capture is read-only evidence gathering, gated only by its own opt-in capability flag.

## Testing

- `apps/extension/tests/tool-gate.spec.ts`: the full matrix (default == ask-change browsing free/changes ask, ask-always asks everything, full never consults the answerer, plan blocks file writes committed and pending while browsing stays free), plus the pre-existing audit-pair behaviors.
- `apps/extension/tests/api-bridge.spec.ts`: `session.permission.get/set` end to end — default fold, durable event append, repeat-selection no-op, unknown-mode `bad-request`.
- `apps/extension/tests/composer-bar.spec.tsx`: switcher render (three modes, checkmark), switch fires `session.permission.set`, chip hidden until the first successful read; CSS pins for the mode sheet.
- Verified live: with the default mode the agent's `page_evaluate` raised the approval card and `tabs_list`/`page_snapshot` did not.
