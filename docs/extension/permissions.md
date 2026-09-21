# Permissions and safety

English | [中文](permissions.zh.md)

This extension drives **real pages under your API keys and your login state**. The controls below decide how much it may do before asking you.

## Three permission tiers

- **每次确认 (ask per action)** — every tool action raises an approval card and waits for your click.
- **仅变更确认 (ask on changes)** — reading is free; anything that changes a page or the browser asks first.
- **完全访问 (full access)** — actions run at once. New sessions start here; use the shield chip in the composer to tighten at any time.

An approval card shows the tool and its arguments before anything runs, and your choice applies to that action.

## What the agent can touch

The agent can click, type, and submit on any page you point it at — including irreversible actions such as orders, posts, or payments on sites where you are signed in. Practical guidance:

- Start with throwaway pages and low-stakes tasks.
- Keep the tier at ask-per-action until you trust a task.
- Review the session log afterwards — conversations and tool results export for audit.

## Data flow in one line

Page content the agent reads goes to the LLM endpoint you configured; everything else — keys, settings, session history — stays on your machine. The full statement lives in the [privacy policy](../privacy.md).
