// @vitest-environment jsdom
/**
 * Pure-guard specs for the 内置能力 switches: 链接净化's tracking-parameter
 * stripping and 危险操作确认's danger-word matching. Both live in shared
 * modules (no chrome bindings) so the capability spec can pin them without a
 * browser double.
 */

import { describe, expect, it } from 'vitest'
import { stripTrackingParams } from '../src/shared/url-privacy.ts'
import { matchesDangerText } from '../src/shared/danger-click.ts'

describe('stripTrackingParams（链接净化）', () => {
  it('剥除 utm_* 与常见跟踪参数，保留业务参数', () => {
    expect(stripTrackingParams('https://a.com/p?utm_source=x&id=7&q=1'))
      .toBe('https://a.com/p?id=7&q=1')
    expect(stripTrackingParams('https://a.com/p?fbclid=AbC&id=7&gclid=E&spm=1'))
      .toBe('https://a.com/p?id=7')
  })

  it('无参数残留时去掉悬空 ?；无跟踪参数原样返回', () => {
    expect(stripTrackingParams('https://a.com/p?utm_source=x')).toBe('https://a.com/p')
    expect(stripTrackingParams('https://a.com/p?id=7')).toBe('https://a.com/p?id=7')
    expect(stripTrackingParams('https://a.com/p')).toBe('https://a.com/p')
  })

  it('非法输入原样返回', () => {
    expect(stripTrackingParams('not a url')).toBe('not a url')
  })
})

describe('matchesDangerText（危险操作确认）', () => {
  it('中英文危险词命中（大小写不敏感）', () => {
    expect(matchesDangerText('删除这条记录')).toBe(true)
    expect(matchesDangerText('确认订单')).toBe(true)
    expect(matchesDangerText('Pay Now')).toBe(true)
    expect(matchesDangerText('Permanently remove account')).toBe(true)
  })

  it('普通按钮与空文本不误伤', () => {
    expect(matchesDangerText('提交')).toBe(false)
    expect(matchesDangerText('下一步')).toBe(false)
    expect(matchesDangerText('')).toBe(false)
  })
})
