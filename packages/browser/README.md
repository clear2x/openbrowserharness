---
description: "The browser capability family: the provider-neutral ctx.browser seam, its extension CDP provider, and the model-facing tab/page tools."
kind: "package-group"
---

# browser/ — browser capability family

English | [中文](README.zh.md)

## Summary

The family that gives the harness eyes and hands inside a real browser: the provider-neutral `ctx.browser` seam, the CDP provider the extension assembles, and the model-facing tools.

| Package | Role | ctx key |
|---|---|---|
| [`browser/`](browser/README.md) | Service Definition: provider registry, selection policy, wire vocabulary | `ctx.browser` |
| [`tool-browser/`](tool-browser/README.md) | Consumer: the model-facing `tabs_*` / `page_*` tools | registers on `ctx.tools` |

The split follows the [`web/`](../web/README.md) family: providers register capabilities; the tool package owns every model-facing name, schema, and presentation. The CDP provider ships with the app bundle, not the library.

## Related documentation

- [Browser subsystem](../../docs/subsystems/browser.md) — the operation facade, snapshot vocabulary, humanized input, and the seam/provider/consumer split this family implements.
