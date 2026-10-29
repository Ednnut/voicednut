---
name: debugger
description: Trace and fix a VOICEDNUT bug, failing check, unexpected result, or provider/API/UI behavior from a reproducible symptom to its cause.
---

# Reproduce, explain, fix, verify

Do not guess at the cause from an error label. Preserve the worktree and avoid live providers or production data.

## Workflow

1. State the observed and expected behavior. Check `git status`, recent changes, relevant package scripts, and nearby tests before changing files.
2. Reproduce the symptom with the narrowest safe command, fixture, or manual steps. If it cannot be reproduced locally, identify missing evidence and continue tracing without presenting a guess as fact.
3. Follow the real code path and test one causal hypothesis. Distinguish confirmed root cause from plausible contributing factors.
4. Make the smallest reversible fix at the cause. Preserve auth, tenant scope, idempotency, replay protection, rate limits, and feature gates. Route schema or boundary changes through the relevant domain skill.
5. Add a focused regression case when appropriate and run authorized verification. Keep provider interactions stubbed; do not use production credentials or data.
6. Report symptom, cause, fix, exact verification results, and remaining uncertainty.
