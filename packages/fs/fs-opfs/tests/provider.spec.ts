/**
 * Provider tests for the OPFS `ctx.fs` backend over the in-memory fake handle
 * tree: target identity, stat/listDir, the read suite, guarded atomic writes,
 * literal edits, and version-token freshness.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { OpfsFileSystem } from '../src/index.ts'
import { fakeRoot, readBack, seed } from './fake-opfs.ts'
import type { FakeOpfsDir } from './fake-opfs.ts'
import type { OpfsDirectoryHandle } from '../src/opfs.ts'
import type { Config } from '../src/index.ts'

/** A provider wired to a fresh fake root (the spec's `root` seam). */
function makeProvider(config: Config = {}): { provider: OpfsFileSystem; root: FakeOpfsDir } {
  const root = fakeRoot()
  const provider = new OpfsFileSystem(new Context(), OpfsFileSystem.Config(config))
  provider.root = (): Promise<OpfsDirectoryHandle> => Promise.resolve(root)
  return { provider, root }
}

const target = async (provider: OpfsFileSystem, path: string, cwd?: string): Promise<FsTarget> =>
  provider.resolve(path, cwd === undefined ? undefined : { cwd })

describe('construction and configuration', () => {
  it('defaults cwd to the OPFS root and diffBasisMaxBytes to 10 MiB', () => {
    const { provider } = makeProvider()
    expect(provider.config.cwd).toBe('/')
    expect(provider.config.diffBasisMaxBytes).toBe(10 * 1024 * 1024)
  })

  it('canonicalizes a relative cwd against the root (explicit resolve step)', async () => {
    const { provider } = makeProvider({ cwd: 'workspace' })
    const resolved = await provider.resolve('a.txt')
    expect(provider.config.cwd).toBe('/workspace')
    expect(resolved.displayPath).toBe('/workspace/a.txt')
  })

  it('fails loud on an invalid diffBasisMaxBytes', () => {
    expect(() => new OpfsFileSystem(new Context(), OpfsFileSystem.Config({ diffBasisMaxBytes: 0 }))).toThrow('fs-opfs:')
    expect(() => new OpfsFileSystem(new Context(), OpfsFileSystem.Config({ diffBasisMaxBytes: 2 ** 31 }))).toThrow('fs-opfs:')
  })

  it('the default root probe fails loudly on a runtime without OPFS (this Node lane)', async () => {
    const provider = new OpfsFileSystem(new Context(), OpfsFileSystem.Config({}))
    await expect(provider.resolve('/x')).resolves.toBeDefined()
    await expect(provider.stat(await provider.resolve('/x'))).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })
})

describe('resolve, processPath, fileUrl, contains', () => {
  it('resolve is stable across aliases that canonicalize equally', async () => {
    const { provider } = makeProvider({ cwd: '/workspace' })
    const direct = await provider.resolve('/workspace/./a.txt')
    const relative = await provider.resolve('a.txt')
    expect(direct.targetKey).toBe(relative.targetKey)
    expect(direct.displayPath).toBe('/workspace/a.txt')
  })

  it('opts.cwd overrides the configured cwd without touching it', async () => {
    const { provider } = makeProvider({ cwd: '/workspace' })
    const resolved = await provider.resolve('a.txt', { cwd: '/other' })
    expect(resolved.displayPath).toBe('/other/a.txt')
    expect(provider.config.cwd).toBe('/workspace')
  })

  it('resolve rejects empty paths and pre-aborted signals', async () => {
    const { provider } = makeProvider()
    await expect(provider.resolve('')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    const controller = new AbortController()
    controller.abort()
    await expect(provider.resolve('/a', { signal: controller.signal })).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('processPath is the canonical path and fileUrl names it under the opfs scheme', async () => {
    const { provider } = makeProvider()
    const resolved = await provider.resolve('/dir/a b.txt')
    expect(provider.processPath(resolved)).toBe('/dir/a b.txt')
    expect(provider.fileUrl(resolved)).toBe('opfs:///dir/a%20b.txt')
  })

  it('contains follows canonical path containment', async () => {
    const { provider } = makeProvider()
    const root = await provider.resolve('/')
    const dir = await provider.resolve('/workspace')
    const file = await provider.resolve('/workspace/a.txt')
    const sibling = await provider.resolve('/other/a.txt')
    expect(provider.contains(root, file)).toBe(true)
    expect(provider.contains(dir, file)).toBe(true)
    expect(provider.contains(dir, dir)).toBe(true)
    expect(provider.contains(dir, sibling)).toBe(false)
    // A shared prefix is not containment: /workspace2 is not inside /workspace.
    expect(provider.contains(dir, await provider.resolve('/workspace2/x'))).toBe(false)
  })
})

describe('stat and lstat', () => {
  it('reports file metadata with a stable version until a write', async () => {
    const { provider, root } = makeProvider()
    await seed(root, '/a.txt', 'hello')
    const resolved = await target(provider, '/a.txt')
    const first = await provider.stat(resolved)
    expect(first).toMatchObject({ type: 'file', size: 5 })
    expect(first?.version).toBeDefined()
    expect(await provider.stat(resolved)).toEqual(first)
    await seed(root, '/a.txt', 'hello!')
    expect(await provider.stat(resolved)).not.toEqual(first)
  })

  it('reports directories (including the root) and undefined for absent paths', async () => {
    const { provider, root } = makeProvider()
    await seed(root, '/dir/a.txt', 'x')
    expect(await provider.stat(await target(provider, '/dir'))).toMatchObject({ type: 'directory' })
    expect(await provider.stat(await target(provider, '/'))).toMatchObject({ type: 'directory' })
    expect(await provider.stat(await target(provider, '/missing'))).toBeUndefined()
    // A path through a regular file cannot exist.
    expect(await provider.stat(await target(provider, '/dir/a.txt/deeper'))).toBeUndefined()
  })

  it('lstat resolves relative paths from the config and rejects empty input', async () => {
    const { provider, root } = makeProvider({ cwd: '/workspace' })
    await seed(root, '/workspace/a.txt', 'hello')
    expect(await provider.lstat('a.txt')).toMatchObject({ type: 'file', size: 5 })
    expect(await provider.lstat('/workspace')).toMatchObject({ type: 'directory' })
    await expect(provider.lstat('')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    // OPFS has no symlinks: the path-entry type never reports symlink.
    expect(await provider.lstat('a.txt')).toMatchObject({ type: 'file' })
  })
})

describe('readText, streamText, readBytes', () => {
  it('readText returns the whole decoded file', async () => {
    const { provider, root } = makeProvider()
    await seed(root, '/a.txt', '内容 content')
    expect(await provider.readText(await target(provider, '/a.txt'))).toBe('内容 content')
  })

  it('readText maps missing, directory, and binary targets to the taxonomy', async () => {
    const { provider, root } = makeProvider()
    await seed(root, '/dir/inner.txt', 'x')
    await expect(provider.readText(await target(provider, '/missing.txt'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(provider.readText(await target(provider, '/dir'))).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    await expect(provider.readText(await target(provider, '/'))).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    const file = await (await root.getDirectoryHandle('dir')).getFileHandle('inner.txt')
    const writable = await file.createWritable()
    await writable.write(new Uint8Array([0x61, 0x00]))
    await writable.close()
    await expect(provider.readText(await target(provider, '/dir/inner.txt'))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('streamText yields the whole text', async () => {
    const { provider, root } = makeProvider()
    await seed(root, '/big.txt', 'a'.repeat(10_000))
    let text = ''
    for await (const chunk of await provider.streamText(await target(provider, '/big.txt'))) text += chunk
    expect(text).toBe('a'.repeat(10_000))
  })

  it('readBytes returns raw bytes and enforces the cap', async () => {
    const { provider, root } = makeProvider()
    await seed(root, '/a.bin', 'abcdef')
    const resolved = await target(provider, '/a.bin')
    expect(new TextDecoder().decode(await provider.readBytes(resolved, undefined, 10))).toBe('abcdef')
    await expect(provider.readBytes(resolved, undefined, 3)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })
})

describe('listDir', () => {
  it('lists children in stable name order with cheap metadata', async () => {
    const { provider, root } = makeProvider()
    await seed(root, '/workspace/b.txt', 'bb')
    await seed(root, '/workspace/a.txt', 'a')
    await (await root.getDirectoryHandle('workspace', { create: true })).getDirectoryHandle('sub', { create: true })
    const entries = await provider.listDir(await target(provider, '/workspace'))
    expect(entries.map(entry => entry.name)).toEqual(['a.txt', 'b.txt', 'sub'])
    const byName = new Map(entries.map(entry => [entry.name, entry]))
    expect(byName.get('a.txt')).toMatchObject({ type: 'file', size: 1 })
    expect(byName.get('b.txt')).toMatchObject({ type: 'file', size: 2 })
    expect(byName.get('sub')).toMatchObject({ type: 'directory' })
    expect(String(byName.get('a.txt')?.target.targetKey)).toBe('/workspace/a.txt')
  })

  it('lists the OPFS root itself', async () => {
    const { provider, root } = makeProvider()
    await seed(root, '/a.txt', 'x')
    expect((await provider.listDir(await target(provider, '/'))).map(entry => entry.name)).toEqual(['a.txt'])
  })

  it('maps missing and non-directory targets to the taxonomy', async () => {
    const { provider, root } = makeProvider()
    await seed(root, '/a.txt', 'x')
    await expect(provider.listDir(await target(provider, '/missing'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    await expect(provider.listDir(await target(provider, '/a.txt'))).rejects.toMatchObject({ code: 'FS_NOT_DIRECTORY' })
  })
})

describe('writeText', () => {
  it('creates files, provisioning missing parents', async () => {
    const { provider, root } = makeProvider()
    const resolved = await target(provider, '/deep/nested/a.txt')
    const outcome = await provider.writeText(resolved, 'hello')
    expect(outcome.operation).toBe('create')
    expect(outcome.before).toBeNull()
    expect(outcome.after).toBe('hello')
    expect(await readBack(root, '/deep/nested/a.txt')).toBe('hello')
    // The digest-bearing outcome token and the metadata-only stat token describe
    // the same state differently (an FsVersion is opaque); both must guard.
    const next = await provider.writeText(resolved, 'again', {
      kind: 'replaceIfVersion',
      version: (await provider.stat(resolved))?.version ?? outcome.version,
    })
    expect(next.operation).toBe('update')
    const guarded = await provider.writeText(resolved, 'third', { kind: 'replaceIfVersion', version: next.version })
    expect(guarded.operation).toBe('update')
  })

  it('overwrites unconditionally and returns the prior LF-normalized basis', async () => {
    const { provider, root } = makeProvider()
    const resolved = await target(provider, '/a.txt')
    await provider.writeText(resolved, 'first')
    const outcome = await provider.writeText(resolved, 'second\r\nline')
    expect(outcome.operation).toBe('update')
    expect(outcome.before).toBe('first')
    // `after` shares the LF diff basis even though storage keeps the CRLF text.
    expect(outcome.after).toBe('second\nline')
    expect(await readBack(root, '/a.txt')).toBe('second\r\nline')
  })

  it('returns before: null when either side reaches the diff-basis limit', async () => {
    const { provider, root } = makeProvider({ diffBasisMaxBytes: 4 })
    const resolved = await target(provider, '/a.txt')
    await provider.writeText(resolved, 'abcd')
    // The prior alone is at the limit (4 >= 4): the basis is declined.
    expect((await provider.writeText(resolved, 'xy')).before).toBeNull()
    // Both sides strictly below the limit: the basis is returned.
    expect((await provider.writeText(resolved, 'ab')).before).toBe('xy')
    // The replacement side alone reaches the limit: the basis is declined.
    expect((await provider.writeText(resolved, 'cdef')).before).toBeNull()
    // A binary prior costs only the basis, never the write.
    const file = await root.getFileHandle('a.txt')
    const writable = await file.createWritable()
    await writable.write(new Uint8Array([0x00, 0x01]))
    await writable.close()
    expect((await provider.writeText(resolved, 'clean')).before).toBeNull()
    expect(await readBack(root, '/a.txt')).toBe('clean')
  })

  it('createIfAbsent preserves an existing file and creates a missing one', async () => {
    const { provider, root } = makeProvider()
    const resolved = await target(provider, '/a.txt')
    await seed(root, '/a.txt', 'prior')
    await expect(provider.writeText(resolved, 'blind', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(await readBack(root, '/a.txt')).toBe('prior')

    const fresh = await target(provider, '/fresh.txt')
    const outcome = await provider.writeText(fresh, 'made', { kind: 'createIfAbsent' })
    expect(outcome.operation).toBe('create')
    expect(await readBack(root, '/fresh.txt')).toBe('made')
  })

  it('replaceIfVersion rejects absence and stale versions with FS_STALE_VERSION', async () => {
    const { provider, root } = makeProvider()
    const resolved = await target(provider, '/a.txt')
    const created = await provider.writeText(resolved, 'v1')
    await expect(provider.writeText(await target(provider, '/missing.txt'), 'x', { kind: 'replaceIfVersion', version: created.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })

    // An out-of-band write (the shared origin's other contexts) invalidates the guard.
    await seed(root, '/a.txt', 'external')
    await expect(provider.writeText(resolved, 'v2', { kind: 'replaceIfVersion', version: created.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await readBack(root, '/a.txt')).toBe('external')

    const current = await provider.stat(resolved)
    if (current === undefined) throw new Error('spec: /a.txt should exist')
    const outcome = await provider.writeText(resolved, 'v3', { kind: 'replaceIfVersion', version: current.version })
    expect(outcome.operation).toBe('update')
  })

  it('refuses non-regular targets', async () => {
    const { provider, root } = makeProvider()
    await seed(root, '/dir/inner.txt', 'x')
    await expect(provider.writeText(await target(provider, '/dir'), 'x')).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    await expect(provider.writeText(await target(provider, '/'), 'x')).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
    await expect(provider.writeText(await target(provider, '/dir/inner.txt/deeper'), 'x'))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('aborts before publication, leaving the visible file unchanged', async () => {
    const { provider, root } = makeProvider()
    const resolved = await target(provider, '/a.txt')
    await provider.writeText(resolved, 'kept')
    const controller = new AbortController()
    controller.abort()
    await expect(provider.writeText(resolved, 'discarded', undefined, controller.signal))
      .rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(await readBack(root, '/a.txt')).toBe('kept')
  })

  it('issues a fresh version even for same-size same-millisecond rewrites', async () => {
    const { provider } = makeProvider()
    const resolved = await target(provider, '/a.txt')
    const first = await provider.writeText(resolved, 'aaaa')
    const second = await provider.writeText(resolved, 'aaab')
    expect(second.version).not.toBe(first.version)
  })

  it('serializes concurrent mutations: the guarded latecomer rejects stale', async () => {
    const { provider } = makeProvider()
    const resolved = await target(provider, '/a.txt')
    const created = await provider.writeText(resolved, 'v0')
    const unconditional = provider.writeText(resolved, 'v1')
    const guarded = provider.writeText(resolved, 'v2', { kind: 'replaceIfVersion', version: created.version })
    await expect(guarded).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await unconditional
    expect(await provider.readText(resolved)).toBe('v1')
  })
})

describe('stale-guard content digest', () => {
  /** Rewrite the fake file in place, preserving its size window and `lastModified`. */
  async function rewriteSameMetadata(root: FakeOpfsDir, name: string, content: string): Promise<void> {
    const file = await root.getFileHandle(name)
    const { lastModified } = await file.getFile()
    file.commit({ data: new TextEncoder().encode(content), lastModified })
  }

  it('an edit guard catches a same-size same-millisecond external rewrite the metadata cannot see', async () => {
    const { provider, root } = makeProvider()
    const resolved = await target(provider, '/a.txt')
    const created = await provider.writeText(resolved, 'aaaa')
    await rewriteSameMetadata(root, 'a.txt', 'aaab')
    // Metadata alone still matches here (revision, size, lastModified unchanged);
    // only the outcome token's content digest exposes the rewrite.
    await expect(provider.editText(resolved, { oldString: 'aaab', newString: 'x', replaceAll: false }, { version: created.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await readBack(root, '/a.txt')).toBe('aaab')
  })

  it('a write guard catches a same-size same-millisecond external rewrite', async () => {
    const { provider, root } = makeProvider()
    const resolved = await target(provider, '/a.txt')
    const created = await provider.writeText(resolved, 'aaaa')
    await rewriteSameMetadata(root, 'a.txt', 'bbba')
    await expect(provider.writeText(resolved, 'v2', { kind: 'replaceIfVersion', version: created.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await readBack(root, '/a.txt')).toBe('bbba')
  })

  it('a byte-identical same-millisecond rewrite still passes the guard', async () => {
    const { provider, root } = makeProvider()
    const resolved = await target(provider, '/a.txt')
    const created = await provider.writeText(resolved, 'aaaa')
    await rewriteSameMetadata(root, 'a.txt', 'aaaa')
    const outcome = await provider.editText(resolved, { oldString: 'aaaa', newString: 'x', replaceAll: false }, { version: created.version })
    expect(outcome.after).toBe('x')
    expect(await readBack(root, '/a.txt')).toBe('x')
  })

  it('a stat-sourced guard verifies metadata only (reads never read content)', async () => {
    const { provider, root } = makeProvider()
    const resolved = await target(provider, '/a.txt')
    await provider.writeText(resolved, 'aaaa')
    const observed = await provider.stat(resolved)
    if (observed === undefined) throw new Error('spec: /a.txt should exist')
    await rewriteSameMetadata(root, 'a.txt', 'aaab')
    // The stat token carries no digest, so this same-ms rewrite is not visible
    // to it; the guard passes on matching metadata (the documented boundary).
    const outcome = await provider.writeText(resolved, 'v2', { kind: 'replaceIfVersion', version: observed.version })
    expect(outcome.operation).toBe('update')
  })
})

describe('editText', () => {
  it('applies a literal edit and reports the LF before/after basis', async () => {
    const { provider, root } = makeProvider()
    const resolved = await target(provider, '/a.txt')
    await provider.writeText(resolved, 'hello\nworld\n')
    const outcome = await provider.editText(resolved, { oldString: 'world', newString: 'there', replaceAll: false })
    expect(outcome.before).toBe('hello\nworld\n')
    expect(outcome.after).toBe('hello\nthere\n')
    expect(await readBack(root, '/a.txt')).toBe('hello\nthere\n')
  })

  it('preserves a CRLF file\u2019s line-ending style on write-back', async () => {
    const { provider, root } = makeProvider()
    const resolved = await target(provider, '/a.txt')
    await provider.writeText(resolved, 'one\r\ntwo\r\n')
    await provider.editText(resolved, { oldString: 'two', newString: 'deux', replaceAll: false })
    expect(await readBack(root, '/a.txt')).toBe('one\r\ndeux\r\n')
  })

  it('guards staleness before matching, on guarded and unconditional paths alike', async () => {
    const { provider, root } = makeProvider()
    const resolved = await target(provider, '/a.txt')
    const created = await provider.writeText(resolved, 'content')
    await seed(root, '/a.txt', 'changed')
    await expect(provider.editText(resolved, { oldString: 'changed', newString: 'x', replaceAll: false }, { version: created.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(provider.editText(await target(provider, '/missing.txt'), { oldString: 'x', newString: 'y', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('maps edit failures to the taxonomy', async () => {
    const { provider, root } = makeProvider()
    const resolved = await target(provider, '/a.txt')
    await seed(root, '/dir/inner.txt', 'x')
    await provider.writeText(resolved, 'dup dup')
    await expect(provider.editText(resolved, { oldString: '', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    await expect(provider.editText(resolved, { oldString: 'absent', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    await expect(provider.editText(resolved, { oldString: 'dup', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    await provider.editText(resolved, { oldString: 'dup', newString: 'x', replaceAll: true })
    expect(await provider.readText(resolved)).toBe('x x')
    await expect(provider.editText(await target(provider, '/dir'), { oldString: 'x', newString: 'y', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })
})
