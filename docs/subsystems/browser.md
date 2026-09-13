# Browser capability

English | [中文](browser.zh.md)

The browser capability seam of [packages/browser/browser](../../packages/browser/browser/src/index.ts) is this fork's addition to the harness: a `ctx.browser` service that drives a real Chrome/Edge tab — open, switch, close, navigate, snapshot, screenshot, humanized clicks and typing, key presses, scrolling, waits, and in-page evaluation. The [extension host](../../apps/extension/README.md) mounts it and supplies the provider; the `page_*` and `tabs_*` model tools are thin wrappers over these operations.

Source: [`packages/browser/browser/src/index.ts`](../../packages/browser/browser/src/index.ts)

## Service surface (`ctx.browser`)

The seam is a provider registry plus a typed operation facade. `provider` returns the active implementation; `providerIds` is a registration-order diagnostic; `register(provider)` mounts one and returns its disposer. Every provider-set change emits the `browser/provider-updated` event.

```ts type-equiv
/** The seam's public service contract (`ctx.browser`). */
interface BrowserRuntime extends Service {
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
```

## Operations

All operations address a tab id first: `switchTab`/`openTab`/`closeTab` manage tabs, `navigate` loads a URL, and the page operations — `snapshot`, `screenshot`, `clickSelector`, `clickPoint`, `typeText`, `pressKey`, `scroll`, `waitFor`, `evaluate` — run against the given tab. `snapshot` pierces Shadow DOM and same-process iframes; `screenshot` captures the viewport by default or the whole laid-out page with `fullPage`; `evaluate` returns the JSON-serialized value of an in-page expression.

## Providers

The extension host supplies one provider implemented over the Chrome DevTools Protocol (`chrome.debugger`) with humanized input: Bezier mouse trajectories, per-keystroke typing, and inertial scrolling. Tests run the seam against a scripted driver implementing the same interface — the seam is deliberately free of CDP types.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowser--browserruntime"></a>

### `ctx.browser` — `BrowserRuntime`

The seam's public service contract (`ctx.browser`).

```ts cordis-catalog
/**
 * Register a browser provider under the seam's provider ids.
 * @param provider - the provider implementation to mount.
 * @returns a disposer that unregisters it; unregistering emits
 *   {@link 'browser/provider-updated'}.
 */
register(provider: BrowserProvider): () => void
```

Source: [`packages/browser/browser/src/index.ts`](../../packages/browser/browser/src/index.ts)

<a id="browser-events"></a>

### `browser/*` events

<a id="browserprovider-updated--emit"></a>

#### `browser/provider-updated` — emit

Emitted after every provider-set change (registration or effect-scoped unregistration) with the resulting provider ids in registration order.

```ts cordis-catalog
/**
 * Emitted after every provider-set change (registration or effect-scoped
 * unregistration) with the resulting provider ids in registration order.
 * @mode emit
 * @param providerIds - provider ids in registration order after the change.
 */
'browser/provider-updated'(providerIds: readonly string[]): void
```

Source: [`packages/browser/browser/src/index.ts`](../../packages/browser/browser/src/index.ts)
<!-- END GENERATED cordis-surface -->
