---
name: debug-fix
description: Diagnose a reported failure, reproduce its root cause, apply a minimal fix, and verify it with focused tests.
---

# Debug and fix

Use when the user reports broken behavior or a failing test and expects it fixed. Capture the observed symptom and expected result; inspect logs, tests, and recent relevant code. Reproduce with the narrowest safe command, then trace the root cause rather than patching the visible symptom.

Make the smallest compatible correction and add or adjust a regression test that fails before the fix when practical. Re-run the reproducer and relevant tests. Preserve unrelated work, avoid broad refactors, and do not mutate production or live provider state. If not reproducible, report the evidence and the next diagnostic needed rather than guessing.
