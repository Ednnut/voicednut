---
name: provider-onboarding
description: Plan or implement a new VOICEDNUT voice or messaging provider, or extend an existing provider's API, event, or webhook behavior using the project's integration patterns.
---

# Onboard a provider safely

Use this skill for provider integration work. Pair it with `telephony`; add `api`, `database`, `security`, `testing`, or `release` only when the requested change crosses those areas. This skill coordinates the work; it does not grant approval for credentials, provider writes, live traffic, or deployment.

## Workflow

1. Read repository instructions, check `git status`, and inspect the nearest provider client, service, adapter, route, webhook, tests, and runbook. For an existing provider, run `bash .agents/skills/provider-onboarding/scripts/provider-surface.sh <provider-name>` to get a file map, then read relevant files.
2. Define the requested capability and the existing VOICEDNUT boundary it should extend. Verify endpoints, authentication, request/response fields, idempotency, retries, event signatures, billing, and lifecycle behavior against current official provider docs and the SDK version actually used. Record direct documentation links for claims that affect the design.
3. Map the contract to existing client/service/adapter seams. Identify unsupported behavior and failure states before coding. Do not infer capabilities from package names, examples, or marketing pages, and do not create a parallel provider framework.
4. Preserve VOICEDNUT's auth, business scope, consent/opt-out, rate limits, idempotency, replay defenses, and safe logging. Keep secrets server-side, bound timeouts and payloads, sanitize errors, and make provider enablement default-off where the existing design uses a gate. Do not invent flag names or retry semantics; follow verified provider behavior and local conventions.
5. Keep provider I/O stubbed in tests. Cover relevant accepted, pending, terminal, malformed, timeout, duplicate, and uncertain-outcome cases. For asynchronous events, verify signature/replay handling and duplicate delivery behavior.
6. Update only the docs and configuration required by the change: env key names and safe defaults, capability/support notes, operator runbook, rollout gates, and rollback/recovery. Do not add credentials or customer data.
7. Review the diff against the requested capability and neighboring providers. Report the verified contract and sources, changed boundaries, checks actually run, unsupported cases, rollout gates, and explicitly whether any external operation occurred.

## Readiness reference

Before implementation or pilot planning, read [provider-readiness.md](references/provider-readiness.md). It is a compact checklist for contract evidence, lifecycle safety, and operator readiness; adapt it to the requested scope rather than treating every item as a reason to expand the task.
