# Phase 13 — Vapi phone-number inventory

Date: 2026-10-25  
Status: admin-only, read-only, paginated Vapi phone-number discovery is implemented.

## Implemented

- Added `GET /api/vapi/phone-numbers` behind the existing admin-token guard.
- The server uses Vapi's `GET /v2/phone-number` endpoint with bounded `page`, `limit`, and `search` query parameters. Results are scoped by Vapi to the organization owning the private API key.
- The response contains only number identity, display name, phone number, provider, status, assigned assistant/squad/workflow IDs, and booleans indicating whether a server URL and server credential are configured. Provider credential IDs, webhook URLs, custom headers, and the rest of the server configuration are omitted.
- The local API does not cache Vapi's inventory and does not mutate phone-number configuration. Returned IDs can be supplied to the explicit inbound route assignment endpoint from [Phase 12](phase12-vapi-inbound-assistant-routing.md).
- Query limits are validated locally; unexpected provider response shapes fail closed with a sanitized error.

## Limits

This is a read-only inventory API. It does not provision, import, update, delete, or reconcile provider numbers, and it does not create organization-scoped local ownership records. The route requires Vapi to be enabled and configured; it returns a service-unavailable response when Vapi credentials are absent. No live Vapi account request was made.

## Verification

- Client tests verify the documented Vapi v2 path, pagination/search query, and server-side Bearer authentication.
- Service tests verify field allowlisting, credential/config redaction, query validation, and malformed response rejection.
- Full API suite: **189 passing**. Syntax checks for `app.js`, `vapiClient.js`, and `vapiPhoneNumberService.js` and `git diff --check` passed.

## Official reference

- [Vapi List Phone Numbers API](https://docs.vapi.ai/api-reference/phone-numbers/phone-number-controller-find-all-paginated)
