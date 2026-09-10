/**
 * Cordis-free OPFS mechanics for the provider in `index.ts`: canonical path
 * resolution, DOM-exception-to-`FsError` mapping, handle-tree traversal, UTF-8
 * text reads (whole, streamed, bounded), version tokens hardened with an FNV-1a
 * content digest, swap-backed atomic writes, and literal editing. Everything
 * here speaks the narrow seam in `opfs.ts`, so the in-memory fake in the specs
 * exercises the exact same code paths as the browser handles.
 * @module @deepseek-ai/dsh-fs-opfs/opfsio
 */

import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type { OpfsDirectoryHandle, OpfsFileBlob, OpfsFileHandle, OpfsWritableFileStream } from './opfs.ts'

/** NUL-byte binary sampling window for whole-text reads (mirrors `dsh-fs-local`). */
const BINARY_SAMPLE_BYTES = 8192

/** Hard sanity ceiling on `diffBasisMaxBytes` (1 GiB) — the default already bounds it to 10 MiB. */
export const MAX_DIFF_BASIS_BYTES = 2 ** 30

// ───────────────────────── paths ─────────────────────────

/**
 * Resolve a model/plugin-supplied path against a base directory into the canonical
 * OPFS path spelling (`/a/b`, or `/` for the root). Dot segments collapse; `..`
 * above the root clamps at the root, mirroring how the local backend's ancestor
 * walk terminates at the filesystem root. This is the provider's explicit
 * resolution step (the `dsh-shell` request/spec split template): a resolution
 * DEFAULT, not a containment boundary — OPFS origin scoping is the containment.
 * @param cwd - base directory a relative `path` resolves against.
 * @param path - absolute (leading `/`) or relative path; empty/whitespace-only throws.
 * @returns the canonical path; the same file always yields the same string.
 */
export function resolveOpfsPath(cwd: string, path: string): string {
  if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  const absolute = path.startsWith('/') ? path : `${cwd}/${path}`
  const segments: string[] = []
  for (const segment of absolute.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // Clamped at the OPFS root: there is no parent above `/`.
      if (segments.length > 0) segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join('/')}`
}

/**
 * Split a canonical path into its parent directory path and basename; the root's base is empty.
 * @param key - the canonical path to split.
 * @returns the parent path and the basename.
 */
export function splitParentBase(key: string): { parentKey: string; base: string } {
  if (key === '/') return { parentKey: '/', base: '' }
  const cut = key.lastIndexOf('/')
  return { parentKey: cut === 0 ? '/' : key.slice(0, cut), base: key.slice(cut + 1) }
}

/**
 * Join a directory path and a child basename into the child's canonical path.
 * @param dirKey - the parent directory's canonical path.
 * @param name - the child's basename.
 * @returns the child's canonical path.
 */
export function joinChild(dirKey: string, name: string): string {
  return dirKey === '/' ? `/${name}` : `${dirKey}/${name}`
}

// ───────────────────────── errors ─────────────────────────

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined
}

function isNotFound(error: unknown): boolean {
  return errorName(error) === 'NotFoundError'
}

function isTypeMismatch(error: unknown): boolean {
  return errorName(error) === 'TypeMismatchError'
}

/**
 * Translate a platform rejection into the seam's typed taxonomy. `NotFoundError`
 * and `TypeMismatchError` both mean the target cannot exist as addressed (an
 * absent entry, or a path passing through a regular file); quota exhaustion and
 * writer-lock contention are I/O-scale failures.
 * @param verb - the operation name used in the message (`read`/`write`/…).
 * @param displayPath - the caller-facing path used in the message.
 * @param error - the platform rejection.
 * @returns the structured error to throw.
 */
export function toFsError(verb: string, displayPath: string, error: unknown): FsError {
  if (error instanceof FsError) return error
  const name = errorName(error)
  if (name === 'NotFoundError' || name === 'TypeMismatchError') {
    return new FsError(`cannot ${verb} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (name === 'QuotaExceededError') {
    return new FsError(`cannot ${verb} "${displayPath}": OPFS quota exceeded`, 'FS_IO_ERROR', { cause: error })
  }
  if (name === 'NoModificationAllowedError' || name === 'InvalidStateError') {
    return new FsError(`cannot ${verb} "${displayPath}": the entry is locked by another writer`, 'FS_IO_ERROR', { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new FsError(`cannot ${verb} "${displayPath}": ${message}`, 'FS_IO_ERROR', { cause: error })
}

/**
 * Cancellation check at the provider's abort points (`FS_ABORTED` on an aborted signal).
 * @param signal - the caller's cancellation signal, if any.
 * @param verb - the operation name used in the message (`read`/`write`/…).
 */
export function throwIfAborted(signal: AbortSignal | undefined, verb: string): void {
  if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
}

// ───────────────────────── traversal ─────────────────────────

/**
 * Walk a directory path from the root. With `create`, missing directories are
 * created (the write path's parent provisioning); with `!create`, an absent or
 * not-a-directory segment returns `null` instead of throwing.
 * @param root - the OPFS root handle the walk starts from.
 * @param key - the canonical directory path to resolve.
 * @param create - provision missing directory segments when true.
 * @returns the directory handle, or `null` when `create` is false and the path
 * cannot be a directory.
 */
export async function resolveDirectoryPath(root: OpfsDirectoryHandle, key: string, create: true): Promise<OpfsDirectoryHandle>
/**
 * Walk a directory path from the root without creating segments.
 * @param root - the OPFS root handle the walk starts from.
 * @param key - the canonical directory path to resolve.
 * @param create - must be false for this overload.
 * @returns the directory handle, or `null` when the path cannot be a directory.
 */
export async function resolveDirectoryPath(root: OpfsDirectoryHandle, key: string, create: false): Promise<OpfsDirectoryHandle | null>
export async function resolveDirectoryPath(
  root: OpfsDirectoryHandle,
  key: string,
  create: boolean,
): Promise<OpfsDirectoryHandle | null> {
  let dir = root
  for (const segment of key.split('/').filter(name => name.length > 0)) {
    try {
      dir = await dir.getDirectoryHandle(segment, create ? { create: true } : undefined)
    } catch (error: unknown) {
      if (!create && (isNotFound(error) || isTypeMismatch(error))) return null
      if (create && isTypeMismatch(error)) {
        throw new FsError(`cannot resolve "${key}": a parent path segment is not a directory`, 'FS_NOT_FOUND', { cause: error })
      }
      throw toFsError('resolve', key, error)
    }
  }
  return dir
}

/**
 * The directory handle for a canonical path, or `null` when the path cannot be a
 * directory (absent, or a segment is a regular file). The root returns the root
 * handle itself.
 * @param root - the OPFS root handle the lookup starts from.
 * @param key - the canonical directory path.
 * @returns the directory handle, or `null` when absent.
 */
export async function directoryFor(root: OpfsDirectoryHandle, key: string): Promise<OpfsDirectoryHandle | null> {
  if (key === '/') return root
  const { parentKey, base } = splitParentBase(key)
  const parent = await resolveDirectoryPath(root, parentKey, false)
  if (parent === null) return null
  try {
    return await parent.getDirectoryHandle(base)
  } catch (error: unknown) {
    if (isNotFound(error) || isTypeMismatch(error)) return null
    throw toFsError('resolve', key, error)
  }
}

/**
 * Probe one directory entry without creating it: the file handle, the directory
 * handle, or `null` when the entry is absent. A `TypeMismatchError` from the file
 * probe means the entry exists but is not a file — the directory arm.
 * @param dir - the directory whose entry is probed.
 * @param base - the entry's basename.
 * @param verb - the operation name used in error messages.
 * @returns the file handle, the directory handle, or `null` when absent.
 */
export async function probeEntry(
  dir: OpfsDirectoryHandle,
  base: string,
  verb: string,
): Promise<OpfsFileHandle | OpfsDirectoryHandle | null> {
  let fileMismatch = false
  try {
    return await dir.getFileHandle(base)
  } catch (error: unknown) {
    if (!isNotFound(error) && !isTypeMismatch(error)) throw toFsError(verb, base, error)
    fileMismatch = isTypeMismatch(error)
  }
  try {
    return await dir.getDirectoryHandle(base)
  } catch (error: unknown) {
    // A vanished entry probes as absent; a directory-arm mismatch repeats only
    // when the file arm already proved the entry is not a file, which no
    // second kind can cause.
    if (isNotFound(error)) return null
    if (!fileMismatch && isTypeMismatch(error)) return null
    throw toFsError(verb, base, error)
  }
}

// ───────────────────────── versions ─────────────────────────

/**
 * The provider's private `FsVersion` encoding, split for guard comparison.
 * Read-side tokens (`stat`/`listDir`) carry the metadata fields only — reads
 * never read content. Write/edit outcomes additionally carry the digest, and a
 * guard compares digests when both its expected token and the current snapshot
 * have one.
 */
export interface VersionComponents {
  /** Provider-side per-path mutation revision. */
  revision: number
  /** Snapshot byte size. */
  size: number
  /** Snapshot millisecond last-modified. */
  lastModified: number
  /** FNV-1a content digest (eight lowercase hex digits); absent on read-side tokens. */
  digest?: string
}

/**
 * FNV-1a 32-bit content digest of raw bytes, as eight lowercase hex digits. A
 * fast, non-cryptographic summary: it hardens the stale guard against
 * same-size, same-millisecond rewrites that the metadata alone cannot see; it
 * is not a security boundary.
 * @param bytes - the content to summarize.
 * @returns the digest, e.g. `'811c9dc5'` for empty content.
 */
export function contentDigest(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index] as number
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Build a version token from its components; the digest is appended only when
 * present, keeping read-side tokens unchanged.
 * @param revision - the provider-side per-path mutation revision.
 * @param size - the snapshot's byte size.
 * @param lastModified - the snapshot's millisecond last-modified.
 * @param digest - the content digest, present only on write/edit outcome tokens.
 * @returns the token string, branded.
 */
export function versionToken(revision: number, size: number, lastModified: number, digest?: string): FsVersion {
  return FsVersion(digest === undefined
    ? `${revision}:${size}:${lastModified}`
    : `${revision}:${size}:${lastModified}:${digest}`)
}

/**
 * Stable version token for a directory (freshness is meaningless for OPFS directories).
 * @param key - the directory's canonical path.
 * @returns the token string, branded.
 */
export function directoryVersion(key: string): FsVersion {
  return FsVersion(`dir:${key}`)
}

/**
 * Parse the provider's own token encoding back into its components.
 * @param version - a token this provider minted (`revision:size:lastModified[:digest]`).
 * @returns the components, or `null` for foreign tokens (directory tokens, empty
 * strings) — a guard against a foreign token can never match.
 */
export function parseVersionToken(version: FsVersion): VersionComponents | null {
  const parts = String(version).split(':')
  if (parts.length !== 3 && parts.length !== 4) return null
  const [revision, size, lastModified, digest] = parts
  const numbers = [revision, size, lastModified].map(Number)
  if (!numbers.every(value => Number.isSafeInteger(value))) return null
  return digest === undefined
    ? { revision: numbers[0] as number, size: numbers[1] as number, lastModified: numbers[2] as number }
    : { revision: numbers[0] as number, size: numbers[1] as number, lastModified: numbers[2] as number, digest }
}

/**
 * Whether `expected` still describes `current`. Metadata must match exactly;
 * the content digest participates only when both sides carry one — an expected
 * token without a digest (read-side metadata) or a current snapshot without one
 * (content the provider did not read, because reads never read content and the
 * pre-write read is capped) verifies metadata only.
 * @param expected - the version the caller observed.
 * @param current - the components observed now; `digest` present only when the
 * current content was actually read.
 * @returns true when the guard passes.
 */
export function versionMatches(expected: FsVersion, current: VersionComponents): boolean {
  const prior = parseVersionToken(expected)
  if (prior === null) return false
  if (prior.revision !== current.revision || prior.size !== current.size || prior.lastModified !== current.lastModified) {
    return false
  }
  return prior.digest === undefined || current.digest === undefined || prior.digest === current.digest
}

// ───────────────────────── reading ─────────────────────────

function notTextError(verb: string, displayPath: string): FsError {
  return new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
}

function decodeUtf8(bytes: Uint8Array, verb: string, displayPath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    // TextDecoder({fatal}) only throws TypeError on invalid bytes; any other
    // throw is an unreachable runtime fault.
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

function decodeUtf8Stream(decoder: TextDecoder, chunk: Uint8Array | undefined, verb: string, displayPath: string): string {
  try {
    return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode()
  } catch (error: unknown) {
    // TextDecoder({fatal}) only throws TypeError on invalid bytes; any other
    // throw is an unreachable runtime fault.
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

/**
 * Read a whole file snapshot as decoded UTF-8 text: NUL-byte binary rejection
 * (the first 8 KiB sample, mirroring `dsh-fs-local`), fatal decoding, and
 * cancellation checks around the snapshot. The edit path uses
 * {@link readEditSnapshot} + {@link decodeEditSnapshot} instead, which reject
 * NUL bytes anywhere and expose the raw bytes for the version digest.
 * @param blob - the snapshot to read.
 * @param displayPath - the caller-facing path used in error messages.
 * @param signal - cancellation signal checked around the snapshot.
 * @returns the whole decoded text.
 */
export async function readWholeBlobText(
  blob: OpfsFileBlob,
  displayPath: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal, 'read')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  throwIfAborted(signal, 'read')
  if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  return decodeUtf8(bytes, 'read', displayPath)
}

/**
 * Stream a whole file snapshot as decoded text chunks. Same text semantics as
 * {@link readWholeBlobText} (binary sampling, cross-chunk UTF-8 decoding) without
 * holding the whole file in memory.
 * @param blob - the snapshot to stream.
 * @param displayPath - the caller-facing path used in error messages.
 * @param signal - cancellation signal checked between chunks.
 * @returns the decoded text chunks in order.
 */
export async function* streamBlobText(
  blob: OpfsFileBlob,
  displayPath: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  throwIfAborted(signal, 'read')
  const reader = blob.stream().getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let sampledBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      throwIfAborted(signal, 'read')
      const sample = value.subarray(0, Math.max(0, BINARY_SAMPLE_BYTES - sampledBytes))
      if (sample.includes(0)) {
        throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
      }
      sampledBytes += sample.length
      yield decodeUtf8Stream(decoder, value, 'read', displayPath)
    }
    throwIfAborted(signal, 'read')
    yield decodeUtf8Stream(decoder, undefined, 'read', displayPath)
  } finally {
    // The snapshot stream holds no external resource; releasing the lock lets
    // the reader be collected even on an early (abort/binary) exit.
    reader.releaseLock()
  }
}

/**
 * Read a whole file snapshot as raw bytes with no decoding or binary rejection.
 * `maxBytes` bounds the complete content: the snapshot size short-circuits
 * before any content read, and the post-read length re-check fails a snapshot
 * that grew past the cap (`FS_TOO_LARGE`), never truncating.
 * @param blob - the snapshot to read.
 * @param displayPath - the caller-facing path used in error messages.
 * @param signal - cancellation signal checked around the read.
 * @param maxBytes - exclusive byte limit on the complete content.
 * @returns the raw bytes.
 */
export async function readWholeBlobBytes(
  blob: OpfsFileBlob,
  displayPath: string,
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<Uint8Array> {
  throwIfAborted(signal, 'read')
  if (blob.size > maxBytes) {
    throw new FsError(`cannot read "${displayPath}": ${blob.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  throwIfAborted(signal, 'read')
  if (bytes.byteLength > maxBytes) {
    throw new FsError(`cannot read "${displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
  }
  return bytes
}

/**
 * Read the pre-write snapshot once for both derived values the write path needs:
 * the LF-normalized contextual-diff basis, and the content digest feeding the
 * stale-guard comparison. The basis is `null` for a snapshot at/above the byte
 * limit, binary, or invalid UTF-8 — the write still succeeds and presentation
 * falls back to a whole-file diff. The size check runs before any content read,
 * so a snapshot at/above the limit yields `{ basis: null }` with no digest and
 * its guard verifies metadata only.
 * @param blob - the pre-write snapshot.
 * @param displayPath - the caller-facing path used in error messages.
 * @param maxBytes - exclusive byte limit on the read.
 * @param signal - cancellation signal checked around the read.
 * @returns the LF-normalized basis (possibly `null`) and the content digest
 * (absent when the snapshot was not read).
 */
export async function readPriorSnapshot(
  blob: OpfsFileBlob,
  displayPath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ basis: string | null; digest?: string }> {
  throwIfAborted(signal, 'read')
  if (blob.size >= maxBytes) return { basis: null }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const digest = contentDigest(bytes)
  if (bytes.byteLength >= maxBytes || bytes.includes(0)) return { basis: null, digest }
  try {
    return { basis: normalizeLineEndings(decodeUtf8(bytes, 'read', displayPath)), digest }
  } catch (error: unknown) {
    // An undecodable prior file only costs the optional basis; the digest stays.
    if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return { basis: null, digest }
    throw error
  }
}

/**
 * UTF-8 byte length of a string without allocating the encoded copy.
 * @param content - the string to measure.
 * @returns the byte length of its UTF-8 encoding.
 */
export function utf8ByteLength(content: string): number {
  let bytes = 0
  for (const char of content) {
    const codePoint = char.codePointAt(0) ?? 0
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}

// ───────────────────────── writing ─────────────────────────

/**
 * Publish UTF-8 text through a swap-backed writer: the platform stages every
 * chunk off-file and swaps it in atomically at `close()`. An abort or failure
 * before `close()` discards the swap via `abort()`, leaving the visible file
 * unchanged and releasing the writer's exclusive lock.
 * @param parent - the directory that receives (or already holds) the file.
 * @param base - the file's basename inside `parent`.
 * @param content - the whole text to publish.
 * @param displayPath - the caller-facing path used in error messages.
 * @param signal - cancellation signal checked before publication.
 */
export async function writeSwapText(
  parent: OpfsDirectoryHandle,
  base: string,
  content: string,
  displayPath: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal, 'write')
  let file: OpfsFileHandle
  try {
    file = await parent.getFileHandle(base, { create: true })
  } catch (error: unknown) {
    throw toFsError('write', displayPath, error)
  }
  let writable: OpfsWritableFileStream
  try {
    writable = await file.createWritable({ keepExistingData: false })
  } catch (error: unknown) {
    throw toFsError('write', displayPath, error)
  }
  try {
    try {
      await writable.write(content)
    } catch (error: unknown) {
      throw toFsError('write', displayPath, error)
    }
    // Pre-publication cancellation: the swap is still discarded, not committed.
    throwIfAborted(signal, 'write')
    await writable.close()
  } catch (error: unknown) {
    // abort() is the only uncommitted-swap release; on an already-closed or
    // already-failed writer its own rejection costs nothing further.
    await writable.abort(`fs-opfs: write to "${displayPath}" was not published`).catch(() => undefined)
    throw error
  }
}

/* jscpd:ignore-start -- mirrored pure-text semantics from `dsh-fs-local`'s fsio: that module's
 * import closure drags in node:fs and cannot load in a browser host, so the helpers are
 * duplicated here and pinned to parity by the specs in both packages. */
/** The dominant line-ending style of a file's raw text. */
export type LineEndings = 'LF' | 'CRLF'

/**
 * Replace CRLF pairs with LF.
 * @param content - the text to normalize.
 * @returns the LF-only text.
 */
export function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

/**
 * Detect the dominant line-ending style from the head of the raw text.
 * @param raw - the un-normalized text.
 * @returns `'CRLF'` when CRLF pairs outnumber lone LFs in the sample, else `'LF'`.
 */
function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/**
 * Restore the file's dominant line-ending style onto LF content.
 * @param content - LF-normalized text.
 * @param lineEndings - the style detected from the raw file.
 * @returns the text as it should be stored.
 */
export function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * Apply a literal replacement to LF-normalized content. Empty or missing search
 * text throws `FS_EDIT_NOT_FOUND`; multiple matches throw `FS_AMBIGUOUS_EDIT`
 * unless `replaceAll` is true.
 * @param content - the LF-normalized file content.
 * @param oldString - the literal text to replace (CRLF-normalized before matching).
 * @param newString - the replacement text (CRLF-normalized before insertion).
 * @param replaceAll - replace every match instead of requiring exactly one.
 * @param displayPath - the caller-facing path used in error messages.
 * @returns the edited content and the number of replacements made.
 */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) {
    throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  }
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) {
    throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  }
  if (!replaceAll && replacements > 1) {
    throw new FsError(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

/**
 * Materialize a snapshot for editing WITHOUT decoding it: the raw bytes plus
 * their content digest. Splitting materialization from decoding lets the
 * provider run the stale guard (which consumes the digest) before any decode
 * work, so a stale edit reports `FS_STALE_VERSION` even against a snapshot that
 * has since become binary or invalid UTF-8.
 * @param blob - the snapshot to materialize.
 * @param signal - cancellation signal checked around the read.
 * @returns the raw bytes and their content digest.
 */
export async function readEditSnapshot(
  blob: OpfsFileBlob,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; digest: string }> {
  throwIfAborted(signal, 'edit')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  throwIfAborted(signal, 'edit')
  return { bytes, digest: contentDigest(bytes) }
}

/**
 * Decode already-materialized edit bytes: whole-buffer NUL-byte binary
 * rejection, fatal decoding, LF normalization, and line-ending detection.
 * @param bytes - the snapshot bytes from {@link readEditSnapshot}.
 * @param displayPath - the caller-facing path used in error messages.
 * @returns the LF-normalized content and the file's dominant line-ending style.
 */
export function decodeEditSnapshot(
  bytes: Uint8Array,
  displayPath: string,
): { content: string; lineEndings: LineEndings } {
  if (bytes.includes(0)) throw new FsError(`cannot edit "${displayPath}": binary file`, 'FS_NOT_TEXT')
  const raw = decodeUtf8(bytes, 'edit', displayPath)
  return { content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw) }
}

/* jscpd:ignore-end */
