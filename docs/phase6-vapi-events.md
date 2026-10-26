# Phase 6 — Vapi call event ingestion

Date: 2026-10-25  
Status: authenticated lifecycle event ingestion implemented; external delivery configuration remains opt-in.

## Implemented

- Added `POST /webhook/vapi` with a fail-closed Bearer credential check. Missing local verifier configuration returns `503`; an invalid token returns `401`.
- Vapi assistant synchronization can attach the webhook URL and Vapi Custom Credential ID when all three values are configured: `VAPI_WEBHOOK_URL`, `VAPI_WEBHOOK_CREDENTIAL_ID`, and `VAPI_WEBHOOK_BEARER_TOKEN`. The webhook URL must be HTTPS and end exactly in `/webhook/vapi`.
- Synced assistants subscribe to `assistant.started`, `status-update`, `end-of-call-report`, `hang`, and (as added in Phase 11) `transfer-update`. The endpoint persists this normalized subset of the official event envelope. Duplicate normalized events are ignored through a unique hash key.
- Stored fields are limited to provider call ID, event/status, sanitized destination kind, end reason, duration, assistant ID, template mapping metadata, timestamp, and receipt time. Transcript text, recording URLs, destination phone/SIP addresses, and raw webhook payloads are not stored.
- Added admin-only `GET /api/vapi/call-events`, with optional template ID, provider call ID, and bounded limit filters. It returns the sanitized event ledger for operations review.

## Boundaries

The event ledger is separate from the legacy `calls` table because Vapi call creation is not wired into VOICEDNUT yet. This phase does not create call records, import transcripts/recordings, run post-call automations, or alter routing. Configure a matching Bearer Token Custom Credential in Vapi before syncing assistants with webhook settings. The event listing uses the existing global admin-token guard because organization-level ownership is not represented in the current schema. No live Vapi webhook delivery was performed.

## Verification

- Event normalization, sensitive artifact exclusion, deduplication, database persistence, secured config attachment, and fail-closed auth policy have unit coverage.
- Full API suite: 156 passing.
- Syntax checks and `git diff --check` pass.

## Official references

- [Vapi server events and lifecycle payloads](https://docs.vapi.ai/server-url/events)
- [Vapi server authentication and Custom Credentials](https://docs.vapi.ai/server-url/server-authentication)
