/**
 * Browser shim for node:fs/promises — loud throw stubs (the mounted closure's
 * reach is util/home-paths' homedir probing via subagent's out-of-process
 * surface; the in-process spawn path never calls these).
 */

function unavailable(name: string): Promise<never> {
  return Promise.reject(new Error(`node:fs/promises ${name}() is not available in the extension bundle`))
}

export function readFile(path: unknown): Promise<never> {
  void path
  return unavailable('readFile')
}

export function writeFile(path: unknown): Promise<never> {
  void path
  return unavailable('writeFile')
}

export function stat(path: unknown): Promise<never> {
  void path
  return unavailable('stat')
}

export function access(path: unknown): Promise<never> {
  void path
  return unavailable('access')
}

export function mkdir(path: unknown): Promise<never> {
  void path
  return unavailable('mkdir')
}

export function opendir(path: unknown): Promise<never> {
  void path
  return unavailable('opendir')
}

export function realpath(path: unknown): Promise<never> {
  void path
  return unavailable('realpath')
}
