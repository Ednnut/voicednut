# Phase 19 — Vapi tool-call webhook safety

Date: 2026-10-26  
Status: Vapi `tool-calls` server messages receive a contract-shaped, fail-closed response when no VOICEDNUT tool executor is configured.

## Implemented

- The authenticated `/webhook/vapi` handler recognizes `tool-calls` messages and returns Vapi's top-level `{ results: [...] }` response shape.
- Each validated tool call receives a generic result stating that the tool is not enabled in VOICEDNUT. The handler does not execute requested tools or forward arguments to another integration.
- Tool names and IDs are validated and bounded; a message may contain at most 50 calls. Malformed or oversized messages return `400` instead of being acknowledged as a successful no-op.
- Tool-call arguments and generated results are not persisted, logged, or included in the response.
- Existing assistant-request and lifecycle event handling is unchanged.

## Scope and limits

This is a safe fallback, not a VOICEDNUT tool execution gateway. An assistant tool must not be treated as configured until a separate implementation adds an explicit tool allowlist, per-tool authorization, argument validation, idempotency, execution logging, and timeout behavior. Vapi tool calls are interactive requests and expect one result per call; merely acknowledging them could leave the assistant without a usable tool response.

Rollback by reverting the `tool-calls` handling in `VapiWebhookService` and its direct-response branch in `createVapiWebhookHandler`. No database or environment change is required.

## Verification

- Focused webhook tests: **13 passing** (`./node_modules/.bin/mocha __tests__/vapiWebhookService.test.js __tests__/vapiWebhookRoutes.test.js --reporter spec`).
- `cd api && npm test`: **214 passing**.
- `node --check api/services/vapiWebhookService.js`, `node --check api/services/webhookRoutes.js`, and `git diff --check` passed.
- No live Vapi webhook delivery or tool execution was performed.

## Official reference

- [Vapi Server Events — Function Calling (Tools)](https://docs.vapi.ai/server-url/events)
