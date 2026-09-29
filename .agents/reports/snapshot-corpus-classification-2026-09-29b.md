# Snapshot corpus debt — Class D/E resolution (2026-09-29, second pass)

Follow-up to [the morning classification](snapshot-corpus-classification-2026-09-29.md).
The 19-residue classes D (explicit-effort flag mismatches) and E (session-array
drift) are resolved: **`test:snapshot` is 131 passed | 0 failed** (2 skipped).

## Class D — per-child-fixture header authority (18 scenarios)

The one-parent-pin variant idea died on contact with the corpus: delegation
semantics differ per mode (a spawn/continuable child stamps the inherited
effort explicitly from its first request; a fork child starts on the adapter
default and flips explicit at its first continuation), and `subagent-mixed`
carries both child kinds in one scenario — no parent-pin-derived variant, and
no scenario-level declaration, can express that.

The suites now compare a subagent child's headers against **its own committed
fixture log** (the authored script is the authority for delegation semantics),
with the same schema-sidecar restoration the pin path uses; parent sessions
keep comparing against the class pin verbatim. Both `verifyHeaders`
implementations (headless + sdk) share the rule. One TypeScript-only casualty:
the sdk suite's `verifyHeaders` needed the fixture contents passed in (the
first attempt passed the file-path array and died on `JSON.parse`).

## Class E — pid noise and stale wire goldens (persistent-tools + 3 subagent scenarios)

Two independent defects:

- **pid leak**: real bash/tool processes report their OS pid; every replay
  spawns a fresh shell, so `pid=<digits>` is run-local noise. `scrubString`
  now masks `pid=\d+` → `pid={{pid}}` (narrow enough to stay clear of
  model-authored prose).
- **stale wire goldens with no refresh channel**: authored scenarios skip
  refresh mode, so `notifications.expected.jsonl`/`result.expected.jsonl`
  (frozen shapes from an older engine — pre-`adapterDefaults` headers) had no
  re-baseline path. `DSH_SNAPSHOT_WIRE_REFRESH=1` on a replay run rewrites
  them from the same normalization the assertion reads. Four scenarios were
  re-baselined this way; `persistent-tools` also gained a realigned
  `workspace.expected/note.txt`.

## Operational notes

- The sdk `verifyHeaders` child-fixture path is the pattern to extend if a
  future scenario mixes delegation modes again — per-child-fixture authority
  scales; parent-pin variants do not.
- The pid mask lives in the shared scrub, so both fixture writing and
  comparison normalize identically; no fixture hand-edits were needed.
