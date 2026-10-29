---
name: miniapp-feature
description: Plan or implement a VOICEDNUT Telegram Mini App page, interaction, or user flow, including responsive states, accessibility, and API action integration.
---

# Build a complete Mini App flow

Use for user-visible Mini App work. Pair with `frontend` and `ui`; add `api-contract-change` when an endpoint or action-bridge contract changes, `miniapp-visual-qa` when browser verification is requested or needed, and `security` when identity, data access, or permissions change.

## Workflow

1. Read root and `miniapp/AGENTS.md`, check `git status`, and inspect the nearest page, route, shared component, data service, and browser spec. Follow existing React, TypeScript, Telegram UI, CSS/SCSS, and loading patterns.
2. Define the user-visible outcome and acceptance states before editing. Consider loading, empty, error, validation, disabled, success, and access-denied states where relevant; do not add states that the flow cannot reach.
3. If the flow uses a server action, use `api-contract-change` to trace and update the shared contract and server implementation before wiring the UI. The current contract source is `miniapp/src/contracts/miniappParityContracts.ts`; locate the relevant action contract and guards rather than assuming a file named `api-actions.ts` exists.
4. Implement the smallest accessible, responsive flow using the existing components and services. Preserve Telegram session handling, capability gates, business scope, and confirmation for risky or billable actions.
5. Verify meaningful flows at relevant viewport sizes and with keyboard/screen-reader semantics. Run contract validation, lint/build, or Playwright/a11y checks only when relevant and authorized. Do not add a browser test for a change that has no browser-visible behavior.
6. Review the diff and report the user-visible change, tested states and viewport/tool evidence, actual commands and outcomes, and remaining gaps.

## Acceptance reference

Use [feature-checklist.md](references/feature-checklist.md) to choose relevant states and browser checks. Keep the checklist scoped to the change; it is not a demand to rebuild adjacent pages or add UI dependencies.
