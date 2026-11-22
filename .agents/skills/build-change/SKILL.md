---
name: build-change
description: Implement a requested feature or code change in an existing codebase while matching its architecture, conventions, contracts, and tests.
---

# Build change

Use when implementing or materially modifying code. For a simple, localized edit, follow the repository guidance without loading this skill.

1. Restate the requested outcome and boundaries. Inspect the target code, nearby callers/tests, package scripts, and relevant project guidance before choosing a design.
2. Prefer the smallest change that fits existing abstractions. Preserve public behavior, compatibility, user edits, and established naming/error-handling patterns. Do not add a new subsystem when an existing workflow can be extended.
3. Verify external APIs and SDK features from installed code or authoritative documentation. Clearly distinguish verified behavior from assumptions; do not invent endpoints, fields, or capabilities.
4. Implement the change and focused tests together. Cover meaningful success, failure, authorization, and boundary cases where relevant.
5. Run focused validation, inspect the final diff for scope creep and regressions, and report changed files, checks, and remaining uncertainty. Do not claim unrun checks.

For Voicednut, follow root `AGENTS.md`; avoid new Telegram slash commands and Mini App changes for Speko tasks unless specifically requested. Never perform live provider or production mutations without explicit approval.
