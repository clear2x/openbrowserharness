/**
 * The extractive compression contract: determinism, budget adherence, the
 * heading-first selection, CJK coverage, and the passthrough below budget.
 *
 * @module text-extract.spec
 */
import { describe, expect, it } from 'vitest'
import { COMPRESSION_FOOTER, compressToBudget, scoreBlocks } from '../src/index.ts'

/** One repeated filler paragraph; distinct fillers exercise keyword scoring. */
const filler = (word: string, n: number): string =>
  Array.from({ length: n }, () => `This sentence discusses ${word} at length and adds little unique signal beyond it.`).join(' ')

describe('compressToBudget', () => {
  it('passes through text at or under the budget verbatim', () => {
    const text = 'Short body.\n\nSecond paragraph.'
    expect(compressToBudget(text, 1000)).toBe(text)
  })

  it('never exceeds the budget and keeps the output deterministic', () => {
    const text = `# Deep guide\n\n${filler('alpha', 40)}\n\n${filler('beta', 40)}\n\n${filler('gamma', 40)}`
    const first = compressToBudget(text, 800)
    expect(first.length).toBeLessThanOrEqual(800)
    expect(compressToBudget(text, 800)).toBe(first)
  })

  it('keeps headings over filler when the budget forces a choice', () => {
    const text = `# Pricing overview\n\n${filler('noise', 30)}\n\n## Enterprise tier\n\n${filler('noise', 30)}\n\n## Team tier\n\n${filler('noise', 30)}`
    const compressed = compressToBudget(text, 400)
    expect(compressed).toContain('# Pricing overview')
    expect(compressed).toContain('## Enterprise tier')
  })

  it('emits the selection in source order', () => {
    const text = '# A\n\nFirst topic sentence one. First topic sentence two.\n\n# B\n\nSecond topic sentence one. Second topic sentence two.'
    const compressed = compressToBudget(text, 90)
    const positions = ['# A', '# B'].map(marker => compressed.indexOf(marker))
    expect(positions[0]).toBeGreaterThanOrEqual(0)
    expect(positions[1]!).toBeGreaterThan(positions[0]!)
  })

  it('favors keyword-dense sentences over boilerplate in Chinese text', () => {
    const boiler = Array.from({ length: 30 }, () => '免责声明：本页面内容仅供参考，请以官方公告为准。').join('')
    const signal = '本教程演示如何在本地部署推理服务，并说明显存占用与量化格式的权衡。'
    const text = `${boiler}\n\n${signal}`
    const compressed = compressToBudget(text, 200)
    expect(compressed).toContain('量化')
  })
})

describe('scoreBlocks', () => {
  it('ranks headings above every sentence', () => {
    const blocks = scoreBlocks('# Title\n\nA content sentence that carries the argument of the whole document here.')
    const heading = blocks.find(block => block.text === '# Title')
    expect(heading?.score).toBe(Number.POSITIVE_INFINITY)
  })

  it('splits CJK sentences on 。 and keeps the count honest', () => {
    const blocks = scoreBlocks('这是第一句话。这是第二句话。这是第三句话，比较长一些，带足够的内容长度。')
    expect(blocks.length).toBe(3)
  })

  it('exposes the footer the callers append after compression', () => {
    expect(COMPRESSION_FOOTER).toContain('Locally compressed')
  })
})
