# Mini App visual QA checklist

Use the existing Playwright and axe setup. Focus on the pages and states changed by the task.

## Viewports

- Phone: 390×844, or the closest project fixture/device size.
- Tablet: 768×1024 when the layout has a distinct tablet state.
- Desktop: 1280×800 when the page supports wider layouts.

## Checks

- Primary action works and produces visible success or pending feedback.
- Loading, empty, error, disabled, and access-denied states are checked when reachable in the changed flow.
- Keyboard users can reach controls in order, see focus, and submit or dismiss dialogs.
- Inputs have labels and errors are associated with their fields; dynamic status is announced.
- No horizontal overflow, clipped controls, or obscured confirmation text at selected sizes.
- Automated axe results are reported as observed; do not suppress existing violations to make a run pass.

## Existing commands

Run from `miniapp/` when requested and relevant:

- `npm run test:e2e`
- `npm run test:a11y`
- `npm run validate:prod` for contracts, lint, and build
