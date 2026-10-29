# Task: Add or extend a voice/messaging provider integration

Route through `provider-onboarding` + `telephony` (+ `api`, `database`, `security`, `testing` as needed; `release` before production enablement). Follow the existing adapter/service seam — do not invent a parallel pattern.

1. Evidence first: read current official provider docs (endpoints, auth, idempotency, webhooks, billing); record which doc page backs each claim. Never infer an endpoint from a name.
2. Scaffold consistently: client in `api/services/<provider>Client.js` (server-only credentials from env, bounded timeouts, origin allowlist, sanitized errors, no auto-retry of mutating calls); operations in `<provider>*Service.js` with constructor-injected `{ db, client }`; template/config translation in `api/adapters/`. Copy structure from `callEClient.js` / `vapiClient.js`.
3. Safety gates: master enable flag default-off plus an independent dispatch kill switch; exact-destination or account allowlists where risky; idempotency reservation before any billable operation; uncertain-outcome reconciliation path and operator-visible status.
4. Persistence: additive tables/columns only via the `api/db/db.js` startup pattern (see `migration-runner` for execution), tenant/business scoping on every new table.
5. Tests: stub all provider I/O; cover accepted/pending/no-answer/unavailable/malformed/timeout/uncertain-acceptance fixtures; duplicate-request and changed-request conflicts; verify other providers' paths unchanged (`cd api && npm test -- --reporter dot`).
6. Docs: env keys added to `.env.example` with off-by-default values; capability matrix row; runbook + rollback notes; NO-GO criteria listed explicitly when live use is gated.

Report per step what was verified vs. assumed; no live calls, payments, or credential use without explicit approval.
