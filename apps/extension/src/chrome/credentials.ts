/**
 * `chrome-credentials`: the CredentialProvider service over
 * chrome.storage.local for the extension host.
 *
 * One writable source layer ('chrome-storage') holding the raw string keyed by
 * the CredentialRef itself (`DEEPSEEK_API_KEY`). The seam-wide rule holds: an
 * empty stored value is absent everywhere — `resolve` skips it and `describe`
 * reports it unconfigured — so a blank never masquerades as a configured
 * secret. set/unset fan out `credentials/updated` after the write commits.
 */

// Imported through the package's `./src/*` export subpath rather than its
// root name: the repo's tsconfig paths remap the root specifier to workspace
// SOURCE (pulling files outside this project's rootDir into the program),
// while the subpath resolves through node_modules with a package id — the
// same precedent as the DeepSeek adapter import in ./llm.ts. Runtime
// resolution (vite) follows the identical exports entry.
import CredentialProvider, { credentialRef } from '@deepseek-ai/dsh-credentials/src/index.ts'
import type { CredentialRef, CredentialInfo, ResolvedCredential } from '@deepseek-ai/dsh-credentials/src/index.ts'
import { readStorageString, writeStorageString } from './settings-store'

const SOURCE = 'chrome-storage'

/** The single credential reference this host manages. */
export const DEEPSEEK_API_KEY_REF: CredentialRef = credentialRef('DEEPSEEK_API_KEY')

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
}

export default ChromeCredentialProvider
