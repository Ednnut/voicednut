# Provider readiness checklist

Use only the checks relevant to the requested capability. Keep verified contract facts separate from assumptions and open questions.

## Contract evidence

- Link the official docs for the exact operation and SDK/API version.
- Confirm auth, required fields, response states, limits, idempotency scope, timeout behavior, and which failures are safe to retry.
- For callbacks/events, confirm signature inputs, timestamp/replay policy, delivery retries, event identity, and ordering guarantees.
- Confirm billing and side effects, including whether preparation or accepted-but-unconnected work can incur charges.

## VOICEDNUT boundary

- Name the existing client, service, adapter, route, persistence, and UI/bot seams that own the behavior.
- Specify which provider capabilities are supported and which fail clearly as unsupported.
- Preserve caller authorization, business/tenant scope, consent/opt-out, idempotency, rate limits, and existing provider behavior.
- Keep secrets server-side; validate untrusted responses/events; redact logs and bound payload size, time, and retries.
- For uncertain mutation outcomes, define reconciliation or same-key replay behavior before dispatch. Never create a fresh operation blindly.

## Verification and rollout

- Stub provider I/O and use synthetic fixtures. Cover the lifecycle and failure cases changed by the work.
- Keep new provider access behind the project's established safe default and independent stop control where applicable.
- Document env key names and defaults, required operator evidence, monitoring, rollback, and forward recovery.
- Keep live account checks, external writes, billable actions, and deployment outside local verification unless separately authorized.
