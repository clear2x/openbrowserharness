/** Regression coverage for locale-aware bilingual Markdown links. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseMarkdown } from './markdown.ts'
import {
  normalizeTranslationMarkdownLinks,
  rewriteTranslationLinkLocales,
  translationLinkLocaleViolations,
  type TranslationLinkContext,
} from './translation-links.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) removeFixtureSafely(root)
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-translation-links-'))
  roots.push(root)
  mkdirSync(join(root, 'docs/zh'), { recursive: true })
  mkdirSync(join(root, 'docs/section/zh'), { recursive: true })
  mkdirSync(join(root, 'packages/zh'), { recursive: true })
  writeFileSync(join(root, 'docs/guide.md'), '# Guide\n')
  writeFileSync(join(root, 'docs/zh/guide.md'), '# 指南\n')
  writeFileSync(join(root, 'docs/reference.md'), '# Overview\n')
  writeFileSync(join(root, 'docs/zh/reference.md'), '# 概览\n')
  writeFileSync(join(root, 'docs/unpaired.md'), '# Only\n')
  writeFileSync(join(root, 'docs/section/index.md'), '# Section\n')
  writeFileSync(join(root, 'docs/section/zh/index.md'), '# 章节\n')
  writeFileSync(join(root, 'packages/outside.md'), '# Outside\n')
  writeFileSync(join(root, 'packages/zh/outside.md'), '# 范围外\n')
  return root
}

function linkContext(
  root: string,
  sourcePath: string,
  repositoryFileExists?: (repoPath: string) => boolean,
): TranslationLinkContext {
  return {
    repoRoot: root,
    sourcePath,
    isTranslationPairSource: path => path.startsWith('docs/'),
    ...(repositoryFileExists === undefined ? {} : { repositoryFileExists }),
  }
}

function expectUnchangedLinkInput(root: string, input: string): void {
  const context = linkContext(root, 'docs/guide.md')
  expect(translationLinkLocaleViolations(input, context)).toEqual([])
  expect(rewriteTranslationLinkLocales(input, context)).toEqual({ content: input, rewritten: 0 })
  expect(normalizeTranslationMarkdownLinks(input, context)).toBe(input)
}

describe('translation link locale validation', () => {
  it('rejects a Chinese link to the English sibling with an exact diagnostic', () => {
    const root = fixture()
    expect(translationLinkLocaleViolations(
      '# 指南\n\n正文。\n\n[概览](../reference.md?view=full#overview)\n',
      linkContext(root, 'docs/zh/guide.md'),
    )).toEqual([{
      sourcePath: 'docs/zh/guide.md',
      line: 5,
      url: '../reference.md?view=full#overview',
      expectedUrl: 'reference.md?view=full#overview',
    }])
  })

  it('rewrites an encoded exact filename without changing its query or fragment suffix', () => {
    const root = fixture()
    const input = '[概览](..%2Freference%2Emd?view=full&amp;mode=all#overview)\n'
    expect(translationLinkLocaleViolations(
      input,
      linkContext(root, 'docs/zh/guide.md'),
    )[0]).toMatchObject({
      url: '..%2Freference%2Emd?view=full&amp;mode=all#overview',
      expectedUrl: 'reference.md?view=full&amp;mode=all#overview',
    })
    expect(rewriteTranslationLinkLocales(input, linkContext(root, 'docs/zh/guide.md'))).toEqual({
      content: '[概览](reference.md?view=full&amp;mode=all#overview)\n',
      rewritten: 1,
    })
  })

  it('encodes each exact path segment with only RFC 3986 unreserved characters', () => {
    const root = fixture()
    const input = '[保留](../a%29%23%3Fb.md?view=full#section)\n'
    const repositoryFiles = new Set(['docs/a)#?b.md', 'docs/zh/a)#?b.md'])
    expect(rewriteTranslationLinkLocales(
      input,
      linkContext(root, 'docs/zh/guide.md', path => repositoryFiles.has(path)),
    )).toEqual({
      content: '[保留](a%29%23%3Fb.md?view=full#section)\n',
      rewritten: 1,
    })
  })

  it('accepts the target-locale sibling and an out-of-scope target with its own sibling', () => {
    const root = fixture()
    expect(translationLinkLocaleViolations(
      '[paired](reference.md) [outside](../../packages/outside.md)\n',
      linkContext(root, 'docs/zh/guide.md'),
    )).toEqual([])
  })

  it('does not fall back when an active target is missing its locale sibling', () => {
    const root = fixture()
    expect(translationLinkLocaleViolations(
      '[missing](../unpaired.md)\n',
      linkContext(root, 'docs/zh/guide.md'),
    )[0]).toMatchObject({ expectedUrl: 'unpaired.md' })
  })

  it('requires English sources to use the English sibling', () => {
    const root = fixture()
    expect(translationLinkLocaleViolations(
      '[Reference](zh/reference.md)\n',
      linkContext(root, 'docs/guide.md'),
    )[0]).toMatchObject({
      url: 'zh/reference.md',
      expectedUrl: 'reference.md',
    })
  })

  it('does not infer an index page from a directory target', () => {
    const root = fixture()
    const input = '[Section](section/)\n'
    expect(translationLinkLocaleViolations(input, linkContext(root, 'docs/zh/guide.md'))).toEqual([])
    expect(rewriteTranslationLinkLocales(input, linkContext(root, 'docs/zh/guide.md')))
      .toEqual({ content: input, rewritten: 0 })
  })

  it('exempts the language switcher target explicitly', () => {
    const root = fixture()
    expect(translationLinkLocaleViolations(
      '# 指南\n\n[English](../guide.md) | 中文\n',
      linkContext(root, 'docs/zh/guide.md'),
      ['../guide.md'],
    )).toEqual([])
  })

  it('does not exempt an ordinary body link to the counterpart', () => {
    const root = fixture()
    const markdown = '# 指南\n\n[English](../guide.md) | 中文\n\n[正文](../guide.md)\n'
    expect(translationLinkLocaleViolations(
      markdown,
      linkContext(root, 'docs/zh/guide.md'),
      ['../guide.md'],
    )).toEqual([{
      sourcePath: 'docs/zh/guide.md',
      line: 5,
      url: '../guide.md',
      expectedUrl: 'guide.md',
    }])
    expect(rewriteTranslationLinkLocales(
      markdown,
      linkContext(root, 'docs/zh/guide.md'),
      ['../guide.md'],
    ).content).toBe('# 指南\n\n[English](../guide.md) | 中文\n\n[正文](guide.md)\n')
  })

  it('uses the selected content plane for target existence without deriving scope from siblings', () => {
    const root = fixture()
    const staged = new Set(['docs/reference.md', 'docs/zh/reference.md'])
    expect(translationLinkLocaleViolations(
      '[概览](../reference.md)\n',
      linkContext(root, 'docs/zh/guide.md', path => staged.has(path)),
    )).toHaveLength(1)
    staged.delete('docs/reference.md')
    expect(translationLinkLocaleViolations(
      '[概览](../reference.md)\n',
      linkContext(root, 'docs/zh/guide.md', path => staged.has(path)),
    )).toHaveLength(0)
    staged.add('docs/reference.md')
    staged.delete('docs/zh/reference.md')
    expect(translationLinkLocaleViolations(
      '[概览](reference.md)\n',
      linkContext(root, 'docs/zh/guide.md', path => staged.has(path)),
    )).toEqual([])
  })
})

describe('translation link rewriting and normalization', () => {
  it('reuses an authored tree without changing its offsets, switcher exemption, or reference resolution', () => {
    const root = fixture()
    const input = '# 指南\n\n[English](../guide.md) | 中文\n\n[行内](../reference.md?view=full&amp;x=1#overview "标题")\n\n[引用][ref]\n\n[ref]: <../reference.md#tail> "标注"\n[ref]: unpaired.md\n'
    const context = linkContext(root, 'docs/zh/guide.md')
    const tree = parseMarkdown(input)
    const originalTree = structuredClone(tree)

    expect(normalizeTranslationMarkdownLinks(input, context, ['../guide.md'], tree)).toBe(
      '# 指南\n\n[English](../guide.md) | 中文\n\n[行内](dsh-translation-target:docs/reference.md?view=full&amp;x=1#overview "标题")\n\n[引用][ref]\n\n[ref]: <dsh-translation-target:docs/reference.md#tail> "标注"\n[ref]: unpaired.md\n',
    )
    expect(translationLinkLocaleViolations(input, context, ['../guide.md'], tree)).toEqual([
      {
        sourcePath: 'docs/zh/guide.md',
        line: 5,
        url: '../reference.md?view=full&amp;x=1#overview',
        expectedUrl: 'reference.md?view=full&amp;x=1#overview',
      },
      {
        sourcePath: 'docs/zh/guide.md',
        line: 9,
        url: '../reference.md#tail',
        expectedUrl: 'reference.md#tail',
      },
    ])
    expect(tree).toEqual(originalTree)
  })

  it('rewrites only the destination while preserving the suffix and title', () => {
    const root = fixture()
    const input = '[概览](../reference.md?view=full&amp;mode=all#overview "reference.md title")\n'
    expect(rewriteTranslationLinkLocales(
      input,
      linkContext(root, 'docs/zh/guide.md'),
    )).toEqual({
      content: '[概览](reference.md?view=full&amp;mode=all#overview "reference.md title")\n',
      rewritten: 1,
    })
  })

  it('rewrites link definitions without changing their labels', () => {
    const root = fixture()
    expect(rewriteTranslationLinkLocales(
      '[概览][ref]\n\n[ref]: <../reference.md#overview> "title"\n',
      linkContext(root, 'docs/zh/guide.md'),
    ).content).toBe('[概览][ref]\n\n[ref]: <reference.md#overview> "title"\n')
  })

  it('uses only the first duplicate reference definition', () => {
    const root = fixture()
    expect(translationLinkLocaleViolations(
      '[概览][ref]\n\n[ref]: reference.md\n[ref]: ../reference.md\n',
      linkContext(root, 'docs/zh/guide.md'),
    )).toEqual([])
  })

  it('does not treat an image-only definition as a document link', () => {
    const root = fixture()
    const input = '![preview][asset]\n\n[asset]: reference.md#overview\n'
    expectUnchangedLinkInput(root, input)
  })

  it.each([
    '<https://example.com/reference.md>\n',
    'https://example.com/reference.md\n',
  ])('leaves GFM autolink source unchanged: %s', (input) => {
    const root = fixture()
    expectUnchangedLinkInput(root, input)
  })

  it('normalizes only paired locale paths and retains other bytes', () => {
    const root = fixture()
    const english = '[Reference](reference.md#overview) [Outside](../packages/outside.md)\n'
    const chinese = '[Reference](reference.md#overview) [Outside](../../packages/outside.md)\n'
    expect(normalizeTranslationMarkdownLinks(
      english,
      linkContext(root, 'docs/guide.md'),
    )).toBe(normalizeTranslationMarkdownLinks(
      chinese,
      linkContext(root, 'docs/zh/guide.md'),
    ))
  })

  it('retains authored query bytes during normalization', () => {
    const root = fixture()
    const escaped = '[Reference](reference.md?x=1&amp;y=2#overview)\n'
    const literal = '[Reference](reference.md?x=1&y=2#overview)\n'
    expect(normalizeTranslationMarkdownLinks(
      escaped,
      linkContext(root, 'docs/guide.md'),
    )).not.toBe(normalizeTranslationMarkdownLinks(
      literal,
      linkContext(root, 'docs/zh/guide.md'),
    ))
  })
})
