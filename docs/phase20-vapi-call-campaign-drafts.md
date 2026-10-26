# Phase 20 — Vapi call-campaign drafts

Date: 2026-10-26  
Status: administrators can create and review draft call-campaign definitions with a pinned live template version and Vapi mapping.

## Implemented

- Added admin-token protected `POST /api/vapi/campaigns`, `GET /api/vapi/campaigns`, and `GET /api/vapi/campaigns/:campaignId` endpoints.
- Campaign creation requires a named campaign, an exact current live template version, its matching compatible/provisioned/synced Vapi mapping, a Vapi phone-number ID, an IANA time zone, a local calling window, and explicit calling days.
- Calling days use ISO weekday numbers (Monday `1` through Sunday `7`); calling windows must be same-day `HH:mm` start/end intervals and cannot cross midnight.
- Draft configuration has bounded concurrency (1–20), retries (0–3), and retry delay (5 minutes–24 hours when retries are enabled). Campaign creation is idempotent through `Idempotency-Key` or `idempotency_key`.
- Added an additive `vapi_call_campaigns` table with foreign keys to the pinned template and mapping. Campaign responses omit the idempotency key and request hash.
- Campaign status is fixed to `draft`. Unknown request fields such as recipients are rejected. The API does not accept contacts or phone numbers, start/dispatch campaigns, create provider calls, or schedule a worker.

## Safety and limits

This is campaign definition and version-pinning groundwork, not campaign execution. The application has no voice-call consent/DNC registry or organization-owned contact-list model, so recipient ingestion and dispatch remain out of scope. The selected phone-number ID is not validated against a live Vapi account during draft creation. All endpoints use the existing global admin-token model because the current schema has no organization ownership for Vapi mappings.

The database change is additive and runs through the existing idempotent schema initialization. Rollback by disabling/removing these routes and the service; preserve the table and draft records unless an operator has verified they are no longer needed. No production database migration or provider operation was performed.

## Verification

- `cd api && npm test`: **219 passing**.
- Focused campaign service/database tests: **15 passing** (`./node_modules/.bin/mocha __tests__/vapiCallCampaignService.test.js __tests__/vapiTemplateMapping.test.js --reporter dot`).
- `node --check api/app.js`, `node --check api/db/db.js`, `node --check api/services/vapiCallCampaignService.js`, and `git diff --check` passed.
- No Vapi provider calls or production database migration were performed.

## Next campaign prerequisites

Before campaign dispatch, add owned contact lists with auditable consent, a voice-specific opt-out/DNC registry, recipient-level eligibility snapshots, and a controlled queue/worker that enforces calling windows, concurrency, idempotent retries, and kill-switch behavior.
