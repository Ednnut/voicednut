# Voicednut agent guide

Use the repository's existing architecture, naming, error handling, and tests. Inspect the closest implementation and package scripts before changing code; avoid parallel systems and unrelated cleanup. Treat existing uncommitted changes as user-owned.

## Workflows

Use the matching skill in `.agents/skills/` for substantial code changes, code explanations, bug reviews, debugging, or repetitive engineering workflows. Keep simple edits simple. Skills are shared with Cline through `.cline/skills/`.

## Project boundaries

- Preserve existing Telegram commands, callbacks, conversations, provider integrations, and API contracts unless the request explicitly changes them.
- Do not add Telegram slash commands or modify the Mini App as part of Speko work unless explicitly requested.
- Verify provider/SDK methods and payloads against the installed implementation or authoritative documentation; do not invent support.
- Never initiate real calls, deploy live agents, mutate production numbers/settings, or run production migrations without explicit approval.
- Keep secrets server-side; sanitize logs and user-facing output.

## Validation

Run focused tests first, then the relevant package suite when practical. Use existing package scripts rather than inventing new commands. Report what ran, failures, and unverified behavior; do not claim checks that were not run.
