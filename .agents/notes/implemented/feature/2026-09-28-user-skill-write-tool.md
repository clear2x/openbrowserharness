# Agent Note: user_skill_write — the model can author and remove skills

Status: implemented

English | [中文](2026-09-28-user-skill-write-tool.zh.md)

## Problem

The agent could read skills but never author them: `tool-skill` exposed only the load tool, the browser storage provider was read-only at the seam, and the only management surface was an api-bridge RPC with zero callers. A user who wanted the agent to remember a reusable procedure had to paste it into the panel themselves, and the "self-loop" goal (the agent improving its own tooling) had no skill-authoring leg to stand on.

## Decision

A skill write seam now runs through the capability's three roles:

- **Service definition** (`packages/skill/skill`): `SkillProvider` gains an optional `persist` capability (`write(input)` / `remove(name)`), and `SKILL_NAME_PATTERN` plus `SkillWriteInput` become the package-level name and payload contracts. The registry gains `ctx.skills.writeSkill(input, options)` and `ctx.skills.removeSkill(name, options)`: they validate at the seam (kebab-case name, non-empty description/content, empty-string `whenToUse` refused), pick the first write-capable provider in the same merge order reads use, delegate, and invalidate the catalog so the next lookup and session catalog include the skill. Providers already driven by storage change events invalidate twice; that is harmless.
- **Browser provider** (`chrome-skill-storage`): implements `persist` by delegating to the existing `writeStoredSkill`/`removeStoredSkill` management functions, so model writes land in exactly the records the api-bridge RPC path writes, and the provider's storage-change listener re-publishes the catalog automatically.
- **Consumer tool** (`tool-skill`): `user_skill_write` takes `action: "write" | "remove"` plus `name`, `description`, optional `whenToUse`, and `content`; it surfaces the registry's validation and no-write-capable-provider errors as tool errors, and its result card reads "saved"/"removed".

The extension composition needs no changes beyond the rebuilt libs: the chrome plugin registers the provider, and the tool registers wherever `tool-skill` mounts.

## Alternatives considered

**An extension-native tool reaching chrome.storage directly.** Rejected: the repository's tool surface lives in shared packages behind ctx seams (the browser tool family consumes `ctx.browser` the same way), and an extension-only tool would need a new mounting precedent while duplicating the storage logic the provider already owns.

**Runtime-only registration (`ctx.skills.register`) instead of persistence.** Rejected: runtime skills die with the session and provide no storage lifecycle; the whole point is skills that survive across sessions, which is what the storage provider already persists.

**Separate `user_skill_remove` tool.** Rejected for now: one tool with a closed `action` union keeps the catalog small and mirrors how the model reasons about save-vs-delete over the same object; splitting remains trivial if prompts show confusion.

## Consequences

The model can now save and remove skills, and saved skills flow into the session catalog on the next turn via the invalidation. The costs: the write seam is a new public registry surface (validation errors are model-visible and must stay clear), coverage must keep the seam at 100% (registry and tool specs cover every branch including the no-provider error), and the recorded-session snapshot corpus — already red on `main` before this change (102 failures at HEAD from the model-config strand's unre-recorded prompts) — now additionally encodes the new tool in tool schemas whenever that corpus is next re-recorded against an aligned environment; the partial re-record attempted here was reverted rather than committed half-green.

## Verification

Registry spec covers delegation, merge-order preference, invalidation-driven lookups, every validation branch, and the no-provider error (43 tests). Tool spec covers write/remove through the real ToolRuntime plus a live registry, empty-`whenToUse` omission, all error branches, the presentation card, and the two-tool schema list (38 tests). Root typecheck and lint are clean, the tool catalog is regenerated for both languages, and the rebuilt engine bundle contains the tool.
