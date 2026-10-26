# Phase 16 — Vapi call reconciliation

Date: 2026-10-25  
Status: administrators can refresh the local lifecycle ledger for a locally correlated Vapi outbound call.

## Implemented

- Added admin-only `POST /api/vapi/calls/:callId/reconcile` to read the provider's current call snapshot and store a sanitized reconciliation event in the existing event ledger.
- The service requires a matching local Vapi idempotency correlation before contacting Vapi and checks that the returned call ID matches the requested ID.
- Only call ID, bounded status, bounded end reason, valid update timestamp, calculated duration, and local template ID/version are persisted. Provider messages, transcript, recordings, destination number, provider configuration, and raw response are excluded.
- Repeated reconciliation of an unchanged provider snapshot is idempotent through a stable event key based on call ID, status, end reason, update timestamp, and duration.
- The endpoint returns only the call ID, normalized status, reconciliation result, and duplicate indicator.

## Existing functionality and limits

Webhook ingestion remains the primary event path and is unchanged. Reconciliation records a provider snapshot; it does not create a legacy `calls` row, trigger post-call automations, or fetch call artifacts. It only supports calls with a local outbound Vapi correlation. No provider state is changed and no live call was placed.

Rollback by removing the route and service; existing webhook events and provider calls are unaffected. No database schema change or environment variable is required.

## Verification

- Service tests cover local correlation before provider reads, provider ID validation, sanitized persistence, computed duration, and deduplication.
- Full API suite: **202 passing**. Syntax checks for the app, service, and test plus `git diff --check` passed.

## Official reference

- [Vapi Get Call API](https://docs.vapi.ai/api-reference/calls/get)
