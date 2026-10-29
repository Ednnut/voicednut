---
name: testing
description: Add or run focused VOICEDNUT unit, integration, regression, contract, coverage, or Mini App browser tests — Mocha API suites with stubbed providers, node --test bot suites, Playwright e2e and axe accessibility, Mini App contract validators, repeat-after-edit verification loops, and test-failure triage.
---

## Workflow

1. Inspect package scripts, test conventions, fixtures, and baseline failures; choose the narrowest test that would catch the behavior.
2. Use API Mocha tests with stubbed services, bot Node tests, Mini App contract checks, and Playwright for meaningful user-visible flows.
3. Keep tests deterministic, isolated, tenant-safe, and independent of production credentials/providers. Cover failure and authorization cases where relevant.
4. Use the owning package's documented commands and the narrowest test that proves the behavior. API: `cd api && npx mocha __tests__/<name>.test.js`, then `npm test -- --reporter dot` when full-suite verification is in scope. Bot: `cd bot && node --test`. Mini App: `npm run validate:contracts`, `npm run lint`, `npm run build`; use `test:e2e` or `test:a11y` for relevant browser behavior when Chromium is available. Coverage tooling is optional and may require a separate install; avoid it unless requested.
5. Triage failures as regressions vs. baseline: record counts before starting (`git stash` spot-check or CI history) so a pre-existing failure is reported, not blamed on the change. Never fix a failing assertion by weakening it — route genuine bugs to `debugger`.
6. Report exact commands, counts, baseline failures, and untested paths; keep secrets and real personal data out of fixtures (synthetic E.164 ranges, fake IDs).

## Guardrails, tools, and approval

Use installed test frameworks and local fixtures. Do not make live calls, send messages, charge payments, mutate production data, or use real personal data. Ask before downloading tools/browser binaries if approval is required.

## Done when

Tests exercise acceptance criteria and important regressions, checks have actual recorded results, and failures or coverage limits are described honestly.
