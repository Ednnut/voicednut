---
name: api
description: Add or change internal or external API integrations, request/response contracts, authentication, or API client behavior.
---

## Workflow

1. Find existing routes, clients, schemas/contracts, auth middleware, error mapping, and tests. Check for an existing SDK or adapter before adding one.
2. Confirm endpoints, authentication, payloads, versions, limits, and errors in official API documentation or verified OpenAPI/schema artifacts. Never infer an endpoint from a name.
3. Validate and bound untrusted input; preserve auth, tenant scope, timeouts, retries, rate limits, idempotency, and sanitized observability.
4. Add deterministic tests with mocked network calls and contract checks; run package validation.

## Guardrails, tools, and approval

Use official docs, verified specs, repository tests, and available web/docs tools. Keep tokens out of config, source, logs, and fixtures. Ask before external writes, credential access, billable calls, or production operations.

## Done when

The API contract is sourced and compatible, security/error behavior is tested, and actual checks plus unresolved assumptions are reported.
