---
description: "Origin Private File System implementation of the ctx.fs provider contract for browser hosts."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-opfs

English | [中文](README.zh.md)


```ts ignore-check
import { OpfsFileSystem } from '@deepseek-ai/dsh-fs-opfs'

await ctx.plugin(OpfsFileSystem, { cwd: '/' })
// ctx.fs uses the OPFS backend; load @deepseek-ai/dsh-fs-observation-policy for the
// freshness policy gate and @deepseek-ai/dsh-tool-fs to expose read/write/edit.
```

## Summary

The **Origin Private File System (OPFS) implementation** of the `ctx.fs` provider contract ([`@deepseek-ai/dsh-fs`](../fs)) for browser hosts (the extension offscreen document, the web shell). Backs the twelve `FileSystem` primitives with the OPFS handle tree inside the page origin; loading it as a plugin populates `ctx.fs`.

## Table of Contents

- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Behavior

- **`resolve(path, opts?)`** — a relative `path` resolves against `opts.cwd` when the caller supplies one, else `config.cwd` (default `/`); an absolute `path` ignores both. The explicit resolution step canonicalizes dot segments and clamps `..` at the OPFS root (the local backend's ancestor walk behaves the same way at its filesystem root). The canonical `/a/b` spelling is both the `displayPath` and the stable `targetKey`: OPFS has no symlinks, so aliases that canonicalize equally share one identity by construction. OPFS origin scoping IS the containment — `config.cwd` is a resolution default, not a sandbox.
- **Execution-world coordinates** — `processPath` exposes the canonical OPFS path spelling; there is no OS path or subprocess world behind it. `fileUrl` names the path under the `opfs` scheme so display consumers keep a stable spelling; it is NOT a `file:` URI and is not fetchable (OPFS exposes no `file:` scheme). `contains` tests identity or descendant containment on canonical path prefixes.
- **`stat` / `lstat`** — return target metadata or `undefined` when absent. `version` combines a provider-side per-path mutation revision with the snapshot's `size`/`lastModified`; write and edit outcomes append an FNV-1a content digest of the published bytes, while read-side tokens carry metadata only (reads never read content). Rewrites made by other contexts on the shared origin (the SidePanel shares this OPFS) still change the token even though the provider never saw them. OPFS entries are files or directories; `lstat` therefore never reports `symlink`.
- **`readText` / `streamText`** — UTF-8 only. `readText` reads a whole file snapshot; `streamText` decodes the snapshot's byte stream chunk by chunk so a large file is not held whole in memory. Both reject NUL-byte binary samples (`FS_NOT_TEXT` — the whole buffer on the edit path, the first 8 KiB on the read path, mirroring `dsh-fs-local`) and non-regular targets.
- **`readBytes`** — raw whole-file bytes with no decoding or binary rejection. The byte cap short-circuits on the snapshot size before any content read, and the post-read length re-check fails a file that grew past the cap after its size was taken (`FS_TOO_LARGE`), never truncating.
- **`listDir`** — lists one directory level in stable `name.localeCompare()` order, with child type, resolved child target, version, and file `size`. It never opens or decodes file contents. Missing targets report `FS_NOT_FOUND`, file targets report `FS_NOT_DIRECTORY`, and a child that vanished after the listing started is reported as `other` without metadata.
- **`writeText`** — atomic: content publishes through the platform's swap-backed writer (`createWritable`), which stages every chunk off-file and swaps it in only at `close()`. An abort or failure before `close()` discards the swap via `abort()`, leaving the visible file unchanged and releasing the writer's lock; missing parent directories are provisioned. The `expected` guard is OPTIONAL: omitting it unconditionally creates-or-overwrites; `createIfAbsent` is mutual exclusion under the provider's per-target mutation lock only (see limitations); `replaceIfVersion` replaces only at the observed version — absence, metadata mismatch, or a content-digest mismatch (when the expected token and the pre-write snapshot both carry the digest) is `FS_STALE_VERSION`, which is what catches the same-size, same-millisecond rewrite the metadata cannot see. An overwrite returns the prior text as its contextual diff basis only when both the prior file and the UTF-8 replacement are strictly below `config.diffBasisMaxBytes` (default 10 MiB); otherwise `before: null` and presentation uses its whole-file fallback.
- **`editText`** — atomic literal read-modify-write over the same primitive, serialized per target by the mutation lock. The `expected` guard is OPTIONAL: when supplied it verifies the version — metadata, plus the content digest when both the expected token and the materialized snapshot carry one — BEFORE literal matching (a stale edit reports `FS_STALE_VERSION`, never `FS_EDIT_NOT_FOUND`/`FS_AMBIGUOUS_EDIT` against newer content); omitting it edits the current content unconditionally. A missing target reports `FS_STALE_VERSION` either way. LF-normalizes for matching, restores the file's dominant CRLF/LF style, and rejects empty `oldString` / zero matches (`FS_EDIT_NOT_FOUND`) or ambiguous multi-matches without `replace_all` (`FS_AMBIGUOUS_EDIT`).

The package-root SDK API is the default/named `OpfsFileSystem` class plus `Config`. Platform mechanics live in `src/opfsio.ts` behind the narrow handle seam in `src/opfs.ts` (an in-memory fake can fully simulate the seam — see the specs); `src/index.ts` is the thin service wiring.

## Model Experience

Indirectly, through [`dsh-tool-fs`](../tool-fs/README.md), which renders this provider's line-windowed UTF-8 content, mutation acknowledgements, and exact provider messages in capped retained results while versions, swap-write mechanics, and directory metadata remain internal.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **`config.cwd` is not a sandbox** — it is a resolution default, not containment. The containment fact is OPFS origin scoping itself: the model can only address files inside the origin's private filesystem, never the user's disk.
- **`createIfAbsent` is lock-scoped, not OS-atomic** — the guard serializes mutations inside this provider instance, and OPFS exposes no exclusive-create primitive it could lean on: `getFileHandle(name, { create: true })` is a silent get-or-create with no created-versus-existing signal, `createWritable` opens existing files without an exclusive-open failure, and swap-writer locks do not span same-origin contexts, so no cross-context lock protocol closes the window either. A creator in another context on the same origin can still create the file first; the version guard then reports the change on the next read.
- **Guard strength follows what the provider read** — write/edit outcome tokens carry the content digest, so the observe→write/edit→guard flow catches same-size, same-millisecond external rewrites. Guards sourced from read-side tokens (`stat`/`listDir`, which never read content), and guards whose pre-write snapshot was not read (a prior at/above `diffBasisMaxBytes`), verify metadata only. Byte-identical rewrites always pass — they are indistinguishable from no change. FNV-1a is a fast 32-bit summary, not a cryptographic hash: a rewrite engineered to its digest can still slip through. The provider's own mutations always advance the revision.
- **`editText`/`writeText` hold the whole file in memory** — streaming exists only on the read path.
- **No delete or move** — the `FileSystem` contract has neither, and OPFS's rename primitive (`move` on the worker-only sync handle) is unavailable in a document. If the contract grows deletion, this provider grows `removeEntry`.

## Dev Note

This package is a fork addition evolving with the extension release cadence; keep the table and this page's contents in sync when the surface changes.
