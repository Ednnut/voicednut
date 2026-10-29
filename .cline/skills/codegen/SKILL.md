---
name: codegen
description: Write new VOICEDNUT features, routes, services, components, scripts, or tests that match the request and surrounding project conventions.
---

# Generate code that fits the request

Turn the user's outcome into the smallest complete change that fits the existing design. Read applicable instructions and preserve unrelated worktree changes.

## Workflow

1. Identify the requested behavior, affected package, contract, and important constraints. Infer ordinary details from nearby patterns; ask only when an unresolved choice would materially change behavior or risk.
2. Find and read the nearest analogues before editing. Trace consequential boundaries: API route → service/adapter → database/provider → response; Mini App action → contract/guard → API; or bot command → handler/service. Reuse existing validation, auth, tenant scoping, error, injection, idempotency, and flag patterns.
3. Check official vendor documentation when implementation depends on external behavior. Avoid new dependencies and abstractions unless the requirement needs them and the user authorized that scope.
4. Implement the requested behavior, including realistic failure states and security-relevant input checks. Keep provider I/O stubbed. Do not perform billable actions or production writes.
5. Add focused regression coverage when the task and repository instructions call for it. Run only checks authorized for the task; report exact commands and outcomes.
6. Review the diff for acceptance criteria, contract drift, secrets, unrelated edits, and unhandled errors. Summarize behavior, touched areas, verification, and remaining assumptions.

## VOICEDNUT conventions

- API services and adapters live under `api/services/` and `api/adapters/`; follow nearby constructor injection and error-envelope conventions.
- Mini App uses React, TypeScript, Vite, Telegram UI, and the existing action registry and payload guards. Read `miniapp/AGENTS.md` for its constraints.
- Database changes use the established additive startup migration pattern. Route schema changes through `database` and `migration-runner`.
- Keep provider flags default-off and preserve auth, business scoping, idempotency, webhook replay protection, and rate limits.
