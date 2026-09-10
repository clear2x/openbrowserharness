/**
 * Shared model-facing `file_path` shape check for the write/edit tools. The
 * schema DSL only expresses "string", so a malformed generation — a prose
 * fragment or another call's tokens spliced into the value (observed in the
 * wild as `/workspace/selftest-report-bwrite id=<subagent-uuid>`) — reached
 * the fs backend and materialized a stray file. This validator stops such
 * values before any path resolution.
 * @module @deepseek-ai/dsh-tool-fs/src/validate-path
 */

/**
 * Reject `file_path` values a path resolver should never receive: blank
 * strings, raw whitespace anywhere in the value (the telltale signature of a
 * spliced argument — target paths in this surface are workspace-relative
 * identifiers that never carry spaces), and control characters.
 * @param filePath - the raw `file_path` argument after schema validation.
 * @throws with a model-facing remedy when the value cannot be a real path.
 */
export function assertWritablePath(filePath: string): void {
  if (filePath.trim().length === 0) {
    throw new Error('file_path must be a non-empty string')
  }
  if (/\s/.test(filePath)) {
    throw new Error(
      `file_path "${filePath}" contains whitespace, so it is not a usable path — the value looks spliced. `
      + 'Re-send the call with file_path set to the plain target path only (no spaces, no extra tokens).',
    )
  }
  if (/[\u0000-\u001f\u007f]/.test(filePath)) {
    throw new Error('file_path contains control characters and cannot be used as a path')
  }
}
