# Phase 10 — Vapi live call transfer

Date: 2026-10-25  
Status: explicit admin initiated PSTN/SIP transfer control implemented.

## Implemented

- Added admin-only `POST /api/vapi/calls/:callId/transfer` for locally correlated Vapi calls.
- The route requires a destination object. It accepts either an E.164 phone destination (`{ "type": "number", "number": "+..." }`) or a SIP URI (`{ "type": "sip", "sipUri": "sip:user@host" }`). An optional spoken transfer message is limited to 500 characters.
- The service retrieves the Vapi call state and trusted per-call control URL. It refuses calls that are not active or destinations that fail validation.
- Vapi receives the documented live control request with `type: "transfer"`, destination, and optional content. The private Vapi API key is not sent to the control host.

## Boundaries

- This is a manually initiated admin API operation. It does not expose arbitrary transfers to assistant tool calls, infer destinations, or implement assistant handoffs.
- Only phone and SIP destinations are supported in this slice. Assistant destinations and warm-transfer workflows remain future work.
- Vapi control authentication is not supported in this phase. No live transfer was executed.

## Verification

- Unit tests cover active-call checks, local call correlation, E.164 transfer payloads, invalid destinations, and private credential isolation.
- Full API suite: **177 passing**. Syntax checks for `app.js`, `db/db.js`, `vapiClient.js`, and `vapiCallControlService.js` passed; `git diff --check` passed.

## Official references

- [Vapi Live Call Control transfer](https://docs.vapi.ai/calls/call-features)
- [Vapi dynamic call transfers](https://docs.vapi.ai/calls/call-dynamic-transfers)
