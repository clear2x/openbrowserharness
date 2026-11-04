---
description: "Thin in-process subagent run entry for maintainers and backend authors who start one-shot in-process children through the activation manager."
kind: "package-library"
---

# @deepseek-ai/dsh-subagent-in-process-driver

English | [中文](README.zh.md)

## Summary

`dsh-subagent-in-process-driver` is the thin one-shot entry in-process subagent callers use to start a child through the activation manager: `startInProcessRun(request, options)` forwards the caller-facing start request to `ctx.subagents.startActivation` on the selected continuable provider with caller delivery, and maps the activation receipt onto a published run. The manager owns child materialization, prompt delivery, settlement capture, structured output, delegated policy inheritance, and disposal; this package adds no lifecycle of its own. It is a library, not a standalone feature: direct callers call `startInProcessRun`, and nothing in a composition configures it. Read this page to understand the run shape a direct caller receives.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

You reach this package through a direct caller, not a composition. The shipped in-process backends (`dsh-subagent-spawn-in-process`, `dsh-subagent-fork-in-process`) participate as providers: their `prepareContinuable` supplies the creation seed, and the activation manager does the rest. This page documents the run shape a direct caller receives.

### What one run provides

One call starts one caller-delivered child. Fulfillment means the manager already published the child in `ctx.agents` and reserved its activation; the run exposes the child's id and live agent, the manager-owned `result` promise, and the activation's `dispose()`. Settlement includes release: the manager disposes the child at natural settlement, so a resolved `result` implies the child is no longer live in the registry, and a later `dispose()` is a shared no-op. Calling `dispose()` before settlement cancels the child instead.

### The one input

`InProcessRunOptions` is `{ provider?: string }` — the registered `ctx.subagents` provider name, defaulting to `spawn`.

### What the child gets

The manager resolves everything: the parent's effective route and output-token cap unless `request.agentOptions` overrides them, the delegated sandbox override and the `'never'` approval pin, the subagent descriptor, the requested working directory, and — when `request.outputSchema` is set — the seam's structured-output runtime, whose captured value arrives as `SubagentResult.structured`. A provider whose `prepareContinuable` returns a seed adds the parent-history prefix.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the mapping contract; the observable behavior is covered in [Use this package](#use-this-package).

### Start contract

The entry follows this sequence:

1. Resolve the subagent runtime from the parent's context; absence fails loud with `CONTINUATION_UNAVAILABLE`.
2. Forward the request to `startActivation` with caller delivery, the selected provider, and the request's optional cwd, preset, agent options, output schema, and depth cap. The seam validates capabilities, depth, and cancellation before publication; a rejected start publishes nothing.
3. Read the published child out of `ctx.agents` and return it beside the activation's result and disposal.

### Cancellation and ownership

The required request signal covers startup through inbox acceptance; after acceptance the caller cancels through `dispose()`, which stops the child, awaits quiescence, and releases the activation. Teardown failures reject `dispose()` without replacing a captured result.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Start mapping: runtime resolution, `startActivation` forward, receipt-to-run shape |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from this entry to the seam that owns the lifecycle.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — start requests, results, provider contract, and activation ownership.
- [dsh-subagent-spawn-in-process](../subagent-spawn-in-process/README.md) — the fresh-child provider.
- [dsh-subagent-fork-in-process](../subagent-fork-in-process/README.md) — the seeded-child provider.
- Delegation-policy decision — how parent sandbox and approval policy reach the child.

-----

<a id="model-experience"></a>
## Model Experience

### Child-agent request

#### What the model sees

The manager sends the task verbatim as the child's initial user message, appends the subagent descriptor and the delegated policy events, and — for a structured run — adds the seam's `structured_output` definition and instruction. A caller-delivered run never notifies the parent; the caller reads only the final output and captured value from the result.

#### Token effect

Child input is isolated from the parent and grows through the child's own steps. The structured instruction and schema are paid only by that child.

#### KV Cache effect

Independent of the parent request cache. The child's later history is append-only from its own prefix.

### Parent start error, indirectly

#### What the model sees

Through the seam, invalid depth or capability requests become the runtime's typed `SubagentError` text; a pre-publication cancellation rejects without publishing a child.

#### Token effect

Zero tokens on a successful start; only the failed parent tool call retains this text.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what an in-process one-shot run cannot do; they are current package constraints.

- **Caller delivery only** — the run never posts a settlement notice to the parent; hosts wanting foreground delivery start through the seam with parent delivery.
- **Continuable materialization** — the manager materializes the child under a continuable descriptor; the old one-shot descriptor shape is not written.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
