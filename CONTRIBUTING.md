# Contributing

English | [中文](CONTRIBUTING.zh.md)

Thank you for your interest in contributing to OpenBrowserHarness! Issues and
pull requests are both welcome — this is an independent project and external
contributions are accepted.

## Reporting issues

Open a GitHub issue. For anything security-sensitive, follow
[SECURITY.md](SECURITY.md) instead of a public issue. A good report includes
the browser and OS version, the provider/model in use, the exported session
log (side panel → *Session log*), and the exact steps that reproduce it.

## Pull requests

1. Fork, branch, and keep changes focused — one logical change per PR.
2. Install and verify locally:

   ```sh
   pnpm install
   pnpm run build:lib
   pnpm run build:extension
   pnpm exec vitest run apps/extension/tests   # from the repository root
   ```

3. Pre-commit hooks (lefthook) run lint, whitespace, bilingual-pairing, and
   third-party-notice gates on staged files — install them via the postinstall
   step and let them guide you rather than working around them.
4. Non-trivial changes ship with an [Agent Note](.agents/notes/README.md) in
   the same PR describing what was decided and why; mechanical edits are
   exempt. This convention is inherited from upstream and is the project's
   decision log.
5. Documentation is bilingual (English + 中文) in paired files with
   `.i18n.yaml` records; when you change one side of a pair, bring the other
   along and re-record with `verify-translation-pairing --write`.

## Repository conventions

The inherited harness architecture and coding rules live in
[AGENTS.md](AGENTS.md) — read it before changing `packages/`. The short
version: everything is a plugin, registrations are effects, misconfiguration
fails loud, and vendored upstream code changes must be logged in
[vendor/README.md](vendor/README.md).

This project repackages [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
as a browser extension; when porting upstream changes, re-apply the extension
modifications listed there and in the Agent Notes.
