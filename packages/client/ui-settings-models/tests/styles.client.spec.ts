/**
 * Models section stylesheet contract, asserted against the CSS text on disk.
 *
 * The section paints in both themes, and a `--dsw-*` name the theme does not
 * declare fails silently: the browser takes the `var()` fallback, so the sheet
 * still renders and only the dark theme looks wrong. Checking the names against
 * the sheet that declares them is what turns that into a test failure.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/ModelsSection.module.css', import.meta.url)), 'utf8')
// The theme package maps `./styles/*` to `./src/styles/*`, so the declarations
// stay on the source plane rather than needing a build.
// Every theme sheet, not just the platform tokens: font and scrollbar
// variables are declared in siblings, and a gate reading one file would call
// their names undeclared.
const tokens = readdirSync(fileURLToPath(new URL('../../ui-theme/src/styles/', import.meta.url)))
  .filter(name => name.endsWith('.css'))
  .map(name => readFileSync(fileURLToPath(new URL(`../../ui-theme/src/styles/${name}`, import.meta.url)), 'utf8'))
  .join('\n')

/** The declarations of one top-level rule, by selector (escaped, so
 * `:not(...)` pseudo arguments are matched literally). */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`ModelsSection.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

/**
 * The body of one `@media`/`@container` block, by brace matching (its rules
 * are nested, so a line-anchored selector match cannot see them).
 */
function atBlock(header: RegExp): string {
  const match = header.exec(css)
  if (match === null) throw new Error(`ModelsSection.module.css has no \`${header.source}\` block`)
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

/** The narrow-shell breakpoint headers: the media primary and its container twin. */
const narrowMedia = /@media \(max-width:\s*559px\)/
const narrowContainer = /@container \(max-width:\s*559px\)/

describe('ModelsSection theme styles', () => {
  it('names only theme variables the token sheet defines', () => {
    // A `--dsw-*` name the sheet never declares is not a near miss: it silently
    // resolves to whatever literal sits in its fallback slot, which is how this
    // section stayed light under the dark theme before. Undeclared names have
    // no fallback at all and inherit, so both spellings must fail here.
    // Every theme-variable prefix the sheets actually use, not just `--dsw-`:
    // a `--dsh-` name reads as a plausible sibling and would otherwise slip
    // past this gate into a fallback literal.
    const named = [...css.matchAll(/var\((--(?:dsw|dsh|ds)-[a-z0-9-]+)/g)].map(match => match[1])
    const undeclared = [...new Set(named)].filter(name => !tokens.includes(`  ${String(name)}:`))
    expect(undeclared).toEqual([])
    expect(css).not.toMatch(/var\(--(?:surface|text-|border|accent-strong)/)
  })

  it('closes every block, so no rule is swallowed by the one above it', () => {
    // A missing `}` on an `@media` block is not a parse error: every rule after
    // it silently becomes conditional, and the whole fetch dialog once painted
    // unstyled for anyone whose system does not ask for reduced motion. Nothing
    // downstream reports this — the sheet loads and the classes still attach.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect((bare.match(/\}/g) ?? []).length).toBe((bare.match(/\{/g) ?? []).length)
  })

  it('lays the section flat on the shell sheet: rail and editor carry no card dressing', () => {
    // The flattened design keeps one surface: nothing between the shell's
    // `bg-base` sheet and the controls may paint its own fill, border,
    // radius, or padding — that nesting is the gray-on-gray card stack the
    // redesign replaces. The only fills are the controls themselves.
    expect(block('.editor')).not.toMatch(/(background|border|padding)\s*:/)
    expect(block('.rail')).not.toMatch(/(background|border|padding)\s*:/)
    expect(block('.railItem')).toContain('background: transparent')
    expect(block('.railItem')).not.toContain('bg-module-platform')
    // The selected chip reads through its own filled capsule: the solid hover
    // token is visible on `bg-base` in both themes (a `bg-layer-1` fill would
    // vanish against the light sheet, where both resolve to white).
    expect(block('.railItemActive')).toContain('background: var(--dsw-alias-interactive-bg-hover-solid)')
    expect(block('.railItemActive')).not.toContain('bg-module-platform')
    // No dashed frames anywhere — the plus glyphs carry the add affordance.
    // Comment-stripped: this gate reads declarations, not prose.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(bare).not.toContain('dashed')
  })

  it('keeps groups uncarded: captions bind them, tinted controls carry the fills', () => {
    // A form group is a caption plus its fields, bound by spacing — not a
    // bordered box nested in the editor. The row-level surfaces (model rows,
    // the inline dialog, the format cards) are controls, so they keep the
    // shared tint fill without a permanent border.
    for (const group of ['.formGroup', '.modelCatalog']) {
      expect(block(group)).not.toMatch(/border|background|padding/)
    }
    // Group captions: small, bold, letter-spaced.
    expect(block('.formGroupTitle')).toContain('letter-spacing')
    expect(block('.modelCatalogTitle')).toContain('letter-spacing')
    expect(block('.modelEntry')).toContain('background: var(--dsw-alias-interactive-bg-hover)')
    expect(block('.modelEntry')).not.toMatch(/border:\s*1px/)
    expect(block('.modelDialog')).toContain('background: var(--dsw-alias-interactive-bg-hover)')
    expect(block('.modelDialog')).not.toMatch(/border:\s*1px/)
    expect(block('.protocolCard')).toContain('border: 1px solid transparent')
    expect(block('.protocolCard')).toContain('background: var(--dsw-alias-interactive-bg-hover)')
    // The pick's brand border rides the shared (grouped) active rule.
    expect(block('.protocolCardActive,\n.protocolCardActive:hover:not(:disabled)'))
      .toContain('border-color: var(--dsw-alias-brand-primary)')
  })

  it('separates the footer actions on the shared label-color hairline', () => {
    // The one divider on the flat sheet: the hairline above the save row,
    // on the same 8% label mix the settings shell dresses its band with.
    expect(block('.editorActions')).toContain(
      'border-top: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)')
  })

  it('fills the inputs on the shared flat recipe: 34px, r8, tint fill, brand focus ring', () => {
    // The tint (`interactive-bg-hover`) stays visible on `bg-base` in both
    // themes; the resting border is transparent so the focus border never
    // shifts layout.
    const input = block('.input')
    expect(input).toContain('height: 34px')
    expect(input).toContain('border-radius: 8px')
    expect(input).toContain('background: var(--dsw-alias-interactive-bg-hover)')
    expect(input).toContain('border: 1px solid transparent')
    const focus = block('.input:focus')
    expect(focus).toContain('border-color: var(--dsw-alias-brand-primary)')
    expect(focus).toMatch(/box-shadow: 0 0 0 2px color-mix\(in srgb, var\(--dsw-alias-brand-primary\) 18%, transparent\)/)
  })

  it('keeps the button discipline: nowrap, 150ms transitions, press states, brand focus ring', () => {
    // The 36px family shares one block; nowrap and the transition live there.
    const family = block('.primaryButton,\n.secondaryButton,\n.linkButton,\n.addModelButton')
    expect(family).toContain('white-space: nowrap')
    expect(family).toContain('transition:')
    // Hover lifts on the token, active presses via the brightness filter.
    expect(block('.primaryButton:hover:not(:disabled)')).toContain('background: var(--dsw-alias-button-primary-hover)')
    expect(block('.primaryButton:active:not(:disabled)')).toContain('filter: brightness(0.92)')
    // Danger reads as danger on its own border, and never wraps.
    expect(block('.dangerButton')).toMatch(/border: 1px solid color-mix\(in srgb, var\(--dsw-alias-state-error-primary\) 40%, transparent\)/)
    expect(block('.dangerButton')).toContain('white-space: nowrap')
    expect(block('.linkButton')).toContain('white-space: nowrap')
    // Focus rings are the brand halo, not the neutral border token.
    const ring = 'box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent)'
    expect(block('.primaryButton:focus-visible,\n.secondaryButton:focus-visible,\n.dangerButton:focus-visible,\n.linkButton:focus-visible,\n.addModelButton:focus-visible,\n.railAdd:focus-visible,\n.railItem:focus-visible,\n.protocolCard:focus-visible')).toContain(ring)
    expect(block('.keyToggle:focus-visible')).toContain(ring)
    expect(block('.modelDialogClose:focus-visible')).toContain(ring)
  })

  it('drops the two-pane layout to a chip strip below 560px of panel width', () => {
    // The SidePanel is its own document (panel width IS the viewport width),
    // so a media query is the dependable primary switch; the container query
    // twin covers this section being embedded in a wider host document. Both
    // must carry the identical chip-strip rules — dropping either one
    // regresses one of the two deployment surfaces.
    expect(css).toMatch(/container-type:\s*inline-size/)
    expect(css).toMatch(narrowContainer)
    expect(css).toMatch(narrowMedia)

    const body = atBlock(narrowContainer)
    expect(body).toContain('flex-direction: column')
    expect(body).toContain('overflow-x: auto')
    // The chip must hug its name when the strip has free space: the wide
    // rail's `.railItemWrap .railItem { flex: 1 1 auto }` carries a two-class
    // specificity the bare narrow `.railItem` rule cannot outrank, and a
    // stretched chip drags its row action (设为默认) to the far edge.
    for (const narrow of [atBlock(narrowMedia), atBlock(narrowContainer)]) {
      expect(ruleIn(narrow, '.railItemWrap .railItem')).toContain('flex: none')
      // The endpoint line shrinks a step so the three-across format row keeps
      // its paths as small as possible at the 387px floor.
      expect(ruleIn(narrow, '.protocolCardEndpoint')).toContain('font-size: 11px')
    }
  })

  it('lets the shell options area own the scroll below 560px', () => {
    // The section claims no height: `height: 100%` once stretched a
    // content-poor section down the sheet, leaving a dead remainder below the
    // form. The shell's `.options` is the only scroller, so the narrow blocks
    // carry neither a `.section` height rule nor a `.pane` scroller of their
    // own — the section keeps its content height and scrolls with the page.
    for (const narrow of [atBlock(narrowMedia), atBlock(narrowContainer)]) {
      expect(narrow).not.toMatch(/\.section\b/)
      expect(narrow).not.toMatch(/\.pane\b/)
      expect(narrow).not.toContain('height: 100%')
      expect(narrow).not.toContain('overflow-y')
    }
  })

  it('gives every dropdown the shared chevron instead of the OS arrow', () => {
    // `select.input` caps the control at 240px, and the OS arrow is painted
    // flush inside that shrunk right edge — visibly tighter than every other
    // control on the page. `.selectInput` is what removes it, reserves the
    // right pad, and paints the shared chevron; a `<select>` that takes
    // `.input` alone silently keeps the OS one.
    const sources = readdirSync(fileURLToPath(new URL('../src/client/', import.meta.url)))
      .filter(name => name.endsWith('.tsx'))
      .map(name => ({
        name,
        text: readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), 'utf8'),
      }))
    const bare = sources.flatMap(({ name, text }) => text
      .split('<select')
      .slice(1)
      // The element's own attributes end at the first `>`; a child `<option>`
      // carries no className of its own and must not answer for the select.
      .map(rest => rest.slice(0, rest.indexOf('>')))
      .filter(attributes => !attributes.includes('selectInput'))
      .map(() => name))
    expect(bare).toEqual([])
  })

  it('never falls back to a literal colour', () => {
    // A token that resolves is never the problem; an undeclared one takes this
    // branch, and a literal here is a single colour for both themes.
    expect(css).not.toMatch(/var\(--dsw-[a-z0-9-]+\s*,\s*(?:#|rgb|rgba|hsl|hsla)/)
  })
})
