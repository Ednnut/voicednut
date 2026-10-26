---
name: frontend
description: Create or safely refactor VOICEDNUT Mini App pages, features, components, data flows, or responsive behavior.
---

## Workflow

1. Read `miniapp/AGENTS.md`, inspect current React/TypeScript/Vite patterns, routes, Telegram UI usage, components, services, and worktree changes.
2. Define the user flow and acceptance criteria; reuse established components, CSS/SCSS, routing, contracts, and data-fetching patterns.
3. Implement the smallest accessible, responsive change. Include loading, empty, error, validation, and protected-route behavior when relevant.
4. Verify at relevant desktop/tablet/mobile widths, keyboard navigation and semantics for meaningful UI changes; run contract, lint, typecheck/build, Playwright, and `npm run test:a11y` as applicable. Record existing accessibility failures as baseline findings instead of suppressing them.

## Guardrails, tools, and approval

Use the existing React 18, TypeScript, Vite, Telegram UI, npm scripts, and Playwright. Check actual browser/tool availability. Consult official React, Vite, Telegram, or API documentation for framework behavior. Do not add another UI framework, styling system, component kit, or visual service without a demonstrated gap and approval. Preserve auth, API contracts, and user changes. Ask before deployment or external writes.

## Done when

The feature follows the current design and data patterns, responsive/accessibility checks are recorded, relevant tests/build pass or failures are explained, and visual claims match inspected evidence.
