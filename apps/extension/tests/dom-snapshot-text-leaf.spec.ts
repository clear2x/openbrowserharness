/**
 * Text-leaf snapshot scan (真机批36 follow-up): childless non-interactive
 * elements carrying visible text enter the snapshot as `passive` entries, so
 * operation feedback ("点击成功 05:33:20") is model-visible without a
 * page_evaluate round-trip.
 *
 * `textLeafOk` is injected into SNAPSHOT_EXPRESSION via function-source
 * serialization — the tests below call the SAME function object the shipped
 * script runs, so the semantics cannot drift. The assembly assertions pin the
 * wiring (tables + predicate actually referenced from the collect loop).
 */

import { describe, expect, it } from 'vitest'
import {
  maskSensitiveText,
  SNAPSHOT_EXPRESSION,
  TEXT_LEAF_LISTED_TAGS,
  TEXT_LEAF_SKIP_TAGS,
  textLeafOk,
  type TextLeafElement,
} from '../src/background/dom-snapshot.ts'

function leaf(
  overrides: Partial<{
    tagName: string
    attributes: string[]
    childCount: number
    textContent: string | null
  }> = {},
): TextLeafElement {
  const { tagName = 'SPAN', attributes = [], childCount = 0, textContent = '点击成功 05:33:20' } =
    overrides
  return {
    tagName,
    hasAttribute: name => attributes.includes(name),
    get children(): { length: number } {
      return { length: childCount }
    },
    textContent,
  }
}

describe('textLeafOk predicate', () => {
  it('accepts a childless non-interactive element with visible text', () => {
    expect(textLeafOk(leaf(), TEXT_LEAF_LISTED_TAGS, TEXT_LEAF_SKIP_TAGS)).toBe(true)
  })

  it('rejects whitespace-only and empty leaves', () => {
    expect(textLeafOk(leaf({ textContent: '   \n\t ' }), TEXT_LEAF_LISTED_TAGS, TEXT_LEAF_SKIP_TAGS)).toBe(false)
    expect(textLeafOk(leaf({ textContent: null }), TEXT_LEAF_LISTED_TAGS, TEXT_LEAF_SKIP_TAGS)).toBe(false)
  })

  it('rejects containers — only childless elements qualify', () => {
    expect(textLeafOk(leaf({ childCount: 2 }), TEXT_LEAF_LISTED_TAGS, TEXT_LEAF_SKIP_TAGS)).toBe(false)
  })

  it('rejects tags the curated selector list already collects (no passive duplicates)', () => {
    for (const tag of ['H3', 'LABEL', 'BUTTON', 'IFRAME', 'IMG', 'OPTION']) {
      expect(textLeafOk(leaf({ tagName: tag }), TEXT_LEAF_LISTED_TAGS, TEXT_LEAF_SKIP_TAGS)).toBe(false)
    }
  })

  it('rejects metadata and svg subtrees', () => {
    for (const tag of ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD']) {
      expect(textLeafOk(leaf({ tagName: tag }), TEXT_LEAF_LISTED_TAGS, TEXT_LEAF_SKIP_TAGS)).toBe(false)
    }
  })

  it('rejects attribute-marked elements — role/onclick/contenteditable/tabindex/aria-hidden', () => {
    for (const attr of ['role', 'onclick', 'contenteditable', 'tabindex', 'aria-hidden']) {
      expect(
        textLeafOk(leaf({ attributes: [attr] }), TEXT_LEAF_LISTED_TAGS, TEXT_LEAF_SKIP_TAGS),
      ).toBe(false)
    }
  })

  it('normalizes mixed-case svg tag names (SVG text nodes keep original case)', () => {
    expect(textLeafOk(leaf({ tagName: 'svg' }), TEXT_LEAF_LISTED_TAGS, TEXT_LEAF_SKIP_TAGS)).toBe(false)
    expect(textLeafOk(leaf({ tagName: 'text' }), TEXT_LEAF_LISTED_TAGS, TEXT_LEAF_SKIP_TAGS)).toBe(true)
  })
})

describe('snapshot expression wiring', () => {
  it('injects the predicate by source and references it from the collect loop', () => {
    expect(SNAPSHOT_EXPRESSION).toContain('var textLeafOk =')
    expect(SNAPSHOT_EXPRESSION).toContain('textLeafOk(h, LEAF_LISTED, LEAF_SKIP)')
    expect(SNAPSHOT_EXPRESSION).toContain('addElement(h, doc, offsetX, offsetY, inShadow, inIframe, piercePrefix)')
  })

  it('carries both tag tables as serialized literals', () => {
    expect(SNAPSHOT_EXPRESSION).toContain(`var LEAF_SKIP = ${JSON.stringify(TEXT_LEAF_SKIP_TAGS)}`)
    expect(SNAPSHOT_EXPRESSION).toContain(`var LEAF_LISTED = ${JSON.stringify(TEXT_LEAF_LISTED_TAGS)}`)
  })

  it('keeps the leaf scan behind the HARD_CAP guard', () => {
    // The collect loop must still bail out once the hard cap is reached —
    // find the leaf call and assert a cap check follows before the loop ends.
    const at = SNAPSHOT_EXPRESSION.indexOf('textLeafOk(h, LEAF_LISTED, LEAF_SKIP)')
    expect(at).toBeGreaterThan(0)
    const tail = SNAPSHOT_EXPRESSION.slice(at, at + 400)
    expect(tail).toContain('total() >= HARD_CAP')
  })
})

describe('maskSensitiveText（内置能力 privacy-mask 的纯函数）', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['联系 13812345678 获取详情', '联系 [手机号] 获取详情', '手机号'],
    ['身份证 11010119900307861X 请核对', '身份证 [身份证号] 请核对', '18 位身份证'],
    ['卡号 6222020200112233445', '卡号 [卡号]', '16–19 位卡号'],
    ['发送到 user.name+tag@example.com.cn 确认', '发送到 [邮箱] 确认', '邮箱'],
    ['普通文本与 12345 短数字保持原样', '普通文本与 12345 短数字保持原样', '短数字不误伤'],
  ]
  for (const [input, expected, label] of cases) {
    it(`打码${label}`, () => {
      expect(maskSensitiveText(input)).toBe(expected)
    })
  }

  it('非 PII 文本逐字通过（掩码只替换命中段）', () => {
    expect(maskSensitiveText('提交订单')).toBe('提交订单')
  })
})
