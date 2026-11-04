/**
 * Settings shell stylesheet contract, asserted against the CSS text on disk.
 *
 * The shell paints the desktop modal card and, below 768px, the full-viewport
 * browser layout. A `--dsw-*` name the theme does not declare fails silently —
 * the browser takes the `var()` fallback, the sheet still renders, and only
 * dark looks wrong — so the token names are checked against the sheets that
 * declare them. The narrow-layout rules and the strip's scrollbar suppression
 * are the ones whose silent loss would reintroduce the floating card and the
 * gray scroll-line regressions.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SettingsRoot.module.css', import.meta.url)), 'utf8')
// The theme package maps `./styles/*` to `./src/styles/*`, so the declarations
// stay on the source plane rather than needing a build. Every theme sheet,
// not just the platform tokens: font, mask, and scrollbar variables are
// declared in siblings, and a gate reading one file would call their names
// undeclared. The trigger row additionally consumes inherited properties the
// sidebar root and the app frame declare, so their sheets join the corpus.
const tokenSources = [
  ...readdirSync(fileURLToPath(new URL('../../ui-theme/src/styles/', import.meta.url)))
    .filter(name => name.endsWith('.css'))
    .map(name => fileURLToPath(new URL(`../../ui-theme/src/styles/${name}`, import.meta.url))),
  fileURLToPath(new URL('../../ui-sidebar/src/client/SidebarRoot.module.css', import.meta.url)),
  fileURLToPath(new URL('../../ui-layout/src/client/AppFrame.module.css', import.meta.url)),
]
const tokens = tokenSources.map(path => readFileSync(path, 'utf8')).join('\n')

/** The declarations of one top-level rule, by selector. */
function block(selector: string): string {
  const match = new RegExp(`^\\${selector} \\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`SettingsRoot.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

/** The body of one `@media` block, by brace matching (its rules are nested, so a line-anchored selector match cannot see them). */
function mediaBlock(header: RegExp): string {
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

/** The declarations of one rule inside a block body. */
function ruleIn(blockBody: string, selector: string): string {
  const match = new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(blockBody)
  if (match === null) throw new Error(`no \`${selector}\` rule inside the block body`)
  return match[1] ?? ''
}

/** The narrow-layout breakpoint header. */
const narrowMedia = /@media \(max-width:\s*767px\)/
/** Every narrow-layout rule is scoped to the browser layout: Windows custom captions and macOS native titlebars keep the desktop rail. */
const browserScope = /html:not\(\[data-windows-titlebar\]\):not\(\[data-platform='darwin'\]\)/

describe('SettingsRoot theme styles', () => {
  it('names only variables the token and inherited-property sheets define', () => {
    // An undeclared `--dsw-*` name silently resolves to whatever literal sits
    // in its fallback slot (or inherits, when there is none) — how surfaces
    // stay light under the dark theme. Every theme-variable prefix the sheet
    // actually uses must be declared somewhere it inherits from.
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

  it('dresses the wide card as the shared 800×800 shell', () => {
    // One height for every section, taken from the viewport rather than the
    // content, because a content-sized panel would resize under the pointer on
    // every nav click. The elevated surface rebinds the scrollbar thumb to the
    // l2 tokens so whichever descendant scrolls inherits the elevation.
    const panel = block('.panel')
    expect(panel).toContain('grid-template-areas')
    expect(panel).toContain('width: 800px')
    expect(panel).toContain('max-width: calc(100vw - 48px)')
    expect(panel).toContain('border-radius: var(--dsw-radius-panel)')
    expect(panel).toContain('box-shadow: var(--dsw-elevation-prominent)')
    expect(panel).toContain('--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)')
  })

  it('rearranges into the full-viewport browser layout below 768px', () => {
    // Windows custom captions and macOS native titlebars retain the desktop
    // rail, so every narrow rule carries the browser-layout root markers; a
    // bare `@media` block would re-float or re-rail both chrome layouts.
    expect(css).toMatch(narrowMedia)
    const narrow = mediaBlock(narrowMedia)
    expect(narrow.match(new RegExp(browserScope.source, 'g'))?.length).toBeGreaterThanOrEqual(6)
    const overlay = ruleIn(narrow, '.overlay')
    expect(overlay).toContain('position: absolute')
    expect(overlay).toContain('height: 100%')
    expect(overlay).toContain('background: var(--dsw-alias-bg-layer-2)')
    const panel = ruleIn(narrow, '.panel')
    expect(panel).toContain('width: 100%')
    expect(panel).toContain('height: 100%')
    expect(panel).toContain('max-width: none')
    expect(panel).toContain('border-radius: 0')
  })

  it('keeps the old 559px card breakpoint retired', () => {
    // The full-viewport switch moved to the 767px tier; a leftover 559px
    // block would re-float the card between 560 and 767px.
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

  it('narrows the options gutter in the browser layout', () => {
    expect(ruleIn(mediaBlock(narrowMedia), '.options')).toContain('padding: 0 16px 24px')
  })

  it('runs the navigation strip without a visible scrollbar', () => {
    // The strip scrolls its cells and suppresses the scrollbar on both
    // engines; an unsuppressed `overflow-x` here is the exact regression the
    // strip once had (a gray scroll line under the tabs).
    const navList = ruleIn(mediaBlock(narrowMedia), '.navList')
    expect(navList).toContain('flex-direction: row')
    expect(navList).toContain('overflow-x: auto')
    expect(navList).toContain('scrollbar-width: none')
    const strip = mediaBlock(narrowMedia)
    expect(strip).toMatch(/\.navList::-webkit-scrollbar \{\s*display: none;?\s*\}/)
  })

  it('keeps every nav cell label an accessible name, never hidden', () => {
    // Cells compress instead of scrolling away, and the label ellipses rather
    // than wrapping; CSS-hiding it would strip the button's accessible name.
    const cell = ruleIn(mediaBlock(narrowMedia), '.navCell')
    expect(cell).toContain('min-width: 108px')
    expect(ruleIn(mediaBlock(narrowMedia), '.navLabel')).not.toContain('display: none')
    expect(block('.navLabel')).toContain('text-overflow: ellipsis')
  })

  it('keeps the close button accessible name in the visually-hidden seat', () => {
    // The close control paints a glyph; its name comes from slot content in
    // the visually-hidden seat, so the seat must stay 1px-clipped, not
    // display:none.
    const seat = block('.hiddenLabel')
    expect(seat).toContain('position: absolute')
    expect(seat).toContain('width: 1px')
    expect(seat).toContain('clip: rect(0 0 0 0)')
    expect(seat).not.toContain('display: none')
  })
})
