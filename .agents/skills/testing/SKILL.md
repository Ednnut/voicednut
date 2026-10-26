---
name: testing
description: Add or run focused VOICEDNUT unit, integration, regression, contract, or Mini App browser tests.
---

## Workflow

1. Inspect package scripts, test conventions, fixtures, and baseline failures; choose the narrowest test that would catch the behavior.
2. Use API Mocha tests with stubbed services, bot Node tests, Mini App contract checks, and Playwright for meaningful user-visible flows.
3. Keep tests deterministic, isolated, tenant-safe, and independent of production credentials/providers. Cover failure and authorization cases where relevant.
4. Run the requested focused test and related validation; report exact commands, counts, baseline failures, and untested paths.

## Guardrails, tools, and approval

Use installed test frameworks and local fixtures. Do not make live calls, send messages, charge payments, mutate production data, or use real personal data. Ask before downloading tools/browser binaries if approval is required.

## Done when

Tests exercise acceptance criteria and important regressions, checks have actual recorded results, and failures or coverage limits are described honestly.
