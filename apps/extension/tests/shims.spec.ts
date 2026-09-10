/**
 * Shim guarantees: the synchronous SHA-256 matches Node's crypto for the
 * inputs the closure feeds it (skill catalogs, MCP tool names), including
 * multi-byte CJK text; the path shims implement the Node semantics the fs
 * tool suite consumes; the fs stub fails loud.
 */

import { createHash } from 'node:crypto'
import { extname as nodeExtname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHash as shimCreateHash } from '../src/shims/crypto.ts'
import { Buffer as ShimBuffer } from '../src/shims/buffer.ts'
import { extname as shimExtname } from '../src/shims/path.ts'
import { realpathSync as shimRealpathSync } from '../src/shims/fs.ts'

describe('crypto shim createHash(sha256)', () => {
  const cases = ['', 'abc', 'hello world', '你好，世界', JSON.stringify({ a: 1, list: ['x', 'y'] }), 'a'.repeat(1000)]

  for (const input of cases) {
    it(`matches node:crypto for ${JSON.stringify(input.slice(0, 24))}`, () => {
      expect(shimCreateHash('sha256').update(input).digest('hex'))
        .toBe(createHash('sha256').update(input).digest('hex'))
    })
  }

  it('rejects other algorithms and encodings loudly', () => {
    expect(() => shimCreateHash('md5')).toThrow()
    expect(() => shimCreateHash('sha256').update('x').digest('base64')).toThrow()
  })
})

describe('buffer shim', () => {
  it('byteLength counts UTF-8 bytes like Node', () => {
    expect(ShimBuffer.byteLength('abc')).toBe(3)
    expect(ShimBuffer.byteLength('你好')).toBe(6)
    expect(ShimBuffer.byteLength(new Uint8Array([1, 2, 3]))).toBe(3)
  })
})

describe('path shim extname', () => {
  const cases: Array<[string, string]> = [
    ['index.js', '.js'],
    ['archive.tar.gz', '.gz'],
    ['/dir.with.dots/file', ''],
    ['.hidden', ''],
    ['README', ''],
    ['a.PNG', '.PNG'],
  ]

  for (const [input, expected] of cases) {
    it(`extname(${JSON.stringify(input)}) matches node:path`, () => {
      expect(shimExtname(input)).toBe(expected)
      expect(shimExtname(input)).toBe(nodeExtname(input))
    })
  }
})

describe('fs shim realpathSync', () => {
  it('fails loud instead of silently no-oping', () => {
    expect(() => shimRealpathSync('/workspace')).toThrow('node:fs')
    expect(() => shimRealpathSync.native('/workspace')).toThrow('node:fs')
  })
})
