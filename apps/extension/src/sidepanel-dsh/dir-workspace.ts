/**
 * Visible-page half of the local-folder workspace: the folder PICKER and the
 * permission re-grant. Both need a user gesture on a visible document, so
 * they live here (side panel / settings page) rather than in the engine —
 * the engine only READS the persisted handle back from IndexedDB
 * (`shared/dir-handles.ts` is the shared storage plane, same origin).
 *
 * Workspaces are SESSION-SCOPED: each session remembers its own folder under
 * `workspace:<sessionKey>` and the shell repoints the ACTIVE pointer on
 * session switches, so the engine's `/local` mount follows the selected
 * session. The fresh-session sentinel uses its own key; the shell migrates it
 * to the minted session id on first send.
 *
 * @module dir-workspace
 */
import type { DirWorkspaceEntry, LocalPermissionState } from '../shared/dir-handles.ts'
import { NEW_SESSION_ID } from './trajectory-host.tsx'
import {
  clearDirWorkspace,
  clearSessionWorkspace,
  queryLocalPermission,
  readDirWorkspace,
  readSessionWorkspace,
  requestLocalPermission,
  setActiveWorkspace,
  saveSessionWorkspace,
} from '../shared/dir-handles.ts'

/**
 * The folder a pick claimed for the fresh-session sentinel, held for the
 * mint (first send / 新建任务): {@link moveSentinelWorkspaceTo} re-persists it
 * under the minted id from this in-memory value — one write, no IndexedDB
 * read in the mint path. Lives in THIS module so the pick and the move share
 * one instance regardless of chunk layout.
 */
let pendingSentinel: DirWorkspaceEntry | undefined

/**
 * Move a sentinel-claimed pick to the minted session id. Fire-and-forget
 * safe: failures leave the entry under the sentinel key (harmless stale row).
 */
export function moveSentinelWorkspaceTo(createdSessionKey: string): void {
  const pending = pendingSentinel
  if (pending === undefined) return
  pendingSentinel = undefined
  // The sentinel row is cleared too: a leftover would hand this folder to the
  // NEXT fresh session that never picked one.
  void saveSessionWorkspace(createdSessionKey, pending)
    .then(() => clearSessionWorkspace(NEW_SESSION_ID))
    .catch(() => {})
}

/** The rail's workspace-row state: no pick yet, or a folder + its permission. */
export interface LocalWorkspaceStatus {
  entry?: DirWorkspaceEntry | undefined
  permission: LocalPermissionState | 'none'
}

/**
 * @param sessionKey - the session whose folder this row manages (the shell's
 * session id; the fresh-session sentinel key included).
 * @returns the current workspace row state (the rail re-reads after actions
 * and on session switches).
 */
export async function localWorkspaceStatus(sessionKey: string): Promise<LocalWorkspaceStatus> {
  const entry = await readSessionWorkspace(sessionKey).catch(() => undefined)
  if (entry === undefined) return { permission: 'none' }
  const permission = await queryLocalPermission(entry.handle).catch(() => 'prompt' as const)
  return { entry, permission }
}

/**
 * Open the browser directory picker and persist the picked folder for one
 * session. MUST be called from a user-gesture handler on a visible page.
 * @param sessionKey - the session that claims this folder.
 * @returns the stored entry, or null when the user cancelled.
 */
export async function pickLocalWorkspace(sessionKey: string): Promise<DirWorkspaceEntry | null> {
  const picker = (window as unknown as {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
  }).showDirectoryPicker
  if (picker === undefined) throw new Error('此浏览器不支持选择本地文件夹')
  const handle = await picker.call(window, { mode: 'readwrite' })
  const entry: DirWorkspaceEntry = { name: handle.name, handle }
  await saveSessionWorkspace(sessionKey, entry)
  // The mint path moves a sentinel pick to the minted id from this in-memory
  // stash — keyed on the SENTINEL LITERAL (trajectory-host's NEW_SESSION_ID).
  if (sessionKey === NEW_SESSION_ID) pendingSentinel = entry
  // The shell's pointer effect only fires on session switches — a pick
  // happens mid-session, so point the ACTIVE mount at this folder here.
  await setActiveWorkspace(sessionKey)
  return entry
}

/**
 * Re-grant readwrite on the session's stored handle (the rail's 重新授权
 * button). MUST be called from a user-gesture handler on a visible page.
 * @param sessionKey - the session whose handle needs the re-grant.
 * @returns the new permission state, or null when the session has no folder.
 */
export async function reauthorizeLocalWorkspace(sessionKey: string): Promise<LocalPermissionState | null> {
  const entry = await readSessionWorkspace(sessionKey).catch(() => undefined)
  if (entry === undefined) return null
  return await requestLocalPermission(entry.handle).catch(() => 'denied' as const)
}

/** Drop the session's remembered folder (that session's /local mount goes empty). */
export async function removeLocalWorkspace(sessionKey: string): Promise<void> {
  await clearSessionWorkspace(sessionKey)
  await setActiveWorkspace(undefined)
}

/**
 * One-time migration: the pre-session-scoped global folder attaches to the
 * fresh-session sentinel key (and becomes the active mount), so an existing
 * setup keeps working under the session-scoped store. Idempotent — the
 * legacy key is cleared after the move.
 */
export async function migrateLegacyWorkspace(): Promise<void> {
  const legacy = await readDirWorkspace().catch(() => undefined)
  if (legacy === undefined) return
  await saveSessionWorkspace(NEW_SESSION_ID, legacy)
  await clearDirWorkspace()
}
