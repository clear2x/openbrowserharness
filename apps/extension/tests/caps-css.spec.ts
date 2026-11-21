// @vitest-environment jsdom
/**
 * SHELL_CSS regression pins: the capability-panel hide-rule selectors that
 * keep the docked dsh conversation tree from hiding its live seats, plus the
 * button no-wrap discipline (operation buttons pin one-line labels; text
 * rows wrap as whole buttons). The panel renders ConversationRoot inside
 * `.dshx-caps-body`; the rules must hide the dsh transcript and the duplicate
 * dsh composer surfaces WITHOUT touching the seats the shell surfaces
 * natively — `conversation.input.dock` (goal bar / todo strip / queue) and
 * `conversation.input.plan` (the plan-mode exit chip) — and must no longer
 * kill the whole scrollBody (the old wholesale rule took the composer seat
 * down with the transcript). String pins, so a revert fails these tests.
 */
import { describe, expect, it } from 'vitest'
import { SHELL_CSS } from '../src/sidepanel-dsh/extension-shell.tsx'

describe('SHELL_CSS capability-panel hide rules', () => {
  it('hides the dsh transcript by its session-body slot, not the scrollBody', () => {
    expect(SHELL_CSS).toContain('.dshx-caps-body [data-slot="conversation.session"]{display:none!important}')
    // The old wholesale kill — `[class*="scrollBody"]{display:none!important}`
    // — hid the composer seat (docks, plan chip) together with the transcript.
    expect(SHELL_CSS).not.toContain('[class*="scrollBody"]{display:none')
    // The old fallback-anchor kill hid the whole composerBar, taking the
    // input.dock rows down with the InputBar.
    expect(SHELL_CSS).not.toContain('[data-chain-overlay-fallback="conversation.composer"]{display:none')
  })

  it('leaves the dock and plan seats un-hid', () => {
    expect(SHELL_CSS).not.toContain('[data-slot="conversation.input.dock"]{display:none')
    expect(SHELL_CSS).not.toContain('[data-slot="conversation.input.plan"]{display:none')
    // The composer seat anchor itself has no hide rule.
    expect(SHELL_CSS).not.toContain('[data-composer-seat]{display:none')
  })

  it('strips the duplicate dsh composer bar instead of hiding the whole bar', () => {
    // The draft scrollport, model/send chrome, notices, and stats line die;
    // the plan-mode chip seat (inside the bar's tool row) must survive, so
    // the bar wrapper itself is never display:none'd.
    expect(SHELL_CSS).toContain('.dshx-caps-body [data-slot="conversation.composer.bar"] [data-input-scroll]{display:none!important}')
    expect(SHELL_CSS).toContain('.dshx-caps-body [data-slot="conversation.composer.bar"] [class*="trailing"]{display:none!important}')
    expect(SHELL_CSS).toContain('.dshx-caps-body [data-slot="conversation.composer.dock"]{display:none!important}')
    expect(SHELL_CSS).toContain('.dshx-caps-body [data-composer-card]{border:none')
    expect(SHELL_CSS).not.toContain('[data-slot="conversation.composer.bar"]{display:none')
  })

  it('hides the answerable composer takeovers the shell InteractionCards replace', () => {
    expect(SHELL_CSS).toContain(
      '.dshx-caps-body [data-slot="conversation.composer"] > :not([data-chain-overlay-fallback]){display:none!important}',
    )
  })

  it('keeps the view-tab and hero-chrome rules', () => {
    expect(SHELL_CSS).toContain('.dshx-caps-body [class*="tabs"]{display:none!important}')
    expect(SHELL_CSS).toContain('.dshx-caps-body [class*="heroGlow"]{display:none!important}')
    expect(SHELL_CSS).toContain('.dshx-caps-body [class*="heroWorkspaceRow"]{display:none!important}')
  })

  it('conceals time-context readings from the chat flow', () => {
    // Model-facing only: the log and the trajectory view keep every reading;
    // the seat attribute carries the durable producer name (no plugin table).
    expect(SHELL_CSS).toContain('[data-chat-flow-producer="time-context"]{display:none!important}')
  })

  it('drops the 能力面板 strip chrome entirely (removed with the strip)', () => {
    // The labeled toggle bar is gone: no head row, no collapse clamp, no
    // idle-hide shim — the card mounts only once a conversation exists (or
    // a pending approval needs the surface), so none of the old state CSS
    // may survive in the sheet.
    expect(SHELL_CSS).not.toContain('.dshx-caps-toggle')
    expect(SHELL_CSS).not.toContain('.dshx-caps.is-hidden')
    expect(SHELL_CSS).not.toContain('.dshx-caps-body.is-collapsed')
  })

  it('shares one width lane between the capability card and the input capsule', () => {
    // Side paddings live on the two lane wrappers; the centered 760 cap rides
    // the cards themselves, so the lane adapts at every host width (a
    // dragged-wide side panel included) and the card/capsule edges coincide.
    expect(SHELL_CSS).toContain(
      '.dshx-composer .dshx-capsule,\n.dshx-caps-lane .dshx-caps{width:100%;max-width:760px;margin:0 auto;box-sizing:border-box}',
    )
    // The composer strip is an unpainted spacer — no full-bleed divider line
    // above the input card on wide hosts.
    expect(SHELL_CSS).toContain('.dshx-composer{flex:0 0 auto;padding:0 12px 12px}')
  })

  it('anchors the user bubble on the theme-invariant DeepSeek blue', () => {
    // --dsw-alias-brand-primary is monochrome by design (near-black in light,
    // near-white in dark): it read as a black slab in light mode and would
    // put white text on white in dark. The static token keeps one blue.
    const ruleStart = SHELL_CSS.indexOf('.dshx-userbubble{')
    expect(ruleStart).toBeGreaterThan(-1)
    const rule = SHELL_CSS.slice(ruleStart, SHELL_CSS.indexOf('}', ruleStart))
    expect(rule).toContain('background:var(--dsw-static-deepseek-500,#4176e6)')
    expect(rule).not.toContain('brand-primary')
  })

  it('flips the enabled send arrow to ink in dark mode', () => {
    // The send arrow is hard-coded #fff on brand fill; the brand alias is
    // near-white in dark, so without this override it would vanish. The
    // welcome glyph is the toolbar icon artwork (an img) and needs no
    // foreground. Disabled keeps its own brand-mix ghost, so the flip
    // scopes to :not(:disabled).
    expect(SHELL_CSS).toContain(
      'body[data-ds-dark-theme] .dshx-send:not(:disabled){color:var(--dsw-static-neutral-bluish-1000,#171717)}',
    )
  })

  it('ghosts the disabled send button off the brand alias, not bg-layer-3', () => {
    // This theme collapses every --dsw-alias-bg-layer-* to #fff, so the old
    // disabled surface (bg-layer-3 + #fff arrow at .6 opacity) rendered a
    // white circle with a white arrow on a white card — invisible. The ghost
    // mixes the monochrome brand alias instead, visible in both themes.
    expect(SHELL_CSS).toContain(
      '.dshx-send:disabled{cursor:default;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 8%,transparent);color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c7dfd) 32%,transparent);box-shadow:none}',
    )
    expect(SHELL_CSS).not.toContain('.dshx-send:disabled{cursor:default;background:var(--dsw-alias-bg-layer-3')
  })

  it('pins the session sheet inside the panel on narrow viewports', () => {
    // ≤560px the history anchor sits ~210px from the left edge; the 300px
    // right-anchored default spills past the panel's LEFT edge. The sheet
    // switches to a viewport-fixed panel-pinned surface (doubled specificity
    // so the later-joined POPOVER_CSS base rules lose).
    expect(SHELL_CSS).toContain(
      '@media (max-width: 560px){\n  .dshx-pop.dshx-sessionspop{position:fixed;left:8px;right:8px;top:50px;width:auto}\n}',
    )
  })
})

describe('SHELL_CSS button no-wrap discipline', () => {
  /**
   * The SidePanel runs 320–800 px; a wrapped button label (e.g. 确认删除
   * breaking mid-word at 387 px) reads broken. Every text-bearing shell
   * button pins one line; overflow ellipsizes instead of wrapping.
   */
  const pin = (selector: string, fragment: string): void => {
    // A selector may appear more than once (e.g. the ≤430 media overrides sit
    // earlier in the sheet than the base rules) — some occurrence must carry
    // the pinned property.
    const bodies: string[] = []
    let at = SHELL_CSS.indexOf(selector)
    while (at !== -1) {
      bodies.push(SHELL_CSS.slice(at, SHELL_CSS.indexOf('}', at) + 1))
      at = SHELL_CSS.indexOf(selector, at + 1)
    }
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies.some(body => body.includes(fragment))).toBe(true)
  }

  it('keeps the one-line pins on the ghost/chip/example buttons', () => {
    pin('.dshx-ghostbtn{', 'white-space:nowrap')
    pin('.dshx-chipbtn{', 'white-space:nowrap')
    // The example card is a flex row (icon + label + arrow); the single-line
    // clamp lives on the label span so a long prompt degrades to an
    // ellipsis, never a second line.
    pin('.dshx-example-label{', 'white-space:nowrap')
    pin('.dshx-example-label{', 'text-overflow:ellipsis')
  })

  it('wraps the error-action row as whole buttons', () => {
    pin('.dshx-error-actions{', 'flex-wrap:wrap')
  })
})

describe('SHELL_CSS settings mount', () => {
  it('anchors the SettingsRoot occupant in the header row', () => {
    // The mount box only anchors the 36px trigger circle; the dialog paints
    // viewport-fixed above the shell.
    expect(SHELL_CSS).toContain('.dshx-settingsmount{flex:none;display:flex;align-items:center}')
  })

  it('carries no class-stem overrides for the settings sheet', () => {
    // The full-bleed narrow form, tab band, and card dressing are
    // ui-settings-general's own (the direct package fix); a shell-side
    // [class*="overlay"/"panel"] override here would fork the styling into
    // two sources of truth.
    expect(SHELL_CSS).not.toContain('[class*="overlay"]')
    expect(SHELL_CSS).not.toContain('[class*="panel"]')
  })
})
