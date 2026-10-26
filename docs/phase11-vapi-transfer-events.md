# Phase 11 — Sanitized Vapi transfer events

Date: 2026-10-25  
Status: forwarding and transfer events are subscribed to and stored without destination addresses.

## Implemented

- Synced assistants with the secured Vapi server URL now subscribe to `transfer-update` in addition to existing lifecycle events.
- The webhook normalizer now accepts Vapi `transfer-update` events and captures the destination kind (`number`, `sip`, or `assistant`). It also captures the `forwarding` status from `status-update` for phone/SIP transfers.
- Added the nullable `destination_type` field to the event ledger with an additive SQLite migration for existing databases.
- Destination phone numbers, SIP URIs, assistant names, transcripts, and raw webhook payloads are excluded from normalized and persisted event rows.

## Boundaries

- Vapi documents `status-update: forwarding` as the start of a phone/SIP transfer attempt; it does not confirm that the destination rang or answered. The legacy `transfer-update` event is not emitted for every phone/SIP transfer and does not report transfer failures.
- Transfer outcomes must be reconciled with subsequent lifecycle events and telephony provider records. This phase does not assert transfer success or run post-call actions.
- No live Vapi webhook delivery was performed.

## Verification

- Tests cover safe destination-type extraction, event subscription, persistence, deduplication, and exclusion of destination addresses and transcript content.
- Full API suite: **180 passing**. Syntax checks for `app.js`, `db.js`, `vapiWebhookService.js`, and `vapiTemplateSyncService.js` passed; `git diff --check` passed.

## Official references

- [Vapi server events: status, forwarding, and transfer updates](https://docs.vapi.ai/server-url/events)
- [Vapi live transfer events](https://docs.vapi.ai/calls/call-dynamic-transfers)
