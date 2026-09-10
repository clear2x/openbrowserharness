# browser/ — browser capability family

English | [中文](README.zh.md)

This family gives the harness eyes and hands inside a real browser: the provider-neutral seam for tab and page automation (`ctx.browser`), the Chrome-extension CDP provider assembled in `apps/extension`, and the model-facing tools that consume the seam.

| Package | Role | ctx key |
|---|---|---|
| [`browser/`](browser/README.md) | Service Definition: provider registry, selection policy, and the `PageSnapshot`/`TabInfo`/`BrowserProvider` wire vocabulary | `ctx.browser` |
| [`tool-browser/`](tool-browser/README.md) | Consumer: the model-facing `tabs_*` / `page_*` tools and the snapshot-first browser guidance | registers on `ctx.tools` |

The seam/provider/consumer split follows the [`web/`](../web/README.md) capability family: providers register capabilities (never tools) on one selection-policy owner, and the tool package owns every model-facing name, schema, prompt section, and presentation. The extension's CDP provider lives outside `packages/` because it ships with the app bundle, not the library.
