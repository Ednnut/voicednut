---
name: miniapp-visual-qa
description: Verify a VOICEDNUT Mini App change for responsive layout, keyboard and accessibility behavior, and browser regressions using the existing Playwright setup.
---

# Verify Mini App behavior in a browser

Use when the user asks to QA or verify a Mini App flow, or when a UI change needs browser evidence. Pair with `miniapp-feature` for implementation work; use `testing` for broader test planning.

## Workflow

1. Read root and `miniapp/AGENTS.md`, inspect the worktree diff, and identify the changed page, states, and nearest browser spec. Do not infer coverage from a passing unrelated dashboard test.
2. Choose checks that exercise the changed behavior: contract validation for action shapes, `npm run test:e2e` for user flows, and `npm run test:a11y` for semantic/accessibility behavior. Check installed browser availability before running them.
3. Inspect the flow at relevant narrow and wide viewport sizes, keyboard order and focus, labels, dynamic status/error announcements, and horizontal overflow. Use the existing specs and conventions; add a browser case only when the change creates browser-visible behavior and the task calls for regression coverage.
4. Report exact commands and results. Separate current findings from known baseline issues. Mention screenshots only when they were actually captured and inspected; do not claim whole-app accessibility from a limited scan.

## Viewport reference

Use [visual-qa-checklist.md](references/visual-qa-checklist.md) to select viewports and interaction checks for the changed surface. Do not require every size or state when it does not apply.
