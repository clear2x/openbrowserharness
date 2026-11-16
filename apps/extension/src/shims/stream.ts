/**
 * Browser shim for node:stream — the account Host's only stream use is
 * `promises.finished(res)` over the OAuth callback response it wrote. The
 * extension's responses are capture objects written once synchronously (the
 * web-server shim), so there is nothing to await; the settle-time cleanup
 * resolves immediately.
 */

const promises = {
  finished(_stream: unknown, _options?: unknown): Promise<void> {
    void _stream
    void _options
    return Promise.resolve()
  },
}

export { promises }

const streamShim = { promises }

export default streamShim
