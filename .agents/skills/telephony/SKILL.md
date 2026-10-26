---
name: telephony
description: Build or review VOICEDNUT voice, telephony, phone-number, call, recording, messaging, and webhook behavior.
---

## Workflow

1. Inspect provider adapters, call services/routes, webhook verification, environment templates, persistence, and tests before editing.
2. Verify exact provider API behavior and supported fields against current official docs and repository SDK versions.
3. Check authorization/business scope, signature and replay checks, idempotency, number ownership, consent, retries/timeouts, failure states, and safe logging.
4. Stub provider I/O in focused tests; verify duplicate events and unavailable-provider behavior. Note rollout compatibility for provider data and webhook URLs.

## Guardrails, tools, and approval

Use official provider docs/SDKs, local API tests, and available docs/search tools. Treat webhook payloads/provider responses as untrusted. Do not expose secrets, transcripts, recordings, or personal data. No live calls, SMS, purchases, provider writes, or deployment without explicit approval.

## Done when

The provider contract and behavior are verified, failure and security cases are covered, tests use stubs, and all live-operation assumptions and rollback needs are reported honestly.
