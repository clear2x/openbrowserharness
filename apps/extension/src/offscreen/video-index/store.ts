/**
 * The index store: every index lives as one directory under
 * `video-index/<encoded-videoKey>/` in the extension's OPFS world, addressed
 * through the `ctx.fs` seam. A JSON read treats absence as `undefined`;
 * `chunks/catalog.json` written last is the publication marker, so a partial
 * index (write failure mid-way) reads as absent and re-indexing simply
 * overwrites. Directory removal is not part of the fs seam's contract, so
 * `removeIndex` deletes every file and tolerates the leftover empty
 * directories (invisible outside fs walks).
 *
 * @module video-index/store
 */

import { VideoIndexError } from './types.ts'
import type {
  ChunkCatalog,
  ChunkFile,
  FrameEvidenceEntry,
  IndexMetadata,
  RegistryEntry,
  SubtitleSource,
} from './types.ts'
import type { FsDirEntry, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'

/**
 * The narrow filesystem face the store needs. A structural subset of the
 * `ctx.fs` FileSystem (unconditional write/delete — no intent guards), so
 * both the OPFS provider and the test memory double satisfy it.
 */
export interface IndexStoreFs {
  resolve(path: string, opts?: { signal?: AbortSignal }): Promise<FsTarget>
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  writeText(target: FsTarget, content: string): Promise<unknown>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
  deleteFile(target: FsTarget): Promise<unknown>
}

/** The registry file listing every published index. */
const REGISTRY_PATH = 'video-index/registry.json'

/** The root directory holding every index. */
const ROOT_DIR = 'video-index'

/**
 * Encode a videoKey into one safe path segment: every character outside
 * `[A-Za-z0-9._-]` becomes `=` plus two hex digits. The encoding is
 * injective (a literal `=` encodes to `=3d`, so no encoded pair collides
 * with a passthrough character), and the result never contains path
 * separators.
 * @param videoKey - the canonical key (e.g. `bilibili:BV1xx:p1`).
 * @returns the directory-safe segment.
 * @throws VideoIndexError when the encoded segment exceeds 200 characters.
 */
export function encodeKeyPath(videoKey: string): string {
  let encoded = ''
  for (const char of videoKey) {
    if (/[A-Za-z0-9._-]/.test(char)) {
      encoded += char
      continue
    }
    encoded += `=${char.charCodeAt(0).toString(16).padStart(2, '0')}`
  }
  if (encoded.length > 200) {
    throw new VideoIndexError(`videoKey 过长，无法编码为索引目录：${videoKey}`, 'VIDEO_INDEX_INVALID_ARGS')
  }
  return encoded
}

/**
 * Whether one path lies inside the index root (defense against a key that
 * escapes through the encoded segment).
 * @param path - the candidate path.
 * @returns true when the path starts with the index root and stays inside it.
 */
function isInsideIndexRoot(path: string): boolean {
  return path === ROOT_DIR || path.startsWith(`${ROOT_DIR}/`)
}

/** One index's on-disk layout helper. */
class IndexPaths {
  /** The encoded directory segment for the key. */
  readonly dirSegment: string

  constructor(videoKey: string) {
    this.dirSegment = encodeKeyPath(videoKey)
  }

  /** @returns the index directory path. */
  dir(): string {
    return `${ROOT_DIR}/${this.dirSegment}`
  }

  /** @returns the metadata file path. */
  metadata(): string {
    return `${this.dir()}/metadata.json`
  }

  /** @returns the frame-evidence index path. */
  evidence(): string {
    return `${this.dir()}/evidence/evidence-index.json`
  }

  /** @returns the publication marker (catalog) path. */
  catalog(): string {
    return `${this.dir()}/chunks/catalog.json`
  }

  /**
   * One chunk file path (validated against the index root).
   * @param chunkId - the chunk id (`000000` style).
   * @returns the chunk file path.
   */
  chunk(chunkId: string): string {
    const path = `${this.dir()}/chunks/${chunkId}.json`
    if (!isInsideIndexRoot(path)) {
      throw new VideoIndexError(`chunkId 越界：${chunkId}`, 'VIDEO_INDEX_INVALID_ARGS')
    }
    return path
  }
}

/**
 * Build the resolve-options record for an optional signal without tripping
 * `exactOptionalPropertyTypes` (an explicit `signal: undefined` property is
 * not assignable to `signal?: AbortSignal`).
 * @param signal - the caller's cancellation, or undefined.
 * @returns the options record, or undefined when there is no signal.
 */
function resolveOpts(signal: AbortSignal | undefined): { signal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { signal }
}

/**
 * Read one JSON file; absence reads as undefined. Other filesystem errors
 * propagate (fail loud), and a corrupt body raises VIDEO_INDEX_CORRUPT.
 * @param fs - the narrow filesystem face.
 * @param path - the path to read.
 * @param signal - aborts the read.
 * @returns the parsed value, or undefined when absent.
 */
async function readJson<T>(fs: IndexStoreFs, path: string, signal: AbortSignal | undefined): Promise<T | undefined> {
  const target = await fs.resolve(path, resolveOpts(signal))
  const info = await fs.stat(target, signal)
  if (info === undefined || info.type !== 'file') return undefined
  const text = await fs.readText(target, signal)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new VideoIndexError(`索引文件无法解析：${path}`, 'VIDEO_INDEX_CORRUPT')
  }
}

/** One registry document (versioned wrapper for future evolution). */
interface RegistryDocument {
  entries: RegistryEntry[]
}

/**
 * The index store over the narrow filesystem face.
 */
export class VideoIndexStore {
  private readonly fs: IndexStoreFs

  constructor(fs: IndexStoreFs) {
    this.fs = fs
  }

  /**
   * Read the registry.
   * @param signal - aborts the reads.
   * @returns the registry entries (empty when the registry does not exist yet).
   */
  async readRegistry(signal?: AbortSignal): Promise<RegistryEntry[]> {
    const document = await readJson<RegistryDocument>(this.fs, REGISTRY_PATH, signal)
    if (document === undefined || !Array.isArray(document.entries)) return []
    return document.entries
  }

  /**
   * Replace the registry wholesale.
   * @param entries - the full new entry list.
   * @param signal - aborts the write.
   */
  async writeRegistry(entries: RegistryEntry[], signal?: AbortSignal): Promise<void> {
    const document: RegistryDocument = { entries }
    const target = await this.fs.resolve(REGISTRY_PATH, resolveOpts(signal))
    await this.fs.writeText(target, JSON.stringify(document))
  }

  /**
   * Read one index's metadata.
   * @param videoKey - the canonical key.
   * @param signal - aborts the read.
   * @returns the metadata, or undefined when absent.
   */
  async readMetadata(videoKey: string, signal?: AbortSignal): Promise<IndexMetadata | undefined> {
    const paths = new IndexPaths(videoKey)
    return readJson<IndexMetadata>(this.fs, paths.metadata(), signal)
  }

  /**
   * Read one index's publication marker.
   * @param videoKey - the canonical key.
   * @param signal - aborts the read.
   * @returns the catalog, or undefined when the index is absent/incomplete.
   */
  async readCatalog(videoKey: string, signal?: AbortSignal): Promise<ChunkCatalog | undefined> {
    const paths = new IndexPaths(videoKey)
    return readJson<ChunkCatalog>(this.fs, paths.catalog(), signal)
  }

  /**
   * Read one chunk file.
   * @param videoKey - the canonical key.
   * @param chunkId - the chunk id.
   * @param signal - aborts the read.
   * @returns the chunk file, or undefined when absent.
   */
  async readChunk(videoKey: string, chunkId: string, signal?: AbortSignal): Promise<ChunkFile | undefined> {
    const paths = new IndexPaths(videoKey)
    return readJson<ChunkFile>(this.fs, paths.chunk(chunkId), signal)
  }

  /**
   * Read one index's subtitle source label straight from its metadata.
   * @param videoKey - the canonical key.
   * @param signal - aborts the read.
   * @returns the subtitle source, or undefined when the index is absent.
   */
  async readSubtitleSource(videoKey: string, signal?: AbortSignal): Promise<SubtitleSource | undefined> {
    const metadata = await this.readMetadata(videoKey, signal)
    return metadata?.capabilities.subtitleSource
  }

  /**
   * Read one index's frame-evidence index.
   * @param videoKey - the canonical key.
   * @param signal - aborts the read.
   * @returns the persisted entries (empty when none).
   */
  async readFrameEvidence(videoKey: string, signal?: AbortSignal): Promise<FrameEvidenceEntry[]> {
    const paths = new IndexPaths(videoKey)
    const document = await readJson<{ videoKey: string; entries: FrameEvidenceEntry[] }>(this.fs, paths.evidence(), signal)
    if (document === undefined || !Array.isArray(document.entries)) return []
    return document.entries
  }

  /**
   * Append one frame-evidence entry (and mint its citation id).
   * @param videoKey - the canonical key.
   * @param entry - the capture facts without the frameId.
   * @param signal - aborts the read-modify-write.
   * @returns the assigned frameId and the new entry count.
   */
  async appendFrameEvidence(videoKey: string, entry: Omit<FrameEvidenceEntry, 'frameId'>, signal?: AbortSignal): Promise<{ frameId: string; frameCount: number }> {
    const paths = new IndexPaths(videoKey)
    const existing = await this.readFrameEvidence(videoKey, signal)
    const frameId = `FRAME_${String(existing.length + 1).padStart(6, '0')}`
    const document = { videoKey, entries: [...existing, { ...entry, frameId }] }
    const target = await this.fs.resolve(paths.evidence(), resolveOpts(signal))
    await this.fs.writeText(target, JSON.stringify(document))
    return { frameId, frameCount: document.entries.length }
  }

  /**
   * Publish one index: chunk files first, the catalog last (the publication
   * marker), then the registry row. `indexedAt` and `revision` are caller-owned.
   * @param payload - everything the index persists.
   * @param signal - aborts the writes.
   * @throws VideoIndexError when the encoded key escapes the index root.
   */
  async publishIndex(payload: {
    videoKey: string
    metadata: IndexMetadata
    catalog: ChunkCatalog
    chunkFiles: ChunkFile[]
    registryEntry: RegistryEntry
  }, signal?: AbortSignal): Promise<void> {
    const paths = new IndexPaths(payload.videoKey)
    if (!isInsideIndexRoot(paths.dir())) {
      throw new VideoIndexError(`videoKey 编码越界：${payload.videoKey}`, 'VIDEO_INDEX_INVALID_ARGS')
    }
    for (const chunkFile of payload.chunkFiles) {
      const target = await this.fs.resolve(paths.chunk(chunkFile.chunkId), resolveOpts(signal))
      await this.fs.writeText(target, JSON.stringify(chunkFile))
    }
    const catalogTarget = await this.fs.resolve(paths.catalog(), resolveOpts(signal))
    await this.fs.writeText(catalogTarget, JSON.stringify(payload.catalog))
    const metadataTarget = await this.fs.resolve(paths.metadata(), resolveOpts(signal))
    await this.fs.writeText(metadataTarget, JSON.stringify(payload.metadata))
    const registry = await this.readRegistry(signal)
    const filtered = registry.filter(entry => entry.videoKey !== payload.videoKey)
    filtered.push(payload.registryEntry)
    await this.writeRegistry(filtered, signal)
  }

  /**
   * Delete every file of one index. Leftover empty directories stay (the fs
   * seam has no directory removal); the registry keeps the authoritative list.
   * @param videoKey - the canonical key.
   * @param signal - aborts the deletions.
   */
  async removeIndex(videoKey: string, signal?: AbortSignal): Promise<void> {
    const paths = new IndexPaths(videoKey)
    const dirTarget = await this.fs.resolve(paths.dir(), resolveOpts(signal))
    const entries = await this.fs.listDir(dirTarget, signal)
    for (const entry of entries) {
      if (entry.type === 'directory') {
        const childEntries = await this.fs.listDir(entry.target, signal)
        for (const child of childEntries) {
          if (child.type === 'file') await this.fs.deleteFile(child.target)
        }
        continue
      }
      if (entry.type === 'file') await this.fs.deleteFile(entry.target)
    }
    const registry = await this.readRegistry(signal)
    await this.writeRegistry(registry.filter(entry => entry.videoKey !== videoKey), signal)
  }
}
