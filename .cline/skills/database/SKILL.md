---
name: database
description: Design or review VOICEDNUT SQLite schemas, persistence semantics, queries and indexes, transactions, data lifecycle/retention, or tenant scoping in api/db/db.js. For executing schema-change rollouts, backfills, or migration verification use `migration-runner`; this skill covers the design and review of persistence behavior.
---

## Workflow

1. Trace DB initialization, wrappers, schema helpers, transaction behavior, and affected queries/callers.
2. Check idempotence, locks/transactions, indexes, constraints, defaults, existing-row compatibility, tenant filters, and partial migration recovery.
3. Test against temporary databases including old-schema fixtures; check query plans when performance is relevant.
4. Document backup, rollback or forward-repair, and application-version compatibility before any production migration.

## Guardrails, tools, and approval

Use existing SQLite libraries and test helpers. Never access or print production records. Preserve WAL/connection semantics unless specifically required. Ask before destructive data operations or production migration.

## Done when

Migration is repeatable, existing data remains compatible, focused tests pass, and recovery is concrete and separately gated for production.
