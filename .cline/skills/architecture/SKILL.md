---
name: architecture
description: Review or change VOICEDNUT package boundaries, provider abstractions, shared contracts, module seams out of api/app.js, or broad refactors; use for ADR-style decisions and before any cross-package or multi-file structural change. For the mechanical execution of an agreed structural change use `refactor`.
---

Trace the relevant request, data, and failure flow across API, bot, Mini App, database, and provider adapters. Inspect callers, tests, manifests, and existing abstractions before proposing a new pattern.

## Workflow

1. Map the affected boundary and its public/internal contracts.
2. Check duplication, ownership, compatibility, failure handling, idempotency, observability, and rollout constraints.
3. Prefer the narrowest design consistent with existing patterns; state alternatives only when tradeoffs matter.
4. Validate affected packages and contract tests; describe migration and rollback when boundaries change.

## Guardrails, tools, and approval

Use repository search, tests, diagrams/docs already present, and official platform documentation. Preserve authentication, authorization, tenant scope, and provider allowlists. Keep user changes. Ask before broad rewrites, breaking contracts, production changes, destructive operations, or external writes.

## Done when

Relevant boundaries and compatibility risks are verified, duplication is considered, focused checks pass or are reported as blocked, and the chosen change has clear acceptance criteria and recovery notes.
