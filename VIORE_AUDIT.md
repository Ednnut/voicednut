# VIORE phase 1: repository architecture and reliability audit

Audit date: 2026-11-22

## Implementation progress

Since the baseline audit, the reliability foundation, a small status-surface improvement, and stale-worker recovery controls have been implemented:

- Outbound and callback submission errors that indicate an uncertain result (provider timeout/network failure, explicit uncertainty, or provider 5xx) no longer fall through to another provider.
- Retryable or unclassified failures for outbound/callback jobs now default to the ambiguous-outcome review hold. Only recognized non-retryable errors bypass that classification; the existing scheduled-SMS retry policy remains unchanged.
- Call jobs with those ambiguous outcomes are dead-lettered as `ambiguous_outbound_outcome`, not automatically retried. The generic DLQ replay endpoint rejects this reason until reconciliation occurs.
- The existing admin `/status` command now reads authenticated `/ready`; the public `/health` response remains minimal. Detailed `/ready` responses carry `Cache-Control: no-store`.
- Authenticated readiness and the existing admin `/status` report now include pending/running/completed/failed call-job counts and open dead-letter count, computed from the existing SQLite tables.
- Stale `running` call jobs are atomically marked failed and dead-lettered as `worker_interrupted_requires_review` after the worker timeout plus a grace period. They are not automatically rerun. Each claim gets a unique lock token, and lock-token checks prevent a late worker from completing, rescheduling, or dead-lettering a quarantined job. Generic DLQ replay rejects this review-only reason.
- The callback-task status API now only edits pending callback jobs through a guarded update and rejects jobs already in the DLQ, preventing that API from bypassing the review hold.
- Worker failures now update the job and its DLQ record in one SQLite transaction. A failed DLQ write rolls back the job transition, and the transaction checks the worker lock token before changing either record.
- Worker completion, retry, or failure writes rejected by the lock-token fence now emit a bounded `late_worker_update_fenced` service-health event containing only the job ID/type and attempted outcome.
- Ordinary DLQ replay now creates the replacement job and transitions its DLQ row in one `BEGIN IMMEDIATE` transaction. It rechecks open status and the replay limit inside the transaction, preventing concurrent admin requests from creating duplicate replay jobs. Ambiguous outbound and interrupted-worker entries remain review-only.
- Generic DLQ replay now blocks all `outbound_call` and `callback_call` jobs, including entries recorded under otherwise non-ambiguous reasons. Non-call jobs retain their existing replay behavior; call-job replay needs a separate explicit operator review/resolution workflow.
- The existing admin `/status` Telegram command shows up to three open DLQ review items by ID, job type, and reason code. Payloads and raw error text are not included in the message; no new command was added.
- The existing admin `/status` now summarizes configured call providers, degraded/open-circuit state, and an observed health score only when a success/error timestamp exists. Its wording distinguishes configuration/circuit state from live connectivity; it performs no provider probe and exposes no credentials.
- The global Speko human-dial admin route now requires `confirm_to` to match the trimmed destination and removes that confirmation field before invoking the call-control service. Unconfirmed/mismatched requests cannot reach the service; the Mini App's separate owner-scoped dial flow was not changed.
- Every global Speko human-call control command now requires an exact `confirm_command` naming the command and control ID; transfer, bridge, and DTMF confirmations also bind the target value. The route strips confirmation metadata before service dispatch, and failed confirmations stop before any provider operation.
- The Telegram status view now reads a dedicated authenticated DLQ summary endpoint backed by a bounded SQL projection that never selects payload or raw error fields.
- The existing `dlq.call.list` operator action now uses the same bounded summary endpoint, so job payloads and raw provider error text do not pass into the bot response path.
- Added an authenticated per-entry DLQ diagnostic endpoint. It reports the recorded job type/reason, marks call outcomes unknown and replay blocked pending review, and recommends checking provider state; it does not return payloads or raw errors and does not perform reconciliation.
- The shared scheduler now stores a stable idempotency key in every new `outbound_call` and `callback_call` job payload. Valid supplied keys are retained, missing/invalid ones get a UUID, and non-call jobs are unchanged. The existing manual retry payload builder assigns a fresh key per explicit retry, and delayed retries preserve that key in the queued payload. This makes queued Speko work satisfy its required key and preserves it across worker attempts; it does not establish provider-side deduplication for Twilio, Plivo, or Vonage.
- The bot package now has a built-in Node test command and focused tests for safe DLQ status-field formatting plus the dependency-free capability policy. The existing GitHub Actions workflow now runs those tests as a prerequisite for deployment. End-to-end middleware/callback authorization and stale/deduplicated action behavior still lack package-level regression coverage; the workflow edit has not been exercised by a GitHub Actions run.
- Speko live agent deploy and rollback attempts now write sanitized start/result records to the existing `service_health_logs` table. An authenticated, bounded `/admin/speko/agent-lifecycle-audit` endpoint exposes those records, including actor source, agent/version IDs, request ID, outcome, and safe error code.
- Focused tests cover the retry classification, SMS compatibility, API error response, health/readiness visibility, and lifecycle audit records.

These changes are in the shared checkout and have not been deployed. They do not add a database migration or dependency, add a Telegram slash command, or modify the Mini App. Lifecycle audit events reuse `service_health_logs` and follow its existing 30-day cleanup policy; they do not provide a tamper-resistant long-term audit ledger.

## Scope and baseline

This is a code-level audit of the current checkout, not a production configuration or deployment review. The checkout already had user-owned edits in API call routing, Speko adapter/persistence, API tests, bot commands, and Mini App files. Those changes were left untouched. The findings below describe the combined checkout as inspected; uncommitted changes should be reviewed separately before merging.

The initial API baseline ran with `npm test` from `api/`: **207 passing**. After reliability, status, queue visibility, lifecycle audit, stale-job recovery, atomic failure handling, Telegram review visibility, conservative outbound retry fallback, redacted DLQ summaries, late-worker observability, call-job replay restrictions, DLQ diagnostics, queued call idempotency keys, explicit retry key generation, and confirmation gates for global human dialing/control commands, the API suite passed with **241 passing**. The bot suite passes **5 dependency-free tests** covering DLQ status redaction, capability mappings, and provider-status formatting. Tests used local SQLite databases and provider stubs/mocks. No real provider requests or production operations were initiated. API configuration emitted expected development warnings for missing credentials, so live-provider readiness was not verified. The Mini App was not part of this baseline.

## Architecture overview

- **API and runtime:** `api/app.js` is the Express application composition root. It registers routes, initializes provider adapters, owns provider selection/runtime state, and starts interval-based background processors.
- **Persistence:** `api/db/db.js` wraps SQLite. Initialization creates tables/indexes and runs additive column checks. Persisted domains include calls and call state, scripts, provider-event deduplication, outbound idempotency, call jobs/dead letters, SMS/email queues, post-call automation, and Speko call/reconciliation records.
- **Call providers:** `api/adapters/` contains Twilio-adjacent policy/registry code plus separate Plivo, Vonage, and Speko adapters. `providerFlowPolicy.js` declares application-supported flows and canonical status mappings. Provider execution is coordinated from `placeOutboundCall` in `api/app.js`.
- **Webhooks and lifecycle:** Routes are registered through `api/services/webhookRoutes.js` and status/call route modules. Twilio signature verification and Speko webhook signature verification have separate guards. Provider event IDs and Speko sequences/leases are persisted for duplicate/out-of-order handling.
- **Telegram bot:** `bot/bot.js` composes grammY middleware, conversations, callbacks, and existing slash commands. `bot/utils/capabilities.js` applies role/capability checks, while `bot/utils/actions.js` and session/UI utilities cover callback validation, deduplication, menus, and operation metrics. Bot actions call the API through `bot/utils/httpClient.js` and HMAC auth helpers.
- **Scripts and operations:** Script lifecycle and provider administration are implemented through existing API and bot workflows. Speko agent management is exposed through authenticated API routes; the checked-in tests cover draft review, explicit deploy confirmation, and rollback confirmation.
- **Jobs:** API background processing uses SQLite call jobs and dead-letter records, plus interval processors in `api/app.js`. SMS, email, payment, post-call automation, and provider reconciliation each also have domain-specific processing paths.
- **Build/release:** API Mocha suite is configured in `api/package.json`. Bot has a dependency-free Node test runner in `bot/tests/operationalStatus.test.js`, and the workflow runs it as a deployment prerequisite. A full release/deployment audit was not performed.

## Existing component reuse map

| Need | Existing implementation to extend |
| --- | --- |
| Provider compatibility and selection | `api/adapters/providerFlowPolicy.js`, `api/adapters/providerState.js`, provider preflight and health helpers in `api/app.js` |
| Outbound call deduplication | `outbound_call_idempotency` and attempt lease methods in `api/db/db.js`, called from `placeOutboundCall` |
| Webhook deduplication and sequencing | `provider_event_idempotency`, Speko sequence claims, `api/adapters/spekoWebhookSecurity.js` |
| Durable delayed work and DLQ | `call_jobs`, `call_job_dlq`, and `processCallJobs` |
| Operator permissions | Bot capability middleware in `bot/bot.js` and `bot/utils/capabilities.js`; admin-token checks on privileged API operations |
| Script lifecycle | Existing call-template persistence, lifecycle helpers, API routes, and `/scripts` bot workflow |
| Operational evidence | `call_metrics`, service-health records, provider health summaries, call state, and Speko operational metrics |

No new queue, broker, orchestration framework, or database is justified by this audit.

## Highest-priority weaknesses

### P0 — Worker crash recovery and ambiguous side effects

At the initial audit baseline, `claimDueCallJobs` moved a job from `pending` to `running` and stamped `locked_at`, while the selection path only selected `pending` jobs. Stale-running recovery has since been added: jobs older than the worker timeout plus grace are atomically failed and held in the DLQ, with a unique lock token fencing any late worker writes. Provider reconciliation is not performed by this quarantine step, so it prevents automatic duplicate work but cannot establish whether a provider accepted the operation.

`processCallJobs` applies a timeout around the promise but does not cancel the underlying provider request. The shared retry classifier considers some timeout and network failures transient; the call-job classification now holds retryable or unclassified outbound/callback errors for review instead of automatically retrying. For outbound calls, a timeout can mean that a provider accepted the call even though the worker did not receive confirmation. Provider-specific rejection proof and reconciliation are still needed before safely retrying.

### P1 — Idempotency coverage differs by provider and entry path

Outbound idempotency storage and replay behavior exist. Speko requires a key and has an explicit reconcile-before-redial path exercised by `spekoOutboundRecovery.test.js`. The inspected provider call sites do not establish a common provider-side idempotency contract for Twilio, Plivo, and Vonage. Queue and retry entry points must be audited for stable key propagation before enabling their automatic retries.

### P1 — Operational signals are distributed

Metrics and health data exist, but several operational domains expose separate status methods and schemas. There is no demonstrated unified operations view spanning calls, jobs, provider health, approvals, and campaigns. Prefer adding a read-only aggregation over introducing a new monitoring subsystem.

### P2 — Validation coverage is uneven across packages

The API suite has broad unit/integration coverage, including provider policies, webhooks, Speko recovery, and persistence. The bot package runs a small dependency-free test suite for operational status formatting and capability policy, and CI is wired to run it before deployment. Actual callback middleware authorization, stale callback behavior, and end-to-end command behavior still lack automated package-level regression coverage. The workflow edit has not been validated by a GitHub Actions run. Mini App validation is outside this baseline.

### P2 — Deployment and lifecycle review remains incomplete

The repository includes a CI workflow and additive schema initialization, but this audit did not establish production backup/restore readiness, migration rehearsal, secret rotation procedures, retention policy, or staging smoke-test coverage. These need explicit evidence before release-readiness claims.

## Minimal-diff implementation plan

1. **Reliability foundation (in progress):** ambiguous and retryable/unclassified submissions stop automatic provider failover/retry and are held in the DLQ. Stale running jobs are atomically quarantined with unique lock-token fencing. Ordinary DLQ replay is atomic against duplicate admin requests, and all side-effecting call jobs require review before generic replay. Scheduled and explicit manual retry call paths carry persisted/idempotent keys, but provider-backed deduplication varies and reconciliation plus an explicit operator resolution workflow remain outstanding.
2. **Operation visibility (in progress):** queue counts are exposed through authenticated readiness and the existing admin status report, which now shows a bounded, redacted DLQ review list. Per-entry diagnostics explain the verified stored reason and safe next action. Provider-backed reconciliation and reviewed resolution for ambiguous entries remain outstanding.
3. **Telegram control centre (partial):** the existing `/status` view exposes queue health, bounded DLQ review items, and call-provider configuration/circuit state without adding commands. Broader active-call, agent, and campaign views plus end-to-end tested contextual actions remain open.
4. **Lifecycle and conversation intelligence (partial/unstarted):** Speko deploy/rollback attempts have sanitized lifecycle audit records. General script evaluation, evidence-based transcript analysis, and review workflows remain unimplemented or require verified source data and retention/access controls.
5. **Campaign and cost governance (unstarted):** no verified contact-level campaign execution controls, actual provider price sources, or budget enforcement were demonstrated in this audit.
6. **Security, observability, and scalability (partial):** readiness and DLQ diagnostics, callback/job fencing, existing capability checks, lifecycle audit, and exact-destination confirmation for the global admin human-dial route improve visibility and control. Callback middleware end-to-end coverage, cross-domain operations aggregation, deployment evidence, and long-term audit retention remain open.
7. **Quality and release readiness (partial):** API and dependency-free bot tests pass locally. The workflow has not been exercised on GitHub Actions, and backup/restore rehearsal, staging verification, secret rotation, and production migration review remain unverified.

## Recommended next implementation files

The reliability and visibility changes currently touch `api/app.js`, `api/db/db.js`, `api/services/callRoutes.js`, `api/services/statusRoutes.js`, `bot/commands/api.js`, and focused API tests. `api/app.js`, `api/db/db.js`, and `api/services/callRoutes.js` also contain pre-existing user-owned edits, which were preserved around the narrow changes. Stale-running-job recovery will require changes in `api/db/db.js` and must test concurrent claimers and interrupted jobs.

No dependency or production migration was required for the completed reliability slice. No live provider operation is authorized or needed. The recovery and concurrent-claim tests use two SQLite connections against a temporary file database; production multi-process load and provider-specific side-effect reconciliation remain unverified.

## Risk assessment

- **High:** replaying ambiguous outbound calls can cause duplicate real-world calls. Automatic retry/failover and generic DLQ replay are now held for all outbound/callback jobs. An explicit provider-backed reconciliation and reviewed replay path is still needed before operators can safely resume these jobs.
- **High, mitigated for automatic paths:** known ambiguous submission outcomes no longer trigger automatic provider failover or worker retry, and generic DLQ replay is blocked. The admin status view surfaces review IDs/reasons, but there is not yet an automated reconciliation workflow for non-Speko providers; operators must inspect provider state before any manual action.
- **Medium:** Speko lifecycle audit events are best-effort if persistence fails and expire after 30 days under existing cleanup. They do not meet long-term immutable audit retention requirements.
- **Medium:** stale-job recovery uses the current 45-second worker timeout plus a 30-second minimum grace period. This is a conservative review hold, not a provider reconciliation workflow; a slow but still-live operation may be held for review, and operators must inspect provider state before any manual action.
- **Medium:** recovery tests cover concurrent sweeps and claims across two SQLite connections, but they do not simulate sustained multi-process load, host failure, or operational recovery procedures.
- **Low:** the audit document and current test baseline do not alter runtime behavior.

## Validation performed

- Inspected API/bot package scripts, API routes and composition, provider policy/adapter structure, call persistence and idempotency, webhook guards, bot capabilities/callbacks, worker claims/retry handling, and existing Speko recovery tests.
- Ran `npm test` in `api/`: **207 passing**.
- After implementation, focused call-job and status route tests passed (**10 passing**), lifecycle audit tests passed (**3 passing**), queue summary/readiness tests passed (**4 passing**), and the full API suite passed (**221 passing**).
- Stale recovery, callback-task guards, atomic failure-to-DLQ behavior, unique concurrent claim tokens, outbound retry fallback, call-job replay restrictions, redacted DLQ summaries, diagnostics, and confirmation-gate rejection for global human dialing/control commands passed focused coverage. The full API suite passed with **241 passing**, including focused tests for generated/preserved scheduled keys and fresh keys for explicit manual retries. `npm test` in `bot/` passed (**5 passing**) for Telegram field redaction, capability mappings, and provider-status formatting. Recovery tests cover fresh/stale filtering, transaction rollback, concurrent sweeps/claims, late-worker fencing, DLQ replay holds, and callback-task mutation guards.
- Did not run provider smoke scripts, deploy, modify production state, run migrations against production, or execute real calls.

## Follow-up implementation (2026-11-22)

The next reliability and Telegram-control slice has now been implemented in the shared checkout:

- Speko session reconciliation now follows provider cursors and refuses to dial when the result set is incomplete or conflicting. A stored operation older than Speko's 24-hour idempotency window stays uncertain if no matching session is found; the adapter does not submit a new call with an expired key.
- Speko phone-session requests can pin a configured `SPEKO_AGENT_VERSION`, and provider error responses preserve retryability and retry-after details for API clients.
- Authenticated Speko lifecycle webhooks wait for the correlated call row before processing. If a callback arrives before persistence, the provider-event reservation is released and the handler returns a retryable 503. Events with missing correlation are acknowledged and recorded as a bounded failure metric.
- Admins can run a read-only Speko lookup against an open call DLQ entry. A found session is reported as evidence for operator review; no result remains uncertain; neither outcome resolves or replays the job. The Telegram `/status` view offers this action only when the stored idempotency record identifies Speko, and its callback is admin-only.
- The provider label is added only to opt-in DLQ summary responses and only from the persisted idempotency record. The job payload and raw error remain redacted.

Validation for this slice: `npm test` in `api/` passed with **249 passing**; `npm test` in `bot/` passed with **6 passing**. The focused Speko adapter/webhook and call-job reliability tests passed before the final API response assertion (**44 passing**); the final full API run includes that assertion. Only mocks and local SQLite tests were used.

### Roadmap status after this slice

| Phase | Status | Evidence and remaining work |
| --- | --- | --- |
| 1. Architecture and reliability audit | Complete | Architecture, risks, reuse map, baseline, and minimal-diff backlog are recorded above. |
| 2. Reliability foundation | Substantially implemented | Durable queue fencing, conservative retries, idempotency, cursor-based Speko reconciliation, expired-key safety, error mapping, webhook ordering, DLQ diagnostics, and Speko provider-backed lookup with reviewed DLQ resolution are covered. Provider-side reconciliation for Twilio, Plivo, and Vonage remains open. |
| 3. Intelligent orchestration | Partial | Existing provider capability and selection policies are reused; a unified operation lifecycle and end-to-end audit coverage across every operation are not complete. |
| 4. Telegram control centre | Partial | `/status` now includes provider-aware Speko DLQ reconciliation callbacks. Script workflow improvements, contextual actions, notification handling, and callback middleware end-to-end tests remain open. No slash command was added. |
| 5. Agent and conversation intelligence | Partial | Speko agent lifecycle audit and existing call-analysis paths are present; transcript search and evidence-linked recommendations remain open. |
| 6. Campaign and cost governance | Partial | Speko month-to-date spend limits and low-balance alerts are available. Campaign limits and verified cross-provider cost tracking remain open. Speko enforcement is best-effort because usage snapshots can lag concurrent calls. |
| 7. Security, observability, and scalability | Partial | Redacted diagnostics, webhook retries, worker fencing, readiness signals, and lifecycle audit are present; cross-domain aggregation, load testing, and long-term tamper-resistant audit remain open. |
| 8. Quality and release readiness | Local checks pass; latest changes unverified | Earlier full API and bot suites pass locally. The new Speko-only, budget, reconciliation, and release-gate changes have not been tested. GitHub Actions, staging behavior, backups/restore, credential rotation, and production readiness have not been exercised. |

No database schema or dependency changes were required for this follow-up. The new reconciliation endpoint is read-only and authenticated. Production readiness and live Speko behavior remain unverified.

## Speko-only, release, and cost-control follow-up

- Speko is the runtime default for new configurations. `SPEKO_EXCLUSIVE_MODE` pins provider state to Speko, rejects admin provider switches and explicit requests for another voice provider, and retains no-failover behavior for Speko calls. Explicit legacy provider settings remain honored unless exclusive mode is enabled.
- Startup and admin provider preflight use the existing verified provider preflight path. The setup wizard prints the read-only Speko preflight command for after the API starts.
- Stale non-terminal Speko calls are periodically reconciled from Speko call/event reads. The uncertain-call DLQ path now supports an explicit operator resolution only after a provider session is found and the administrator confirms its exact ID and supplies a reason; the DLQ status and audit event are committed atomically. Missing results remain open and uncertain.
- Agent deployment requires a version-matched manual release checklist when `SPEKO_AGENT_RELEASE_GATE_REQUIRED=true` (enabled by default in Speko-exclusive setup) covering draft review, simulated test review, failure paths, and rollback readiness. The installed SDK still has no evaluation endpoint; no live calls or deployment were initiated.
- Optional monthly spend limits and low-balance thresholds use Speko's typed usage summary. The API blocks new calls once reported month-to-date cost reaches the configured threshold and sends throttled admin alerts from a 15-minute background check. This is a best-effort cap because concurrent/in-flight calls may settle after the provider usage snapshot.
- This follow-up's runtime behavior and SQLite status migration have not been validated by a test run or against production data. Production readiness, webhook outage recovery under load, and live Speko behavior remain unverified.

