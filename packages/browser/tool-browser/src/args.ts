/**
 * Shared defensive validation for the browser tool arguments. The JSON-schema
 * layer already enforces types/required/enum; these helpers reject the value
 * constraints it cannot express, with clear Chinese errors.
 * @module @deepseek-ai/dsh-tool-browser/args
 */

/** Upper bound accepted for a model-supplied wait budget (ms). */
export const MAX_TIMEOUT_MS = 30_000

/** Validate one `tab_id` argument: a non-negative safe integer.
 * @param value - the raw numeric argument from the model call.
 * @param field - argument name used in the error message.
 * @returns the validated tab id. */
export function parseTabId(value: number, field = 'tab_id'): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} 必须是非负整数（收到 ${JSON.stringify(value)}）`)
  }
  return value
}

/** Validate one `url` argument: a non-blank string.
 * @param value - the raw url argument from the model call.
 * @returns the validated url. */
export function parseUrl(value: string): string {
  if (value.trim().length === 0) {
    throw new Error('url 必须是非空字符串')
  }
  return value
}

/** Validate one CSS-selector argument: a non-blank string.
 * @param value - the raw selector argument from the model call.
 * @param field - argument name used in the error message.
 * @returns the validated selector. */
export function parseSelector(value: string, field = 'selector'): string {
  if (value.trim().length === 0) {
    throw new Error(`${field} 必须是非空的 CSS selector`)
  }
  return value
}

/** Validate one JavaScript-expression argument: a non-blank string.
 * @param value - the raw expression argument from the model call.
 * @param field - argument name used in the error message.
 * @returns the validated expression. */
export function parseExpression(value: string, field = 'expression'): string {
  if (value.trim().length === 0) {
    throw new Error(`${field} 必须是非空的 JavaScript 表达式`)
  }
  return value
}

/** Validate one optional positive-integer argument (px amounts, wait budgets).
 * @param value - the raw numeric argument from the model call.
 * @param field - argument name used in the error message.
 * @param max - inclusive upper bound; `undefined` means unbounded.
 * @returns the validated number, or `undefined` when absent. */
export function parsePositiveInteger(value: number | undefined, field: string, max?: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} 必须是正整数（收到 ${JSON.stringify(value)}）`)
  }
  if (max !== undefined && value > max) {
    throw new Error(`${field} 不能超过 ${max}（收到 ${JSON.stringify(value)}）`)
  }
  return value
}
