# VOICEDNUT Phases 11–16 Implementation Report

Status snapshot: 2026-11-14. This report describes the current repository worktree. It does not represent a production rollout; no deployment or production database change was performed.

## A. Executive summary

The current implementation connects outbound call execution to shared correlation context, provider capability recommendations, durable post-call event and workflow processing, scoped customer identity, reviewed structured extraction, and safer Telegram Bot conversations. Enterprise work adds audited business provider-routing revisions, existing CALL-E usage reservations and currency-aware usage records, and a route-specific API integration guide.

These changes improve traceability and recovery while preserving current provider adapters and API route behavior. They do not complete every item in the roadmap. The phase matrix below is intentionally conservative.

## B. Architecture

- Outbound execution services can carry a minimized `execution_context` with request, actor, business, provider, call, workflow, and idempotency correlation references. Provider payloads and transcript content are not copied into the context.
- Shared provider routing uses the existing registry and adapters. Direct Vapi and Cartesia paths remain provider-specific where the repository already requires that boundary.
- Post-call events are persisted in a bounded durable queue; workflow definitions and run/step audit use existing SQLite persistence. Retries are bounded, and ambiguous external actions are routed to review instead of replayed automatically.
- Structured extraction runs after call completion, validates output against a bounded agent-config schema, records transcript evidence and provenance, and leaves results pending human review.
- The Bot calls the API as the source of truth. Short-lived conversation state is persisted in Bot SQLite under a chat-and-Telegram-user key; API effects are guarded against grammY conversation replay.

## C. Phase completion matrix

| Phase | Status | Evidence and remaining scope |
| --- | --- | --- |
| 11 — Unified orchestration | Partially completed | Shared execution context and lifecycle correlation exist for selected shared outbound routes. Coverage is not yet platform-wide across all providers, Bot operations, and workers. |
| 12 — Provider/runtime intelligence | Partially completed | Capability evaluation, read-only provider recommendations, readiness/circuit observations, and business provider ordering exist. Recommendations do not dispatch, and uncertain submissions do not trigger automatic failover. |
| 13 — Event-driven automation | Partially completed | Durable workflow events, versioned definitions, execution step audit, retry/dead-letter handling, and explicit recovery exist. Not every event source and external action is covered. |
| 14 — Customer/conversation intelligence | Partially completed | CRM identity matching uses email, external CRM ID, or local contact ID; phone alone is not a deduplication identity. Business-scoped customer context and interaction-history coverage remain incomplete. |
| 15 — Structured AI and Bot experience | Partially completed | Structured extraction, evidence validation, pending review, clearer command guidance, per-user recoverable sessions, and replay-safe API effects exist. Notification coverage and any further AI/chat assistance remain incomplete. |
| 16 — Enterprise configuration, usage, and developer experience | Partially completed | CALL-E provider-routing, safety-policy, and mission approval-policy revisions with rollback, CALL-E usage accounting, GPT and cross-system rule-based anomaly summaries, API contract guidance, and an opt-in business outgoing webhook slice exist. Usage, anomaly source coverage, webhook event coverage, and contract coverage remain scoped and incomplete. |

No phase is marked complete, blocked, or not started: each has verified implementation, but the roadmap's full acceptance criteria remain open.

## D. Provider intelligence

The shared provider registry evaluates supported outbound operations and capabilities and exposes a read-only recommendation endpoint. Recommendations distinguish eligible alternatives from verified health and do not create credentials, authorize a call, or dispatch one. Business provider routing is applied through existing adapters; explicit preferences, readiness, circuit state, and uncertainty protections remain in force. Ambiguous provider submissions require reconciliation rather than automatic retry or failover.

## E. Automation

Post-call workflow definitions are versioned and validated. Durable event records carry minimized metadata and opaque idempotency correlation. Run and step audit supports bounded retry and operator review; manual event replay is restricted to dead-lettered events. Workflow execution remains behind its existing disabled-by-default feature flag. Existing providers and action adapters are retained.

## F. Customer intelligence

Contact identity resolution no longer deduplicates on phone alone. Structured post-call results are tied to call/business references and remain subject to business scope and reviewer authorization. The current CRM sync persistence is not a general tenant-isolated interaction-history store, so it must not be treated as one.

## G. AI intelligence

Post-call extraction accepts a bounded JSON Schema subset from agent configuration, sends a bounded transcript to the configured OpenRouter model, validates JSON and evidence locally, records model/provenance and confidence, and stores results for review. Results begin pending review and cannot directly authorize workflow actions. QA and extraction retain rollout/shadow/allowlist controls.

## H. Telegram Bot

The Bot provides contextual help for existing call, provider, CALL-E, workflow, and administrative commands. Sensitive call flows retain explicit confirmation. Conversation state is keyed by chat and Telegram user, serialized per owner, and expires after 15 minutes. Expired, incompatible, or corrupt state is cleared with restart guidance. HTTP effects inside conversations use a bounded replay guard; uncertain mutations direct operators to inspect status before retrying. Mission notifications continue to require explicit operator subscriptions and idempotent event handling.

## I. Enterprise operations

- Configuration remains in the repository's existing environment, settings, and business-policy mechanisms; no competing configuration store was added.
- Business provider-routing policy now has an append-only revision history. Existing rows are imported as baseline revisions; updates create atomic revisions; authorized policy managers can roll back to a prior revision, which is recorded as a new event.
- CALL-E business safety policies now retain append-only baseline/configured/rollback revisions with actor attribution. Existing rows are backfilled once by an additive startup migration. The current business safety policy remains live and is rechecked before each recipient dispatch; a setting rollback restores a prior snapshot as a new revision and does not erase history.
- CALL-E mission approval policies now retain append-only baseline/configured/rollback revisions with actor attribution. `GET /api/call-e/mission-approval-policy` returns bounded history; policy managers can restore a revision through the rollback endpoint, recorded as a new revision. Active dispatch continues to use the current approval threshold and expiry policy.
- CALL-E usage records distinguish operator-entered actuals from estimates, retain explicit currency/source data, conservatively include reservations, and preserve estimate replacement audit. Business-scoped mission reports now expose usage coverage and explicitly count dispatched recipients with no recorded cost as unknown; this is not a provider billing reconciliation. The API does not independently fetch or verify provider billing records.
- `GET /api/observability/gpt` exposes informational rules for GPT tool failure rate, open circuits, and degraded SLO counts. It does not suspend work and is not platform-wide anomaly detection.
- `GET /api/observability/anomalies` adds authenticated informational rules for call-volume surges, latest open provider diagnostic circuits, persisted failed/error call rows grouped by provider, bounded process-local global HMAC rejection buckets, call-job retries, CALL-E dispatched-recipient counts and active reservations, outgoing webhook/inbound webhook failures, post-call workflow failures and durable workflow event retries, and persisted Mini App authentication threshold alerts. Rules are configurable and never block operations. Evidence limits are returned/documented: HMAC counts omit webhook bypass routes and route-specific token/session failures and reset on process restart; provider call errors require persisted local error codes; campaign dispatch counts require a recorded local call ID; workflow retries count only durable post-call event rows with more than one recorded processing attempt.
- `api/README.md` documents observed authentication, correlation, error, pagination, and idempotency conventions and selected real route contracts. The outgoing webhook product supports business-scoped `post_call_completed`, `post_call_outcome_classified`, and `post_call_automation_failed` events. Subscription configuration has append-only, actor-attributed history; deliveries pin the configuration revision used for retry and replay. Broader lifecycle event coverage and generated OpenAPI remain incomplete.

## J. Database and compatibility

Changes use the existing additive SQLite startup migration pattern. Provider-routing, CALL-E safety-policy, mission approval-policy, and outgoing-webhook configuration history add revision and index tables, append-only triggers, compatible columns, and one-time baseline backfills. Startup migration, backfill, and capture-trigger installation execute under `BEGIN IMMEDIATE`; setting writes and SQLite triggers record each subsequent revision atomically. Webhook deliveries pin the revision at enqueue time and join against that immutable snapshot for destination and signing-key reference. Existing queued deliveries are assigned the current baseline during migration because their original configuration is unavailable. Tests cover pre-versioning schemas, repeat migration, legacy writers, concurrent provider-routing updates, policy rollback, delivery pinning, and append-only behavior. No production database was opened or migrated.

Rollback is an audited forward change that restores a selected historical provider order or safety-policy snapshot. Removing history tables would destroy audit evidence and is not an application rollback procedure. For a shared deployment, take a SQLite-consistent backup including WAL state before rollout, verify the new schema and one expected baseline revision per existing policy/subscription, and use a forward repair if migration verification fails. An application rollback can retain the additive columns/tables; older policy writers continue to be captured by database triggers. Production rollout still requires its own approval and backup procedure.

## K. Verification

- `cd api && npm test -- --reporter dot` — 1,085 passing after adding usage coverage reporting and the opt-in post-call automation-failure webhook event.
- `cd api && npm run lint` — passed.
- `cd api && npx mocha __tests__/callECampaignMissionDb.test.js __tests__/callEMissionOperationsService.test.js --reporter dot` — 36 passing before the final migration-lock adjustment; the final database-focused run `npx mocha __tests__/callECampaignMissionDb.test.js --reporter dot` — 24 passing after it.
- `cd api && npx mocha __tests__/vapiOutboundCallRoute.test.js --reporter dot` — 3 passing after its expected correlation input was updated.
- `cd bot && npm test` — 151 tests, 146 passed, 5 skipped, 0 failed.
- `cd api && npx mocha __tests__/outgoingWebhookService.test.js __tests__/outgoingWebhookDb.test.js --reporter spec` — 8 passing after adding config-history redaction, actor attribution, pinned destination/signing reference, and success-state coverage; transport was stubbed and no external endpoint was contacted.
- `cd api && npx mocha __tests__/outgoingWebhookService.test.js __tests__/outgoingWebhookDb.test.js __tests__/postCallAutomationTriggers.test.js --reporter spec` — 18 passing with outcome-classification payload minimization and source wiring; no external endpoint was contacted.
- `cd api && npx mocha __tests__/outgoingWebhookService.test.js __tests__/postCallAutomationTriggers.test.js __tests__/outgoingWebhookDb.test.js --reporter spec` — 20 passing after adding the opt-in `post_call_automation_failed` event, its minimized contract, and trigger wiring; no external endpoint was contacted.
- `cd api && npx mocha __tests__/platformAnomalyDb.test.js __tests__/statusRoutes.test.js --reporter spec` — 5 passing with provider-grouped call-error metrics, threshold alerts, auth, and privacy assertions.
- `cd api && npx mocha __tests__/apiAuthFailureMetrics.test.js __tests__/statusRoutes.test.js __tests__/platformAnomalyDb.test.js --reporter spec` — 7 passing with bounded process-local buckets, alert thresholds, authorization, and privacy assertions.
- `cd api && npx mocha __tests__/platformAnomalyDb.test.js __tests__/statusRoutes.test.js --reporter spec` — 5 passing after adding a configurable anomaly alert for retried durable workflow events.
- `cd api && npx mocha __tests__/callECampaignMissionDb.test.js __tests__/callEMissionOperationsService.test.js --reporter dot` — 41 passing after adding mission usage coverage and unknown-cost reporting.
- `cd api && npx mocha __tests__/callECampaignMissionDb.test.js __tests__/callEMissionOperationsService.test.js __tests__/callEMissionSchemaMigration.test.js --reporter dot` — 41 passing with mission approval-policy history, rollback, and additive-schema migration coverage.
- `git diff --check` and JavaScript syntax checks for the edited API modules — passed.

No live provider calls, messages, payments, or deployment operations were performed. Mini App files were not changed.

## L. Security and governance

Verified in the implemented paths: current API-side business membership and policy-manager checks; signed Bot actor assertions for routes that accept actor IDs; explicit call confirmation; idempotency/reconciliation guidance; bounded transcript/schema input; secret and sensitive-result filtering; replay-safe conversation effects; append-only workflow, usage, provider-routing, safety-policy, mission-approval, and webhook-configuration revisions. The remaining phase gaps below mean this is not a platform-wide security or enterprise-readiness certification.

## M. Deployment readiness

No deployment has occurred. Before staging, validate the additive migration against a copy of the target SQLite schema, confirm WAL-aware backup and restore, inspect API/Bot environment parity, and check route authorization and provider readiness. Keep workflow/extraction/notification gates at their reviewed rollout settings and perform only stubbed or no-call rehearsal first. Production use requires an independent release review and explicit deployment authorization.

## N. Highest-value remaining work

1. Extend usage provenance and limits across provider-reported call, AI, TTS, STT, transcription, recording, campaign, and workflow data without inventing prices.
2. Expand anomaly evidence to aggregate route-specific token/session and webhook authentication failures across process instances, and add richer campaign consumption and more workflow patterns. Current alerts remain informational; global HMAC counters are process-local, and provider call errors are available only when a local failed/error call row carries an error code.
3. Extend outgoing webhook event coverage beyond the current post-call completion, classification, and automation-failure events; current delivery has tenant authorization, allowlisted payloads, DNS pinning, signing, bounded retry, append-only configuration history, pinned delivery config, history, confirmed dead-letter replay, and stub-transport verification.
4. Add version history/rollback to remaining mutable organization settings where active execution semantics require it, without creating a competing settings store.
5. Continue standardizing route schemas and errors incrementally, then generate OpenAPI only after the actual contracts are sufficiently stable.
6. Broaden execution-context coverage and tenant-safe customer interaction history, then update the phase matrix only after end-to-end evidence.
