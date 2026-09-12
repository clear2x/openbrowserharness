/**
 * Browser capability seam.
 *
 * Mirrors the seam/provider/consumer split of the `web/` capability family:
 * this package owns only the service surface (`ctx.browser`) and the wire
 * types every implementation agrees on. Concrete providers (e.g. the Chrome
 * extension CDP provider inside apps/extension) register here; model-facing
 * tools (dsh-tool-browser) consume the seam and never import a provider.
 *
 * @module @deepseek-ai/dsh-browser
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

// ─────────────────────────── wire types ───────────────────────────

// ─────────────────────────── wire types ───────────────────────────

/** One viewport coordinate in CSS pixels. */
export interface Point {
  x: number
  y: number
}

/** One element bounding box in viewport CSS pixels. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** One interactive element of a page snapshot (viewport CSS coordinates). */
export interface PageElementInfo {
  /** Stable index within the snapshot; models may reference elements by it. */
  index: number
  tag: string
  /**
   * Best-effort CSS selector addressable from the top document. Elements
   * inside open shadow roots or same-origin iframes cannot be reached by a
   * top-level querySelector: there the selector is the empty string and
   * callers must use `center` (position click) instead.
   */
  selector: string
  /** Truncated visible text (≤80 chars). */
  text: string
  role?: string
  ariaLabel?: string
  placeholder?: string
  href?: string
  rect: Rect
  center: Point
  interactive: boolean
  /** Element lives inside an open shadow root (selector not addressable). */
  inShadowDom?: boolean
  /** Element lives inside a same-origin iframe (center already mapped to the top viewport). */
  inIframe?: boolean
}

/** One full page snapshot: URL, title, viewport geometry, and every collected element. */
export interface PageSnapshot {
  tabId: number
  url: string
  title: string
  timestamp: number
  viewport: { width: number; height: number; scrollX: number; scrollY: number }
  elements: PageElementInfo[]
}

/** One open tab as reported by the tabs_* tools. */
export interface TabInfo {
  tabId: number
  title: string
  url: string
  active: boolean
  windowId: number
  index: number
}

/** One captured page screenshot: encoded image bytes plus their true raster facts. */
export interface PageScreenshot {
  /** Encoded image bytes in the declared `mediaType`. */
  data: Uint8Array
  mediaType: 'image/png'
  width: number
  height: number
}

// ─────────────────────────── provider contract ───────────────────────────

/**
 * Environment-backed implementation of browser capabilities. Methods throw
 * `Error` with human-readable messages on failure; structured data comes
 * back as return values. All coordinates are viewport CSS pixels.
 */
export interface BrowserProvider {
  readonly id: string

  tabs(): Promise<TabInfo[]>
  switchTab(tabId: number): Promise<void>
  openTab(url: string, opts?: { active?: boolean }): Promise<TabInfo>
  closeTab(tabId: number): Promise<void>

  navigate(tabId: number, url: string): Promise<void>
  /**
   * Step back one entry in the tab's session history.
   * @returns whether a previous entry existed (false = already at the oldest).
   */
  goBack(tabId: number): Promise<boolean>
  /**
   * Step forward one entry in the tab's session history.
   * @returns whether a next entry existed (false = already at the newest).
   */
  goForward(tabId: number): Promise<boolean>
  snapshot(tabId: number): Promise<PageSnapshot>
  /**
   * Capture the page as a PNG: the visible viewport by default, the whole
   * laid-out page with `fullPage`. Read-only — it never changes page state.
   */
  screenshot(tabId: number, opts?: { fullPage?: boolean }): Promise<PageScreenshot>
  /** Click a selector-addressable element with humanized motion. */
  clickSelector(tabId: number, selector: string): Promise<void>
  /** Click viewport coordinates with humanized motion. */
  clickPoint(tabId: number, point: Point): Promise<void>
  typeText(
    tabId: number,
    selector: string,
    text: string,
    opts?: { submit?: boolean }
  ): Promise<void>
  pressKey(tabId: number, key: string): Promise<void>
  scroll(tabId: number, direction: 'up' | 'down', amountPx?: number): Promise<void>
  waitFor(tabId: number, selector: string, timeoutMs?: number): Promise<void>
  evaluate<T = unknown>(tabId: number, expression: string): Promise<T>
}

// ─────────────────────────── service surface ───────────────────────────

/** The seam's public service contract (`ctx.browser`). */
export interface BrowserRuntime extends Service {
  /** Currently active provider; throws when none is registered. */
  readonly provider: BrowserProvider
  /**
   * Currently registered provider ids, in registration order. Diagnostic and
   * invariant surface only — execution always goes through {@link provider}.
   */
  readonly providerIds: readonly string[]
  /**
   * Register a browser provider under the seam's provider ids.
   * @param provider - the provider implementation to mount.
   * @returns a disposer that unregisters it; unregistering emits
   *   {@link 'browser/provider-updated'}.
   */
  register(provider: BrowserProvider): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserRuntime
  }
  interface Events {
    /**
     * Emitted after every provider-set change (registration or effect-scoped
     * unregistration) with the resulting provider ids in registration order.
     * @mode emit
     * @param providerIds - provider ids in registration order after the change.
     */
    'browser/provider-updated'(providerIds: readonly string[]): void
  }
}

/**
 * Config for the browser seam. `defaultProviderId` pins which provider wins
 * when several are registered; omitted means auto-select when exactly one is
 * registered (the current single-provider stage never needs it).
 */
export interface BrowserRuntimeConfig {
  /** Explicit provider id. Omitted = require exactly one registered provider. */
  readonly defaultProviderId?: string
}

/**
 * The browser capability service (`ctx.browser`). Load as a plugin; providers
 * register through {@link BrowserRuntimeService.register} and consumers read
 * {@link BrowserRuntimeService.provider} at execution time.
 *
 * Provider resolution (at `provider` access time, never order-dependent):
 * - A configured id that is registered → that provider.
 * - A configured id not registered → 中文配置错误.
 * - No id configured, exactly one registered provider → that provider.
 * - No id configured, none registered → 中文可用性错误.
 * - No id configured, several registered providers → 中文歧义错误 (pick one via
 *   `defaultProviderId`).
 */
export class BrowserRuntimeService extends Service implements BrowserRuntime {
  /**
   * Provider selection config. `defaultProviderId` is optional: the current
   * stage ships one provider per composition, so the id routing stays a
   * skeleton until a second provider exists.
   */
  static Config: z<BrowserRuntimeConfig> = z.object({
    defaultProviderId: z.string().description('Explicit browser provider id; omitted auto-selects the single registered provider.'),
  })

  private providers = new Map<string, BrowserProvider>()
  private readonly defaultProviderId: string | undefined

  constructor(ctx: Context, config: BrowserRuntimeConfig = {}) {
    super(ctx, 'browser')
    this.defaultProviderId = config.defaultProviderId
  }

  /** Ids of every registered provider, in registration order. */
  get providerIds(): readonly string[] {
    return [...this.providers.keys()]
  }

  /**
   * Register a browser provider. Throws on a duplicate id, a blank/malformed
   * id, or a provider missing required function members. Returns a disposer;
   * disposed with the calling fiber. Each change emits
   * `browser/provider-updated`.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  register(provider: BrowserProvider): () => void {
    if (typeof provider !== 'object' || provider === null) {
      throw new Error('browser.register：provider 必须是一个对象')
    }
    if (typeof provider.id !== 'string' || provider.id.trim() !== provider.id || provider.id.length === 0 || /\s/.test(provider.id)) {
      throw new Error(`browser.register：provider.id 必须是无空白字符的非空字符串（收到 ${JSON.stringify(provider.id)}）`)
    }
    for (const method of PROVIDER_METHODS) {
      if (typeof (provider as unknown as Record<string, unknown>)[method] !== 'function') {
        throw new Error(`browser.register：provider "${provider.id}" 缺少必需的方法 ${method}()`)
      }
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`browser.register：id 为 "${provider.id}" 的浏览器 provider 已注册`)
    }
    const providers = this.providers
    const ctx = this.ctx
    const dispose = ctx.effect(function* () {
      providers.set(provider.id, provider)
      ctx.emit('browser/provider-updated', [...providers.keys()])
      yield () => {
        providers.delete(provider.id)
        ctx.emit('browser/provider-updated', [...providers.keys()])
      }
    }, 'browser.register()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /** The resolved provider; throws a 中文 error when resolution fails. */
  get provider(): BrowserProvider {
    const configured = this.defaultProviderId
    if (configured !== undefined) {
      const provider = this.providers.get(configured)
      if (provider === undefined) {
        throw new Error(`browser：配置的 defaultProviderId "${configured}" 未注册（当前已注册：${this.describeRegistered()}）`)
      }
      return provider
    }
    const [single] = this.providers.values()
    if (single === undefined) {
      throw new Error('browser：尚未注册任何浏览器 provider，无法执行浏览器操作')
    }
    if (this.providers.size > 1) {
      throw new Error(`browser：注册了多个浏览器 provider（${[...this.providers.keys()].join('、')}），请在配置中指定 defaultProviderId`)
    }
    return single
  }

  /** Human-readable registry state for error context. */
  private describeRegistered(): string {
    return this.providers.size === 0 ? '无' : [...this.providers.keys()].join('、')
  }
}

/** Instance members every provider must expose as functions. */
const PROVIDER_METHODS = [
  'tabs', 'switchTab', 'openTab', 'closeTab',
  'navigate', 'goBack', 'goForward', 'snapshot', 'screenshot', 'clickSelector', 'clickPoint', 'typeText',
  'pressKey', 'scroll', 'waitFor', 'evaluate',
] as const

export default BrowserRuntimeService
