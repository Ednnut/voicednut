VOICEDNUT — Phase 1: Unified Communications Foundation & Live Operations

ROLE

Act as a principal software architect, senior Node.js backend engineer, telephony infrastructure engineer, AI voice integration engineer, and senior Telegram bot developer.

Your mission is to evolve the existing VOICEDNUT project into a unified, intelligent, enterprise-ready AI communications platform.

Think and work proactively. Inspect the actual repository, understand its existing architecture, reuse proven implementations, and deliver production-quality improvements with the smallest effective changes.

1. PRIMARY OBJECTIVE

Build a unified communications foundation that makes all supported providers and AI voice capabilities work together through VOICEDNUT’s existing API and Telegram BOT.

The desired experience:

* /call is the single unified outgoing-call command.
* /provider manages telephony and AI capability defaults through interactive menus.
* /cartesia provides separate interactive Cartesia management.
* All compatible calls use the same VOICEDNUT call records and lifecycle.
* All providers feed into shared internal webhook processing.
* Telegram users receive immediate and continuous call-status feedback.
* Authorized administrators can monitor calls and investigate failures.
* Call results are consistently recorded and accessible.

Do not create a separate calling system for Cartesia or any other provider.

2. STRICT PROJECT SCOPE

Prioritize:

* api/
* bot/

Keep miniapp/ completely untouched.

Do not redesign or implement Mini App features until the API and BOT implementation is complete, tested, and stable.

Preserve:

* Existing project structure.
* Existing database and migrations.
* Existing authentication and authorization.
* Existing payment integrations.
* Existing provider integrations.
* Existing Telegram commands and interactive menus.
* Existing business logic and successful workflows.

Do not replace functioning code simply because a different implementation is preferred.

3. STAGE ONE — REPOSITORY AND ARCHITECTURE AUDIT

Before changing code, inspect:

* Project structure and dependencies.
* Provider adapters and registration.
* Existing call services and controllers.
* Provider-selection logic.
* /provider command and interactive settings.
* /call command and call-creation workflow.
* Cartesia integration and existing Cartesia commands.
* Webhook routes and signature verification.
* Call-status normalization.
* Call persistence and identifier correlation.
* Telegram notification and message-editing mechanisms.
* Administrator commands and permissions.
* Retry, queue, and error-handling mechanisms.
* Existing tests and validation scripts.

Identify:

1. What already works correctly.
2. What can be reused.
3. What is incomplete or duplicated.
4. Which integrations lack complete webhook/status support.
5. Which changes are necessary to achieve the objective.

Do not assume a provider is integrated merely because its name appears in the project.

Produce a concise implementation plan and then proceed with safe implementation.

4. STAGE TWO — UNIFIED PROVIDER AND CAPABILITY ARCHITECTURE

Extend the existing architecture rather than introducing a competing framework.

Separate provider responsibilities into compatible capabilities:

Telephony

* Places and receives telephone calls.
* Supplies authoritative telephone call lifecycle events.
* Exposes call identifiers and provider-specific results.

AI voice and speech

* TTS.
* STT.
* Voice generation.
* Voice profiles.
* Compatible AI model and speech capabilities.

VOICEDNUT orchestration

* Resolves provider configuration.
* Validates compatibility.
* Executes calls.
* Correlates provider identifiers.
* Maintains internal call records.
* Coordinates webhook processing and notifications.

Cartesia must remain an independently manageable AI voice capability layer.

Preserve Twilio, Plivo, Vonage, and all other verified existing integrations.

Make future integrations possible through the existing adapter architecture without duplicating business logic.

5. STAGE THREE — INTERACTIVE /provider CONFIGURATION

Improve the existing /provider command using the established interactive Telegram menu architecture.

Allow authorized users to configure independently:

* Default telephony provider.
* AI voice engine.
* TTS provider.
* STT provider.
* AI model.
* Voice profile.
* Compatible fallback preferences.

Requirements:

* Display current selections.
* Show only supported options.
* Allow interactive selection and confirmation.
* Validate configuration before saving.
* Preserve previous valid settings if a new selection fails.
* Support Back, Cancel, Refresh, and Reset where appropriate.
* Keep provider-specific advanced options out of the normal user journey.
* Enforce tenant and user permissions.

Changing the telephony provider must not silently change the AI voice engine, and vice versa.

6. STAGE FOUR — UNIFIED /call EXECUTION

Make /call the only normal outgoing-call initiation workflow.

When invoked:

1. Load the user’s authorized configuration.
2. Resolve the default telephony provider.
3. Resolve compatible AI voice and speech capabilities.
4. Identify required fields.
5. Ask only for missing information.
6. Display a simple interactive call setup.
7. Validate the destination and provider configuration.
8. Validate agent and AI capability compatibility.
9. Create or prepare the internal call record safely.
10. Execute through the selected telephony provider.
11. Store the actual provider call ID.
12. Correlate applicable AI voice/session identifiers.
13. Start the shared status-monitoring workflow.
14. Immediately notify the user of the submission result.

Do not show an active call when the provider has rejected the request.

Do not silently switch providers.

Do not initiate duplicate calls because of retries or uncertain network responses.

Where call execution times out after a potentially successful provider request, use safe reconciliation or an explicit uncertain state rather than blindly resubmitting.

7. STAGE FIVE — UNIFIED WEBHOOK AND LIVE CALL ENGINE

This is a critical deliverable.

Extend the existing webhook infrastructure so every compatible provider participates in one internal VOICEDNUT call lifecycle.

Preserve provider-specific external webhook endpoints and payload formats where required.

Each provider adapter should:

* Verify its webhook signature.
* Validate incoming events.
* Identify the correct internal call.
* Normalize provider-specific event information.
* Forward events to shared processing.
* Handle provider-specific exceptions.

The shared processing service should:

* Process events idempotently.
* Prevent duplicate state transitions.
* Handle late and out-of-order events safely.
* Persist event history.
* Update the internal call record.
* Trigger the existing Telegram notification mechanism.
* Record processing failures.
* Support safe retry and recovery.

Use the existing status model where possible.

Support the following states where the provider exposes sufficient evidence:

* Queued.
* Initiated.
* Ringing.
* Answered.
* In progress.
* Completed.
* Busy.
* No answer.
* Failed.
* Canceled.
* Unknown or uncertain, where appropriate.

Do not fabricate events or statuses.

Cartesia correlation

Keep telephone lifecycle events authoritative to the telephony provider.

Cartesia session events may supplement the internal call record where officially supported.

Maintain the appropriate internal call ID, telephony call ID, and Cartesia session ID separately.

Never treat a Cartesia session event as proof that a telephone call connected or ended.

8. STAGE SIX — PROFESSIONAL TELEGRAM LIVE-CALL EXPERIENCE

Reuse the existing call-status notification implementation that already works well for other providers.

The objective is consistency, not a new notification framework.

After a successful call submission, provide immediate feedback.

Example:

📞 VOICEDNUT — Outgoing Call

Status: Queued

Destination: +234 XXX XXX XXXX

Telephony: Selected provider

AI Voice: Cartesia

Reference: VN-XXXX

As actual provider events arrive, update the same Telegram message where supported.

Example status updates:

🟡 Ringing

🟢 Connected

🔵 In progress

✅ Completed

🔴 Failed

⚪ No answer

At the end of the call, display:

* Final status.
* Call duration where available.
* Completion time.
* Provider information.
* Call result.
* Recording/transcript availability where supported and authorized.
* Failure explanation and useful recovery guidance.

Use existing Telegram message-editing and callback conventions.

Prevent duplicate notifications.

If message editing fails, use a safe fallback notification without disrupting call execution.

9. STAGE SEVEN — INTERACTIVE CARTESIA MANAGEMENT

Keep /cartesia as one interactive dashboard entry point.

Reuse the existing Telegram interactive menu architecture.

Provide appropriate menus for:

* Connection status.
* Voice management.
* Voice selection.
* Model management.
* Voice settings.
* Voice testing.
* Usage and activity.
* Refresh and navigation.

Use pagination, validation, confirmations, Back, and Cancel actions.

Retrieve supported capabilities from verified official Cartesia API contracts.

Voice testing must not initiate a telephone call.

Saved Cartesia configuration must be available to the unified /call engine whenever selected and compatible.

Keep Cartesia independently manageable without disconnecting it from the shared call infrastructure.

10. STAGE EIGHT — UNIFIED CALL HISTORY AND ADMINISTRATOR VISIBILITY

Reuse existing database tables and call-management services.

Every call should retain the relevant information available from its providers:

* Internal VOICEDNUT call ID.
* User and tenant ownership.
* Telephony provider.
* Provider call ID.
* AI voice engine.
* Cartesia session identifier where applicable.
* Destination reference.
* Agent reference.
* Call status.
* Event timestamps.
* Duration.
* Final outcome.
* Error information.
* Recording/transcript references where supported.
* Telegram notification reference where needed.

Improve existing operations so authorized users can view recent calls, active calls, individual call details, and results.

Authorized administrators should be able to inspect:

* Active calls.
* Failed calls.
* Stale calls.
* Missing or delayed webhooks.
* Webhook processing failures.
* Provider health.
* Notification failures.

Enforce existing role-based and tenant-level access controls.

11. STAGE NINE — PROVIDER RELIABILITY AND RECOVERY

Strengthen existing integrations with:

* Connection and configuration validation.
* Provider-specific rate-limit handling.
* Appropriate timeout handling.
* Safe retry policies.
* Webhook signature verification.
* Idempotency protection.
* Duplicate-event prevention.
* Stale-call detection.
* Safe status reconciliation where supported.
* Structured logging.
* Correlation IDs.
* Actionable error messages.

Never automatically retry an uncertain call submission in a way that might place a second real call.

Fallback routing must only happen when the original provider’s execution state is sufficiently known and retrying is safe.

12. STAGE TEN — TESTING AND REGRESSION

Use existing test frameworks and conventions.

Add focused tests for:

* Provider selection.
* Capability compatibility.
* Unified call creation.
* Cartesia integration.
* Provider-specific webhook signatures.
* Event normalization.
* Duplicate events.
* Out-of-order events.
* Late events.
* Missing call identifiers.
* Failed call submissions.
* Uncertain call submissions.
* Telegram live-status updates.
* Telegram notification recovery.
* Administrator permissions.
* Tenant isolation.
* Bot restarts.
* Existing provider regression.

Use mocked provider responses for automated testing.

Do not make real calls during automated tests.

Do not claim that live provider integration has been verified when only mocked tests have been run.

13. ENGINEERING AND SECURITY REQUIREMENTS

* Keep API keys server-side.
* Never expose credentials in Telegram messages or logs.
* Validate all external inputs.
* Verify webhook signatures.
* Protect against cross-tenant access.
* Apply least-privilege authorization.
* Prevent unauthorized recording/transcript access.
* Use safe database transactions where appropriate.
* Preserve existing migrations and compatibility.
* Avoid unnecessary packages.
* Avoid duplicate services.
* Follow existing code style and conventions.
* Document new environment variables and configuration requirements.
* Do not invent API endpoints, SDK methods, events, or provider capabilities.

Use official provider documentation and existing repository contracts as the source of truth.

14. EXECUTION STRATEGY

Work incrementally.

For each implementation stage:

1. Inspect the relevant existing code.
2. Identify the smallest safe change.
3. Implement the change.
4. Run focused tests.
5. Fix regressions.
6. Verify compatibility with existing services.
7. Document important decisions.

Do not rewrite the whole project.

Do not introduce unnecessary architectural complexity.

Do not stop after writing an implementation plan when the required work can safely be performed in the repository.

If a critical implementation is blocked by missing credentials, unsupported provider functionality, or unavailable external services, complete the safe work that can be done and clearly identify the blocker.

15. STRICT APPROVAL GATES

Do not perform any of the following without explicit approval:

* Real outgoing or incoming calls.
* Real SMS or messaging campaigns.
* Phone-number purchases or releases.
* Billable provider operations.
* Production deployments.
* Production database migrations.
* Destructive data changes.
* Production credential changes.
* Paid infrastructure creation.

Read-only inspection, local development, mocked tests, and non-destructive code changes are permitted.

16. FINAL ACCEPTANCE CRITERIA

The implementation is successful only when:

1. Existing supported providers continue working.
2. /provider controls compatible defaults through interactive menus.
3. /call provides one consistent call initiation experience.
4. Cartesia remains independently manageable through interactive menus.
5. Cartesia-powered calls use the selected telephony provider.
6. Compatible calls use the shared VOICEDNUT webhook lifecycle.
7. Users receive immediate call submission feedback.
8. Live call statuses update in Telegram when provider events are available.
9. Final call results are recorded and visible.
10. Authorized administrators can investigate active and failed calls.
11. Webhook retries do not create duplicate calls.
12. Existing call workflows and BOT commands remain functional.
13. Relevant automated tests pass.
14. miniapp/ remains untouched.

17. FINAL IMPLEMENTATION REPORT

At completion, report:

* Architecture discovered.
* Existing functionality reused.
* Features implemented.
* Files changed.
* Provider integrations affected.
* Webhook and lifecycle changes.
* Telegram BOT improvements.
* Database changes, if any.
* Tests actually executed and their results.
* Remaining provider limitations.
* Outstanding blockers.
* Recommended next implementation phase.

Be precise and truthful about what was implemented and verified.

FINAL PRODUCT VISION

VOICEDNUT should feel like one intelligent enterprise communications platform, not a collection of disconnected provider commands.

Users should simply configure their defaults, manage their AI capabilities, initiate calls, and see their results.

VOICEDNUT should handle the underlying provider complexity reliably, securely, and consistently.

Prioritize simplicity for users and engineering excellence behind the scenes.

18. NEXT PRIORITY ROADMAP

Implement these enhancements in order. They build on the provider-neutral Call Activity Center and are intended to connect existing call, provider, webhook, reconciliation, and post-call automation features without replacing the working provider flows.

1. Build one durable provider-neutral call lifecycle record.

   Current calls are represented across the shared `calls` and `call_states` tables, Vapi event and idempotency records, and Cartesia call and webhook records. Establish one canonical local call identity with verified actor/business ownership, provider call IDs, idempotency references, and a normalized append-only event timeline. Project provider events into that lifecycle while retaining provider-specific metadata behind allowlisted adapters. Backfill historical calls only when their owner and business scope can be established from trusted records; leave ambiguous records unassigned rather than guessing.

   Acceptance criteria:
   * New Twilio, Plivo, Vonage, Vapi, and Cartesia calls appear in one scoped call history.
   * The same local call identity is used by call details, callbacks, status refresh, and post-call workflows.
   * Duplicate and out-of-order provider events do not regress terminal state or create duplicate lifecycle events.
   * Historical records without verified ownership remain unavailable to user-scoped views and are reported as an explicit migration limitation.

2. Integrate safe reconciliation into the Call Activity Center.

   Add a per-call reconciliation action for uncertain submissions, using the provider call ID or the original idempotency/request correlation data when the ID is missing. Connect the existing Vapi and Cartesia reconciliation services to this shared flow, and provide equivalent provider lookup paths for direct carriers where identifiers are available. Add a bounded background reconciler for eligible unresolved records, with backoff, leases, deduplication, and a durable audit trail. A provider search miss must remain unresolved until its safe visibility window has elapsed; it must not trigger a new call.

   Acceptance criteria:
   * Users can reconcile an eligible call from its Activity Center detail view without switching provider commands.
   * Reconciliation only reads provider state and updates local records; it never submits or ends a call.
   * A retry is allowed only after a definitive provider rejection or other authoritative proof that no call was accepted.
   * Missing identifiers, incomplete searches, ambiguous matches, provider timeouts, and eventual-consistency windows remain visibly unresolved with a clear next step.

3. Route every terminal call event through durable post-call automation.

   Send normalized completion events from each provider through one durable, idempotent queue before running summaries, QA, notifications, and approved post-call workflows. Replace fire-and-forget completion triggers with persisted enqueueing, leased workers, bounded retries, dead-letter visibility, and per-step run status. Preserve consent, business scope, and approval rules for every downstream action.

   Acceptance criteria:
   * A completed call from every supported provider can trigger the same configured post-call capabilities.
   * Duplicate callbacks, refreshes, and worker restarts do not duplicate notifications or business actions.
   * Failed, delayed, and completed automation runs are visible to authorized operators with safe error codes and recovery actions.
   * Post-call processing failure never changes the recorded provider call outcome or causes another call to be placed.

4. Simplify call setup into one guided launch flow.

   Keep telephony selection and AI voice selection distinct, while presenting them in one call setup experience. Based on the selected call mode, gather only required inputs such as business, agent, source number, script, and voice profile. Run the existing provider readiness, business authorization, consent, contact policy, and idempotency checks before showing a concise preflight summary and one final confirmation.

   Acceptance criteria:
   * The user sees the selected telephony provider, AI voice mode, destination, business, and required script/agent before dispatch.
   * Missing configuration and unsupported capabilities are shown with a direct setup path before a provider request is made.
   * A single confirmation submits the exact previewed request with one reusable idempotency key.
   * Canceling or changing inputs before confirmation makes no provider call and leaves no ambiguous submission.

5. Add a shared offline lifecycle rehearsal and production readiness gate.

   Expand the current provider acceptance tests into a common offline scenario for each provider covering dispatch, accepted response, timeout/unknown outcome, webhook delivery, status refresh, reconciliation, duplicate events, and post-call automation. Run this matrix alongside existing API, BOT, profile, and provider parity checks in CI. Extend the operator readiness view with recent provider lookup success/failure, webhook delivery lag, unresolved call age, and failed automation counts. Clearly distinguish local configuration checks from live provider connectivity.

   Acceptance criteria:
   * Every provider passes the same lifecycle contract against stubbed provider clients without placing live calls.
   * CI fails on provider contract drift, unsafe retry behavior, missing actor/business scope, or duplicate side effects.
   * Operators can identify stale unresolved calls and failed webhooks/automation from one sanitized dashboard.
   * Production rollout remains gated on the documented checks, with a tested rollback path and no claim of live connectivity unless an actual probe ran.

Recommended implementation sequence: complete item 1 first, then items 2 and 3 on the shared lifecycle. Implement item 4 as the user-facing flow over those stable contracts, and keep item 5 as the release gate for each phase.
