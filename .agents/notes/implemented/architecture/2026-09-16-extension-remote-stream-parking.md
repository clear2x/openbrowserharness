# Agent Note: The extension panel's Remote stream face — park, don't dial WebSocket

Status: implemented

## Problem

The SidePanel's replacement connection module supplied only `rpc.call`, so the
0.1.5 gateway client (`ClientRemoteService`) treated every Remote stream as
undialable in-process and started its WebSocket mux against
`ws://<extension-origin>/api/remote.mux` — an endpoint no extension origin can
ever serve. The result was a permanent console retry storm (`Remote stream
WebSocket failed to open`), a live `session-controller` control-stream failure
log per generation, and downstream inert-module errors (`cannot get required
service "sessions" in inactive context` from `AgentPresetSeatController`,
whose provider fiber ordering under the extension's static module registry is
still under investigation — the boot's unhandled-rejection stack logger now
names the throw site).

## Decision

`createPortRpc` now implements `open` with an explicit two-entry policy:

- **`$events` is served faithfully for what the engine actually emits.** The
  port's host stream already fans allowlisted host events out as
  `host/remote-event` frames; the opener synthesizes the pump's `ready`
  handshake (fresh client id, `home: ''`) and reshapes those frames into
  `emit` frames. The engine emits no waterfall requests and no
  `api-session/*` typert events, so listeners for those stay inert — the same
  functional status as the dead WebSocket path, without the noise.
- **Every other endpoint parks**: the generator resolves only when the
  caller's signal aborts, warns once per endpoint (not per retry), and never
  yields. A silent wait preserves the pre-open status quo for consumers the
  engine cannot serve (`session/control`, `workspace/follow`) instead of
  feeding a reconnect storm.

With `open` defined, the gateway never starts its WebSocket mux
(`streams.start()` is gated on `rpc.open === undefined`), so the storm is
structurally gone, not merely quieted.

A boot-time `unhandledrejection`/`error` logger prints the reason plus the
first stack frames as separate console lines (multi-line console values
truncate on the shell's error surface) — this is what located the seat
controller's accessor as the inactive-context throw site.

## Alternatives considered

**Faithful `session/control` / `workspace/follow` adapters over the mux.**
The follow contracts need snapshot pages, assistant-stream revision baselines,
and projection acks the engine's mux frames do not carry; building them is a
dedicated project, not a noise fix.

**Throw for unknown endpoints.** Rejected: a throwing stream fails the
consumer's generation and re-enters a retry loop — quieter than WebSocket
spam but still churn.

**Suppress the WebSocket dial in the gateway package.** Rejected: upstream
code, and the extension is exactly the deployable whose carrier cannot serve
the fallback; the carrier decision belongs in the carrier's module.

## Consequences

Remote-event listeners keyed to engine-forwarded host events (settings and
credential invalidations) now receive live frames over the Port. Consumers of
unservable streams hang inert with one console line each. If a future engine
build serves more Remote streams over the api bridge, their endpoints move out
of the parked set by implementing them in `createPortRpc`.

## Residuals

- The `AgentPresetSeatController` inactive-context rejection at boot: the
  stack is captured (seat accessor reading `scope.sessions`); the suspected
  cause is provider-fiber ordering under the extension's static module
  registry. One boot-time rejection, no functional surface behind it in the
  extension shell (its preset chip rides chain A directly).
- Cold v0 sessions containing `permission/mode` refuse historical migration by
  design (the alpha historical-event decision owns the bounded refusal); the
  session list degrades them to header facts, fail-soft, every boot.
