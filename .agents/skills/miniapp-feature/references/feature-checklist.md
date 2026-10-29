# Mini App feature checklist

Select the checks that apply to the requested flow.

## Before editing

- Closest route, page, shared component, API service, and existing e2e/a11y coverage identified.
- User goal, primary success path, permissions, and visible side effects are clear.
- Action/response contract changes are traced through `api-contract-change` before UI wiring.

## Interaction states

- Loading and retry behavior match the request lifecycle.
- Empty and error states explain what the user can do next.
- Forms validate inputs and associate errors with fields.
- Disabled and access-denied states explain unavailable actions when useful.
- Confirmation and success feedback match the action's real side effects.

## Accessibility and layout

- Controls have names, roles, keyboard operation, and visible focus.
- Dynamic status or errors are announced appropriately.
- Content remains usable at relevant narrow and wide viewport sizes.
- Contrast and touch targets follow existing Telegram UI patterns.

## Verification

- Contract validation, lint/build, or Playwright checks are chosen based on files and behavior changed.
- Browser tests use deterministic fixtures and do not trigger live calls, messages, payments, or production writes.
- Screenshots and visual claims are included only when actually captured and inspected.
