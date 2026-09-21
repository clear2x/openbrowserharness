# Configure models

English | [中文](providers.zh.md)

The extension talks to the LLM endpoint you configure. API keys live in `chrome.storage.local` on your machine and leave it only as authentication headers on requests to that endpoint.

## Built-in presets

- **DeepSeek** — the DeepSeek platform API.
- **智谱 GLM** — the Zhipu BigModel open platform, in both its OpenAI-compatible and Anthropic-protocol routes (the GLM Coding Plan endpoint).

Pick a preset in Settings and paste the API key from the provider's console.

## Custom endpoints

Any of the following works through **Add a custom provider**:

- OpenAI-compatible chat endpoints (base URL + key), including self-hosted gateways.
- Anthropic-protocol endpoints.
- Local Ollama.

## Picking a model and reasoning effort

Each conversation can switch model and reasoning effort from the composer's model chip. The effort menu lists only the levels the selected model actually supports.

Models differ in input modalities: screenshot understanding ([page_screenshot](./automation.md)) requires a model that accepts images. A text-only endpoint receives a clear error instead of a silent drop.

## Notes and limits

- Model or base-URL changes apply to newly created agents; a running conversation keeps the route it started with.
- Provider presets are starting points — endpoints, model lists, and pricing are owned by the provider you choose, and their terms apply to the content you send.
