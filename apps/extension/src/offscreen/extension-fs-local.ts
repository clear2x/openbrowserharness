/**
 * `extension-fs-local`: the engine-side half of the local-folder workspace.
 * Wraps the mounted OPFS filesystem's root-handle getter with a SYNTHETIC
 * routing root: the real OPFS root is exposed as-is, plus one virtual child
 * directory `local/` that resolves to the user-picked local folder handle
 * (persisted by the visible page through `shared/dir-handles.ts`). Every
 * `ctx.fs` consumer — glob/grep, working_directory cd, read/write/edit —
 * reaches the local folder through ordinary `/local/...` paths with ZERO
 * per-tool changes, because `OpfsFileSystem`'s methods all traverse
 * `this.root()` and this module is the only thing that changed.
 *
 * Permission plane: the offscreen document has no user gesture, so a handle
 * whose `readwrite` permission degraded to `prompt` (browser restart) can
 * never be re-acquired here. The `local/` branch therefore collapses to an
 * EMPTY, write-refusing placeholder directory whenever the handle is absent
 * or un-granted, failing operations with `FS_PERMISSION_DENIED` and a
 * re-authorization pointer (the rail's button performs the actual grant).
 * The rest of the tree is untouched — a `listDir('/')` never breaks.
 *
 * @module extension-fs-local
 */
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { OpfsDirectoryHandle, OpfsFileHandle, OpfsHandle } from '@deepseek-ai/dsh-fs-opfs/src/opfs.ts'
import { readActiveWorkspace } from '../shared/dir-handles.ts'

/** The module id this file registers under (see the offscreen composition). */
export const name = 'extension-fs-local'

/** The mounted OPFS provider this module decorates. */
export const inject: readonly string[] = ['fs']

/** The virtual child directory name under the synthetic root. */
export const LOCAL_DIR = 'local'

/** Why the `local/` branch is a placeholder (drives the refusal message). */
type PlaceholderReason = 'not-picked' | 'needs-regrant'

/**
 * An empty, read-only placeholder directory standing in for `local/` while
 * no usable local folder is mounted. Direct children "do not exist"; any
 * create fails with `FS_PERMISSION_DENIED` and a pointer at the re-authorization
 * flow — so `cd /local` succeeds, `ls /local` is empty, and a write refuses
 * with an actionable message instead of breaking the whole tree.
 */
class PlaceholderLocalDirectory implements OpfsDirectoryHandle {
  readonly kind = 'directory' as const
  readonly name = LOCAL_DIR

  constructor(private readonly reason: PlaceholderReason) {}

  private refusal(): FsError {
    const message = this.reason === 'not-picked'
      ? '尚未选择本地文件夹——在工作台左栏「工作区」选择后即可读写 /local/'
      : '本地文件夹需要重新授权——在工作台左栏「工作区」点击「重新授权」'
    return new FsError(message, 'FS_PERMISSION_DENIED')
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle> {
    if (options?.create === true) throw this.refusal()
    // A non-creating lookup of a child inside an empty placeholder: not found.
    throw new FsError(`cannot open "${name}" under /local: 本地文件夹未挂载`, 'FS_NOT_FOUND')
  }

  async getFileHandle(name: string): Promise<OpfsFileHandle> {
    // A read of any child: plain not-found (reads must not require the grant).
    throw new FsError(`cannot open "${name}" under /local: 本地文件夹未挂载`, 'FS_NOT_FOUND')
  }

  // eslint-disable-next-line require-yield -- an empty async iterable by design
  async *values(): AsyncGenerator<OpfsHandle> {
    return
  }

  async removeEntry(name: string): Promise<void> {
    throw new FsError(`cannot open "${name}" under /local: 本地文件夹未挂载`, 'FS_NOT_FOUND')
  }
}

/** Structural permission query on a local handle (real DOM handles carry it). */
type PermissionQuery = (descriptor: { mode: 'readwrite' }) => Promise<'granted' | 'prompt' | 'denied'>

/** The user-picked directory handle as this module consumes it. */
type LocalHandle = OpfsDirectoryHandle & { queryPermission?: PermissionQuery }

/** Reads the persisted workspace entry (injected so specs run on fakes). */
type WorkspaceReader = () => Promise<{ name: string; handle: LocalHandle } | undefined>

/** The runtime reader: the shared IDB store, degraded on any outage. Reads
    the ACTIVE session's folder (the shell repoints the pointer on session
    switches), falling back to the pre-session-scoped global entry. */
const defaultReadWorkspace: WorkspaceReader = async () => {
  const stored = await readActiveWorkspace().catch(() => undefined)
  if (stored === undefined) return undefined
  return { name: stored.name, handle: stored.handle as LocalHandle }
}

/**
 * Resolve the user's local directory handle, or the reason it is unusable.
 * @returns the granted directory handle, or a placeholder reason.
 */
type LocalHandleResolution = { handle: OpfsDirectoryHandle } | { placeholder: PlaceholderReason }

async function resolveLocalHandle(readWorkspace: WorkspaceReader): Promise<LocalHandleResolution> {
  const stored = await readWorkspace().catch(() => undefined)
  if (stored === undefined) return { placeholder: 'not-picked' }
  const state = await stored.handle.queryPermission?.call(stored.handle, { mode: 'readwrite' })
  if (state !== 'granted') return { placeholder: 'needs-regrant' }
  return { handle: stored.handle }
}

/**
 * Wrap the base root getter: the returned root delegates everything to the
 * real OPFS root and additionally serves the virtual `local/` child. The
 * workspace reader is injectable — specs run against in-memory fakes for
 * both sources.
 * @param base - the getter being decorated (the OPFS root probe).
 * @param readWorkspace - the persisted-handle reader (defaults to the shared IDB store).
 * @returns the decorated root-handle getter.
 */
export function makeLocalAwareRoot(
  base: () => Promise<OpfsDirectoryHandle>,
  readWorkspace: WorkspaceReader = defaultReadWorkspace,
): () => Promise<OpfsDirectoryHandle> {
  let synthetic: OpfsDirectoryHandle | undefined
  return async (): Promise<OpfsDirectoryHandle> => {
    if (synthetic !== undefined) return synthetic
    synthetic = {
      kind: 'directory',
      name: '__obh-routing-root__',
      async getDirectoryHandle(child: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle> {
        if (child === LOCAL_DIR) {
          const resolved = await resolveLocalHandle(readWorkspace)
          if ('handle' in resolved) return resolved.handle
          return new PlaceholderLocalDirectory(resolved.placeholder)
        }
        const root = await base()
        return root.getDirectoryHandle(child, options)
      },
      async getFileHandle(child: string, options?: { create?: boolean }): Promise<OpfsFileHandle> {
        const root = await base()
        return root.getFileHandle(child, options)
      },
      async removeEntry(child: string, options?: { recursive?: boolean }): Promise<void> {
        const root = await base()
        return root.removeEntry(child, options)
      },
      async *values(): AsyncGenerator<OpfsHandle> {
        yield { kind: 'directory', name: LOCAL_DIR }
        const root = await base()
        yield* root.values()
      },
    }
    return synthetic
  }
}

/**
 * Decorate the mounted OPFS provider with the local-aware synthetic root.
 * Runs after the fs-opfs row in the composition (inject `fs` waits for it).
 * @param ctx - engine plugin context providing `fs`.
 */
export function apply(ctx: Context): void {
  const fs = ctx.get('fs') as { root?: unknown }
  if (typeof fs?.root !== 'function') return
  fs.root = makeLocalAwareRoot(fs.root as () => Promise<OpfsDirectoryHandle>)
}
