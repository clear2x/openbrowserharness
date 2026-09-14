# Use the Web UI

English | [中文](index.zh.md)

> **Looking for the browser extension?** This guide covers the inherited desktop Web UI (`apps/web`), which the upstream harness also ships. The OpenBrowserHarness extension does not use a server — build it and load it in Chrome/Edge as described in the [root README](../../../README.md#install-from-source); the in-panel model settings configure providers directly. The pages under [Develop](../develop/basic/index.md) apply to both.

Start the Web UI through the [root README](../../../README.md#install-from-source); the command prints its URL. This guide begins after that server is running. The `dsh` process uses its invoking directory as the default filesystem location, but a fresh Web UI has no selected workspace until you add one.

## Configure a model

Open **Settings → Models**, enter a [DeepSeek API key](https://platform.deepseek.com/), and save it. The model route becomes usable immediately without restarting the server.

The [model configuration guide](./providers.md) covers other providers and custom OpenAI-compatible endpoints.

## Choose a workspace

Click **Choose workspace**, add the project directory where you started `dsh`, and select it. The session composer remains unavailable until a workspace is selected.

## Run a task

Start a session and send:

> Summarize this repository and identify its main packages.

The agent can read and edit workspace files, run commands, delegate work, and maintain a plan. The Web UI asks before operations that require approval under the active permission policy.

## Continue

- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
- [Use other CLI modes](../../../apps/cli/README.md)
- [Develop a plugin](../develop/basic/index.md)
