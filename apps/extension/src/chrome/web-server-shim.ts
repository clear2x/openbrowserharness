/**
 * Browser stand-in for the desktop web server: the DeepSeek account host
 * (`@deepseek-ai/dsh-deepseek-account`) awaits the OAuth callback code by
 * listening on the `webserver/request` waterfall — an event the desktop's
 * api-gateway dispatches from real HTTP traffic. A browser host cannot serve
 * HTTP, so this shim provides the `webServer` service marker, listens for the
 * callback forwarded from the Service Worker (`onMessageExternal` → internal
 * broadcast), and re-dispatches it over the same waterfall with a synthetic
 * request/response pair shaped for the upstream listener (`/oauth/callback`
 * path, `code`+`state` query, capture-capable response).
 *
 * The upstream listener still owns the contract: host/path matching,
 * timing-safe state validation, and single-use enforcement run unchanged.
 * @module chrome-web-server-shim
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { OAuthCallbackForward } from '../shared/protocol'

export const name = 'chrome-web-server-shim'
/** The shim is its own service surface; no cordis injections. */
export const inject = [] as const

/** Structural request the upstream listener reads (`headers.host`, `url`, `method`). */
interface ShimRequest {
  headers: Record<string, string>
  url: string
  method: string
}

/** Structural response the upstream listener writes (`writeHead(...).end()`). */
interface ShimResponse {
  statusCode: number | undefined
  writeHead(status: number, headers?: Record<string, string>): ShimResponse
  end(body?: string): void
}

/** The waterfall event the account host listens on. Declared locally: the
 * desktop web-server package (which owns the canonical node-typed
 * declaration) is not part of the extension's type graph. */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'webserver/request'(request: ShimRequest, response: ShimResponse, next: () => Promise<void>): Promise<void>
  }
}

/** Internal forward message from the relay page (shape declared in
 * `shared/protocol.ts` alongside the loopback callback origin). */

export class WebServerShim extends Service {
  private readonly onRuntimeMessage = (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void): boolean => {
    if (message === null || typeof message !== 'object'
      || (message as { channel?: unknown }).channel !== 'oauth-callback-forward') return false
    const forward = message as Partial<OAuthCallbackForward>
    if (typeof forward.code !== 'string' || typeof forward.state !== 'string'
      || typeof forward.originHost !== 'string' || typeof forward.callbackPath !== 'string') {
      sendResponse({ ok: false, error: 'bad payload' })
      return false
    }
    // Keep the channel open until the waterfall settles so the relay page can
    // report the real dispatch outcome.
    void this.dispatch(forward.originHost, forward.callbackPath, forward.code, forward.state)
      .then((status) => { sendResponse({ ok: true, status }) })
      .catch((err: unknown) => { sendResponse({ ok: false, error: String(err) }) })
    return true
  }

  constructor(ctx: Context) {
    super(ctx, 'webServer')
    chrome.runtime.onMessage.addListener(this.onRuntimeMessage)
  }

  /**
   * Re-dispatch one OAuth callback over the `webserver/request` waterfall.
   * The synthesized request satisfies the upstream listener's checks
   * (`/oauth/callback` on the configured origin with `code`+`state` query);
   * the synthetic response captures the written status for diagnostics.
   * @param originHost - Host of the registered callback origin (the loopback
   * relay port; see `shared/protocol.ts`).
   * @param callbackPath - Path the upstream listener matches (`/oauth/callback`).
   */
  async dispatch(originHost: string, callbackPath: string, code: string, state: string): Promise<number | undefined> {
    let capturedStatus: number | undefined
    const req: ShimRequest = {
      headers: { host: originHost },
      url: `${callbackPath}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      method: 'GET',
    }
    const res: ShimResponse = {
      statusCode: undefined,
      writeHead(status: number) {
        this.statusCode = status
        capturedStatus = status
        return this
      },
      end(): void {
        // Nothing to stream: the shim response is a capture object.
      },
    }
    const fallback = (): Promise<void> => {
      // No other webserver listeners exist in this composition.
      if (capturedStatus === undefined) capturedStatus = 404
      return Promise.resolve()
    }
    await this.ctx.waterfall('webserver/request', req, res, fallback)
    return capturedStatus
  }

  /** Remove the internal listener (the page dies with the offscreen document anyway). */
  dispose(): void {
    chrome.runtime.onMessage.removeListener(this.onRuntimeMessage)
  }
}

/** Mount the shim: an object plugin (namespace `apply`) constructing the
 * service — the chrome-service convention (`chrome-skill-storage`). */
export interface Config {}

export function apply(ctx: Context, _config: Config): void {
  void _config
  new WebServerShim(ctx)
}
