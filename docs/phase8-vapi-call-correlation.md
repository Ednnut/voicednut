# Phase 8 — Vapi call idempotency and local correlation

Date: 2026-10-25  
Status: durable request deduplication and admin call lookup implemented.

## Implemented

- Vapi call creation now requires a caller-provided idempotency key. The existing `outbound_call_idempotency` table stores a request hash, Vapi provider name, remote call ID, and normalized response. The customer number is not stored in this record.
- Repeating a completed request with the same key and same inputs returns the original Vapi call ID without another provider request. Reusing that key for a different template, mapping, phone number ID, or destination returns a conflict.
- A retryable transport/API error leaves the record pending. Repeating the request then returns an unresolved-outcome conflict instead of placing another call. Definitive provider errors mark the key failed; a new key is required to try again.
- Added admin-only `GET /api/vapi/calls/:callId`, which joins the local outbound request record to the sanitized lifecycle event ledger by Vapi call ID.

## Boundaries

- This provides an audit/correlation path, not a row in the legacy `calls` table. Existing post-call automations and transcript workflows are still not invoked for Vapi calls.
- If the provider accepts a call but local persistence fails before storing its ID, the request remains unresolved. An operator must reconcile the Vapi call in its dashboard before submitting another request.
- No live Vapi calls or webhook deliveries were used for verification.

## Verification

- Service tests cover successful replay, key/destination conflict, stale mapping replay, unresolved timeout behavior, and no-call validation failures.
- SQLite tests verify provider call IDs resolve to local request and template metadata.
- Full API suite: **167 passing**. Syntax checks for `app.js`, `db/db.js`, and Vapi outbound call service passed; `git diff --check` passed.

## Official references

- [Vapi Create Call API](https://docs.vapi.ai/api-reference/calls/create)
- [Vapi outbound calling guide](https://docs.vapi.ai/calls/outbound-calling)
