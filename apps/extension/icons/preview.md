# OpenBrowserHarness action icon

One metaphor: a smart pointer whose tip breaks into an engine orbit —
the agent harnessing web pages through a humanized cursor. The two glowing
nodes on the ring are touch points; the core glow behind the pointer is the
agent engine. Nothing else competes with the pointer, so the mark survives 16px.

## Files

- `icon.svg` — vector source of truth (viewBox 0 0 128)
- `icon16.png` / `icon32.png` / `icon48.png` / `icon128.png` — rendered from the SVG

Regenerate after editing the SVG:

```sh
tmp=$(mktemp -d) && cd "$tmp" && npm i @resvg/resvg-js >/dev/null
node -e '
const { Resvg } = require("@resvg/resvg-js");
const fs = require("fs");
const svg = fs.readFileSync(process.argv[1], "utf8");
for (const s of [16, 32, 48, 128]) {
  fs.writeFileSync(
    process.argv[2] + "/icon" + s + ".png",
    new Resvg(svg, { fitTo: { mode: "width", value: s }, font: { loadSystemFonts: false } }).render().asPng(),
  );
}' /path/to/apps/extension/icons/icon.svg /path/to/apps/extension/icons
```

Note: `manifest.json` does not reference these yet; wire
`icons`/`action.default_icon` when the branding lands.

## Palette

| Token | Value | Role |
| --- | --- | --- |
| `#6291FF` | gradient stop 0% | lightest electric blue (top-left) |
| `#3A5CE9` | gradient stop 38% | mid transition |
| `#2036A6` | gradient stop 72% | royal depth |
| `#101C4F` | gradient stop 100% | deep-space navy (bottom-right) |
| `#4C7DFD` | — | product brand primary; hue anchor of the ramp above |
| `#8A5CFF` @ 45%→0 | top-right radial | violet cast |
| `#FFFFFF` | pointer / orbit / nodes | focal elements |
| `#050D2E`, `#060F33` | vignette, pointer shadow | grounding |
