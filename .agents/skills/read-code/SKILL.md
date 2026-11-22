---
name: read-code
description: Explain or trace unfamiliar, complex, or legacy code using concrete evidence from the repository, without changing files.
---

# Read code

Use when asked how code works, where behavior originates, or how a request flows across modules. This is an inspect-and-explain workflow, not a request to implement a fix.

Trace from the relevant entry point through callers, state/data transformations, persistence, external boundaries, and error paths. Search for definitions and usages, then read the smallest useful surrounding context. Prefer current code and tests over comments or assumptions. Separate observed facts from inference, cite specific files/symbols/lines, and mention meaningful caveats or missing coverage. Do not edit files unless the user separately asks for a change.
