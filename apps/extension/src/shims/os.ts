/** Browser shim for node:os — the homedir probe surface and the account
 * Host's analytics-only device identity. */

export function homedir(): string {
  return '/'
}

export function tmpdir(): string {
  return '/tmp'
}

export const EOL = '\n'

export function platform(): string {
  return 'browser'
}

/** Analytics-only device identity for the account Host (`device_model`). */
export function arch(): string {
  return 'unknown'
}

/** Analytics-only OS identity for the account Host (`os_version`). */
export function release(): string {
  return 'unknown'
}

// The vendored loader's built lib may import the namespace default; mirror
// the named members as one object.
const osShim = {
  homedir,
  tmpdir,
  EOL,
  platform,
  arch,
  release,
}

export default osShim
