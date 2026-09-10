# Agent Note: The settings surface is full-bleed and flat inside the extension SidePanel

Status: implemented

English | [中文](2026-08-29-settings-surface-flat-redesign.zh.md)

## Problem

`SettingsRoot` was designed as a web-page modal: a gray mask overlay plus an inset, max-width, heavily-shadowed rounded card. Mounted into a 387px extension SidePanel that presentation read as a big gray container with a white card floating inside it — the user's words: a huge gray gap around an inner card, and none of it premium. Three aggravators rode along: the section tab row overflowed into a horizontal scrollbar; the card carried its own × duplicating the shell's close; and inside the card the surfaces nested again — an options container, a section block, a rail card, a form-group card, and finally the inputs, each with its own background/border/radius, with `.section { height: 100% }` stretching a large blank gray run-out below short content. The AX tree stopped at the headers textarea: everything below was mounted but unreachable.

## Decision

At host widths ≤768px the settings surface is a full-bleed sheet, and it is flat.

- **Full bleed.** The mask is `display: none`; `.panel` is 100%×100% on `bg-base` with no radius, border, or shadow, so the tab band sits flush under the shell header — the sheet reads as a continuation of the shell, not a dialog over it. Both a `@media` and a `@container` (the overlay is the inline-size container) carry identical rules, and the breakpoint moved from 559px to the shell's central 768px. Above 768px the centered card remains, tightened: r16, a 1px label-8% hairline, `--dsw-shadow-lv2` instead of the heavy slab.
- **One 36px topbar.** The "设置" title row is gone (a visually-hidden seat keeps the dialog's `aria-labelledby`); the band carries the tabs, the action seat, and the single ×. Tabs are underline-style — 12.5px labels over a 2px brand underline that overlays the band's own hairline — with the scrollbar removed by starvation: tighten paddings, at ≤430px drop the glyphs (the text labels stay, since they are the tabs' accessible names), then ellipsis.
- **Flat content.** Inside `ui-settings-models` nothing is a card: the rail is a bare chip strip, the editor and form groups sit directly on `bg-base`, the model catalog rows are plain rows with an inline ghost add button, and groups separate by a 1px label-8% hairline above the save region. Inputs are tinted fills — `interactive-bg-hover[-solid]`, r8, 34px, transparent resting border, brand focus ring — and every button is `white-space: nowrap`.
- **Type scale stepped down**: page title 15/600, group titles 12/600, body and inputs 13px, hints 12px muted.

The settings read/write logic and wire payloads are untouched; this is presentation and surface only. `ModelsSection`'s group structure from the same day's provider work survives — the flattening changes how surfaces look, not what is grouped.

## Alternatives considered

- **Moving the tab row into the shell header line** (the user's first suggestion). The settings surface is a `position: fixed; inset: 0` modal layer that covers the shell header; sharing the header row means de-modalizing the surface and reworking a settled header, and it would break the >768px centered-card form. The chosen equivalent — deleting the surface's own title row and letting the 36px tab band sit flush under the shell header — reads the same way at a fraction of the churn.
- **Shell-side class-stem overrides (`[class*="overlay"]`, `[class*="panel"]`).** The established shell pattern, but it would have left the modal-card design as the source of truth and bolted an extension-specific counter-design beside it. Fixing `SettingsRoot.module.css` directly gives dsh web narrow windows the same benefit and keeps one source of truth. The shell now pins a guard that it must not grow `[class*="overlay"/"panel"]` overrides for this slot.
- **`bg-layer-1` for the tinted input fills, per the first spec.** Invisible in the light theme: there `bg-layer-1` equals `bg-base`, so the fill disappears. The fills use `--dsw-alias-interactive-bg-hover[-solid]` — the application's standard 6–8% tint, visible in both themes.
- **Tinted form-group cards.** Round-1 screenshots showed a tinted group surface stacked above tinted inputs re-introduces the nesting feel the redesign removes. Groups are flat: a 12/600 muted title over its fields.

## Consequences

The extension settings read as a native settings page: no gray gutters, no nested cards, everything scrollable end-to-end (the AX tree reaches the model rows, the add-model button, the probe, and save — previously it stopped at the headers textarea). The dialog semantics survive the de-carding: the accessible name rides the hidden seat, Escape closes, and the single × is the pointer close (mask-click closing does not exist in the full-bleed form). Wide hosts keep a card, so the mask-click close path stays there.

The dsh web app inherits the change: narrow web windows get the same full-bleed sheet, wide windows the tightened card. A headless-Chrome screenshot harness (built at `/tmp/dsh-settings-flat/`, regenerable) rendered the real module.css at 387/494/900 in both themes through two visual iterations; the harness discovered its own trap — headless Chrome's minimum window width is 500px, so a "387px" screenshot must host the document in an iframe for the media queries to answer the iframe viewport.

## Testing

`packages/client/ui-settings-general/tests/styles.client.spec.ts` pins the full-bleed twins, the token discipline (no literal colors), the no-scrollbar tab band, and the icon-drop ladder; `settings-root.client.spec.tsx` pins the topbar structure and the hidden title seat; `packages/client/ui-settings-models/tests/styles.client.spec.ts` pins the flat discipline (no card surfaces on rail/editor/formGroup/catalog, tinted transparent-resting-border inputs, button nowrap) alongside the provider grouping; `apps/extension/tests/caps-css.spec.ts` pins the shell mount class and the absence of class-stem overrides. The three suites run green together (34 files, 305 tests at the change point).
