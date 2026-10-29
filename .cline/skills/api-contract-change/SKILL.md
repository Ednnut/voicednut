---
name: api-contract-change
description: Change or add a VOICEDNUT Express API or Mini App action-bridge contract while preserving authentication, response envelopes, tenant scope, and client compatibility.
---

# Change an API contract end to end

Use when a route, request/response shape, error envelope, or Mini App action changes. Pair with `api`; add `frontend`, `database`, `security`, or `telephony` only when the change crosses those areas.

## Workflow

1. Read repository instructions, check `git status`, and find the route/action registration, current callers, nearest validation and test patterns, auth middleware, and response/error helpers. Trace the actual request path before proposing a shape.
2. Write down the method/path or action name, input/output shape, error cases, authorization/capability, business scope, side effects, retry/idempotency behavior, and compatibility expectations.
3. For Mini App actions, use `miniapp/src/contracts/miniappParityContracts.ts` as the current action contract source. Trace related payload guards and API client/service code, plus the supported-action list, payload/spec validation, capability checks, and handler dispatch in `api/app.js`. Do not assume `miniapp/src/contracts/api-actions.ts` exists.
4. For Express endpoints, extend the closest route pattern and preserve middleware order, `sendApiError` response conventions, validation, rate limits, and existing auth/session/business boundaries. Prefer an existing service seam when one already owns the behavior.
5. Treat all request bodies, headers, webhook payloads, and provider responses as untrusted. Bound sizes and timeouts; preserve idempotency for mutations; sanitize errors and logs. Verify external API behavior against current official docs or a checked-in verified schema.
6. Update the caller and contract checks together. Use deterministic tests and stub provider/network I/O. Include authorization, malformed-input, duplicate/replay, and failure cases that apply to the change.
7. Review compatibility across server and clients. Report contract changes, auth and side-effect boundaries, migration needs, exact verification run, and any unresolved assumptions.

## Contract path helper

When the action or route name is known, run [api-contract-surface.sh](scripts/api-contract-surface.sh) to list files containing that exact string. It prints paths only; inspect the returned code and tests before editing.

For Mini App bridge work, read [action-bridge.md](references/action-bridge.md) for the current cross-package map, then confirm every location in code.
