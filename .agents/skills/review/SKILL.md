---
name: review
description: Review VOICEDNUT changes or a named code area for bugs, security gaps, edge cases, race conditions, and contract drift; use when asked to check or audit rather than fix.
---

# Review findings, not preferences

Keep the review read-only unless the user also asks for fixes. Start from the requested diff or area and its intended behavior. If scope is unclear, inspect the current diff and state the scope used.

## Review approach

- Read surrounding code, callers, tests, and relevant contracts before judging behavior.
- Check correctness and failure paths first, then auth and tenant scoping, idempotency and concurrency, untrusted inputs, compatibility, and missing regression coverage.
- Trace suspected problems into callees or focused evidence. Do not report speculative issues as confirmed findings.
- Ignore style preferences unless they violate a project convention or make a concrete defect more likely.

## Findings

Order findings by severity. Each finding needs a file and line, the failure condition, its concrete impact, and the smallest useful remedy. Use `blocker`, `should-fix`, or `nit`; omit empty categories. Label unresolved suspicions as needing confirmation.

End with a short verdict and the main residual risk. Do not modify files, post external comments, or claim tests passed unless they were actually run and in scope.
