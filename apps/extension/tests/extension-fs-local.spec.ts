/**
 * `extension-fs-local` spec: the synthetic routing root's `local/` branch —
 * granted handles delegate, absent/un-granted handles collapse to the empty
 * write-refusing placeholder, and the real root stays reachable alongside.
 * Both the OPFS root and the user handle are in-memory fakes standing in for
 * the DOM handles (the fs-opfs seam is structural — see opfs.ts); the
 * workspace reader is injected the same way.
 */
import { describe, expect, it } from 'vitest'
import type { OpfsDirectoryHandle, OpfsFileHandle, OpfsHandle } from '@deepseek-ai/dsh-fs-opfs/src/opfs.ts'
import { makeLocalAwareRoot } from '../src/offscreen/extension-fs-local.ts'

/** Permission state a fake handle reports through its queryPermission member. */
type FakePermission = 'granted' | 'prompt'

/** The OpfsFileBlob members the fakes stand in for. */
interface FileLike {
  size: number
  lastModified: number
  arrayBuffer(): Promise<ArrayBuffer>
  stream(): ReadableStream<Uint8Array>
}

/** The writable face a fake createWritable returns. */
interface WritableLike {
  write(data: Uint8Array<ArrayBuffer> | string): Promise<void>
  close(): Promise<void>
  abort(reason?: unknown): Promise<void>
}

/** In-memory file handle: a static blob snapshot (the OpfsFileBlob members). */
class FakeFile implements OpfsHandle {
  readonly kind = 'file' as const
  readonly size = 0
  readonly lastModified = 0

  constructor(readonly name: string) {}

  async getFile(): Promise<FileLike> {
    const bytes = new TextEncoder().encode(this.name)
    return {
      size: bytes.byteLength,
      lastModified: 0,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      stream: () => new ReadableStream<Uint8Array>({
        start: (controller) => { controller.enqueue(bytes); controller.close() },
      }),
    }
  }

  async createWritable(): Promise<WritableLike> {
    return {
      write: async () => {},
      close: async () => {},
      abort: async () => {},
    }
  }
}

/** In-memory directory handle: named children only. */
class FakeDir implements OpfsDirectoryHandle {
  readonly kind = 'directory' as const
  readonly children = new Map<string, OpfsHandle>()
  permission: FakePermission = 'granted'

  constructor(readonly name: string) {}

  async queryPermission(descriptor: { mode: 'readwrite' }): Promise<FakePermission> {
    void descriptor
    return this.permission
  }

  async getDirectoryHandle(child: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle> {
    const found = this.children.get(child)
    if (found !== undefined && found.kind === 'directory') return found as OpfsDirectoryHandle
    if (options?.create === true) {
      const created = new FakeDir(child)
      this.children.set(child, created)
      return created
    }
    throw Object.assign(new Error(`no directory ${child}`), { name: 'NotFoundError' })
  }

  async getFileHandle(child: string): Promise<OpfsFileHandle> {
    const found = this.children.get(child)
    if (found !== undefined && found.kind === 'file') return found as OpfsFileHandle
    throw Object.assign(new Error(`no file ${child}`), { name: 'NotFoundError' })
  }

  async *values(): AsyncGenerator<OpfsHandle> {
    for (const child of this.children.values()) yield child
  }

  async removeEntry(child: string): Promise<void> {
    this.children.delete(child)
  }
}

/** The IDB-plane fake: permission state survives the "persist", the handle is the fake itself. */
const store: { name: string; handle: FakeDir }[] = []

const fakeReader = async (): Promise<{ name: string; handle: FakeDir } | undefined> => store[0]

function fakeRootGetter(root: FakeDir): () => Promise<OpfsDirectoryHandle> {
  return async () => root
}

async function collect(iterable: AsyncIterable<OpfsHandle>): Promise<string[]> {
  const names: string[] = []
  for await (const entry of iterable) names.push(entry.name)
  return names
}

describe('extension-fs-local synthetic routing root', () => {
  it('grants /local to a handle whose permission is granted', async () => {
    const opfsRoot = new FakeDir('opfs-root')
    opfsRoot.children.set('notes.txt', new FakeFile('notes.txt'))
    const user = new FakeDir('my-project')
    user.permission = 'granted'
    store.length = 0
    store.push({ name: 'my-project', handle: user })

    const root = await makeLocalAwareRoot(fakeRootGetter(opfsRoot), fakeReader)()
    const local = await root.getDirectoryHandle('local')
    expect(local).toBe(user)
    // Sibling reads still reach the real root.
    const file = await root.getFileHandle('notes.txt')
    expect(file.kind).toBe('file')
    // The root listing serves the virtual child plus the real children.
    const names = await collect(root.values())
    expect(names).toContain('local')
    expect(names).toContain('notes.txt')
  })

  it('collapses /local to an empty write-refusing placeholder when nothing is picked', async () => {
    store.length = 0
    const opfsRoot = new FakeDir('opfs-root')
    const root = await makeLocalAwareRoot(fakeRootGetter(opfsRoot), fakeReader)()
    const local = await root.getDirectoryHandle('local')
    const refused = local.getDirectoryHandle('x', { create: true })
    await expect(refused).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(refused).rejects.toThrow('选择本地文件夹')
    await expect(local.getFileHandle('x')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    expect(await collect(local.values())).toEqual([])
    // The real root keeps working alongside.
    expect(await root.getDirectoryHandle('anything', { create: true })).toBeDefined()
  })

  it('collapses /local with a re-grant pointer when the permission degraded to prompt', async () => {
    const user = new FakeDir('my-project')
    user.permission = 'prompt'
    store.length = 0
    store.push({ name: 'my-project', handle: user })
    const opfsRoot = new FakeDir('opfs-root')
    const root = await makeLocalAwareRoot(fakeRootGetter(opfsRoot), fakeReader)()
    const local = await root.getDirectoryHandle('local')
    const refused = local.getDirectoryHandle('x', { create: true })
    await expect(refused).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(refused).rejects.toThrow('重新授权')
    // Reads through the placeholder stay plain not-found (reads never need the grant).
    await expect(local.getFileHandle('x')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('is a stable identity: repeated root() calls share one synthetic root', async () => {
    const opfsRoot = new FakeDir('opfs-root')
    const getter = makeLocalAwareRoot(fakeRootGetter(opfsRoot), fakeReader)
    const first = await getter()
    const second = await getter()
    expect(first).toBe(second)
  })

  it('refuses to remove the virtual local entry through the root', async () => {
    const opfsRoot = new FakeDir('opfs-root')
    opfsRoot.children.set('keep.txt', { kind: 'file', name: 'keep.txt' })
    const root = await makeLocalAwareRoot(fakeRootGetter(opfsRoot), fakeReader)()
    await root.removeEntry('keep.txt')
    expect(opfsRoot.children.has('keep.txt')).toBe(false)
    expect(await root.getDirectoryHandle('local')).toBeDefined()
  })
})
