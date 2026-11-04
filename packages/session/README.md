---
description: "The durable session data plane: persistence, projection, titles, and telemetry around the live core session service."
kind: "package-group"
---

# session/ — durable session data plane

English | [中文](README.zh.md)

## Summary

The durable family around `core/session`'s live in-memory service: the persistence seam with its storage backends and checkpoint policy, the projection seam that serves whole log-derived values, log-backed titles, and outbound session telemetry. All **product** packages. `session-query/` remains a sibling group: the read/tool surface is consumed independently of persistence internals.

## Persistence

Durable session persistence, semantic checkpoint policy, and the shipped storage backends.

| Package | Role | ctx key |
|---|---|---|
| [`message-quotes/`](message-quotes/README.md) | Quotation controls and Markdown blockquote rendering | — |
| [`session-format/`](session-format/README.md) | Pure adjacent-format chain and artifact validation library | library — no ctx key |
| [`session-format-v0-to-v1/`](session-format-v0-to-v1/README.md) | Frozen released-v0 decoder and identity migration into released v1 | library — no ctx key |
| [`session-format-v1-to-v2/`](session-format-v1-to-v2/README.md) | Frozen released-v1 decoder and cardinality-changing Assistant-stream migration into released v2 | library — no ctx key |
| [`session-format-v2-to-v3/`](session-format-v2-to-v3/README.md) | Frozen V2 decoder and system-prompt, envelope, and PTC migration into V3 | library — no ctx key |
| [`session-format-v3-to-v4/`](session-format-v3-to-v4/README.md) | V3 identity migration and V4 codec with generation-aware delivery validation | library — no ctx key |
| [`session-format-catalog/`](session-format-catalog/README.md) | Generated static catalog of shipped adjacent migrations | library — no ctx key |
| [`session-persistence/`](session-persistence/README.md) | Defines the durable session-storage service and the shared write coordination every backend composes | `ctx.sessionPersistence` |
| [`session-persistence-jsonl/`](session-persistence-jsonl/README.md) | Shipped backend: immutable canonical generation filenames per Session with exclusive successor publication, optionally Zstandard-compressed | registers on `ctx.sessionPersistence` |
| [`session-persistence-indexeddb/`](session-persistence-indexeddb/README.md) | Persists sessions in IndexedDB for browser/extension hosts | registers on `ctx.sessionPersistence` |
| [`session-checkpoint-policy/`](session-checkpoint-policy/README.md) | Makes model requests, top-level tool side effects, and completed steps durable before the next action | wraps `ctx.llm` and `ctx.tools` |
| [`session-log-deepseek/`](session-log-deepseek/README.md) | Uploads the incremental canonical log as optional official DeepSeek request metadata | contributes `dsh_session_log` |

The session-persistence decision records the persistence design.

## Projection

Serves current, log-derived per-session state to client carriers.

| Package | Role | ctx key |
|---|---|---|
| [`session-projection/`](session-projection/README.md) | Defines and drives projection units that fold committed events into whole current values | `ctx.sessionProjections` |
| [`working-directory/`](working-directory/README.md) | Owns each Session's effective execution directory and user-context changes | `ctx.workingDirectory` |
| [`tool-working-directory/`](tool-working-directory/README.md) | Reads or changes the active directory through one tool | `working_directory` |
| [`session-projection-cache/`](session-projection-cache/README.md) | Persists projection checkpoints so cold reads skip full log loads | `ctx.sessionProjectionCache` |
| [`session-stats/`](session-stats/README.md) | Serves whole-log conversation counts and wall times through the `sessionStats` unit | registers on `ctx.sessionProjections` |
| [`session-turn-outline/`](session-turn-outline/README.md) | Serves the whole-log turn outline (turn, `turn/start` seq, prompt preview) through the `turnOutline` unit | registers on `ctx.sessionProjections` |

## Titles

Derives durable session titles from the session log, with an optional model-backed provider.

| Package | Role | ctx key |
|---|---|---|
| [`session-title/`](session-title/README.md) | Log-backed session titles with a deterministic fallback and one optional provider | `ctx.sessionTitle` |
| [`session-title-llm/`](session-title-llm/README.md) | Shared bounded execution for provider-owned title strategies | library — no ctx key |
| [`session-title-first-prompt-llm/`](session-title-first-prompt-llm/README.md) | Titles a session from its first eligible human message | registers on `ctx.sessionTitle` |

Deployments may register one model-backed provider; the service retains a deterministic fallback when none is present.

## SessionTelemetryBackend

Projects session activity into outbound telemetry and delegates delivery to a configured reporting backend. The telemetry decision records the reporting boundary; the mode decision records immediate, feedback-gated, and disabled delivery.

| Package | Role |
|---|---|
| [`session-telemetry/`](session-telemetry/README.md) | Defines capture, redaction, projection, and live or on-demand backend delivery. |
| [`session-telemetry-otel/`](session-telemetry-otel/README.md) | Delivers telemetry through OpenTelemetry logs in `FULL`, `FEEDBACK_ONLY`, or `DISABLED` mode. |

<a id="related-documentation"></a>
## Related documentation

- [Session persistence subsystem](../../docs/subsystems/persistence.md) — backend-neutral service semantics, the flush checkpoint, and crash recovery.
- [Working directory subsystem](../../docs/subsystems/working-directory.md) — effective directory and recovery.
- [Session projections subsystem](../../docs/subsystems/session-projection.md) — the projection unit contract and drive semantics.
- [Session titles subsystem](../../docs/subsystems/session-title.md) — title eligibility, fallback, and provider flow.
- [Session telemetry subsystem](../../docs/subsystems/session-telemetry.md) — capture, redaction, and delivery modes.
- [Session subsystem](../../docs/subsystems/session.md) — the live event log every package in this group persists or derives from.

See [`session-title-all-prompts-llm`](../experimental/session-title-all-prompts-llm/README.md) for the experimental optional capability.

<a id="dev-note"></a>
## Dev Note

None.
