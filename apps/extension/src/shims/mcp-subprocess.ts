/**
 * Browser stub for the subprocess seam's scrubbed parent env: only the MCP
 * stdio transport (already stubbed out) consumed it, so the browser build
 * carries an empty-env stand-in that keeps the transport factory's signature
 * without pulling node:child_process into the offscreen bundle.
 */

/** The extension has no parent process environment to scrub. */
export function scrubbedParentEnv(): Record<string, string> {
  return {}
}
