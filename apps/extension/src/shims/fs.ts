/**
 * Browser shim for node:fs — a loud throw stub. The mounted closure's reaches
 * are dsh-subagent's out-of-process re-export surface (accessSync/statSync/
 * constants) and dsh-sandbox's root canonicalization (realpathSync, only
 * called when a confining sandbox policy resolves — never in this composition);
 * any accidental call fails with a clear message instead of silently no-oping.
 */

function unavailable(name: string): never {
  throw new Error(`node:fs ${name}() is not available in the extension bundle`)
}

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 } as const

export function accessSync(path: string, mode?: number): never {
  void path
  void mode
  unavailable('accessSync')
}

export function statSync(path: string): never {
  void path
  unavailable('statSync')
}

export function readFileSync(path: string): never {
  void path
  unavailable('readFileSync')
}

export function existsSync(path: string): boolean {
  void path
  return false
}

export function mkdirSync(path: string): never {
  void path
  unavailable('mkdirSync')
}

export function writeFileSync(path: string, data: unknown): never {
  void path
  void data
  unavailable('writeFileSync')
}

export function appendFileSync(path: string, data: unknown): never {
  void path
  void data
  unavailable('appendFileSync')
}

/** `realpathSync` shape with the `.native` twin dsh-sandbox's canonicalPath resolves through. */
interface RealpathSync {
  (path: string): never
  native(path: string): never
}

export const realpathSync = Object.assign(
  function realpathSync(path: string): never {
    void path
    return unavailable('realpathSync')
  },
  {
    native(path: string): never {
      void path
      return unavailable('realpathSync.native')
    },
  },
) satisfies RealpathSync
