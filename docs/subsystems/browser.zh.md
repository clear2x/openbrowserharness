# 浏览器能力

[English](browser.md) | 中文

[packages/browser/browser](../../packages/browser/browser/src/index.ts) 的浏览器能力 seam 是本项目对 harness 的扩展：一个驱动真实 Chrome/Edge 标签页的 `ctx.browser` 服务——打开、切换、关闭、导航、快照、截图、拟人化点击与打字、按键、滚动、等待以及页内求值。[扩展宿主](../../apps/extension/README.md)挂载该服务并提供提供方；`page_*` 与 `tabs_*` 模型工具是这些操作的薄封装。

源码：[`packages/browser/browser/src/index.ts`](../../packages/browser/browser/src/index.ts)

## 服务面（`ctx.browser`）

该 seam 是提供方注册表加类型化操作门面。`provider` 返回当前实现；`providerIds` 是注册顺序的诊断视图；`register(provider)` 挂载一个提供方并返回其 disposer。提供方集合的每次变化都会发出 `browser/provider-updated` 事件。

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

## 操作

所有操作首先寻址标签页 id：`switchTab`/`openTab`/`closeTab` 管理标签页，`navigate` 加载 URL；页面操作——`snapshot`、`screenshot`、`clickSelector`、`clickPoint`、`typeText`、`pressKey`、`scroll`、`waitFor`、`evaluate`——在指定标签页上执行。`snapshot` 穿透 Shadow DOM 与同进程 iframe；`screenshot` 默认截取可视视口，`fullPage` 时截取完整排版页面；`evaluate` 返回页内表达式的 JSON 序列化值。

## 提供方

扩展宿主提供一个基于 Chrome DevTools Protocol（`chrome.debugger`）实现的提供方，带拟人化输入：贝塞尔鼠标轨迹、逐键打字与惯性滚动。测试针对实现同一接口的脚本化驱动运行 seam——该 seam 刻意不依赖任何 CDP 类型。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Source: [`packages/browser/browser/src/index.ts:131`](../../packages/browser/browser/src/index.ts)

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

Source: [`packages/browser/browser/src/index.ts:159`](../../packages/browser/browser/src/index.ts)
<!-- END GENERATED cordis-surface -->
