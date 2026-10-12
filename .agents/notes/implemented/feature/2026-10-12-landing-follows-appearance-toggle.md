# Agent Note: the landing page follows the appearance toggle

Status: implemented

English | [中文](2026-10-12-landing-follows-appearance-toggle.zh.md)

## Problem

The user reported that the dark/light switch on the GitHub Pages site did nothing. The landing route pinned its palette dark in both modes: `theme/custom.css` re-declared the `--vp-c-*` set under an unconditional `body:has(.VPHome)`, so flipping the toggle toggled `html.dark` but changed no pixel of the home surface — the body-scoped dark values applied in light mode too. Documentation pages toggled normally; only the home route was dead.

## Decision

The landing now renders one palette per appearance mode:

- **Token layer**: every landing color lives in a `--landing-*` custom property declared once per mode — light values on `:root`, the previous hardcoded dark values on `html.dark` (same-element specificity, later block wins). Component rules reference tokens only; no rule hardcodes a color.
- **Scoped dark pin**: the `--vp-c-*` re-declaration (nav, search modal, cards) moved under `html.dark body:has(.VPHome)`, so the stock light palette applies in light mode. The mode-independent derived variables (`--vp-nav-bg-color`, `--vp-local-search-*`) stay re-declared on `body:has(.VPHome)` per the variable-resolution rule recorded in the 2026-09-28 landing note.
- **Light palette**: white surface, ink hairlines, deep-cyan and indigo accents — the plain-engineering language mapped onto white; the primary CTA keeps its gradient border through a two-layer background (solid padding-box fill plus gradient border-box).
- **Orbit artwork**: `OrbitArt.vue` reads `useData().isDark` and swaps its ring/spark RGB triplets per mode. The animated loop re-reads the palette every frame; the static reduced-motion composition redraws once on a flip through a `watch`. Faint static strokes carry a per-mode gain multiplier (×1.6 on white, 1 on ink) because white washes hairline strokes out faster than near-black.

Verification: `website:build` passed; a nine-assertion Playwright matrix (initial light, toggle to dark, toggle back, docs-page toggle, per-mode token colors) passed; full-page captures of both modes were visually checked. Dark mode is unchanged against the previous live site because the dark token values are the previous hardcoded values.

## Alternatives considered

**Hide the toggle on the home route.** Rejected: the report is that switching does not work; removing the switch preserves the defect and leaves light-mode visitors on a dark page.

**Keep the landing dark and let only documentation pages toggle.** Rejected: the nav is shared, so a dark home under a light nav after one navigation reads as breakage, not as a choice.

**Duplicate the landing CSS per mode.** Rejected: two copies of every rule drift apart; the token layer states each color once per mode.

## Consequences

The appearance toggle now switches the whole site. Dark mode is unchanged; light mode is a new surface built entirely from tokens, so future landing color changes edit the two token blocks. The 2026-09-28 landing note was updated where it asserted the old state (dark in both color modes, aurora backdrop, screenshot-collage hero, load-only motion).

## Follow-up (same day): mojibake tab title in the landing shots

The user reported garbled text in the tab selector of the last landing image. The learn-site fixture pages the panel shots are captured against are UTF-8 but carried no charset declaration, and `python3 -m http.server` serves `text/html` without a charset parameter, so the browser sniffed a legacy CJK encoding: the fixture tab's title reached the SidePanel header tab selector as mojibake, and the real-machine shoot baked it into `panel-learn`/`panel-presets` (`panel-trajectory` shows the panel's own tab and was never affected). The shoot script now writes the fixture itself with `<meta charset="utf-8">` on every page — no leftover `/tmp` state — and gates each screenshot on the tab selector's decoded text before capturing; all three shots were re-captured and the site redeployed.
