/**
 * Origin Private File System (OPFS) implementation of `ctx.fs` for browser hosts
 * (the extension offscreen document, the web shell). Canonical OPFS paths are the
 * stable target identity, reads expose regular UTF-8 text or typed errors, and
 * mutations publish through the platform's swap-backed writers. OPFS origin
 * scoping IS the containment — no `sandboxMode` is reported, so the tool layer
 * advertises no escalation fields.
 * @module @deepseek-ai/dsh-fs-opfs
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { opfsRoot } from './opfs.ts'
import type { OpfsDirectoryHandle, OpfsFileBlob, OpfsFileHandle, OpfsHandle } from './opfs.ts'
import {
  applyLiteralEdit,
  contentDigest,
  decodeEditSnapshot,
  directoryFor,
  directoryVersion,
  joinChild,
  normalizeLineEndings,
  parseVersionToken,
  probeEntry,
  readEditSnapshot,
  readPriorSnapshot,
  readWholeBlobBytes,
  readWholeBlobText,
  resolveDirectoryPath,
  resolveOpfsPath,
  restoreLineEndings,
  splitParentBase,
  streamBlobText,
  toFsError,
  throwIfAborted,
  utf8ByteLength,
  versionMatches,
  versionToken,
  writeSwapText,
  MAX_DIFF_BASIS_BYTES,
} from './opfsio.ts'

/** Configuration for the OPFS filesystem backend. */
export interface Config {
  /**
   * Base directory for relative paths, in canonical OPFS spelling. Defaults to
   * `/` (the origin's OPFS root). A resolution default, NOT a containment
   * boundary — OPFS origin scoping is the containment.
   */
  cwd?: string
  /**
   * Exclusive UTF-8 byte limit on each overwrite-diff side. Defaults to 10 MiB.
   */
  diffBasisMaxBytes?: number
}

const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

/** Probe result shared by `stat`/`lstat`: OPFS entries are files or directories, nothing else. */
interface EntryInfo {
  version: FsVersion
  type: 'file' | 'directory'
  size?: number
}

/**
 * The OPFS backend. Paths resolve against {@link Config.cwd} (default `/`) into
 * canonical `/a/b` spellings that serve as both the display path and the stable
 * target key; the same file always yields the same key because OPFS has no
 * symlinks.
 *
 * Version tokens combine a per-path mutation revision with the snapshot's
 * `size`/`lastModified`; write/edit outcomes append an FNV-1a content digest,
 * and a guarded write/edit re-hashes the current content when its expected
 * token and the snapshot both carry one — a same-size, same-millisecond rewrite
 * by another context on the shared origin no longer passes the guard. Read-side
 * tokens (`stat`/`listDir`) carry metadata only: reads never read content.
 *
 * `createIfAbsent` is mutual exclusion under this provider's per-target lock
 * only. OPFS exposes no exclusive-create primitive — `getFileHandle(name,
 * { create: true })` is a silent get-or-create with no created-vs-existing
 * signal, `createWritable` opens existing files without an exclusive failure,
 * and swap-writer locks do not span same-origin contexts — so a creator in
 * another context on the shared origin can win the race; the version guard
 * reports the change on the next read.
 */
export class OpfsFileSystem extends FileSystem {
  static Config: z<Config> = z.object({
    cwd: z.string().default('/'),
    diffBasisMaxBytes: z.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES),
  })

  /** Validated config (schemastery applied the defaults, `cwd` canonicalized, before construction). */
  readonly config: Required<Config>

  /**
   * Root-handle getter; the default probes `navigator.storage.getDirectory()` at
   * CALL time, so a runtime without OPFS still activates the plugin and only file
   * operations fail. Specs install an in-memory fake handle tree here.
   */
  root: () => Promise<OpfsDirectoryHandle> = opfsRoot

  /** Per-targetKey tail promise: serializes mutating ops so the read→guard→write
   * window can't interleave (one winner, the rest see the new version and reject
   * as stale). */
  private locks = new Map<string, Promise<unknown>>()
  /** Per-path mutation counter feeding the version tokens. */
  private revisions = new Map<string, number>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = config as Required<Config>
    if (!Number.isSafeInteger(resolved.diffBasisMaxBytes)
      || resolved.diffBasisMaxBytes <= 0
      || resolved.diffBasisMaxBytes > MAX_DIFF_BASIS_BYTES) {
      throw new Error(`fs-opfs: diffBasisMaxBytes must be a positive safe integer no greater than ${MAX_DIFF_BASIS_BYTES}`)
    }
    this.config = {
      cwd: resolveOpfsPath('/', resolved.cwd),
      diffBasisMaxBytes: resolved.diffBasisMaxBytes,
    }
  }

  /** Run `op` with exclusive access to `targetKey` (FIFO per key). */
  private async withLock<T>(targetKey: string, op: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(op, op)
    // Keep the chain alive but swallow this op's result/throw for the *next* waiter.
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) {
        this.locks.delete(targetKey)
      }
    }
  }

  private bumpRevision(key: string): void {
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
  }

  private versionOf(key: string, blob: { size: number; lastModified: number }, digest?: string): FsVersion {
    return versionToken(this.revisions.get(key) ?? 0, blob.size, blob.lastModified, digest)
  }

  private async blobOf(file: OpfsFileHandle, verb: string, displayPath: string): Promise<OpfsFileBlob> {
    try {
      return await file.getFile()
    } catch (error: unknown) {
      throw toFsError(verb, displayPath, error)
    }
  }

  // async keeps validation throws rejections (the seam's async contract), not synchronous throws.
  // oxlint-disable-next-line typescript/require-await -- no await by design; needed under the full oxlint config
  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
    const key = resolveOpfsPath(opts?.cwd ?? this.config.cwd, path)
    return { targetKey: FsTargetKey(key), displayPath: key }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    // OPFS exposes no `file:` scheme: the canonical URI names the origin-private
    // path under the opfs scheme so display/routing consumers keep a stable
    // spelling. It is not fetchable.
    return `opfs://${encodeURI(this.processPath(target))}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const parentPath = this.processPath(parent)
    const childPath = this.processPath(child)
    return childPath === parentPath || childPath.startsWith(parentPath === '/' ? '/' : `${parentPath}/`)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.probeInfo(String(target.targetKey), 'stat', signal)
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    // OPFS has no symlinks, so the path-entry probe equals the target probe and
    // never reports `symlink`.
    return this.probeInfo(resolveOpfsPath(opts?.cwd ?? this.config.cwd, path), 'lstat', signal)
  }

  /**
   * Probe a canonical path's metadata, or `undefined` when the path is absent.
   * One traversal serves `stat` (target-shaped) and `lstat` (path-shaped): the
   * error taxonomy is identical because OPFS distinguishes no path/target cases.
   */
  private async probeInfo(key: string, verb: string, signal?: AbortSignal): Promise<EntryInfo | undefined> {
    const root = await this.root()
    const { parentKey, base } = splitParentBase(key)
    const parent = key === '/' ? root : await resolveDirectoryPath(root, parentKey, false)
    if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
    if (parent === null) return undefined
    const entry = key === '/' ? root : await probeEntry(parent, base, verb)
    if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
    if (entry === null) return undefined
    if (entry.kind !== 'file') return { version: directoryVersion(key), type: 'directory' }
    const blob = await this.blobOf(entry, verb, key)
    return { version: this.versionOf(key, blob), type: 'file', size: blob.size }
  }

  /**
   * Resolve a target to its regular-file snapshot and run `op` on it: a missing
   * target reports `FS_NOT_FOUND`, a directory target `FS_NOT_REGULAR_FILE`.
   */
  private async withFile<T>(
    target: FsTarget,
    verb: string,
    signal: AbortSignal | undefined,
    op: (blob: OpfsFileBlob) => Promise<T>,
  ): Promise<T> {
    const key = String(target.targetKey)
    const root = await this.root()
    const { parentKey, base } = splitParentBase(key)
    if (base === '') throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    const parent = await resolveDirectoryPath(root, parentKey, false)
    if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
    if (parent === null) throw new FsError(`cannot ${verb} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    const entry = await probeEntry(parent, base, verb)
    if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
    if (entry === null) throw new FsError(`cannot ${verb} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (entry.kind !== 'file') throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    return op(await this.blobOf(entry, verb, target.displayPath))
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.withFile(target, 'read', signal, blob => readWholeBlobText(blob, target.displayPath, signal))
  }

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return Promise.resolve(
      this.withFile(target, 'read', signal, blob => Promise.resolve(streamBlobText(blob, target.displayPath, signal))),
    )
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return this.withFile(target, 'read', signal, blob => readWholeBlobBytes(blob, target.displayPath, signal, maxBytes))
  }

  override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    // OPFS snapshots expose only whole-file buffers: read the window out of
    // the arrayBuffer, clamped by the blob size like every other backend.
    return this.withFile(target, 'read', signal, async (blob) => {
      throwIfAborted(signal, 'readByteRange')
      const offset = Math.max(0, Math.min(range.offset, blob.size))
      const length = Math.max(0, Math.min(range.length, blob.size - offset))
      const bytes = new Uint8Array(await blob.arrayBuffer())
      return bytes.subarray(offset, offset + length)
    })
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const key = String(target.targetKey)
    const root = await this.root()
    const info = await this.probeInfo(key, 'list', signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    const dir = key === '/' ? root : await directoryFor(root, key)
    if (dir === null) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')

    const children: OpfsHandle[] = []
    try {
      for await (const child of dir.values()) children.push(child)
    } catch (error: unknown) {
      throw toFsError('list', target.displayPath, error)
    }
    throwIfAborted(signal, 'list')
    children.sort((left, right) => left.name.localeCompare(right.name))

    const entries: FsDirEntry[] = []
    for (const child of children) {
      throwIfAborted(signal, 'list')
      const childTarget = { targetKey: FsTargetKey(joinChild(key, child.name)), displayPath: joinChild(target.displayPath, child.name) }
      if (child.kind !== 'file') {
        entries.push({ name: child.name, type: 'directory', target: childTarget, version: directoryVersion(joinChild(key, child.name)) })
        continue
      }
      try {
        const blob = await this.blobOf(await dir.getFileHandle(child.name), 'list', childTarget.displayPath)
        entries.push({
          name: child.name,
          type: 'file',
          target: childTarget,
          version: this.versionOf(joinChild(key, child.name), blob),
          size: blob.size,
        })
      } catch (error: unknown) {
        // A child that vanished after the listing started is reported as `other`
        // without metadata; any other metadata failure fails the whole listing.
        if (error instanceof FsError && error.code === 'FS_NOT_FOUND') {
          entries.push({ name: child.name, type: 'other', target: childTarget })
          continue
        }
        throw error
      }
    }
    throwIfAborted(signal, 'list')
    return entries
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const key = String(target.targetKey)
      const root = await this.root()
      throwIfAborted(signal, 'write')
      const { parentKey, base } = splitParentBase(key)
      if (base === '') throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      // Missing parent directories are created (the local backend's `mkdir -p` parity).
      const parent = await resolveDirectoryPath(root, parentKey, true)
      const existingEntry = await probeEntry(parent, base, 'write')
      const existingFile = existingEntry !== null && existingEntry.kind === 'file' ? existingEntry : undefined
      if (existingEntry !== null && existingFile === undefined) {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      const priorBlob = existingFile === undefined
        ? undefined
        : await this.blobOf(existingFile, 'write', target.displayPath)
      const expectedDigest = expected?.kind === 'replaceIfVersion'
        ? parseVersionToken(expected.version)?.digest
        : undefined

      if (expected?.kind === 'replaceIfVersion') {
        // Stale guard, metadata phase: the file must still exist at the version
        // the owner observed, rejected without reading content.
        if (priorBlob === undefined) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        if (!versionMatches(expected.version, {
          revision: this.revisions.get(key) ?? 0,
          size: priorBlob.size,
          lastModified: priorBlob.lastModified,
        })) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existingFile !== undefined) {
        // createIfAbsent onto an existing file: a blind overwrite — require a read
        // first. OPFS offers no exclusive-create primitive, so this is mutual
        // exclusion under the per-target lock; another context on the shared
        // origin can still create first (README limitations).
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }
      // No expectation means an unconditional but still atomic write.

      // One bounded pre-write read serves both derived values: the
      // contextual-diff basis (both overwrite sides strictly below the limit)
      // and the content digest for the guard's digest phase.
      const prior = priorBlob !== undefined
        && (utf8ByteLength(content) < this.config.diffBasisMaxBytes || expectedDigest !== undefined)
        ? await readPriorSnapshot(priorBlob, target.displayPath, this.config.diffBasisMaxBytes, signal)
        : undefined
      if (expectedDigest !== undefined && prior?.digest !== undefined && prior.digest !== expectedDigest) {
        // Metadata matches but the content was rewritten under the guard (the
        // same-size, same-millisecond rewrite the metadata cannot see).
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }

      // Capture an optional contextual-diff basis before the write; a prior file
      // at/above the limit (either side) yields `before: null` and the consumer
      // keeps its whole-file fallback.
      const before = existingFile === undefined || utf8ByteLength(content) >= this.config.diffBasisMaxBytes
        ? null
        : prior?.basis ?? null
      await writeSwapText(parent, base, content, target.displayPath, signal)
      this.bumpRevision(key)

      const afterFile = await parent.getFileHandle(base)
      const afterBlob = await this.blobOf(afterFile, 'write', target.displayPath)
      return {
        operation: existingFile === undefined ? 'create' : 'update',
        version: this.versionOf(key, afterBlob, contentDigest(new TextEncoder().encode(content))),
        before,
        // LF-normalized to share the diff basis with `before` (also LF): a CRLF
        // overwrite must not read as every line changed.
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const key = String(target.targetKey)
      const root = await this.root()
      throwIfAborted(signal, 'edit')
      const { parentKey, base } = splitParentBase(key)
      if (base === '') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      const parent = await resolveDirectoryPath(root, parentKey, false)
      if (signal?.aborted) throw new FsError('edit aborted', 'FS_ABORTED')
      // Stale guard before literal matching: an edit based on an old read reports
      // FS_STALE_VERSION, not FS_EDIT_NOT_FOUND/FS_AMBIGUOUS_EDIT against newer
      // content. Missing targets use the same stale code on guarded and
      // unconditional edit paths.
      if (parent === null) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      const existing = await probeEntry(parent, base, 'edit')
      if (existing === null) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      if (existing.kind !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      const blob = await this.blobOf(existing, 'edit', target.displayPath)
      // The guard consumes the same materialized bytes the edit applies to, so a
      // same-size, same-millisecond external rewrite fails the digest comparison.
      const snapshot = await readEditSnapshot(blob, signal)
      if (expected && !versionMatches(expected.version, {
        revision: this.revisions.get(key) ?? 0,
        size: blob.size,
        lastModified: blob.lastModified,
        digest: snapshot.digest,
      })) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }

      const original = decodeEditSnapshot(snapshot.bytes, target.displayPath)
      const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
      const content = restoreLineEndings(edited.content, original.lineEndings)
      await writeSwapText(parent, base, content, target.displayPath, signal)
      this.bumpRevision(key)

      const afterFile = await parent.getFileHandle(base)
      const afterBlob = await this.blobOf(afterFile, 'edit', target.displayPath)
      return {
        version: this.versionOf(key, afterBlob, contentDigest(new TextEncoder().encode(content))),
        // The LF-normalized before/after text (the applied-hunk diff basis);
        // line-ending restoration is a storage detail the diff ignores.
        before: original.content,
        after: edited.content,
      }
    })
  }
}

export default OpfsFileSystem
