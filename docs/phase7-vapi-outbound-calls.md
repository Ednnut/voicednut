# Phase 7 — Explicit Vapi outbound calls

Date: 2026-10-25  
Status: opt-in, explicitly mapped Vapi outbound calls are available through an admin API.

## Implemented

- Added `POST /api/call-scripts/:id/vapi-call`, guarded by the existing admin-token middleware.
- The request must name a Vapi mapping ID, Vapi phone number ID, E.164 destination, and an idempotency key. The route never chooses a number or mapping implicitly. Durable replay and call lookup are described in [Phase 8](phase8-vapi-call-correlation.md).
- Calls are accepted only when the mapping is compatible, provisioned, synced, matches the requested template, and matches its current version. Mappings with recorded unsupported template behavior are rejected.
- The create request uses the saved Vapi assistant and pins its recorded assistant version when present. The call uses the documented Vapi `POST /call` shape (`assistantId`, optional `assistantVersion`, `phoneNumberId`, `customer.number`).
- The operation is opt-in and makes one provider request. It does not fail over to another telephony provider after an error because a timeout may mean Vapi created the call.

## Boundaries and follow-up

- At this phase, this was an administrative integration endpoint. Phase 15 adds an explicit Vapi provider choice to the existing authenticated `/outbound-call` API; see [Phase 15](phase15-vapi-customer-outbound-calls.md).
- It returns the Vapi call ID and status but does not create a VOICEDNUT `calls` row, attach organization ownership, import transcripts or recordings, or run existing post-call automations. Lifecycle events remain in the separate sanitized Vapi event ledger from Phase 6.
- No Vapi phone-number inventory or ownership mapping exists in the current schema. The caller must provide a Vapi phone number ID explicitly.
- No live Vapi call was placed. The local idempotency key prevents repeated requests from placing duplicate calls; timeout outcomes remain unresolved and are not automatically retried because Vapi's call API does not document an idempotency field.

## Verification

- Service tests cover explicit mappings and phone IDs, template version drift, unsupported behavior, and missing provider resources.
- Full API suite: **161 passing**. `node --check` passed for `app.js`, `db/db.js`, and the outbound service; `git diff --check` passed.
- No external provider calls are part of tests.

## Official references

- [Vapi Create Call API](https://docs.vapi.ai/api-reference/calls/create)
- [Vapi outbound calling guide](https://docs.vapi.ai/calls/outbound-calling)
