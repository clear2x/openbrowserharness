/**
 * fs-opfs seam guarantees for the extension host: the browser's real DOM OPFS
 * handle types remain structurally assignable to the provider's narrow seam
 * (checked at compile time through the DOM lib this face carries), and the
 * provider's default root probe fails with the structured taxonomy — not a
 * TypeError — on a runtime without OPFS (this Node lane).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import OpfsFileSystem from '@deepseek-ai/dsh-fs-opfs'
// Extensionful import: the seam interfaces live in the package's platform module,
// resolved to source by this face's paths (the package root carries only the class).
import type { OpfsDirectoryHandle, OpfsFileHandle } from '@deepseek-ai/dsh-fs-opfs/src/opfs.ts'

/**
 * Compile-time seam compatibility: the platform root handle, a file handle,
 * and their members must keep satisfying the structural seam the provider
 * speaks. A lib.dom signature change fails `tsc -b apps/extension` right here.
 */
type DomRootSatisfiesSeam = FileSystemDirectoryHandle extends OpfsDirectoryHandle ? true : false
type DomFileSatisfiesSeam = FileSystemFileHandle extends OpfsFileHandle ? true : false

const domRootSatisfiesSeam: DomRootSatisfiesSeam = true
const domFileSatisfiesSeam: DomFileSatisfiesSeam = true

describe('fs-opfs seam compatibility', () => {
  it('keeps the DOM handle tree assignable to the provider seam', () => {
    expect(domRootSatisfiesSeam).toBe(true)
    expect(domFileSatisfiesSeam).toBe(true)
  })

  it('fails loud with the structured taxonomy when OPFS is absent (this Node lane)', async () => {
    const provider = new OpfsFileSystem(new Context(), OpfsFileSystem.Config({}))
    const resolved = await provider.resolve('/probe.txt')
    await expect(provider.stat(resolved)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await expect(provider.readText(resolved)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })
})
