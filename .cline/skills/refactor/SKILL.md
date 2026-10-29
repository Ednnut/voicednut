---
name: refactor
description: Restructure VOICEDNUT code while preserving observable behavior, such as extracting modules, simplifying complex functions, or moving symbols.
---

# Preserve behavior while changing structure

Treat behavior preservation as the acceptance criterion. Separate any requested behavior change from the refactor so each can be reviewed independently.

## Workflow

1. Define the structural goal and observable behavior that must remain stable. Inspect the worktree, callers, dynamic registrations, contracts, and nearest tests.
2. Choose a sequence of small reversible edits. Keep compatibility shims when they reduce migration risk; remove them only after checking references, including string-keyed or configuration-based references.
3. Follow existing module seams. In the API, prefer current service/adapter patterns and constructor injection; do not introduce a framework or speculative abstraction.
4. Verify behavior with the narrowest relevant checks authorized for the task. Compare routes, action names, env keys, or schema surfaces when those are in scope.
5. Review for accidental behavior changes and report the moves, verification evidence, and remaining shims or risks.

Do not mass-format unrelated code, delete dynamically referenced files without checking callers, or claim equivalence without evidence.
