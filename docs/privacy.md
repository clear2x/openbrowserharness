# Privacy policy

English | [中文](privacy.zh.md)

OpenBrowserHarness is a browser extension that runs an AI agent entirely inside your browser. This policy states what data the extension processes and where that data goes. It applies to every distribution channel of the extension, including the Chrome Web Store and Microsoft Edge Add-ons.

## No servers, no telemetry

The extension operates no server and sends no telemetry, analytics, or crash reports. The agent loop, session storage, and browser automation all run on your machine.

## Page content the agent reads

When you give the agent a task, it reads the pages you point it at: accessibility snapshots, screenshots, extracted text, and form fields. The agent sends this content to the large-language-model endpoint you configure.

The extension ships presets for the DeepSeek and Zhipu GLM APIs and accepts custom OpenAI-compatible and Anthropic-compatible endpoints. Requests carry your own API key. The receiving provider processes the content under its own privacy policy; the extension developer receives none of it.

## API keys and settings

API keys and extension settings are stored in `chrome.storage.local` on your machine. They leave the machine only as authentication headers on requests to the endpoint you chose.

## Session history

Conversations, tool results, and generated artifacts persist in the browser's IndexedDB on your machine. Nothing syncs to an external service. Removing the extension, or clearing its site data in the browser, deletes session history.

## Permissions

- `debugger` drives the tabs the agent works on — clicks, keyboard input, scrolling, and page reading — through the Chrome DevTools Protocol. The browser shows its "started debugging" banner while the agent works; the extension attaches only to the tab a task targets.
- `tabs` plus `<all_urls>` host access lets you direct the agent at any page. The extension does not read or alter pages in the background without a task.
- `storage` keeps keys, settings, and sessions on your machine.
- `sidePanel` renders the agent panel. `offscreen` hosts the long-lived agent process. `alarms` runs an internal keep-alive timer for that process. `sessions` lets the agent reopen tabs you recently closed.
- `activeTab` grants temporary access to the current tab when you click the extension's toolbar icon.

## User plugins

You can author and load your own plugins. Plugin code runs in a sandboxed extension page that the manifest's `sandbox` directive isolates from the extension's own pages. The extension does not ship or distribute third-party plugins.

## Children

The extension is a developer tool and is not directed at children under 13.

## Changes

This policy is versioned in the extension's source repository. A material change to data handling ships in the release that introduces it and updates this page.

## Contact

Open an issue at [github.com/clear2x/openbrowserharness/issues](https://github.com/clear2x/openbrowserharness/issues).
