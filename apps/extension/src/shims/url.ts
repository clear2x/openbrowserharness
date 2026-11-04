/**
 * Browser shim for node:url — the vendored loader's built lib imports the
 * namespace default for `fileURLToPath`/`pathToFileURL`; the extension bundle
 * never resolves real file URLs, so both directions throw loudly.
 */

function unavailable(name: string): never {
  throw new Error(`node:url ${name}() is not available in the extension bundle`)
}

export function fileURLToPath(url: unknown): string {
  void url
  return unavailable('fileURLToPath')
}

export function pathToFileURL(path: unknown): URL {
  void path
  return unavailable('pathToFileURL')
}

const urlShim = {
  fileURLToPath,
  pathToFileURL,
}

export default urlShim
