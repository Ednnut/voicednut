# Phase 9 — Vapi live call termination

Date: 2026-10-25  
Status: admin-only end-call control implemented for locally correlated Vapi calls.

## Implemented

- Added `GET /call/:id` to the server-side Vapi client and a live-control request that sends `POST` to the call's returned `monitor.controlUrl` with `{"type":"end-call"}`.
- Added admin-only `POST /api/vapi/calls/:callId/end`. It first requires a completed local Vapi outbound correlation record, then retrieves the Vapi call and its current state.
- Calls already ended according to Vapi or the sanitized event ledger return idempotent success. Calls in unknown or non-active states are rejected.
- Control URLs must use HTTPS, have a hostname under `.vapi.ai`, contain no credentials, port, query, or fragment, and end with `/control`. The private API key is sent only to `api.vapi.ai`, never to the per-call control host.
- The control URL is neither returned to the caller nor persisted. Vapi lifecycle webhooks remain the source for final status updates.

## Boundaries

- The end-call action is available only for Vapi calls created and correlated through VOICEDNUT. It does not route through the existing Twilio/Plivo/Vonage termination adapter.
- Vapi assistants must have live call control enabled to return a usable control URL. If the URL is missing or the provider rejects the request, VOICEDNUT returns an error and does not claim the call ended.
- Vapi control URLs that require control authentication are not supported by this integration slice; those requests fail and should be configured for unauthenticated control or handled in a later credential-aware phase.
- No live call was ended during verification.

## Verification

- Unit tests cover local correlation, active/ended states, invalid control hosts, request method/body, and keeping the private API credential off the control-host request.
- Full API suite: **173 passing**. Syntax checks for `app.js`, `db/db.js`, `vapiClient.js`, and `vapiCallControlService.js` passed; `git diff --check` passed.

## Official references

- [Vapi Live Call Control](https://docs.vapi.ai/calls/call-features)
- [Vapi Get Call API](https://docs.vapi.ai/api-reference/calls/get)
- [Vapi call control authentication notes](https://docs.vapi.ai/gpt-live/configuration#live-call-control)
