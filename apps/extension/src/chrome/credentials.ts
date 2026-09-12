/**
 * `chrome-credentials`: the CredentialProvider service over
 * chrome.storage.local for the extension host.
 *
 * Two key spaces: one writable reference layer ('chrome-storage') holding the
 * raw string keyed by the CredentialRef itself (`DEEPSEEK_API_KEY`), and a
 * JSON record layer for plugin-held credentials under a `record:` prefix. The
 * seam-wide rule holds: an empty stored value is absent everywhere — `resolve`
 * skips it and `describe` reports it unconfigured — so a blank never
 * masquerades as a configured secret. set/unset fan out
 * `credentials/reference-updated` after the write commits.
 */

// Imported through the package's `./src/*` export subpath rather than its
// root name: the repo's tsconfig paths remap the root specifier to workspace
// SOURCE (pulling files outside this project's rootDir into the program),
// while the subpath resolves through node_modules with a package id — the
// same precedent as the DeepSeek adapter import in ./llm.ts. Runtime
// resolution (vite) follows the identical exports entry.
import CredentialProvider, { credentialRef } from '@deepseek-ai/dsh-credentials/src/index.ts'
import type {
  CredentialRef,
  CredentialInfo,
  ResolvedCredential,
  CredentialKey,
  CredentialRecord,
  CredentialRecordInfo,
  CredentialRecordEntry,
} from '@deepseek-ai/dsh-credentials/src/index.ts'
import { readStorageString, writeStorageString } from './settings-store'
import { storageGet } from './storage-client'

const SOURCE = 'chrome-storage'
const RECORD_PREFIX = 'record:'

/** The single credential reference this host manages. */
export const DEEPSEEK_API_KEY_REF: CredentialRef = credentialRef('DEEPSEEK_API_KEY')

const readRecord = async (key: CredentialKey): Promise<CredentialRecord | undefined> => {
  const raw = await readStorageString(RECORD_PREFIX + key)
  if (raw.length === 0) return undefined
  return JSON.parse(raw) as CredentialRecord
}

export class ChromeCredentialProvider extends CredentialProvider {
  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = await readStorageString(ref)
    if (value.length === 0) return undefined
    return { value, source: SOURCE }
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const value = await readStorageString(ref)
    return {
      configured: value.length > 0,
      ...(value.length > 0 ? { source: SOURCE } : {}),
      writable: true,
    }
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      throw new Error(`credentials：拒绝写入空值（清除请用 unset），引用 "${ref}"`)
    }
    await writeStorageString(ref, value)
    this.notifyUpdated(ref)
  }

  override async unset(ref: CredentialRef): Promise<void> {
    await writeStorageString(ref, '')
    this.notifyUpdated(ref)
  }

  override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return readRecord(key)
  }

  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = await readRecord(key)
    return record === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: record.kind, writable: true }
  }

  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    const all = await storageGet(null)
    const entries: CredentialRecordEntry[] = []
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(RECORD_PREFIX) || typeof value !== 'string' || value === '') continue
      const record = JSON.parse(value) as CredentialRecord
      entries.push({ key: key.slice(RECORD_PREFIX.length) as CredentialKey, kind: record.kind })
    }
    return entries
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(await readRecord(key))
    if (next === undefined) return readRecord(key)
    await writeStorageString(RECORD_PREFIX + key, JSON.stringify(next))
    this.notifyRecordUpdated(key)
    return next
  }

  override async deleteRecord(key: CredentialKey): Promise<void> {
    const record = await readRecord(key)
    if (record === undefined) return
    await writeStorageString(RECORD_PREFIX + key, '')
    this.notifyRecordUpdated(key)
  }
}

export default ChromeCredentialProvider
