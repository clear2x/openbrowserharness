/**
 * Cordis-free tests for the OPFS mechanics: canonical path resolution, DOM-error
 * mapping, handle-tree traversal over the in-memory fake, whole/streamed/bounded
 * reads, and literal editing.
 */

import { describe, expect, it } from 'vitest'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import { FakeOpfsDir, fakeRoot, seed } from './fake-opfs.ts'
import type { FakeOpfsFile } from './fake-opfs.ts'
import {
  applyLiteralEdit,
  contentDigest,
  decodeEditSnapshot,
  directoryFor,
  joinChild,
  parseVersionToken,
  probeEntry,
  readEditSnapshot,
  readPriorSnapshot,
  readWholeBlobBytes,
  readWholeBlobText,
  resolveDirectoryPath,
  resolveOpfsPath,
  splitParentBase,
  streamBlobText,
  toFsError,
  utf8ByteLength,
  versionMatches,
  versionToken,
} from '../src/opfsio.ts'

/** Assert `run()` rejects with the given structured FsError code. */
async function expectFsError(run: () => Promise<unknown>, code: string): Promise<void> {
  await expect(run()).rejects.toMatchObject({ code })
}

/** Handle for a seeded file. */
async function fileOf(root: FakeOpfsDir, path: string): Promise<FakeOpfsFile> {
  const segments = path.split('/').filter(name => name.length > 0)
  let dir: FakeOpfsDir = root
  for (const segment of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment)
  }
  return dir.getFileHandle(segments.at(-1) ?? '')
}

/** Overwrite a seeded file's bytes directly through a swap writer. */
async function writeBytes(root: FakeOpfsDir, path: string, bytes: readonly number[]): Promise<void> {
  const file = await fileOf(root, path)
  const writable = await file.createWritable()
  await writable.write(new Uint8Array(bytes))
  await writable.close()
}

describe('resolveOpfsPath', () => {
  it('keeps absolute paths canonical', () => {
    expect(resolveOpfsPath('/base', '/workspace/a.txt')).toBe('/workspace/a.txt')
  })

  it('resolves relative paths against cwd and collapses dots', () => {
    expect(resolveOpfsPath('/base', 'a/./b.txt')).toBe('/base/a/b.txt')
    expect(resolveOpfsPath('/base', '../a.txt')).toBe('/a.txt')
    expect(resolveOpfsPath('/a/b', '../../..')).toBe('/')
  })

  it('clamps .. above the root, mirroring the local backend root walk', () => {
    expect(resolveOpfsPath('/base', '../../../../x.txt')).toBe('/x.txt')
  })

  it('rejects empty and whitespace-only paths with FS_NOT_FOUND', () => {
    expect(() => resolveOpfsPath('/', '')).toThrow(FsError)
    expect(() => resolveOpfsPath('/', '   ')).toThrow(FsError)
    expect(() => resolveOpfsPath('/', '')).toThrow('file_path must be a non-empty string')
  })
})

describe('splitParentBase and joinChild', () => {
  it('splits the root into an empty base', () => {
    expect(splitParentBase('/')).toEqual({ parentKey: '/', base: '' })
  })

  it('splits top-level and nested keys', () => {
    expect(splitParentBase('/a.txt')).toEqual({ parentKey: '/', base: 'a.txt' })
    expect(splitParentBase('/dir/sub/a.txt')).toEqual({ parentKey: '/dir/sub', base: 'a.txt' })
  })

  it('joins children under the root and under nested directories', () => {
    expect(joinChild('/', 'a.txt')).toBe('/a.txt')
    expect(joinChild('/dir', 'a.txt')).toBe('/dir/a.txt')
  })
})

describe('toFsError', () => {
  it('passes FsError instances through', () => {
    const original = new FsError('already typed', 'FS_NOT_FOUND')
    expect(toFsError('read', '/a', original)).toBe(original)
  })

  it('maps NotFound and TypeMismatch to FS_NOT_FOUND', () => {
    expect(toFsError('read', '/a', new DOMException('x', 'NotFoundError')).code).toBe('FS_NOT_FOUND')
    expect(toFsError('read', '/a', new DOMException('x', 'TypeMismatchError')).code).toBe('FS_NOT_FOUND')
  })

  it('maps quota and writer-lock failures to FS_IO_ERROR with cause', () => {
    const quota = toFsError('write', '/a', new DOMException('x', 'QuotaExceededError'))
    expect(quota.code).toBe('FS_IO_ERROR')
    expect(quota.cause).toBeInstanceOf(DOMException)
    const locked = toFsError('write', '/a', new DOMException('x', 'NoModificationAllowedError'))
    expect(locked.code).toBe('FS_IO_ERROR')
  })

  it('maps unknown errors and non-errors to FS_IO_ERROR', () => {
    expect(toFsError('read', '/a', new Error('boom')).code).toBe('FS_IO_ERROR')
    expect(toFsError('read', '/a', 'boom').code).toBe('FS_IO_ERROR')
  })
})

describe('traversal over the fake tree', () => {
  it('resolveDirectoryPath(create: false) returns null for missing segments', async () => {
    const root = fakeRoot()
    await seed(root, '/existing/a.txt', 'x')
    expect(await resolveDirectoryPath(root, '/existing', false)).toBeInstanceOf(FakeOpfsDir)
    expect(await resolveDirectoryPath(root, '/missing', false)).toBeNull()
    // A segment that is a regular file cannot be a directory.
    expect(await resolveDirectoryPath(root, '/existing/a.txt/deeper', false)).toBeNull()
  })

  it('resolveDirectoryPath(create: true) provisions parents and refuses file segments', async () => {
    const root = fakeRoot()
    const dir = await resolveDirectoryPath(root, '/new/deeper', true)
    expect(dir).toBeInstanceOf(FakeOpfsDir)
    expect((await root.getDirectoryHandle('new')).name).toBe('new')
    await seed(root, '/afile', 'x')
    await expectFsError(async () => resolveDirectoryPath(root, '/afile/child', true), 'FS_NOT_FOUND')
  })

  it('directoryFor answers the root itself and null for absent paths', async () => {
    const root = fakeRoot()
    expect(await directoryFor(root, '/')).toBe(root)
    expect(await directoryFor(root, '/nope')).toBeNull()
  })

  it('probeEntry distinguishes file, directory, and absent entries', async () => {
    const root = fakeRoot()
    await seed(root, '/dir/inner.txt', 'x')
    expect((await probeEntry(root, 'dir', 'read'))?.kind).toBe('directory')
    const dir = await directoryFor(root, '/dir')
    if (dir === null) throw new Error('fake tree: /dir should exist')
    expect((await probeEntry(dir, 'inner.txt', 'read'))?.kind).toBe('file')
    expect(await probeEntry(dir, 'absent.txt', 'read')).toBeNull()
  })
})

describe('readWholeBlobText', () => {
  it('decodes UTF-8 whole reads', async () => {
    const root = fakeRoot()
    await seed(root, '/a.txt', 'héllo 你好')
    const blob = await (await fileOf(root, '/a.txt')).getFile()
    expect(await readWholeBlobText(blob, '/a.txt')).toBe('héllo 你好')
  })

  it('rejects NUL bytes inside the 8 KiB read sample and anywhere on the edit decode path', async () => {
    const root = fakeRoot()
    await seed(root, '/sampled.bin', `clean${'x'.repeat(8192)}\0tail`)
    const sampled = await (await fileOf(root, '/sampled.bin')).getFile()
    // The NUL sits past the read path's sample window; the edit path's whole
    // buffer rejects it.
    expect(await readWholeBlobText(sampled, '/sampled.bin')).toContain('tail')
    const sampledBytes = new Uint8Array(await sampled.arrayBuffer())
    expect(() => decodeEditSnapshot(sampledBytes, '/sampled.bin')).toThrow(FsError)

    await seed(root, '/head.bin', '\0early')
    const head = await (await fileOf(root, '/head.bin')).getFile()
    await expectFsError(() => readWholeBlobText(head, '/head.bin'), 'FS_NOT_TEXT')
  })

  it('rejects invalid UTF-8 with FS_NOT_TEXT', async () => {
    const root = fakeRoot()
    await seed(root, '/bad.txt', 'ok')
    await writeBytes(root, '/bad.txt', [0xff, 0xfe])
    const blob = await (await fileOf(root, '/bad.txt')).getFile()
    await expectFsError(() => readWholeBlobText(blob, '/bad.txt'), 'FS_NOT_TEXT')
  })

  it('reports pre-abort cancellation', async () => {
    const root = fakeRoot()
    await seed(root, '/a.txt', 'x')
    const blob = await (await fileOf(root, '/a.txt')).getFile()
    const controller = new AbortController()
    controller.abort()
    await expectFsError(() => readWholeBlobText(blob, '/a.txt', controller.signal), 'FS_ABORTED')
  })
})

describe('streamBlobText', () => {
  it('decodes across chunk boundaries (multibyte split over one-byte chunks)', async () => {
    const root = fakeRoot(1)
    await seed(root, '/split.txt', '你a好')
    const blob = await (await fileOf(root, '/split.txt')).getFile()
    const chunks: string[] = []
    for await (const chunk of streamBlobText(blob, '/split.txt')) chunks.push(chunk)
    expect(chunks.join('')).toBe('你a好')
    expect(chunks.length).toBeGreaterThan(3)
  })

  it('rejects binary samples and invalid UTF-8 with FS_NOT_TEXT', async () => {
    const root = fakeRoot(2)
    await seed(root, '/bin.txt', 'ok')
    await writeBytes(root, '/bin.txt', [0x61, 0x00, 0x62])
    await expectFsError(async () => {
      const blob = await (await fileOf(root, '/bin.txt')).getFile()
      let text = ''
      for await (const chunk of streamBlobText(blob, '/bin.txt')) text += chunk
      return text
    }, 'FS_NOT_TEXT')

    await seed(root, '/utf8.txt', 'ok')
    await writeBytes(root, '/utf8.txt', [0x61, 0xf0, 0x62])
    await expectFsError(async () => {
      const blob = await (await fileOf(root, '/utf8.txt')).getFile()
      let text = ''
      for await (const chunk of streamBlobText(blob, '/utf8.txt')) text += chunk
      return text
    }, 'FS_NOT_TEXT')
  })

  it('reports pre-abort cancellation', async () => {
    const root = fakeRoot()
    await seed(root, '/a.txt', 'x')
    const blob = await (await fileOf(root, '/a.txt')).getFile()
    const controller = new AbortController()
    controller.abort()
    await expectFsError(async () => {
      for await (const chunk of streamBlobText(blob, '/a.txt', controller.signal)) void chunk
    }, 'FS_ABORTED')
  })
})

describe('readWholeBlobBytes', () => {
  it('returns raw bytes within the cap and refuses larger snapshots', async () => {
    const root = fakeRoot()
    await seed(root, '/a.bin', 'abcdef')
    const blob = await (await fileOf(root, '/a.bin')).getFile()
    expect(new TextDecoder().decode(await readWholeBlobBytes(blob, '/a.bin', undefined, 6))).toBe('abcdef')
    await expectFsError(() => readWholeBlobBytes(blob, '/a.bin', undefined, 5), 'FS_TOO_LARGE')
  })

  /* v8 ignore next 4 -- the post-read re-check fires only when a real platform's
   * committed content grows past its own snapshot size between the size read and
   * the arrayBuffer; the fake snapshot cannot produce that divergence. */
  it('refuses content that grew past the cap after the size check', async () => {
    const root = fakeRoot()
    await seed(root, '/a.bin', 'abcdef')
    const blob = await (await fileOf(root, '/a.bin')).getFile()
    Object.defineProperty(blob, 'size', { value: 1 })
    await expectFsError(() => readWholeBlobBytes(blob, '/a.bin', undefined, 5), 'FS_TOO_LARGE')
  })
})

describe('readPriorSnapshot', () => {
  it('gives the LF-normalized basis and digest together, or null basis for oversized/binary/undecodable priors', async () => {
    const root = fakeRoot()
    await seed(root, '/crlf.txt', 'a\r\nb')
    const text = await (await fileOf(root, '/crlf.txt')).getFile()
    expect(await readPriorSnapshot(text, '/crlf.txt', 10)).toEqual({
      basis: 'a\nb',
      digest: contentDigest(new TextEncoder().encode('a\r\nb')),
    })
    expect(await readPriorSnapshot(text, '/crlf.txt', 3)).toEqual({ basis: null })

    await seed(root, '/bin.txt', '\0binary')
    const bin = await (await fileOf(root, '/bin.txt')).getFile()
    // A binary prior still yields a digest for the stale guard; only the basis is declined.
    expect(await readPriorSnapshot(bin, '/bin.txt', 10)).toEqual({
      basis: null,
      digest: contentDigest(new TextEncoder().encode('\0binary')),
    })

    await seed(root, '/bad.txt', 'ok')
    await writeBytes(root, '/bad.txt', [0xff])
    const bad = await (await fileOf(root, '/bad.txt')).getFile()
    expect(await readPriorSnapshot(bad, '/bad.txt', 10)).toEqual({
      basis: null,
      digest: contentDigest(new Uint8Array([0xff])),
    })
  })

  it('reports pre-abort cancellation for the basis read', async () => {
    const root = fakeRoot()
    await seed(root, '/crlf.txt', 'a\r\nb')
    const text = await (await fileOf(root, '/crlf.txt')).getFile()
    const controller = new AbortController()
    controller.abort()
    await expectFsError(() => readPriorSnapshot(text, '/crlf.txt', 10, controller.signal), 'FS_ABORTED')
  })
})

describe('readEditSnapshot and decodeEditSnapshot', () => {
  it('materializes raw bytes with their digest, then decodes to LF content plus the detected style', async () => {
    const root = fakeRoot()
    await seed(root, '/crlf.txt', 'a\r\nb\r\nc')
    const blob = await (await fileOf(root, '/crlf.txt')).getFile()
    const snapshot = await readEditSnapshot(blob)
    expect(snapshot.digest).toBe(contentDigest(new TextEncoder().encode('a\r\nb\r\nc')))
    expect(decodeEditSnapshot(snapshot.bytes, '/crlf.txt')).toEqual({ content: 'a\nb\nc', lineEndings: 'CRLF' })
  })

  it('rejects whole-buffer binaries on decode and pre-abort on materialize', async () => {
    const root = fakeRoot()
    await seed(root, '/bin.bin', `clean${'x'.repeat(8192)}\0tail`)
    const blob = await (await fileOf(root, '/bin.bin')).getFile()
    const snapshot = await readEditSnapshot(blob)
    expect(() => decodeEditSnapshot(snapshot.bytes, '/bin.bin')).toThrow(FsError)

    const controller = new AbortController()
    controller.abort()
    await expectFsError(() => readEditSnapshot(blob, controller.signal), 'FS_ABORTED')
  })
})

describe('version tokens', () => {
  it('contentDigest matches FNV-1a 32-bit reference vectors', () => {
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
    expect(contentDigest(new Uint8Array())).toBe('811c9dc5')
    expect(contentDigest(encode('a'))).toBe('e40c292c')
    expect(contentDigest(encode('abc'))).toBe('1a47e90b')
    expect(contentDigest(encode('foobar'))).toBe('bf9cf968')
    expect(contentDigest(encode('你好'))).toBe(contentDigest(encode('你好')))
  })

  it('versionToken omits the digest slot for read-side tokens and round-trips through parse', () => {
    expect(versionToken(1, 2, 3)).toBe('1:2:3')
    expect(versionToken(1, 2, 3, 'deadbeef')).toBe('1:2:3:deadbeef')
    expect(parseVersionToken(versionToken(1, 2, 3))).toEqual({ revision: 1, size: 2, lastModified: 3 })
    expect(parseVersionToken(versionToken(1, 2, 3, 'deadbeef'))).toEqual({
      revision: 1,
      size: 2,
      lastModified: 3,
      digest: 'deadbeef',
    })
    // Directory tokens and other foreign spellings never parse.
    expect(parseVersionToken(FsVersion('dir:/a'))).toBeNull()
    expect(parseVersionToken(FsVersion(''))).toBeNull()
    expect(parseVersionToken(FsVersion('x:2:3'))).toBeNull()
  })

  it('versionMatches compares metadata always and digests only when both sides carry one', () => {
    const current = { revision: 1, size: 2, lastModified: 3, digest: 'aaaa0000' }
    expect(versionMatches(versionToken(1, 2, 3, 'aaaa0000'), current)).toBe(true)
    // A digest mismatch means the content was rewritten under the guard.
    expect(versionMatches(versionToken(1, 2, 3, 'bbbb0000'), current)).toBe(false)
    // Metadata always decides first.
    expect(versionMatches(versionToken(9, 2, 3, 'aaaa0000'), current)).toBe(false)
    // A read-side token (no digest) verifies metadata only; a snapshot without a
    // digest (content not read) cannot check the digest either.
    expect(versionMatches(versionToken(1, 2, 3), current)).toBe(true)
    const digestless = { revision: 1, size: 2, lastModified: 3 }
    expect(versionMatches(versionToken(1, 2, 3, 'bbbb0000'), digestless)).toBe(true)
    // Foreign tokens never match.
    expect(versionMatches(FsVersion('dir:/a'), current)).toBe(false)
  })
})

describe('utf8ByteLength', () => {
  it('counts ASCII, CJK, and astral-plane bytes', () => {
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('你好')).toBe(6)
    expect(utf8ByteLength('😀')).toBe(4)
    expect(utf8ByteLength('')).toBe(0)
  })
})

describe('applyLiteralEdit', () => {
  it('replaces exactly one match', () => {
    expect(applyLiteralEdit('a\nb\nc', 'b', 'x', false, '/f')).toEqual({ content: 'a\nx\nc', replacements: 1 })
  })

  it('rejects empty needles, missing needles, and ambiguous matches', () => {
    expect(() => applyLiteralEdit('abc', '', 'x', false, '/f')).toThrow(FsError)
    expect(() => applyLiteralEdit('abc', 'zz', 'x', false, '/f')).toThrow(FsError)
    expect(() => applyLiteralEdit('abcb', 'b', 'x', false, '/f')).toThrow(FsError)
    expect(applyLiteralEdit('abcb', 'b', 'x', true, '/f').content).toBe('axcx')
  })

  it('reports the specific edit codes', async () => {
    await expectFsError(async () => applyLiteralEdit('abc', 'zz', 'x', false, '/f'), 'FS_EDIT_NOT_FOUND')
    await expectFsError(async () => applyLiteralEdit('abcb', 'b', 'x', false, '/f'), 'FS_AMBIGUOUS_EDIT')
  })

  it('normalizes CRLF inside the needle before matching', () => {
    expect(applyLiteralEdit('a\nb', 'a\r\nb', 'x', false, '/f').content).toBe('x')
  })
})
