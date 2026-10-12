/**
 * 危险操作确认 (the safe-click built-in capability): element text that reads
 * as a destructive or money-moving action routes the click through approval
 * even in the full-access permission mode. Pure word matching lives here so
 * the capability spec can pin it without a browser.
 */

/** Substrings (case-insensitive) whose presence marks a click as dangerous. */
const DANGER_WORDS: readonly string[] = [
  '删除', '清空', '注销', '卸载', '格式化', '支付', '付款', '下单', '提交订单', '确认订单', '立即购买',
  'delete', 'remove all', 'pay now', 'checkout', 'confirm order', 'place order', 'permanently',
]

/**
 * Whether one element's visible text reads as a dangerous action. Empty text
 * never matches (icon-only buttons stay ungated).
 */
export function matchesDangerText(text: string): boolean {
  if (text === '') return false
  const folded = text.toLowerCase()
  return DANGER_WORDS.some(word => folded.includes(word))
}
