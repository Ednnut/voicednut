---
name: api-incident-triage
description: Triage a VOICEDNUT API failure or unexpected request/provider behavior by tracing sanitized evidence from route and middleware through services and persistence.
---

# Triage API incidents from evidence

Use when a request fails, returns an unexpected response, or an API/webhook/provider flow behaves incorrectly. Keep triage read-only unless the user asks for a fix; then hand off to `debugger` with the confirmed symptom and path. Pair with `api`, `telephony`, or `database` only for the affected boundary.

## Workflow

1. Capture the expected and observed behavior, affected route/action, time window, and any request/correlation ID the user can safely share. Check `git status` and recent changes before attributing a regression.
2. Read the route registration and middleware order, response/error helper, relevant service and database/provider calls, and nearest tests. Follow the request through the actual code path.
3. Use only sanitized logs or user-provided evidence. Separate what the code proves from what runtime telemetry suggests. Avoid exposing tokens, phone numbers, transcripts, payment data, or customer rows.
4. Check common failure boundaries: auth/session, validation and payload limits, capability/business scope, rate limiting, idempotency/replay, timeout/retry behavior, database state, provider response/webhook verification, and normalized error mapping.
5. Reproduce locally with fixtures or stubbed I/O where possible. Do not access production systems, request credentials, mutate live data, or initiate provider calls without explicit authorization.
6. Return a concise timeline/path, most likely cause ranked by evidence, reproduction status, impact and scope, safe next check, and whether a code fix is needed. Mark uncertain hypotheses clearly.

## Evidence reference

Use [triage-evidence.md](references/triage-evidence.md) to collect sufficient context while excluding sensitive values.
