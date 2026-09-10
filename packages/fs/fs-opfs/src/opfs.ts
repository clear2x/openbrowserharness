/**
 * Narrow handle seam between the provider and the Origin Private File System.
 * The provider and the Cordis-free mechanics in `opfsio.ts` speak ONLY these
 * structural interfaces, so an in-memory fake can fully stand in for the
 * platform (getDirectoryHandle / getFileHandle / getFile / createWritable /
 * directory iteration); the real DOM `FileSystemDirectoryHandle` tree is
 * structurally assignable to them without adapters.
 *
 * The seam is deliberately narrower than the OPFS surface: the `FileSystem`
 * contract has no delete/move primitive, and OPFS's rename (`move` on the
 * worker-only `FileSystemSyncAccessHandle`) is unavailable in a document, so
 * no removal or move member exists here — if the contract grows those, the
 * seam grows with it.
 * @module @deepseek-ai/dsh-fs-opfs/opfs
 */

import { FsError } from '@deepseek-ai/dsh-fs'

/** Name/kind pair yielded by directory iteration (the DOM `FileSystemHandle` shape). */
export interface OpfsHandle {
  /** Whether the entry is a file or a directory. */
  readonly kind: 'file' | 'directory'
  /** Basename of the entry inside its directory. */
  readonly name: string
}

/** Metadata-plus-content accessor for one file snapshot (the DOM `File` members in use). */
export interface OpfsFileBlob {
  /** Byte size of the snapshot. */
  readonly size: number
  /** Millisecond timestamp of the last modification before this snapshot. */
  readonly lastModified: number
  /** The snapshot's whole content. */
  arrayBuffer(): Promise<ArrayBuffer>
  /** The snapshot's content as a byte stream. */
  stream(): ReadableStream<Uint8Array>
}

/** Writer that stages into a swap and publishes on close (the DOM `createWritable` shape). */
export interface OpfsWritableFileStream {
  /**
   * Stage a chunk; a string is encoded as UTF-8. The buffer element is pinned to
   * `ArrayBuffer` backing so the real DOM `FileSystemWritableFileStream.write`
   * (whose chunk union demands `ArrayBufferView<ArrayBuffer>`) stays assignable
   * to this seam.
   */
  write(data: Uint8Array<ArrayBuffer> | string): Promise<void>
  /** Publish the staged swap as the file's new content and release the writer. */
  close(): Promise<void>
  /** Discard the staged swap and release the writer without publishing. */
  abort(reason?: unknown): Promise<void>
}

/** One file entry in an OPFS directory. */
export interface OpfsFileHandle extends OpfsHandle {
  readonly kind: 'file'
  /** A snapshot of the file's current content and metadata. */
  getFile(): Promise<OpfsFileBlob>
  /** Open a swap-backed writer; publication happens atomically at `close()`. */
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableFileStream>
}

/** One directory entry in an OPFS directory tree. */
export interface OpfsDirectoryHandle extends OpfsHandle {
  readonly kind: 'directory'
  /** Return a child directory, optionally creating it. */
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>
  /** Return a child file handle, optionally creating it. */
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>
  /** Iterate the direct children (name/kind pairs, no metadata). */
  values(): AsyncIterable<OpfsHandle>
}

/**
 * Structural shape of the platform entry point this package needs, kept DOM-lib-free
 * because this package's compiler face is a Node face. The real browser object satisfies
 * it structurally; the lookup is the package's one platform probe, and a runtime without
 * OPFS fails it loudly at first use.
 */
interface OpfsStorageProbe {
  getDirectory?: () => Promise<OpfsDirectoryHandle>
}

/**
 * The default root-handle getter: `navigator.storage.getDirectory()` resolved at CALL
 * time (never at plugin construction, so compositions on runtimes without OPFS still
 * activate the plugin and only file operations fail). Specs replace the provider's
 * public `root` field with an in-memory fake.
 * @returns the origin's OPFS root directory handle.
 */
export function opfsRoot(): Promise<OpfsDirectoryHandle> {
  const storage = (globalThis as { navigator?: { storage?: OpfsStorageProbe } }).navigator?.storage
  const getDirectory = storage?.getDirectory
  if (getDirectory === undefined) {
    return Promise.reject(new FsError(
      'OPFS is unavailable: this runtime exposes no navigator.storage.getDirectory()',
      'FS_IO_ERROR',
    ))
  }
  return getDirectory.call(storage)
}
