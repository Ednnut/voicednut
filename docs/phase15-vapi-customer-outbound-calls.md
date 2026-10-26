# Phase 15 — Customer API Vapi outbound calls

Date: 2026-10-25  
Status: the existing authenticated `/outbound-call` API can explicitly dispatch eligible template calls through Vapi.

## Implemented

- Added an opt-in request path using `provider: "vapi"` on the existing `/outbound-call` endpoint. Existing requests without that explicit provider selection keep their prior provider-selection and failover behavior.
- Vapi requests require `script_id`, `mapping_id`, `phone_number_id`, an E.164 destination number, and an idempotency key in the body or `Idempotency-Key` header.
- If `script_version` is supplied, it must match the synchronized mapping version; stale version requests are rejected before calling Vapi.
- Requests use the existing `requireOutboundAuthorization` middleware and the same `VapiOutboundCallService` as the admin Vapi call endpoint. Current synced mapping/version and unsupported template behavior are checked before creating the call.
- Successful responses return the provider call ID, status, selected template/version, mapping, and deduplication result in the existing API response style.
- Vapi errors never fall through to another telephony provider. This is required because a timeout may mean Vapi created the call; the durable idempotency record remains unresolved until reconciled.

## Limits and rollback

This route does not create a row in the legacy `calls` table, attach organization ownership, import transcript/recording content, or run legacy post-call automations. Administrators can inspect the provider call through the existing Vapi call lookup and sanitized event ledger; customer-scoped Vapi call inspection is not added here. API authorization continues to use the existing outbound API auth model; organization-scoped template ownership is not present in the current database schema.

No local execution provider or existing template is switched to Vapi by this API. Roll back by stopping requests with `provider: "vapi"`; existing requests continue using their prior path. No live call was placed.

## Verification

- Route tests cover explicit dispatch, required resources, response correlation, mapping rejection, and no fallback to legacy providers.
- The Vapi call-service suite covers idempotency replay, conflicting keys, stale/incompatible mappings, unsupported behavior, and unknown provider outcomes.
- Full API suite: **199 passing**. Syntax checks for `app.js` and `callRoutes.js` and `git diff --check` passed.

## Official reference

- [Vapi Create Call API](https://docs.vapi.ai/api-reference/calls/create)
