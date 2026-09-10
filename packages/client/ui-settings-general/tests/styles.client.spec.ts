/**
 * Settings shell stylesheet contract, asserted against the CSS text on disk.
 *
 * The shell paints in both themes and in two deployment surfaces (the desktop
 * modal card and the extension SidePanel's full-bleed sheet). A `--dsw-*`
 * name the theme does not declare fails silently — the browser takes the
 * `var()` fallback, the sheet still renders, and only dark looks wrong — so
 * the token names are checked against the sheet that declares them. The
 * full-bleed and no-scrollbar rules are the ones whose silent loss would
 * reintroduce the double-container and scroll-strip regressions.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SettingsRoot.module.css', import.meta.url)), 'utf8')
// The theme package maps `./styles/*` to `./src/styles/*`, so the declarations
// stay on the source plane rather than needing a build. Every theme sheet,
// not just the platform tokens: font, mask, and scrollbar variables are
// declared in siblings, and a gate reading one file would call their names
// undeclared.
const tokens = readdirSync(fileURLToPath(new URL('../../ui-theme/src/styles/', import.meta.url)))
  .filter(name => name.endsWith('.css'))
  .map(name => readFileSync(fileURLToPath(new URL(`../../ui-theme/src/styles/${name}`, import.meta.url)), 'utf8'))
  .join('\n')

/** The declarations of one top-level rule, by selector. */
function block(selector: string): string {
  const match = new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`SettingsRoot.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

/**
 * The body of one `@media`/`@container` block, by brace matching (its rules
 * are nested, so a line-anchored selector match cannot see them).
 */
function atBlock(header: RegExp): string {
  const match = header.exec(css)
  if (match === null) throw new Error(`SettingsRoot.module.css has no \`${header.source}\` block`)
  const open = css.indexOf('{', match.index)
  let depth = 1
  let end = open
  while (depth > 0) {
    end += 1
    const char = css[end]
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
  }
  return css.slice(open, end)
}

/** The declarations of one rule inside a `@media`/`@container` block body. */
function ruleIn(blockBody: string, selector: string): string {
  const match = new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(blockBody)
  if (match === null) throw new Error(`no \`${selector}\` rule inside the block body`)
  return match[1] ?? ''
}

/** The narrow-sheet breakpoint headers: the media primary and its container twin. */
const bleedMedia = /@media \(max-width:\s*768px\)/
const bleedContainer = /@container \(max-width:\s*768px\)/
const compactMedia = /@media \(max-width:\s*430px\)/
const compactContainer = /@container \(max-width:\s*430px\)/

describe('SettingsRoot theme styles', () => {
  it('names only theme variables the token sheet defines', () => {
    // An undeclared `--dsw-*` name silently resolves to whatever literal sits
    // in its fallback slot (or inherits, when there is none) — how surfaces
    // stay light under the dark theme. Every theme-variable prefix the sheet
    // actually uses must be declared.
    const named = [...css.matchAll(/var\((--(?:dsw|dsh|ds)-[a-z0-9-]+)/g)].map(match => match[1])
    const undeclared = [...new Set(named)].filter(name => !tokens.includes(`  ${String(name)}:`))
    expect(undeclared).toEqual([])
    expect(css).not.toMatch(/var\(--(?:surface|text-|border|accent-strong)/)
  })

  it('closes every block, so no rule is swallowed by the one above it', () => {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect((bare.match(/\}/g) ?? []).length).toBe((bare.match(/\{/g) ?? []).length)
  })

  it('never falls back to a literal colour', () => {
    expect(css).not.toMatch(/var\(--dsw-[a-z0-9-]+\s*,\s*(?:#|rgb|rgba|hsl|hsla)/)
  })

  it('dresses the wide card with a hairline and the light lv2 shadow', () => {
    // The old slab (lv3 on a 24px-radius card) plus the mask is what read as
    // a double container in a narrow panel; the wide form keeps the mask but
    // trades the heavy shadow for the hairline + lv2 pair.
    const panel = block('.panel')
    expect(panel).toContain('border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)')
    expect(panel).toContain('box-shadow: var(--dsw-shadow-lv2)')
    expect(panel).not.toContain('--dsw-shadow-lv3')
    expect(panel).toContain('border-radius: 16px')
  })

  it('bleeds the sheet full-size in both narrow blocks', () => {
    // The SidePanel is its own document (panel width IS the viewport width),
    // so a media query is the dependable primary switch; the container query
    // twin covers the shell being embedded in a narrow host element. Both
    // must carry the identical full-bleed rules — dropping either regresses
    // one of the two deployment surfaces back to the floating card.
    expect(css).toMatch(/container-type:\s*inline-size/)
    expect(css).toMatch(bleedMedia)
    expect(css).toMatch(bleedContainer)

    for (const narrow of [atBlock(bleedMedia), atBlock(bleedContainer)]) {
      const mask = ruleIn(narrow, '.mask')
      expect(mask).toContain('display: none')
      const panel = ruleIn(narrow, '.panel')
      expect(panel).toContain('width: 100%')
      expect(panel).toContain('height: 100%')
      expect(panel).toContain('max-width: none')
      expect(panel).toContain('border: none')
      expect(panel).toContain('border-radius: 0')
      expect(panel).toContain('box-shadow: none')
      // Same base color as the shell header behind/below the band: the sheet
      // reads as a continuation of the chrome, not a card floating on it.
      expect(panel).toContain('background: var(--dsw-alias-bg-base)')
    }
  })

  it('keeps the old 559px card breakpoint retired', () => {
    // The full-bleed switch moved to the shell's 768px tier; a leftover 559px
    // block would re-float the card between 560 and 768px.
    expect(css).not.toMatch(/max-width:\s*559px/)
  })

  it('keeps the options area a bare page margin, not a container', () => {
    // The flat sections (ModelsSection's language) render straight on the
    // sheet; the scroller must not paint its own surface or the page reads as
    // a card inside the panel again.
    const options = block('.options')
    expect(options).toContain('overflow-y: auto')
    expect(options).not.toMatch(/background|border|border-radius/)
  })

  it('widens the narrow options gutter for the flat sections', () => {
    // The full-bleed sheet spends its horizontal budget on the section
    // column (12/16/24), not on the old 12px inset.
    for (const narrow of [atBlock(bleedMedia), atBlock(bleedContainer)]) {
      expect(ruleIn(narrow, '.options')).toContain('padding: 12px 16px 24px')
    }
  })

  it('runs the tab band without a horizontal scrollbar', () => {
    // The strip's overflow is hidden, with the scrollbar suppression on top;
    // an `overflow-x: auto` here is the exact regression the strip once had
    // (a gray scroll line under the tabs).
    const tabList = block('.tabList')
    expect(tabList).toContain('overflow: hidden')
    expect(tabList).toContain('scrollbar-width: none')
    expect(css).toMatch(/\.tabList::-webkit-scrollbar \{\s*display: none;/)
    expect(tabList).not.toContain('overflow-x')

    // Tabs shrink instead of scrolling: every tab can compress, and its label
    // ellipses rather than wrapping.
    expect(block('.tab')).toContain('white-space: nowrap')
    expect(block('.tabLabel')).toContain('text-overflow: ellipsis')
    expect(block('.tab.active')).toContain('border-bottom-color: var(--dsw-alias-brand-primary)')
  })

  it('drops the glyphs last, in both compact blocks, keeping the labels', () => {
    // The starvation ladder ends at the ≤430px tier: tighter paddings, then
    // the icons go. The labels must stay — they are the tab buttons'
    // accessible names, and CSS-hiding them would strip the name.
    expect(css).toMatch(compactMedia)
    expect(css).toMatch(compactContainer)
    for (const compact of [atBlock(compactMedia), atBlock(compactContainer)]) {
      expect(ruleIn(compact, '.tabIcon')).toContain('display: none')
      expect(compact).not.toMatch(/\.tabLabel/)
    }
    expect(block('.tabLabel')).not.toContain('display: none')
  })
})
