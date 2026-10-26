# Phase 18 — Vapi web-call operations

Date: 2026-10-26  
Status: locally correlated Vapi browser calls are available to the existing admin call inspector and reconciliation path.

## Implemented

- Expanded `getVapiOutboundCallByProviderId` to resolve completed records for both `vapi` and `vapi_web` calls. The projection now identifies the provider and returns only the provider call ID, status, and template/version/mapping correlation metadata.
- Existing admin `GET /api/vapi/calls/:callId` can now show the sanitized lifecycle events for a browser call as well as its local correlation.
- Existing admin `POST /api/vapi/calls/:callId/reconcile` can now fetch a browser-call snapshot from Vapi and append the same deduplicated, sanitized reconciliation event used for phone calls.
- Existing end/transfer operations remain limited to phone calls; making browser calls visible to the shared inspector does not implicitly broaden call-control access.
- No new endpoint, database table, or schema migration was added.

## Scope and limits

The Vapi Get Call response can include messages, artifacts, destinations, and provider configuration. This implementation continues to persist only normalized status and call lifecycle metadata; it does not expose the raw response or call artifacts through these endpoints. The inspector and reconciliation endpoints remain admin-token protected. Organization-scoped customer access and legacy `calls`-table integration remain outside this increment because the current Vapi call correlation records do not contain organization/user ownership.

Rollback by restoring the provider filter in `getVapiOutboundCallByProviderId` to `provider = 'vapi'`; existing Vapi phone-call inspection and reconciliation remain available. No production data migration is required.

## Verification

- `cd api && npm test`: **210 passing**. The first run hit the existing 2-second timeout in an unrelated Plivo test; the rerun passed.
- Focused DB and reconciliation tests: **14 passing** (`./node_modules/.bin/mocha __tests__/vapiTemplateMapping.test.js __tests__/vapiCallReconciliationService.test.js --reporter dot`).
- `node --check api/app.js`, `node --check api/db/db.js`, `node --check api/services/vapiCallReconciliationService.js`, and `git diff --check` passed.
- No live Vapi read or call-control request was made.

## Official reference

- [Vapi Get Call API](https://docs.vapi.ai/api-reference/calls/get)
