---
name: provider-contract-audit
description: Audit a VOICEDNUT provider integration against current official API documentation and the repository's adapter, service, webhook, configuration, and tests. Use before provider onboarding, contract changes, upgrades, or provider readiness review.
---

# Provider contract audit

Compare the code with the provider's current official contract. An audit reports evidence and gaps; it does not claim provider certification or live readiness.

## Workflow

1. Read root `AGENTS.md`; inspect `git status` and preserve in-progress changes.
2. Use `integration-catalog` to locate the complete integration path and `api-docs-reference` to select official docs and determine the exact version evidence. Select the owning domain skill (`telephony`, `api`, `ai`, or `database`) and `security` when relevant.
3. Find current official documentation for the exact API version, auth mode, webhook version, and capability. Record direct URLs and any date/version visible. Do not rely on memory or third-party summaries for contract claims.
4. Compare request/response fields, required headers, authentication, signature verification, retries/timeouts, idempotency, pagination, rate limits, error handling, version pinning, and event lifecycle with code and focused tests.
5. Present findings first, each with severity, code location, official doc reference, concrete impact, and a minimal recommendation. Separate confirmed gaps from unknowns and undocumented assumptions.
6. For a requested fix, implement only the agreed scoped change and use fake-provider tests. Never call a live provider as part of the audit.

## Guardrails

- Keep secrets, payment details, call transcripts, and personal data out of output.
- Never infer credentials, provider account state, webhook reachability, or production readiness from source code.
- Preserve auth, tenant/business scope, consent/opt-out, idempotency, replay defenses, rate limits, and approval gates.
- Pair with `provider-onboarding` for adding a provider, `api-contract-change` for route/bridge changes, `payment-rehearsal` for isolated payment lifecycle rehearsal, and `release` for a release decision.
