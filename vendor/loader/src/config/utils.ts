import { valueMap } from '@deepseek-ai/cosmokit'

// eslint-disable-next-line no-new-func
/**
 * Evaluate a JavaScript expression against a loader context scope.
 *
 * The evaluator is constructed lazily: extension pages (MV3 CSP
 * `script-src 'self'`) forbid `new Function` outright, so merely importing
 * this module must stay side-effect free. Compositions that never use YAML
 * `!js` expressions (e.g. the browser extension host, whose configs are
 * plain objects) never construct it at all.
 */
let evaluateFn: ((ctx: object, expr: string) => any) | undefined

export function evaluate(ctx: object, expr: string): any {
  evaluateFn ??= new Function('ctx', 'expr', `
    with (ctx) {
      return eval(expr)
    }
  `) as (ctx: object, expr: string) => any
  return evaluateFn(ctx, expr)
}

/** Recursively replace YAML `!js` expression nodes with evaluated values. */
export function interpolate(ctx: object, value: any) {
  if (isJsExpr(value)) {
    return evaluate(ctx, value.__jsExpr)
  } else if (!value || typeof value !== 'object') {
    return value
  } else if (Array.isArray(value)) {
    return value.map(item => interpolate(ctx, item))
  } else {
    return valueMap(value, item => interpolate(ctx, item))
  }
}

/** Return true when a value is a serialized loader JavaScript expression. */
export function isJsExpr(value: any): value is JsExpr {
  return value instanceof Object && '__jsExpr' in value
}

/** Serialized JavaScript expression produced by the include YAML tag. */
export interface JsExpr {
  __jsExpr: string
}
