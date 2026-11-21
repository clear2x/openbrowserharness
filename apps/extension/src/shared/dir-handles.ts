/**
 * Local-folder workspace handle store: the shared-side half of the browser
 * extension's local-directory bridge. The user picks a folder in a visible
 * extension page (side panel / settings page — `showDirectoryPicker` needs a
 * user gesture); the `FileSystemDirectoryHandle` is persisted in IndexedDB,
 * which the offscreen engine document shares by origin, and the engine's
 * local-aware filesystem root reads it back per operation (see
 * `offscreen/extension-fs-local.ts`).
 *
 * Chromium permission model: a handle's `readwrite` permission degrades to
 * `prompt` when the browser restarts, and `requestPermission` must run inside
 * a user gesture on a visible page — so the engine can never re-acquire it;
 * the rail's 重新授权 button does (through {@link requestLocalPermission}).
 * The storage primitives are reached through structural access so both
 * compiler faces (host and client) compile without DOM-lib coupling drift.
 *
 * @module dir-workspace
 */

/** The single workspace folder this build mounts (v1: one folder). */
export interface DirWorkspaceEntry {
  /** The picked folder's basename (display + the `local/` child identity). */
  name: string
  /** The persisted directory handle. */
  handle: FileSystemDirectoryHandle
}

const DB_NAME = 'dsh-dir-handles'
const STORE = 'handles'
/** Legacy pre-session-scoped key (one global folder). */
const KEY = 'workspace'
/** The pointer key naming the ACTIVE session's workspace (a session key). */
const ACTIVE_KEY = 'workspace-active'
/** Key prefix for one session's remembered folder: `workspace:<sessionKey>`. */
const SESSION_PREFIX = 'workspace:'

/** The permission state of one persisted handle (the DOM queryPermission shape). */
export type LocalPermissionState = 'granted' | 'denied' | 'prompt'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('dir-handles: indexedDB open failed')) }
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const request = run(tx.objectStore(STORE))
      request.onsuccess = () => { resolve(request.result as T) }
      request.onerror = () => { reject(request.error ?? new Error('dir-handles: request failed')) }
      // Close only after the transaction fully settles: closing in the same
      // task that created the transaction can abort it before the request
      // commits, leaving the wrapped promise pending forever.
      tx.oncomplete = () => { try { db.close() } catch { /* already closed */ } }
      tx.onabort = () => { try { db.close() } catch { /* already closed */ } }
    })
  } finally {
    try { db.close() } catch { /* already closed */ }
  }
}

/** Persist (or replace) the picked workspace folder handle. */
export async function saveDirWorkspace(entry: DirWorkspaceEntry): Promise<void> {
  await withStore<void>('readwrite', store => store.put(entry, KEY))
}

/** @returns the stored workspace folder, or undefined when none was picked yet. */
export async function readDirWorkspace(): Promise<DirWorkspaceEntry | undefined> {
  return withStore<DirWorkspaceEntry | undefined>('readonly', store => store.get(KEY))
}

/** Drop the stored workspace folder (and, with it, the engine's mount). */
export async function clearDirWorkspace(): Promise<void> {
  await withStore<void>('readwrite', store => store.delete(KEY))
}

/** Remember one session's folder under its own key. */
export async function saveSessionWorkspace(sessionKey: string, entry: DirWorkspaceEntry): Promise<void> {
  await withStore<void>('readwrite', store => store.put(entry, SESSION_PREFIX + sessionKey))
}

/** @returns one session's remembered folder, or undefined when it has none. */
export async function readSessionWorkspace(sessionKey: string): Promise<DirWorkspaceEntry | undefined> {
  return withStore<DirWorkspaceEntry | undefined>('readonly', store => store.get(SESSION_PREFIX + sessionKey))
}

/** Drop one session's remembered folder. */
export async function clearSessionWorkspace(sessionKey: string): Promise<void> {
  await withStore<void>('readwrite', store => store.delete(SESSION_PREFIX + sessionKey))
}

/**
 * Point the ACTIVE workspace at one session's remembered folder (the engine's
 * per-operation read resolves through this pointer). `undefined` clears the
 * pointer — the mount goes empty until a session with a folder activates.
 */
export async function setActiveWorkspace(sessionKey: string | undefined): Promise<void> {
  // Expression body: `run` must receive the request — a block body here would
  // return undefined and the wrapped promise would reject with a TypeError.
  await withStore<void>('readwrite', store =>
    sessionKey === undefined ? store.delete(ACTIVE_KEY) : store.put(sessionKey, ACTIVE_KEY),
  )
}

/**
 * @returns the ACTIVE session's folder: the pointer's session key first, the
 * legacy global key as the fallback (pre-session-scoped data keeps working),
 * else undefined.
 */
export async function readActiveWorkspace(): Promise<DirWorkspaceEntry | undefined> {
  const withPointer = await withStore<DirWorkspaceEntry | string | undefined>('readonly', store => store.get(ACTIVE_KEY))
  if (typeof withPointer === 'string') {
    return withStore<DirWorkspaceEntry | undefined>('readonly', store => store.get(SESSION_PREFIX + withPointer))
  }
  return readDirWorkspace()
}

/**
 * Query a handle's `readwrite` permission through structural access (the DOM
 * members exist on real handles; a test fake implements the same shape).
 * @returns 'granted', 'prompt' (needs a gesture re-grant), or 'denied'.
 */
export async function queryLocalPermission(handle: FileSystemDirectoryHandle): Promise<LocalPermissionState> {
  const query = (handle as {
    queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<LocalPermissionState>
  }).queryPermission
  if (query === undefined) return 'granted' // a fake handle without the member: tests opt out of the permission plane
  return await query.call(handle, { mode: 'readwrite' })
}

/**
 * Request `readwrite` on a handle. MUST run inside a user gesture on a visible
 * page (the rail's 重新授权 button click) — the engine document cannot.
 */
export async function requestLocalPermission(handle: FileSystemDirectoryHandle): Promise<LocalPermissionState> {
  const request = (handle as {
    requestPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<LocalPermissionState>
  }).requestPermission
  if (request === undefined) return 'granted'
  return await request.call(handle, { mode: 'readwrite' })
}
