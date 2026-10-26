---
name: ui
description: Improve Mini App visual hierarchy, navigation, interaction states, forms, accessibility, and responsive polish.
---

## Workflow

1. Inspect existing page, design tokens/styles, shared components, Telegram UI conventions, and similar screens.
2. Identify the user task and specific interaction problem; preserve the design system and avoid duplicate components.
3. Review focus order, keyboard operation, labels, contrast, touch targets, responsive layout, loading/empty/error/success states, and form feedback.
4. Validate with browser/Playwright at representative widths and a keyboard pass; run `npm run test:a11y` when the Mini App is in scope and report baseline violations without hiding them.

## Guardrails, tools, and approval

Use existing React/CSS/SCSS and Telegram UI components first. Use screenshots only when supported and do not claim visual inspection without it. Keep user data out of screenshots and traces. Ask before broad redesign, new design dependencies, or external visual-testing services.

## Done when

The identified interaction is improved without duplicate patterns, responsive and keyboard checks are documented, and remaining accessibility limitations are explicit.
