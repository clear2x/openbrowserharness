# Open items — snapshot replay divergences (2026-09-30)

The corpus converged to 131/133 for the bash/pwsh guidance port
(df94eb419b). Two scenarios remain red with replay-only divergences;
both need a dedicated investigation session.

## 1. acp fs-escalation-approved — configOptions catalog mismatch

The re-baselined live `stdout.expected.jsonl` advertises three model
options (flash / pro / flash-vision-exp) and described reasoning-effort
entries (live llm-deepseek catalog). The replayed run advertises only
flash+pro with bare-id effort names (the replay adapter's catalog from
`cordis.snapshot.yml` declares exactly those two models and
`reasoningEfforts` without descriptions).

The two environments structurally disagree about `configOptions`
(AcpModelControl.options reads `llm.listModels`), and record/live vs
replay will always differ here unless the replay catalog mirrors the
live catalog (add the vision-exp entry with inputModalities, and give
ReplayAdapter's resolveModel the described-effort shape the live
adapter produces) or the comparison normalizes configOptions.

Also in the same scenario: replayed fs tool results render
`<path>{{cwd}}/{{cwd}}/escalated.md</path>` (doubled cwd prefix) while
the live recorded result has the correct single prefix. `resolveLocalTarget`
itself does not double (verified by direct invocation); the doubling
likely lives in the replay cwd mapping (`/dsh-snapshot-cwd` virtual root
→ real cwd) or in `tokenizeFixtureString`'s basename regex interacting
with the virtual path. Suggested first step: dump the replay run's actual
`file_path` argument and `displayPath` result for one write call.

## 2. sdk persistent-tools — same doubled-cwd shape

Same doubled prefix in tool results after the guidance re-baseline.

## Why not fixed inline

Both are replay-environment path/catalog behaviors, not the guidance
port itself; each needs instrumented replay runs to pin the exact
transformation. Everything else in the 133-scenario corpus is green.
