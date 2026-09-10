/**
 * In-memory fake of the narrow OPFS handle seam (`../src/opfs.ts`): a mutable
 * name→node tree whose files commit through swap-backed writers, so the provider
 * and mechanics run their real logic without a browser. Chunked snapshot streams
 * and DOMException-kind errors reproduce the platform behaviors the provider
 * maps (`NotFoundError`, `TypeMismatchError`).
 * @module fake-opfs
 */

import type { OpfsDirectoryHandle, OpfsFileBlob, OpfsFileHandle, OpfsHandle, OpfsWritableFileStream } from '../src/opfs.ts'

/** Monotonic fake clock: every committed write advances `lastModified`. */
let clock = 1

function notFound(name: string): Error {
  return new DOMException(`fake-opfs: no entry named "${name}"`, 'NotFoundError')
}

function typeMismatch(name: string): Error {
  return new DOMException(`fake-opfs: "${name}" is of the other kind`, 'TypeMismatchError')
}

/** An immutable content snapshot taken at `getFile()` time. */
class FakeBlob implements OpfsFileBlob {
  readonly size: number
  readonly lastModified: number

  constructor(
    private readonly bytes: Uint8Array,
    lastModified: number,
    private readonly chunkSize: number,
  ) {
    this.size = bytes.length
    this.lastModified = lastModified
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer
  }

  stream(): ReadableStream<Uint8Array> {
    const { bytes, chunkSize } = this
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          controller.enqueue(bytes.slice(offset, offset + chunkSize))
        }
        controller.close()
      },
    })
  }
}

/** Swap-backed writer: staged chunks publish to the file only at `close()`. */
class FakeWritable implements OpfsWritableFileStream {
  private pending: Uint8Array
  private settled = false

  constructor(
    private readonly file: FakeOpfsFile,
    keepExistingData: boolean,
  ) {
    this.pending = keepExistingData ? file.snapshot().slice() : new Uint8Array(0)
  }

  async write(data: Uint8Array | string): Promise<void> {
    if (this.settled) throw new DOMException('fake-opfs: writer already settled', 'InvalidStateError')
    const chunk = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const merged = new Uint8Array(this.pending.length + chunk.length)
    merged.set(this.pending)
    merged.set(chunk, this.pending.length)
    this.pending = merged
  }

  async close(): Promise<void> {
    if (this.settled) throw new DOMException('fake-opfs: writer already settled', 'InvalidStateError')
    this.file.commit({ data: this.pending, lastModified: clock += 1 })
    this.settled = true
  }

  async abort(): Promise<void> {
    this.settled = true
  }
}

export class FakeOpfsFile implements OpfsFileHandle {
  readonly kind = 'file' as const
  state: { data: Uint8Array; lastModified: number }

  constructor(
    readonly name: string,
    state: { data: Uint8Array; lastModified: number } = { data: new Uint8Array(0), lastModified: clock += 1 },
    private readonly chunkSize = 4 * 1024,
  ) {
    this.state = state
  }

  /** Current bytes (spec-side seeding/inspection helper). */
  snapshot(): Uint8Array {
    return this.state.data
  }

  /** Publication hook for the swap-backed writer (same-module collaborator). */
  commit(state: { data: Uint8Array; lastModified: number }): void {
    this.state = state
  }

  async getFile(): Promise<OpfsFileBlob> {
    return new FakeBlob(this.state.data, this.state.lastModified, this.chunkSize)
  }

  async createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableFileStream> {
    return new FakeWritable(this, options?.keepExistingData === true)
  }
}

export class FakeOpfsDir implements OpfsDirectoryHandle {
  readonly kind = 'directory' as const
  private readonly children = new Map<string, FakeOpfsFile | FakeOpfsDir>()

  constructor(
    readonly name: string,
    private readonly chunkSize = 4 * 1024,
  ) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeOpfsDir> {
    const found = this.children.get(name)
    if (found instanceof FakeOpfsDir) return found
    if (found !== undefined) throw typeMismatch(name)
    if (options?.create === true) {
      const created = new FakeOpfsDir(name, this.chunkSize)
      this.children.set(name, created)
      return created
    }
    throw notFound(name)
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeOpfsFile> {
    const found = this.children.get(name)
    if (found instanceof FakeOpfsFile) return found
    if (found !== undefined) throw typeMismatch(name)
    if (options?.create === true) {
      const created = new FakeOpfsFile(name, { data: new Uint8Array(0), lastModified: clock += 1 }, this.chunkSize)
      this.children.set(name, created)
      return created
    }
    throw notFound(name)
  }

  values(): AsyncIterable<OpfsHandle> {
    const entries: OpfsHandle[] = Array.from(this.children.values(), child => ({ kind: child.kind, name: child.name }))
    return (async function* () {
      for (const entry of entries) yield entry
    })()
  }
}

/** A fresh empty OPFS root; `chunkSize` controls snapshot stream chunking. */
export function fakeRoot(chunkSize = 4 * 1024): FakeOpfsDir {
  return new FakeOpfsDir('', chunkSize)
}

/** Seed `content` at `path` through the real handle API (directories created). */
export async function seed(root: FakeOpfsDir, path: string, content: string): Promise<void> {
  const segments = path.split('/').filter(name => name.length > 0)
  const base = segments.at(-1)
  if (base === undefined) throw new Error('fake-opfs: seed path must name a file')
  let dir = root
  for (const segment of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment, { create: true })
  }
  const file = await dir.getFileHandle(base, { create: true })
  const writable = await file.createWritable()
  await writable.write(content)
  await writable.close()
}

/** Read the current committed content at `path` back through the real handle API. */
export async function readBack(root: FakeOpfsDir, path: string): Promise<string> {
  const segments = path.split('/').filter(name => name.length > 0)
  const base = segments.at(-1)
  if (base === undefined) throw new Error('fake-opfs: read path must name a file')
  let dir: FakeOpfsDir = root
  for (const segment of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment)
  }
  const blob = await (await dir.getFileHandle(base)).getFile()
  return new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()))
}
