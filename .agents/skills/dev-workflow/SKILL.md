---
name: dev-workflow
description: Run or automate repeatable engineering workflows such as test suites, safe refactors, local setup, and reversible development migrations.
---

# Development workflow

Use for repetitive or multi-step engineering operations. Discover the repository's existing scripts and conventions first; state the intended scope and choose the least disruptive workflow. Prefer deterministic project scripts and focused batches over ad hoc broad rewrites.

Before migrations or bulk edits, inspect the exact targets, preserve a recoverable diff, and confirm compatibility/rollback behavior. Keep secrets out of commands and logs. Do not run production migrations, deploy, contact real users, initiate calls, or change live provider resources without explicit approval. Validate each meaningful stage, run relevant tests, and summarize outcomes, residual risks, and rollback steps.
