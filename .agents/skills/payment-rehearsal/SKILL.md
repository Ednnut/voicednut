---
name: payment-rehearsal
description: Verify VOICEDNUT payment and webhook lifecycle behavior using stubbed providers and isolated test data, without creating real charges, invoices, or refunds. Use for payment workflow rehearsal, duplicate-event safety checks, or a focused payment regression.
---

# Payment workflow rehearsal

Use `references/rehearsal-checklist.md` to exercise the payment path requested. This workflow is for local, fake-provider verification; it does not certify a live provider account or production readiness.

## Workflow

1. Read root `AGENTS.md`, inspect `git status`, and select `database`, `api`, `security`, `testing`, and/or `release` only as relevant.
2. Trace the switchboard/policy, provider service, webhook verification and reconciliation, persistence, and existing focused tests. See `integration-catalog` for navigation.
3. Use injected fake clients, synthetic identifiers, and a temporary database or existing isolated fixture. Keep provider network access disabled.
4. Exercise the smallest relevant lifecycle: accepted request, provider failure/timeout, webhook verification, duplicate/replayed event, state reconciliation, and retry/idempotency behavior.
5. Assert persisted state and observable response while ensuring logs/errors omit credentials, payment data, and raw provider payloads.
6. Report exact command and outcome. State clearly that fake-provider results do not prove sandbox/live connectivity.

## Guardrails

- Never use live credentials or set a live-smoke flag. Do not create/capture/refund/send anything through a real provider.
- Never weaken approval gates, tenant scope, signature verification, replay protection, idempotency, or amount limits to make a rehearsal pass.
- If a sandbox rehearsal is explicitly requested, first confirm the command is non-billable and sandbox-only; ask before external writes or use of credentials.
- Follow project instructions on tests: add/run only the focused checks required or explicitly requested.
