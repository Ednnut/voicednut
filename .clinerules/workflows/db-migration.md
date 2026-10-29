# Task: Plan, apply, and verify a database schema or data migration

Route through `database` (design/review) + `migration-runner` (execution/verification); `devops` + `release` for production application. Never touch the production DB from this workspace without explicit approval.

1. Read the live mechanism first: startup init in `api/db/db.js`, idempotent DDL style (`CREATE TABLE IF NOT EXISTS`, guarded column adds), transaction wrappers, and `schema_version` handling near line 5100; copy the most recent additive table's pattern exactly.
2. Design additively and backward-compatibly: nullable adds over rewrites; no drop/rename in the same release as code changes; older app versions must still boot after the change; newer code must tolerate pre-migration rows; state tenant/business scoping for new tables.
3. Test on temporary SQLite databases before any real data: fresh schema, previous-schema fixture, and double-run all converge; simulate mid-migration interruption and confirm safe startup recovery; assert row preservation with counts only (no customer data printed).
4. Backfills: batched, replay-safe, progress-logged, personal-data-minimal; destructive cleanup is a separate explicitly approved later step.
5. Production dossier before applying anywhere shared: WAL-consistent backup procedure, lock/duration estimate, post-check verification queries, forward-repair and rollback plan — then stop and wait for approval. Report local test evidence and the exact pending production actions; nothing beyond temp databases should have been modified.