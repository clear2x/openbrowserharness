/** Browser shim for node:os — the homedir probe surface only. */

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

// The vendored loader's built lib may import the namespace default; mirror
// the named members as one object.
const osShim = {
  homedir,
  tmpdir,
  EOL,
  platform,
}

export default osShim
