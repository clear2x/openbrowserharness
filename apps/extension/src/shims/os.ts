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
