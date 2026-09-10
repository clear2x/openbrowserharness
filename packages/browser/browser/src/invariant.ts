/**
 * Package-owned durable invariants for `@deepseek-ai/dsh-browser`: the wire
 * shapes every provider agrees on, plus the provider-registry event contract.
 * @module @deepseek-ai/dsh-browser/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-browser'

/** Cordis companion plugin name. */
export const name = 'browser-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Whether one value is a finite number (IDs and coordinates are integers, but snapshots may carry floats). */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Validate the wire shape of one {@link PageSnapshot} element (`index`, `tag`,
 * `selector`, `text`, `rect`, `center`, `interactive`, and the optional
 * shadow/iframe markers). Provider authors call this before returning a
 * snapshot; {@link validatePageSnapshot} runs it over every element.
 * @param value - one candidate element record.
 * @param fail - the bound invariant failure reporter.
 */
export function validatePageElementInfo(value: unknown, fail: InvariantFailure): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('page snapshot element 必须是对象')
  }
  const element = value as Record<string, unknown>
  if (!isNumber(element['index']) || !Number.isInteger(element['index']) || element['index'] < 0) {
    fail(`snapshot 元素 index 必须是非负整数（收到 ${JSON.stringify(element['index'])}）`)
  }
  if (typeof element['tag'] !== 'string' || element['tag'].length === 0) {
    fail(`snapshot 元素 ${JSON.stringify(element['index'])} 的 tag 必须是非空字符串`)
  }
  if (typeof element['selector'] !== 'string') {
    fail(`snapshot 元素 ${element['index']} 的 selector 必须是字符串（不可寻址时为空字符串）`)
  }
  if (typeof element['text'] !== 'string') {
    fail(`snapshot 元素 ${element['index']} 的 text 必须是字符串`)
  }
  const rect = element['rect']
  if (typeof rect !== 'object' || rect === null || Array.isArray(rect)) {
    fail(`snapshot 元素 ${element['index']} 的 rect 必须是 { x, y, width, height } 对象`)
  } else {
    const box = rect as Record<string, unknown>
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      if (!isNumber(box[key])) fail(`snapshot 元素 ${element['index']} 的 rect.${key} 必须是有限数字`)
    }
  }
  validatePoint(element['center'], `snapshot 元素 ${element['index']} 的 center`, fail)
  if (typeof element['interactive'] !== 'boolean') {
    fail(`snapshot 元素 ${element['index']} 的 interactive 必须是布尔值`)
  }
  if (element['inShadowDom'] !== undefined && typeof element['inShadowDom'] !== 'boolean') {
    fail(`snapshot 元素 ${element['index']} 的 inShadowDom 必须是布尔值`)
  }
  if (element['inIframe'] !== undefined && typeof element['inIframe'] !== 'boolean') {
    fail(`snapshot 元素 ${element['index']} 的 inIframe 必须是布尔值`)
  }
}

/** Validate one `{x, y}`-plus record; the caller names the field. */
function validatePoint(value: unknown, field: string, fail: InvariantFailure): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${field} 必须是 { x, y } 对象`)
  }
  const point = value as Record<string, unknown>
  if (!isNumber(point['x']) || !isNumber(point['y'])) {
    fail(`${field} 的 x/y 必须是有限数字`)
  }
}

/**
 * Validate the wire shape of one {@link PageSnapshot}: scalar header fields,
 * the viewport record, and every element. Snapshot values cross the seam as
 * plain JSON, so structural checks (not class membership) are the contract.
 * @param value - one candidate snapshot.
 * @param fail - the bound invariant failure reporter.
 */
export function validatePageSnapshot(value: unknown, fail: InvariantFailure): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('PageSnapshot 必须是对象')
  }
  const snapshot = value as Record<string, unknown>
  if (!isNumber(snapshot['tabId']) || !Number.isInteger(snapshot['tabId']) || snapshot['tabId'] < 0) {
    fail(`PageSnapshot.tabId 必须是非负整数（收到 ${JSON.stringify(snapshot['tabId'])}）`)
  }
  if (typeof snapshot['url'] !== 'string') fail('PageSnapshot.url 必须是字符串')
  if (typeof snapshot['title'] !== 'string') fail('PageSnapshot.title 必须是字符串')
  if (!isNumber(snapshot['timestamp']) || snapshot['timestamp'] < 0) {
    fail('PageSnapshot.timestamp 必须是非负数字')
  }
  const viewport = snapshot['viewport']
  if (typeof viewport !== 'object' || viewport === null || Array.isArray(viewport)) {
    fail('PageSnapshot.viewport 必须是对象')
  } else {
    const view = viewport as Record<string, unknown>
    for (const key of ['width', 'height', 'scrollX', 'scrollY'] as const) {
      if (!isNumber(view[key])) fail(`PageSnapshot.viewport.${key} 必须是有限数字`)
    }
  }
  if (!Array.isArray(snapshot['elements'])) fail('PageSnapshot.elements 必须是数组')
  const elements = snapshot['elements'] as unknown[]
  for (const [index, element] of elements.entries()) {
    if (typeof element === 'object' && element !== null
      && (element as Record<string, unknown>)['index'] !== index) {
      fail(`PageSnapshot.elements[${index}] 的 index 字段必须是它在数组中的位置 ${index}`)
    }
    validatePageElementInfo(element, fail)
  }
}

/* jscpd:ignore-start -- package companions share registration plumbing */
/**
 * Validate the provider-registry event contract: `browser/provider-updated`
 * must carry the runtime's exact registered id list, and every id must be a
 * non-blank, whitespace-free string (the same rule `register()` enforces).
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const validateIds = (ids: readonly string[], source: string): void => {
    if (!Array.isArray(ids)) fail(`${source} 必须是 provider id 数组`)
    for (const id of ids) {
      if (typeof id !== 'string' || id.trim() !== id || id.length === 0 || /\s/.test(id)) {
        fail(`${source} 携带非法 provider id ${JSON.stringify(id)}`)
      }
    }
  }
  validateIds(ctx.browser.providerIds, 'browser.providerIds')
  ctx.on('browser/provider-updated', (ids) => {
    validateIds(ids, 'browser/provider-updated 事件负载')
    const current = ctx.browser.providerIds
    if (ids.length !== current.length || ids.some((id, i) => id !== current[i])) {
      fail(`browser/provider-updated 事件负载 [${ids.join(', ')}] 与当前注册表 [${current.join(', ')}] 不一致`)
    }
  }, { global: true })
}, { inject: ['browser'] })
/* jscpd:ignore-end */

/**
 * Register the browser invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
