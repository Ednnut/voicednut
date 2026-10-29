You are the principal software architect, senior full-stack engineer, voice-AI infrastructure engineer, security engineer, QA lead, and DevOps engineer responsible for upgrading the existing VOICEDNUT project into a production-grade AI Voice Operations Platform. Work directly within the existing repository and follow all instructions below.

## 1. Mission and non-negotiable constraints

Build a comprehensive, reliable, secure, extensible platform for AI calling, autonomous voice agents, call orchestration, integrations, enterprise governance, analytics, and developer tooling.

- Preserve existing repository structure, framework choices, working features, routes, APIs, UI, database conventions, and integrations wherever possible.
- Preserve Twilio, Plivo, and Vonage. Add CALL-E as an additional provider, not a replacement.
- Do not perform destructive migrations, delete existing functionality, overwrite secrets, change production configuration, deploy, purchase resources, or initiate real phone calls without explicit user approval.
- Keep credentials and provider API keys server-side. Never expose secrets in browser code, logs, analytics, test fixtures, or error responses.
- Do not invent API endpoints, SDK methods, provider capabilities, webhook events, or test results. Verify against official current documentation and the installed package versions.
- Respect provider differences. Implement capability-aware adapters and clearly report unsupported features instead of simulating them as if they worked.
- Use mock providers and fixtures for automated tests. No real calls in tests unless separately approved.
- Do not create a new framework or replace the current stack merely because another technology is fashionable.

## 2. Phase 0 — Repository discovery and audit

Before changing code, inspect the complete repository, Git status, recent commits, README, project instructions, package manifests, application entry points, frontend routes, backend services, database schema and migrations, authentication and authorization, provider integrations, environment variables, jobs/queues, webhook handlers, CI workflows, tests, deployment configuration, and existing UI conventions.

Review the CALL-E integration repository and relevant example apps:
- https://github.com/Ednnut/call-e-integrations
- https://github.com/CALLE-AI/call-e-integrations
- https://github.com/CALLE-AI/awesome-phone-call-agents

Verify current CALL-E OAuth/API/SDK contracts using official documentation. Compare the fork with upstream and identify relevant changes without blindly merging them. Check API/SDK version drift, authentication changes, supported operations, result schemas, polling behavior, webhook support, idempotency, confirmation requirements, and error handling.

Produce a repository-specific audit with:
1. Existing architecture and stack.
2. Existing features and provider capabilities.
3. Missing features mapped to actual code locations.
4. Security, reliability, accessibility, and performance risks.
5. Database/API compatibility concerns.
6. Reusable modules versus genuinely necessary additions.
7. Prioritized implementation phases and dependency order.
8. Tests and verification commands that actually work in this repository.

Run safe, non-destructive inspection and existing tests where feasible. Record pre-existing failures separately from regressions. Do not modify files during the initial audit. Present the findings and request approval before consequential implementation changes.

## 3. Phase 1 — Provider architecture and control plane

Design or improve a common provider contract consistent with the existing architecture. Create normalized internal representations for provider capabilities, call requests, execution identifiers, lifecycle states, structured results, transcripts, summaries, errors, retryability, usage, and timestamps.

Implement:
- CALL-E adapter using verified current contracts.
- Twilio, Plivo, and Vonage compatibility checks and regression tests.
- Capability registry covering outbound calls, inbound calls, scheduling, IVR handling, transfer, recording, transcripts, streaming, interruption handling, webhooks, status retrieval, and other features only when actually supported.
- Capability-aware routing and preflight validation.
- Provider-specific configuration and health checks.
- Consistent error taxonomy and safe diagnostic messages.
- Timeouts, cancellation, bounded retries, backoff, circuit breakers, and rate limits where appropriate.
- Idempotency protection against duplicate execution and accidental redialing.
- Provider credential validation and secret redaction.
- Contract tests and mock adapters for each provider.

Never force all providers into unsupported lowest-common-denominator behavior. Keep provider-specific options available through a safe, typed extension mechanism.

## 4. Phase 2 — CALL-E integration

Integrate CALL-E into the existing provider and service architecture, not as an isolated demo. Support the verified features available in the selected API/SDK version, including authentication, call planning, approved execution, execution-status retrieval, structured results, transcripts or summaries when available, and webhook processing where officially supported.

Requirements:
- Keep API keys and tokens on the server.
- Validate and normalize all incoming and outgoing payloads.
- Separate planning or preview from execution.
- Require explicit approval before any real outbound call.
- Respect CALL-E confirmation tokens and server-returned next steps, safety instructions, and stop conditions.
- Treat status polling as bounded, recoverable, and restart-safe.
- Normalize terminal statuses without assuming that all providers use identical status names.
- Persist execution IDs and reconcile incomplete runs after restarts.
- Prevent duplicate calls on retries, repeated webhooks, client refreshes, or worker restarts.
- Validate webhook signatures when supported by the official contract; reject or quarantine invalid events.
- Handle duplicate, delayed, and out-of-order webhook events safely.
- Preserve provider-specific output, provenance, and execution metadata where useful.
- Provide mock mode, fixtures, unit tests, integration contract tests, and troubleshooting documentation.

Do not claim support for raw audio streaming, arbitrary telephony controls, real-time interruption handling, or any other feature unless the verified CALL-E interface exposes it.

## 5. Phase 3 — Unified Voice Operations Center

Build a polished, responsive dashboard using the existing UI framework and design system. Include:
- Overview of calls, outcomes, active executions, failures, usage, and spend.
- Searchable and filterable call history.
- Call detail views with provider, status timeline, permitted recordings, transcript, summary, structured outcome, duration, and cost when available.
- Filters for date, provider, campaign, agent, status, outcome, and organization.
- Retry or resume controls only where safe and supported, with duplicate-execution protection and confirmation.
- Provider health and configuration status.
- Live or near-real-time updates using the existing supported infrastructure.
- Loading, empty, error, permission-denied, and offline states.
- Accessible keyboard navigation, semantic controls, responsive layouts, and consistent visual design.

Enforce tenant and role permissions on the backend, not just by hiding frontend controls. Avoid leaking phone numbers, recordings, transcripts, or customer information to unauthorized users.

## 6. Phase 4 — Visual AI Agent Studio

Create a guided agent builder that supports, as applicable to the existing architecture:
- Agent name, purpose, instructions, opening message, and conversation goals.
- Provider and capability selection.
- Verified model, voice, speech-to-text, text-to-speech, and language options.
- Structured variables and business context.
- Approved tools and external actions.
- Timeout, fallback, escalation, and human handoff policies.
- Safety and disclosure settings.
- Version history, draft/published states, and rollback.
- Preview or simulation with mock conversations.
- Validation before publishing.

Store configurations in versioned, validated schemas. Keep secrets out of agent definitions. Do not display options a provider cannot support, and do not pretend simulated calls are real executions.

## 7. Phase 5 — Workflow and automation builder

Implement a durable workflow engine or extend the existing job architecture. Support validated steps for:
- Trigger and schedule.
- Input validation and contact eligibility checks.
- Agent/provider selection.
- Human approval.
- Call execution.
- Result classification.
- Conditional branching.
- Wait and follow-up scheduling.
- Webhook or external-system actions.
- Human escalation.
- Completion and audit logging.

Provide a visual workflow editor only if it fits the current stack and can be maintained reliably. Persist execution state, support safe recovery after restarts, and prevent duplicate side effects. Add bounded retries, timeouts, cancellation, dead-letter handling where appropriate, and per-step audit records. Never implement unbounded loops or automatic redialing after ambiguous failures.

## 8. Phase 6 — Campaigns and scheduling

Build controlled campaign management with:
- Contact import and validation.
- Duplicate detection and suppression checks.
- Time-zone-aware scheduling and permitted calling windows.
- Quiet hours and configurable jurisdiction rules.
- Consent records, opt-out handling, and do-not-call lists.
- Per-campaign and per-tenant rate limits and spending budgets.
- Concurrency limits, pacing, and queue visibility.
- Pause, resume, cancel, and emergency kill switch.
- Outcome-based follow-up rules.
- Campaign previews and dry runs.
- Human approval before launch and before consequential retry policies.
- Progress, cost, failure, and outcome reporting.

Default to dry-run mode. Do not launch campaigns or contact real people without explicit approval. Never treat a missing answer, busy signal, or uncertain execution as permission to redial.

## 9. Phase 7 — Multi-provider routing and resilience

Build a routing service that evaluates real provider capabilities, configuration, health, region, permitted use, estimated cost where known, and organization policy. Support configurable primary-provider selection, explicitly permitted fallback, provider-specific constraints, circuit breaking, and observability.

Do not silently switch providers after a call may already have started. Require idempotency and execution-state reconciliation before fallback. Distinguish configuration errors, rate limits, transient network errors, provider outages, rejected requests, and ambiguous execution outcomes. Provide an explainable routing decision record.

## 10. Phase 8 — Quality, evidence, and outcome intelligence

Create a quality and analytics layer that can:
- Extract validated structured outcomes from provider results.
- Track reached, not reached, voicemail, completed, failed, opted out, and other defined outcomes without conflating them.
- Evaluate configurable business-specific success criteria.
- Summarize conversations and identify commitments or follow-up needs where permitted.
- Record source provenance and distinguish provider-supplied data from derived AI analysis.
- Support review queues, human corrections, and quality scoring.
- Track latency, errors, completion rates, and cost when measurable.
- Provide tenant-scoped dashboards and exportable reports.

Do not invent call outcomes or present model-generated conclusions as verified facts. Apply retention policies, access control, redaction, and consent requirements to transcripts and recordings.

## 11. Phase 9 — CRM and business-context integrations

Create reusable integration interfaces for customer records, cases, appointments, calendars, notifications, and helpdesk systems. Prioritize integrations that fit the existing repository and actual user needs.

Support:
- Contact and case lookup.
- Controlled context injection into agent sessions.
- Outcome synchronization.
- Appointment proposals and updates with authorization.
- Webhook-driven synchronization where supported.
- Field mapping, validation, deduplication, and conflict handling.
- Scoped credentials and auditable external actions.
- Human approval for consequential changes.

Use official APIs and documented scopes. Do not invent integration endpoints or sync private customer data without explicit configuration and authorization.

## 12. Phase 10 — Developer platform

Provide a consistent developer experience aligned with the current stack:
- Versioned REST API and OpenAPI specification if appropriate.
- Typed TypeScript SDK aligned with the actual server contract.
- Webhook registration, signature verification, delivery history, retries, and replay protection.
- MCP tools for safe planning, permitted execution after confirmation, and read-only status retrieval where supported.
- CLI commands for configuration validation, status checks, simulation, and approved operations.
- Example integrations and starter templates.
- Authentication, authorization, scopes, rate limits, pagination, idempotency, and stable error responses.
- API versioning and migration guides.
- Local development and mock-provider workflows.

Document each operation's side effects and required permissions. Read-only commands must remain read-only. Never allow MCP or CLI execution to bypass the approval and safety layers.

## 13. Phase 11 — Enterprise governance and compliance

Implement only where consistent with the current authentication and tenancy model:
- Organizations, projects, and tenant isolation.
- Role-based access control and least privilege.
- API-key lifecycle and rotation.
- Audit trails for administrative and consequential actions.
- Secret management and encryption appropriate to the stack.
- Retention and deletion controls for call data.
- Consent and opt-out records.
- Calling-hour and jurisdiction policies.
- Recording and transcript access controls.
- Per-tenant quotas, rate limits, and spend limits.
- Configurable retention, data export, and deletion workflows.
- Emergency kill switch and incident diagnostics.

Verify applicable legal and regulatory requirements with qualified sources; do not claim blanket compliance or certification. Default to the stricter applicable configured policy where jurisdiction is known, and stop for review when required policy information is missing.

## 14. Phase 12 — Billing, usage, and ROI

Create provider-aware usage metering and cost analytics based on verified provider billing data and clearly labeled estimates. Track usage by organization, provider, agent, campaign, and time period where possible.

Add configurable budgets, thresholds, alerts, usage exports, and cost-per-outcome metrics. Separate actual billed amounts from estimates and from internal platform fees. Prevent duplicate usage records and never fabricate prices or ROI. Do not initiate purchases or change billing settings without explicit approval.

## 15. Phase 13 — Integrations marketplace and extensibility

Establish a maintainable connector registry for provider integrations, CRM, helpdesk, calendars, automation tools such as n8n, and future supported services. Add integrations incrementally based on verified APIs and demand. Provide capability metadata, setup validation, permissions, health status, version compatibility, and clear installation documentation.

Do not build a large marketplace UI before the connector architecture, security boundaries, and lifecycle management are ready.

## 16. Engineering quality requirements

- Follow the repository's existing conventions and minimize unnecessary dependencies.
- Use strict types and runtime validation at external boundaries.
- Add unit, integration, contract, authorization, regression, and end-to-end tests appropriate to each feature.
- Include fixtures and mock providers; tests must not initiate real calls.
- Add migrations only when required, with backward compatibility and rollback guidance.
- Test duplicate events, timeouts, retries, process restarts, partial failures, provider outages, and ambiguous call states.
- Add observability with structured logs, correlation IDs, metrics, and secret/PII redaction.
- Test accessibility, mobile responsiveness, and error handling for UI changes.
- Update documentation, environment examples, configuration validation, and troubleshooting instructions.
- Run lint, type checks, tests, and builds available in the project.
- Never report a check as passing unless it was actually run successfully.
- Do not mask failures, weaken security checks, or delete tests to make the build pass.

## 17. Implementation workflow

Work in dependency-ordered, reviewable phases:

A. Audit and report; no file changes.
B. Propose architecture and implementation plan; request approval.
C. Establish baseline tests and provider contracts.
D. Implement the provider control plane and CALL-E integration.
E. Add governance and safe execution foundations.
F. Add the operations dashboard and agent studio.
G. Add durable workflows, campaigns, and routing.
H. Add quality analytics and business integrations.
I. Add developer APIs, SDK/MCP/CLI capabilities.
J. Add enterprise controls, billing analytics, and extensibility.
K. Perform regression, security, accessibility, performance, and deployment-readiness reviews.

After each approved phase:
1. Explain the exact scope.
2. Make small, logically grouped changes.
3. Run relevant checks.
4. Report changed files and important implementation decisions.
5. Report passing and failing tests honestly.
6. Document remaining risks and any required manual configuration.
7. Stop before the next consequential phase if approval is required.

## 18. Definition of done

The project is not complete merely because the UI looks good or the CALL-E API returns a response. Completion requires a maintainable architecture, preserved existing providers, capability-aware integrations, safe and idempotent execution, durable job recovery, tenant isolation where applicable, secure secrets, comprehensive tests, usable documentation, accurate usage reporting, accessible UI, and a clear deployment checklist.

## Immediate action

Phase 0 audit and implementation-plan approval are complete. Continue only with the currently approved phase, update the implementation checklist below, and request approval before starting another consequential phase.

## Implementation checklist

### Phase 1 — Provider architecture and control plane

- [x] Preserve the existing Twilio, Plivo, and Vonage adapters and flows.
- [x] Keep CALL-E task creation distinct from generic outbound call creation and active-call termination.
- [x] Add read-only registry operation preflight with stable unsupported/not-registered reasons before adapter I/O.
- [x] Document the repository's integrated provider capabilities separately from broader provider API features.
- [x] Add mocked regression coverage for Twilio call payload construction, Plivo REST request construction, and Vonage SDK call/hangup operations.
- [x] Remove the CALL-E `summary` capability claim; the checked Calls V2 contract exposes transcript, structured result, outcome, and event history, not a separate summary field.
- [x] Review provider readiness, health scoring, circuit cooldown, API rate limiting, timeout, and bounded-retry behavior. Keep open circuits out of the attempt order until half-open.
- [x] Prevent carrier call creation retries and provider switching after an ambiguous submission. Only continue to another provider when submission is known to be rejected or not started; retain an existing idempotency reservation as pending on an ambiguous result.
- [x] Sanitize normalized outbound errors and provider-health diagnostics so provider response messages do not enter routine call error logs.
- [x] Keep the shared registry result envelope limited to execution identity, submission state, provider/canonical status, and metadata. Preserve read/result payloads as provider-specific optional data; do not synthesize transcript, summary, usage, or timestamps when an adapter cannot provide them.

The general outbound API still accepts requests without an idempotency key for compatibility. Those unkeyed requests cannot retain a local reservation after an ambiguous provider response; the route now returns an explicit stop-and-investigate error and does not automatically fail over. Requiring idempotency keys for all callers is a separate API compatibility decision.

Phase 1 is complete for the current provider registry and outbound carrier path. It does not establish live provider readiness or authorize a pilot. No later phase is authorized by this checklist.

### Phase 2 — CALL-E integration

- [x] Keep CALL-E access behind server-side `CALLE_API_KEY`, an allowlisted production or test base URL, bounded request timeouts, and the existing default-off provider/dispatch gates.
- [x] Integrate the documented Calls V2 REST contract (`POST /v2/calls`, `GET /v2/calls/{id}`, `POST /v2/calls/{id}/cancel`, and paged event reads) through the existing client, adapter registry, service, and persistence boundaries. No CALL-E SDK dependency is installed or required.
- [x] Separate no-call template preview from execution. Dispatch requires the exact approved preview fingerprint, an unexpired pilot approval, current business-operator membership, an explicit operator confirmation, consent evidence, destination allowlisting, and the one-call pilot guard.
- [x] Persist the local/provider execution linkage and original request fingerprint before submission. Preserve same-key recovery after uncertain submission; do not create a new key, redial, or fail over automatically.
- [x] Normalize documented execution status, telephone outcome, result readiness, validated scalar result, and transcript turns without treating `completed` as business success. Keep provider result and transcript out of ordinary local persistence and logs.
- [x] Provide bounded, restart-safe status/event reconciliation, cursor retention, event-ID deduplication for event pages, result-schema validation, and business-scoped operator review.
- [x] Process only the documented terminal Calls V2 webhook envelope. Match `CALL-E-Event-Id` to the body event ID, fetch the authoritative snapshot using server credentials, and persist only minimal receipt identifiers. Current CALL-E webhooks are unsigned: the header match is not authentication or a signature, so webhook payloads are never trusted as authoritative data. The route is bounded and rate-limited.
- [x] Add deterministic client, dispatch, idempotency/recovery, reconciliation, webhook, and offline lifecycle coverage using mocks and synthetic data; document current endpoint behavior and stop/recovery steps.

Contract scope checked 2026-10-28: direct HTTP Calls V2, not the separate OAuth/MCP workflow. Calls V2 has no CALL-E confirmation token, planning endpoint, scheduling, batch recipients, or active-call hangup operation; VOICEDNUT's no-call preview and explicit operator gate provide its local approval boundary. The official webhook guide documents unsigned terminal deliveries with at-least-once retries and requires `CALL-E-Event-Id` to match the envelope `id`. See [Calls API](https://docs.heycall-e.com/api-reference/calls), [Webhooks](https://docs.heycall-e.com/webhooks), and the [official CALL-E integrations repository](https://github.com/CALLE-AI/call-e-integrations).

Phase 2 is complete for the documented Calls V2 integration and local guarded dispatch path. This is implementation/test readiness only: provider credentials, account eligibility, destination authorization, external approvals, and any live pilot remain unverified and disabled.

### Phase 3 — Unified Voice Operations Center

- [x] Extend the existing Ops Dashboard, Call Log Explorer, and Provider Control surfaces instead of introducing a parallel dashboard framework.
- [x] Add CALL-E history with bounded pagination and filters for execution state, telephone outcome, result readiness, call identifier, and date range.
- [x] Enforce current CALL-E business-operator membership in the backend before returning a history list; query records only for currently granted businesses and keep the dashboard's `dashboard_view` capability check.
- [x] Return summary metadata only in list responses. Do not include destination numbers, provider payloads, transcript, or structured results in history rows or ordinary logs.
- [x] Add per-call status refresh and event timeline using existing authenticated CALL-E reconciliation; keep content review behind explicit confirmation and existing business-scoped authorization and payload bounds.
- [x] Preserve the existing Script Studio `caller_flags_manage` action contracts; expose separate Call Log dashboard actions requiring `dashboard_view` plus the same backend business-operator check.
- [x] Reuse existing operations metrics, provider health, status state, and call-history UI; add labeled loading, empty, error, and operator-access-denied states with keyboard-operable controls and responsive layout.
- [x] Add API service tests for tenant/business filtering, revoked membership, validated filters, bounded pagination, and private-field exclusion; add deterministic fixture-backed browser coverage for list, filter, timeline, and explicit private-content review.
- [x] Use no recording, spend, or standalone summary fields because the current CALL-E Calls V2 integration does not expose them through VOICEDNUT.

Phase 3 is complete for the existing cross-provider operations center and the new business-scoped CALL-E operations view. Other provider history remains in its existing Call Log Explorer; this change does not add new provider endpoints or broaden their access rules.

### Phase 4 — Visual AI Agent Studio (implementation and local review complete)

- [x] Extend the existing Script Studio call-template editor with agent name, purpose, runtime profile, instructions, opening message, and conversation-goal authoring.
- [x] Add server-side pre-review validation with bounded field sizes and a maximum of 50 supported `{variable}` placeholders; preserve the existing draft/review/approval/live lifecycle.
- [x] Make the existing deterministic template-render preview readable and explicit that it performs no model inference or external call.
- [x] Surface existing version history and guarded rollback in the Mini App. Restoration creates a new version and draft; it never publishes automatically.
- [x] Include the agent schema version in new snapshots while remaining compatible with existing snapshots; schema versioning itself required no migration.
- [x] Register the existing Vapi Mini App routes after Express initialization and shared request middleware; add a boot-order regression test.
- [x] Define a versioned provider-capability schema from the existing call-flow registry, validate provider/flow membership and runtime gates, and expose it through the authenticated provider configuration response. No model, voice, speech, or language options are claimed by this flow-only schema.
- [x] Add versioned agent runtime settings for approved tool names and bounded tool timeouts; persist them in an additive nullable template column, include them in version snapshots, validate tools against the locally generated tool manifest, and enforce the allowlist before Voice Agent Bridge implementation execution.
- [x] Apply configured Voice Agent Bridge timeouts only beneath the server-wide tool timeout ceiling; retain existing behavior for templates without runtime settings.
- [x] Treat a configured empty tool allowlist as deny-all and recheck the server-side policy immediately before tool execution, including when a tool request is not advertised to the voice runtime.
- [x] Keep the current template’s agent restrictions active when a call references a stale content version, so version mismatch cannot turn off the allowlist or timeout.
- [x] Add bounded schema-v2 business reference context to agent runtime settings and include it in GPT and Voice Agent system instructions for outbound and default inbound scripts. Treat values as delimited reference data, not instructions; preserve schema-v1 runtime settings.
- [x] Add schema-v3 escalation outcome allowlists restricted to `review_case` and `secure_follow_up`; narrow the advertised GPT tool enum and enforce the configured default in the handler so callback requests cannot schedule calls under this policy.
- [x] Add a schema-v4 tool failure policy with legacy-compatible `continue` behavior and an explicit `end_call` fallback that records a sanitized failure state, does not retry, and uses the existing call-ending path.
- [x] Add schema-v5, disabled-by-default Twilio handoff policy for Voice Agent scripts with a fixed E.164 destination. Advertise `live_transfer` only for authenticated Twilio calls using a `live` script with the policy enabled. Require verified stream HMAC authentication and Twilio inbound DTMF `1` to claim the transfer (`2` cancels); persist one handoff row per call with expiry and atomic state transitions before the call update, clear the stored destination when confirmation is consumed, and never retry an ambiguous provider result. The transfer uses the official active-call TwiML update pattern and records `started_unconfirmed`; destination answer is not inferred. Other providers and the separate Vapi route are not presented as this runtime's handoff capability.
- [x] Expose authenticated script version comparisons in Script Studio, with capability-gated, read-only version diffs and draft-only restoration; retain the existing review/approval/live lifecycle.
- [x] Add per-script Deepgram speech-voice selection from the existing curated catalog, persist it through the authenticated Mini App action bridge and script-version snapshots, and reject unsupported voice IDs server-side. Keep custom/legacy stored choices visible for preservation; an empty choice retains profile-based voice selection.
- [x] Add per-agent Deepgram language, speech-recognition model, and managed reasoning-model options. Persist them in runtime schema v6, validate supported language/model combinations plus an explicit matching speech voice server-side, and apply them to the Voice Agent Settings payload. Flux models use `v2` and omit Nova-only formatting; Nova receives its configured language and multilingual Flux receives a matching language hint. The UI exposes only curated supported choices and keeps credentials server-side.

Phase 4 implementation and local regression/security review are complete. Approved tools, bounded tool timeouts, structured business reference context, constrained non-callback escalation outcomes, tool failure fallback, Twilio-only Voice Agent handoff, draft/version comparison controls, per-script Deepgram speech-voice selection, and validated per-agent Deepgram language, speech-recognition, and managed reasoning-model settings are implemented. Handoff requires a live Twilio script, verified stream HMAC authentication, a fixed admin-configured destination, and inbound DTMF confirmation; one durable state row per call prevents duplicate dispatch, and ambiguous transfer outcomes are not retried. The system records transfer start without claiming the destination answered. A configured tool failure policy can explicitly end the active call with the existing safe closing path; it does not retry a failed tool. Script comparisons are read-only; restoration creates a draft and does not publish. Other providers' handoff features are not claimed. A real provider smoke test, production configuration review, and deployment decision remain outside local verification; no live calls or deployment were performed.

### Phase 5 — Workflow and automation builder (foundation in progress)

- [x] Extend existing post-call automation run records with ordered, persisted per-action progress states and sanitized error codes; no schema migration required.
- [x] Retry failed email actions with the existing stable per-action idempotency key, while skipping completed steps from the prior run.
- [x] Block automatic retry when a step was left running or a failed CRM/ticket action may have had an external side effect; older unaudited runs containing non-email actions are also blocked.
- [x] Add regression coverage for persisted step progress, completed-step skipping, stable email idempotency, and ambiguous/non-idempotent retry rejection.
- [x] Add additive versioned workflow-definition storage with strict schema-v1 validation, draft/approved lifecycle, admin-only listing and approval, bounded wait steps, acyclic branch graphs, and supported existing action types.
- [x] Record the admin-token principal label and approval timestamp; each saved version is immutable and a later edit creates a new draft version. Approval does not publish or execute a workflow.
- [x] Add service, route authorization, schema validation, and SQLite persistence coverage using temporary local databases and test doubles.
- [ ] Define versioned workflow schemas, approval states, bounded wait/branch steps, durable triggers and execution state, cancellation/recovery, and auditable editor/API surfaces.

This remains a foundation for the workflow builder, not a workflow executor or visual editor. Existing automation rules and provider behavior are unchanged. Definitions use an additive table created by the existing idempotent SQLite startup initializer; no existing rows are rewritten. No live call, deployment, or production configuration change was performed. Local verification and remaining risks are recorded with the implementation report.
