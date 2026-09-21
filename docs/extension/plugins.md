# User plugins

English | [中文](plugins.zh.md)

You can extend the agent with small plugins you write yourself. The extension ships no third-party plugins and distributes none.

## What a plugin is

A plugin is a JavaScript factory: a function that receives the plugin context and subscribes to the engine's declared events through it.

```js
function (ctx) {
  ctx.on('<event>', (payload) => {
    // react to engine events
  })
}
```

You write the source in the extension panel; the extension stores it locally and loads it into future sessions.

## Sandbox isolation

Plugin code runs in a dedicated sandbox page declared by the manifest's `sandbox` field — the only extension page where `new Function` is allowed. The sandbox has no direct `chrome.*` access; everything a plugin does goes through the context object the engine hands it.

## Managing plugins

The panel lists your plugins with their load state. From there you can enable or disable a plugin, remove it, or rewrite its source. State changes take effect for subsequent sessions.

## When a plugin fails

A plugin that throws while loading fails loudly: the engine disables it, records the error on the plugin's entry, and surfaces the message in the panel and to the agent's plugin listing. Clear the failure by fixing and rewriting the source — the error marker clears when the plugin loads successfully.
