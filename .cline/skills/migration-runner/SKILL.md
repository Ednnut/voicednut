---
name: migration-runner
description: Plan, apply, and verify VOICEDNUT SQLite schema changes or stored-data migrations; use with database for design and with devops/release for shared or production rollout.
---

# Make migrations replay-safe

Read `api/db/db.js` and the current startup migration mechanism before editing. Preserve the established additive, idempotent pattern instead of introducing a new migration framework.

## Workflow

1. Define the schema/data change, affected tenant scope, compatibility window, and rollback or forward-repair path. Inspect relevant queries and callers before choosing the shape.
2. Prefer additive changes that allow old application versions to boot and new code to handle rows written before migration. Keep destructive cleanup separate.
3. Verify fresh, previous-schema, and already-migrated states on temporary databases. For backfills, make batches bounded and replay-safe; verify with counts or schema metadata rather than exposing row contents.
4. Document the shared-environment plan before any shared data change: backup method appropriate to SQLite/WAL, expected lock impact, post-change queries, and recovery options.
5. Stop before applying to shared or production data unless the user has authorized that specific operation. Report what changed locally, test evidence, compatibility, and exact remaining rollout steps.
