# Agent Note: extension-only docs site and the branded landing page

Status: implemented

English | [中文](2026-09-28-extension-only-docs-site-and-branded-landing.zh.md)

## Problem

The documentation site projected the whole inherited dsh corpus, so a Chrome Web Store reviewer landing on the privacy policy saw upstream CLI documentation for a product the extension does not ship — the Python SDK, GitHub review sessions, and a "DeepSeek Harness" home page. The default VitePress home read as a bare docs index, and the first branding pass (a dark hero band over an otherwise light page) left the white nav search box and light cards visually disconnected from the hero. The store submission needs a first page that is unambiguously this product.

## Decision

The site now publishes only the extension's own corpus, and the home route is a branded product page:

- **Reduced publication manifest** (`website/docs.ts`): two `layout: home` locale homes (`docs/extension/index.md`/`.zh.md`), five guide pages (quickstart, providers, automation, permissions, user plugins), and the privacy policy at `reference/privacy` under a Policies sidebar group. The upstream corpus (Cordis tutorial, subsystems, SDK, cookbook) stays in the repository unprojected; the `zh-develop`/`en-develop` collections and their nav entries are gone.
- **Landing page composition** is frontmatter plus `LandingLayout.vue`, with the section copy in `landing-copy.ts`: the headline, tagline, and actions from frontmatter over a scripted browser-window-and-side-panel stage (`HeroStage.vue`, seated through the `home-hero-image` slot), a stats strip after the hero, the feature grid with inline stroke-SVG icons, and long-form sections after it (how-it-runs, design notes, preset picker, install steps, closing call to action). The stage is a scripted illustration, not a recording: it names shipped tools, carries a recorded reply, and says so in its caption. The hero's visual was a collage of three re-shot panel screenshots, then a generative orbit canvas behind the copy, before the stage.
- **The immersive dark home** re-declares the full `--vp-c-*` palette plus `--vp-local-search-*` and `--vp-nav-bg-color` for the home route in `theme/custom.css`, originally over a generated aurora backdrop (the user's `gpt-image-2.5` endpoint, a 102 KB JPEG). The 2026-10-08 redraw replaced that backdrop, first with a generative orbit canvas and then with the hero stage; on 2026-10-12 the pin moved under `html.dark body:has(.VPHome)` so the appearance toggle switches the landing surface (see that day's note).
- **Motion** is entrance, scroll-reveal, and the stage loop: the hero copy and the stage rise on load, below-fold `[data-reveal]` sections fade in through an IntersectionObserver, and the stage plays its turn while any part of it is in the viewport. The hidden reveal start state applies only under the `dsh-landing-js` class, which an inline head script sets, so the page is complete without JavaScript; `prefers-reduced-motion` shows the stage's last frame and every section.

### Projection mechanics the content depends on

`sidebar: null` pages are locale homes: the projector publishes only their frontmatter, so home content lives entirely in YAML and the body carries just the H1 plus the language switcher (the pairing gate requires the switcher directly after the H1). Repository-relative links in guide pages are rewritten onto site routes by the projector; links inside frontmatter are not (YAML is opaque to the mdast rewriter), so hero links are written in site form directly.

### The dark-theme variable rule

Custom properties resolve at `:root`, so inherited declarations like `--vp-local-search-bg: var(--vp-c-bg)` carry the already-resolved light value; the body scope must re-declare the derived variables for them to re-resolve on the dark palette. This is why a body-level `--vp-c-bg` override alone left the search modal white.

## Alternatives considered

**A custom Vue home component replacing `VPHome`.** Rejected: the slot surface plus frontmatter achieves the composition with zero component maintenance, keeps the bilingual pairing gates operating on the source markdown, and survives VitePress upgrades; a full replacement would fork the default theme's home layout.

**A separate store microsite outside the repository.** Rejected: the GitHub Pages pipeline already existed (public repo, deployed workflow), keeps materials versioned with the code, and one privacy-policy URL serves both the repository and the store listings.

**Keeping the upstream corpus on the site under a clear separation.** Rejected: the store reviewer is one click from the policy page; any upstream content on the same domain invites the wrong-product reading the kit exists to prevent.

**CSS-only hero glow instead of generated artwork.** Rejected after the first branded pass read as generic: the generated aurora gives the surface real depth for 102 KB, and the image-generation endpoint was provided for exactly this.

## Consequences

The site no longer serves the upstream developer documentation — those documents are read on GitHub, and the site's job is the extension product. The theme carries extra layout files and a `vue` devDependency (types only; both were caught by the pre-push typecheck). Landing copy is duplicated per locale: hero and features in frontmatter, which the pairing gate polices, and the remaining sections in `landing-copy.ts`, which no gate pairs. The payoff: the store listing's first click lands on a page that is unambiguously this product — dark-ink in dark mode, and light since the 2026-10-12 appearance-toggle fix — with a repeatable screenshot self-check loop (build, Playwright capture, live re-check after deploy) that every subsequent landing change has gone through.
