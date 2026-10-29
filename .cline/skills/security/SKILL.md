---
name: security
description: Review VOICEDNUT authentication, authorization, secrets, privacy, tenant/business isolation, webhook signature and replay defenses, payment/OTP/tool-backed template risk, dependency vulnerabilities (npm audit), injection, rate limits, or risky side effects; use for security-focused review of a diff or area — findings-first, minimal fixes only.
---

## Workflow

1. Trace trust boundaries, credential sources, data flow, authn/authz checks, tenant/business scope, and exposed logs.
2. Check input validation, injection, webhook verification/replay, session/token handling, rate limiting, dependency advisories, and least privilege as relevant.
3. Verify protections with focused negative tests and safe local scans; separate confirmed findings from assumptions.
4. Recommend the smallest fix and describe severity, exposure, mitigation, and recovery without copying sensitive values.

## Guardrails, tools, and approval

Use repository security middleware/tests, package audit tools, and official security documentation. Never print/read secrets unnecessarily, probe production, exploit external systems, or weaken protections to make checks pass. Ask before credential access, destructive remediation, external writes, or production changes.

## Done when

Relevant controls are verified, tests cover denied/invalid behavior, no sensitive data is disclosed, and unresolved findings are clearly prioritized.
