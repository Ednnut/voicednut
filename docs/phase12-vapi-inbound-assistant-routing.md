# Phase 12 — Vapi inbound assistant routing

Date: 2026-10-25  
Status: explicit admin-managed inbound number routing is available for current synced template mappings.

## Implemented

- Added `vapi_inbound_routes`, keyed by the exact Vapi phone number ID and referencing an existing VOICEDNUT template mapping.
- Added admin-only `PUT /api/vapi/inbound-routes/:phoneNumberId` with `{ "mapping_id": 123 }` and `DELETE /api/vapi/inbound-routes/:phoneNumberId`.
- Route creation accepts only compatible, provisioned, synced mappings whose template version is still current. Every assistant-request lookup repeats those checks, so later template edits stop routing through the stale assistant automatically.
- The authenticated `POST /webhook/vapi` now handles Vapi `assistant-request` messages. It returns the documented `{ "assistantId": "..." }` shape for a match, or a short spoken `{ "error": "..." }` response for an unknown or stale number. Other lifecycle events retain their existing response and persistence behavior.
- Phone number IDs are stored as opaque provider IDs. The route does not infer a template from the caller's phone number, organization, or a default template.

## Setup and limits

Vapi requires an `assistant-request` response within 7.5 seconds. Routing performs one local indexed lookup and does not call Vapi or other services during the request. Configure the Vapi phone number with no fixed assistant, point its server URL to the secured `/webhook/vapi` endpoint, and attach a Vapi Custom Credential that sends the configured Bearer token. Synced assistant webhook configuration does not automatically configure phone-number server settings. Do not enable inbound routing until the credential and URL are configured on the Vapi number.

This phase does not provide Vapi phone-number inventory/sync, organization-scoped route ownership, a management UI, assistant overrides, dynamic caller personalization, or live inbound-call verification. Mappings and routes use the existing global admin authorization model.

## Verification

- Service tests cover mapped and unmapped assistant requests; route-handler coverage checks the direct Vapi response body.
- SQLite integration coverage checks route persistence, unknown numbers, and fail-closed behavior after a template version changes.
- Full API suite: **184 passing**. Syntax checks for the changed JavaScript files and `git diff --check` passed.
- No live Vapi webhook or inbound call was performed.

## Official references

- [Vapi server events and assistant-request contract](https://docs.vapi.ai/server-url/events)
- [Vapi server authentication](https://docs.vapi.ai/server-url/server-authentication)
- [Vapi phone-number hooks and fallback behavior](https://docs.vapi.ai/phone-numbers/phone-number-hooks)
