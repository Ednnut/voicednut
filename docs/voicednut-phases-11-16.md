
# VOICEDNUT — ADVANCED PLATFORM INTELLIGENCE & AUTOMATION
## MASTER CODEX IMPLEMENTATION PROMPT — PHASES 11–16

Repository:
https://github.com/Ednnut/voicednut

Project:
VOICEDNUT — Enterprise Voice AI Platform

Role:
Act as a principal software architect, senior backend engineer, senior Node.js engineer, AI systems engineer, automation architect, API security engineer, and production reliability engineer.

Your mission is to continue improving the existing Voicednut repository by implementing the next generation of platform-wide intelligence, orchestration, automation, customer context, conversational Bot capabilities, and enterprise operations.

This implementation continues the earlier Voicednut API and Telegram Bot roadmap.

The foundational implementation priorities are:

- Unified call lifecycle.
- Provider orchestration.
- API security and authorization.
- Telegram Bot reliability.
- Agent and runtime configuration.
- Campaign governance.
- Post-call processing.
- Database reliability.
- Observability.

Do not assume that every previous phase has already been completed. Verify the actual repository state before implementing anything.

==================================================
1. IMPLEMENTATION SCOPE
==================================================

PRIMARY SCOPE:

- api/
- bot/
- Relevant shared backend services.
- Existing database and migration infrastructure.
- Existing tests.
- Existing scripts.
- Existing technical documentation.

STRICTLY EXCLUDED:

- miniapp/
- React components.
- Mini App pages.
- Mini App redesign.
- Mini App frontend logic.
- Mini App routing.
- Mini App styling.
- Mini App-specific enhancements.

The Mini App may be inspected only when necessary to understand existing API contracts or preserve compatibility.

Do not modify Mini App files.

==================================================
2. NON-NEGOTIABLE PROJECT CONSTRAINTS
==================================================

A. PRESERVE EXISTING FUNCTIONALITY

Preserve the existing architecture, repository structure, functionality, and provider integrations.

Existing providers that must remain supported:

- Twilio
- Plivo
- Vonage
- Vapi
- Cartesia
- CALL-E
- Any other existing integrations discovered in the repository.

Do not remove or replace existing providers.

Do not rewrite working services without a demonstrated engineering reason.

B. PRESERVE EXISTING PROJECT STRUCTURE

Do not create unnecessary root-level directories.

Extend existing services, registries, workers, models, and modules wherever appropriate.

Avoid introducing competing implementations of:

- Call lifecycle management.
- Provider orchestration.
- Workflow execution.
- Event processing.
- Agent management.
- Contact management.
- Post-call processing.
- Usage accounting.

C. PROTECT PRODUCTION

Do not:

- Initiate real phone calls.
- Send real SMS.
- Execute live campaigns.
- Contact customers.
- Modify production databases.
- Deploy to production.
- Create billable cloud resources.
- Modify production provider configurations.
- Rotate or replace production credentials.
- Expose secrets.

Use mocks, fixtures, isolated databases, and sandbox configurations.

D. IMPLEMENTATION QUALITY

Every enhancement must be:

- Production-oriented.
- Secure.
- Testable.
- Maintainable.
- Observable.
- Idempotent where appropriate.
- Backward-compatible where feasible.
- Integrated with existing services.
- Documented.

Do not build superficial placeholder features.

Do not claim an integration is complete unless the actual functionality exists and has been tested.

==================================================
3. INITIAL REPOSITORY VERIFICATION
==================================================

Before implementation:

1. Inspect the current branch.
2. Record the current commit SHA.
3. Inspect git status.
4. Identify existing uncommitted changes.
5. Inspect the previous implementation phases.
6. Determine which earlier phases are completed, partial, or missing.
7. Inspect the actual API and Bot architecture.
8. Inspect existing database schemas and migrations.
9. Inspect existing workflow and event processing services.
10. Inspect existing tests and documentation.

Pay particular attention to existing:

- Provider registry.
- Provider capability registry.
- Provider flow policy.
- Canonical call lifecycle, if implemented.
- Call outcome recorder.
- Post-call workflow services.
- CALL-E campaign and mission services.
- Vapi services.
- Cartesia webhook services.
- Telegram Bot commands.
- Bot HTTP client.
- Authentication and authorization.
- Background workers.
- Logging and health checks.

Do not duplicate an existing feature.

If a previous phase is incomplete, implement its missing foundation before building a dependent feature.

Produce a dependency and readiness report.

==================================================
PHASE 11 — UNIFIED PLATFORM ORCHESTRATION
==================================================

PRIORITY: CRITICAL

OBJECTIVE:

Make Voicednut's existing API services, providers, agents, call lifecycle, automation, and post-call processing operate as one coordinated platform.

The goal is to establish a shared execution context and orchestration layer.

Do not build one giant service containing all business logic.

Reuse existing services and dependency injection.

--------------------------------------------------
11.1 SHARED EXECUTION CONTEXT
--------------------------------------------------

Introduce or improve a unified execution context.

Every relevant operation should have a consistent correlation structure.

Support:

- Internal execution ID.
- Request ID.
- Internal call ID.
- Organization ID.
- Business ID where applicable.
- Initiating actor.
- Agent ID.
- Agent version.
- Provider.
- Provider call ID.
- Workflow ID.
- Campaign ID where applicable.
- Execution type.
- Execution status.
- Current execution stage.
- Created and updated timestamps.
- Error classification.
- Idempotency reference.

Use existing database conventions.

Do not introduce unnecessary duplicated identifiers.

Ensure identifiers can be correlated across:

- Telegram Bot.
- API requests.
- Provider dispatch.
- Provider webhooks.
- Background workers.
- Reconciliation.
- Post-call processing.
- Notifications.

--------------------------------------------------
11.2 PLATFORM ORCHESTRATOR
--------------------------------------------------

Inspect the existing API service composition before deciding whether a new orchestrator is necessary.

If an equivalent orchestration service already exists, improve it instead.

The orchestrator should coordinate:

1. Incoming request.
2. Authentication.
3. Authorization.
4. Organization context.
5. User and actor context.
6. Agent resolution.
7. Runtime validation.
8. Provider capability resolution.
9. Provider configuration validation.
10. Consent and destination validation.
11. Execution authorization.
12. Dispatch.
13. Lifecycle tracking.
14. Reconciliation.
15. Post-call processing.
16. Notification.
17. Audit event creation.

Keep provider API communication inside provider-specific services and adapters.

--------------------------------------------------
11.3 EXECUTION STATE MACHINE
--------------------------------------------------

Define a consistent execution state model.

Possible stages:

- created
- validating
- awaiting_approval
- approved
- ready
- dispatching
- accepted
- running
- reconciling
- processing
- completed
- failed
- canceled
- paused
- requires_attention

Use existing lifecycle terminology when possible.

Avoid unnecessary new states.

Define:

- Valid transitions.
- Invalid transitions.
- Terminal states.
- Retryable failures.
- Non-retryable failures.
- Ambiguous execution states.
- Recovery behavior.

An execution must not be marked completed merely because a provider accepted the initial request.

--------------------------------------------------
11.4 EXECUTION STEP TRACKING
--------------------------------------------------

Record meaningful execution steps.

For example:

Execution created
  -> Agent validated
  -> Provider validated
  -> Consent verified
  -> Dispatch authorized
  -> Provider accepted
  -> Call completed
  -> Outcome recorded
  -> Workflow executed
  -> Notification delivered

Record:

- Step name.
- Start time.
- Completion time.
- Result.
- Error classification.
- Retry count.
- Related entity.
- Correlation ID.

Avoid storing unnecessary sensitive payloads.

--------------------------------------------------
11.5 RECOVERY AND RESUMABILITY
--------------------------------------------------

Support safe recovery of interrupted operations.

Determine which steps can be resumed.

Do not repeat irreversible actions automatically.

For ambiguous provider dispatch:

- Reconcile provider state.
- Check known provider identifiers.
- Check idempotency references.
- Recover existing operations when possible.
- Require manual attention when the result cannot be established safely.

Never assume a network timeout means a provider did not accept a call.

--------------------------------------------------
11.6 ACCEPTANCE CRITERIA
--------------------------------------------------

- Relevant API operations share consistent execution context.
- Bot and API operations can be correlated.
- Existing provider-specific services remain intact.
- Execution progress is observable.
- Interrupted recoverable operations can resume safely.
- Irreversible operations cannot be accidentally repeated.
- Tests cover normal and failure execution paths.

==================================================
PHASE 12 — INTELLIGENT PROVIDER AND RUNTIME ENGINE
==================================================

PRIORITY: CRITICAL

OBJECTIVE:

Make provider and runtime selection capability-driven, transparent, and reliable.

Users should be able to specify what they want to accomplish without needing to understand every provider's internal implementation.

--------------------------------------------------
12.1 PROVIDER CAPABILITY NORMALIZATION
--------------------------------------------------

Inspect the current provider registry and capability registry.

Build on existing structures.

For each provider, represent verified capabilities such as:

- Outbound calling.
- Inbound calling.
- Task-oriented calling.
- Real-time audio streaming.
- Voice selection.
- Supported languages.
- STT support.
- TTS support.
- AI model compatibility.
- Call retrieval.
- Call termination.
- Event retrieval.
- Transcript availability.
- Recording availability.
- Webhook support.
- Reconciliation capability.

Only advertise capabilities verified in actual implementation or official provider documentation.

Distinguish:

- Supported.
- Unsupported.
- Configured.
- Enabled.
- Temporarily unavailable.
- Unknown.

A provider being registered does not prove it is configured or healthy.

--------------------------------------------------
12.2 CONFIGURATION COMPATIBILITY ENGINE
--------------------------------------------------

Create or improve a compatibility evaluator.

Evaluate combinations of:

- Agent.
- Agent version.
- Provider.
- Voice.
- Language.
- AI model.
- STT.
- TTS.
- Runtime mode.
- Tools.
- Handoff configuration.
- Organization policies.

Return structured validation results.

Example:

{
  "compatible": false,
  "errors": [
    {
      "code": "VOICE_NOT_SUPPORTED",
      "field": "voice",
      "message": "The selected voice is not supported by this provider."
    }
  ],
  "warnings": []
}

Adapt the response to the repository's existing API response conventions rather than forcing this exact schema.

--------------------------------------------------
12.3 INTELLIGENT PROVIDER RECOMMENDATION
--------------------------------------------------

Introduce a recommendation service that can rank eligible providers using:

- Required capabilities.
- Configured credentials.
- Provider availability.
- Runtime compatibility.
- Organization preferences.
- Verified cost information.
- Reliability history, where meaningful.
- Explicit user preferences.

Return:

- Recommended provider.
- Other compatible alternatives.
- Reasons for recommendations.
- Missing configuration.
- Warnings.
- Unsupported capabilities.

Do not invent cost or performance data.

Do not treat incomplete historical metrics as reliable rankings.

--------------------------------------------------
12.4 SAFE FAILOVER
--------------------------------------------------

Improve existing failover policy.

Requirements:

- Respect explicitly selected providers.
- Never silently switch providers after ambiguous dispatch.
- Reconcile before retrying.
- Prevent duplicate real calls.
- Apply provider-specific retry policies.
- Respect organization configuration.
- Record failover decisions.
- Make failover behavior auditable.

--------------------------------------------------
12.5 PROVIDER HEALTH
--------------------------------------------------

Implement truthful provider health reporting.

Separate:

- Configuration health.
- Credential verification.
- Connectivity.
- Capability availability.
- Recent provider failures.
- Reconciliation backlog.

Do not perform expensive or intrusive health checks on every user request.

Use bounded, controlled checks where appropriate.

--------------------------------------------------
12.6 ACCEPTANCE CRITERIA
--------------------------------------------------

- Provider compatibility is evaluated before dispatch.
- Incompatible configurations are explained clearly.
- Provider recommendations are evidence-based.
- Provider selection respects organization policy.
- Failover cannot create accidental duplicate calls.
- Health reporting distinguishes configuration from operational availability.

==================================================
PHASE 13 — EVENT-DRIVEN WORKFLOW AUTOMATION
==================================================

PRIORITY: CRITICAL

OBJECTIVE:

Connect existing calls, agents, campaigns, contacts, webhooks, and post-call services through reliable reusable workflows.

Do not create a competing workflow engine if existing workflow services can be extended.

--------------------------------------------------
13.1 STANDARD EVENT CONTRACT
--------------------------------------------------

Introduce or normalize an internal event envelope.

It should support:

- Event ID.
- Event type.
- Event version.
- Occurred-at timestamp.
- Received-at timestamp.
- Organization reference.
- Actor reference where applicable.
- Correlation ID.
- Aggregate type.
- Aggregate ID.
- Idempotency key.
- Event source.
- Processing metadata.

Examples:

- call.requested
- call.accepted
- call.ringing
- call.answered
- call.completed
- call.failed
- call.reconciliation_required
- transcript.available
- agent.published
- campaign.approved
- campaign.paused
- workflow.started
- workflow.completed
- workflow.failed
- contact.updated
- followup.required

Use a consistent naming convention.

Do not emit events for operations that did not actually occur.

--------------------------------------------------
13.2 DURABLE EVENT PROCESSING
--------------------------------------------------

Inspect the existing persistence and worker infrastructure.

Implement a durable event-processing mechanism using the current database architecture where practical.

Consider transactional outbox processing for critical operations.

Requirements:

- Persist events before asynchronous processing.
- Prevent duplicate processing.
- Track processing attempts.
- Support bounded retries.
- Track processing ownership.
- Support dead-letter or failed states.
- Support safe replay.
- Recover interrupted processing.
- Preserve event ordering where required.

Do not introduce an external message broker unless the repository's needs and existing architecture justify it.

Do not make database event processing unbounded.

--------------------------------------------------
13.3 WORKFLOW DEFINITION ENGINE
--------------------------------------------------

Build on existing workflow definition services.

A workflow should support:

- Name.
- Description.
- Organization ownership.
- Version.
- Trigger.
- Conditions.
- Actions.
- Execution policy.
- Approval requirements.
- Retry policy.
- Timeout.
- Enabled/disabled state.
- Audit history.

Support controlled triggers such as:

- Call completed.
- Call failed.
- Appointment event received.
- Eligible contact created.
- Follow-up required.
- Campaign state changed.
- Human-approved action.

Do not create arbitrary public event triggers that bypass authorization.

--------------------------------------------------
13.4 CONDITION EVALUATOR
--------------------------------------------------

Support validated conditions such as:

- Call outcome equals completed.
- Customer requested follow-up.
- Agent extraction confidence exceeds a configured threshold.
- Contact is eligible.
- Organization has the required integration.
- Campaign is approved.
- Contact has not already received the same action.

Use an allowlisted condition vocabulary.

Never execute arbitrary JavaScript, eval, or user-supplied executable code.

Validate workflow definitions before publication.

--------------------------------------------------
13.5 ACTION REGISTRY
--------------------------------------------------

Create or improve a controlled action registry.

Possible actions, subject to existing capabilities:

- Record call outcome.
- Create follow-up task.
- Send authorized Telegram notification.
- Update an internal contact record.
- Start an approved workflow.
- Schedule an eligible future action.
- Trigger post-call QA.
- Request human review.
- Execute an explicitly authorized external integration.

Every action must define:

- Required permissions.
- Input schema.
- Output schema.
- Timeout.
- Idempotency behavior.
- Retry policy.
- Failure classification.
- Audit requirements.

External actions must remain protected by authorization and consent controls.

--------------------------------------------------
13.6 WORKFLOW EXECUTION
--------------------------------------------------

Implement:

- Execution history.
- Step-level status.
- Retry limits.
- Backoff.
- Idempotency.
- Cancellation.
- Pause and resume.
- Timeout handling.
- Error reporting.
- Recovery.
- Execution ownership.

A failure in one independent action must not unnecessarily prevent unrelated eligible actions.

Do not retry irreversible actions unless safe idempotency is established.

--------------------------------------------------
13.7 WORKFLOW TEMPLATES
--------------------------------------------------

Provide reusable templates for:

A. APPOINTMENT REMINDERS

1. Receive an appointment event.
2. Validate contact eligibility.
3. Resolve approved agent.
4. Validate provider and runtime.
5. Check dispatch authorization.
6. Execute the approved operation.
7. Record outcome.
8. Notify the appropriate party.
9. Create follow-up when required.

B. MISSED-CALL FOLLOW-UP

1. Receive a verified missed-call event.
2. Resolve customer and organization.
3. Check consent and contact restrictions.
4. Determine whether follow-up is allowed.
5. Select approved follow-up workflow.
6. Execute only authorized actions.
7. Record results.

C. LEAD QUALIFICATION

1. Receive eligible lead.
2. Validate destination.
3. Select qualification agent.
4. Validate runtime.
5. Obtain required approval.
6. Execute authorized call.
7. Extract structured results.
8. Update internal lead information.
9. Create follow-up task when appropriate.

D. CUSTOMER SUPPORT ESCALATION

1. Detect an eligible escalation event.
2. Capture relevant interaction context.
3. Create a support follow-up record.
4. Notify an authorized team member.
5. Track resolution status.

These templates must not be presented as operational integrations unless their underlying services exist.

--------------------------------------------------
13.8 ACCEPTANCE CRITERIA
--------------------------------------------------

- Existing workflow infrastructure is reused.
- Events are durable.
- Duplicate actions are prevented.
- Workflow execution is auditable.
- Failed work can be recovered safely.
- Sensitive actions require authorization.
- Templates are validated and versioned.
- No live external action is executed during automated tests.

==================================================
PHASE 14 — CUSTOMER AND CONVERSATION INTELLIGENCE
==================================================

PRIORITY: HIGH

OBJECTIVE:

Give authorized agents and workflows access to relevant customer interaction history while preserving privacy and data integrity.

--------------------------------------------------
14.1 CUSTOMER IDENTITY AND CONTACT CONTEXT
--------------------------------------------------

Inspect existing contact and customer models first.

Do not create duplicate contact systems.

Improve contact resolution across:

- Organization.
- Phone number.
- Existing customer ID.
- External CRM reference.
- Provider-specific customer reference.
- Historical call records.

Use normalized identifiers and carefully controlled matching.

Phone-number matching alone must not establish identity where ambiguity exists.

Do not merge records automatically when confidence is insufficient.

--------------------------------------------------
14.2 INTERACTION HISTORY
--------------------------------------------------

Where authorized, associate relevant information:

- Previous calls.
- Call outcomes.
- Agent interactions.
- Approved transcripts.
- Recording metadata.
- Follow-up tasks.
- Campaign history.
- Contact preferences.
- Consent records.
- Human-reviewed information.

Support chronological interaction history.

Respect organization boundaries.

--------------------------------------------------
14.3 AGENT CONTEXT RETRIEVAL
--------------------------------------------------

Create a controlled context retrieval service.

Before an eligible interaction, it should be able to retrieve relevant approved context.

Examples:

- Customer's stated preferred language.
- Previously confirmed appointment information.
- Outstanding follow-up.
- Relevant previous interaction summary.
- Approved business-specific information.

Apply:

- Organization scoping.
- Access permissions.
- Data minimization.
- Retention policies.
- Relevance filtering.
- Source provenance.

Do not expose another organization's customer context.

Do not inject all historical records into every prompt.

--------------------------------------------------
14.4 INFORMATION PROVENANCE
--------------------------------------------------

Every extracted customer fact should distinguish:

- User-provided.
- Provider-provided.
- Transcript-extracted.
- AI-inferred.
- Human-verified.
- System-generated.

Store relevant source references and timestamps.

Never silently convert an AI inference into a verified customer fact.

Allow uncertain extracted information to enter a human-review process.

--------------------------------------------------
14.5 DUPLICATE CONTACT PREVENTION
--------------------------------------------------

Improve duplicate detection.

Use:

- Organization scope.
- Normalized phone number.
- External references.
- Existing identifiers.
- Confidence scoring.

When matching is ambiguous, request review rather than merging records.

--------------------------------------------------
14.6 PRIVACY AND RETENTION
--------------------------------------------------

Respect existing retention and consent policies.

Do not unnecessarily duplicate:

- Full transcripts.
- Recording files.
- Sensitive personal information.
- Authentication information.

Implement access and deletion behavior consistent with the existing platform's data policies.

--------------------------------------------------
14.7 ACCEPTANCE CRITERIA
--------------------------------------------------

- Relevant customer history is available to authorized workflows.
- Contacts are organization-scoped.
- Duplicate matching is conservative.
- Extracted information has provenance.
- Unverified inferences are not treated as facts.
- Retention and consent policies are enforced.

==================================================
PHASE 15 — STRUCTURED AI INTELLIGENCE AND TELEGRAM BOT EXPERIENCE
==================================================

PRIORITY: HIGH

This phase has two connected workstreams.

A. Structured conversation intelligence.
B. Intelligent Telegram Bot experience.

--------------------------------------------------
15A. STRUCTURED CONVERSATION INTELLIGENCE
--------------------------------------------------

OBJECTIVE:

Transform call transcripts and outcomes into reliable structured business information.

Do not rebuild the existing voice runtime.

Build on existing transcript, call outcome, post-call QA, and agent services.

#### 15A.1 Extraction framework

Support configurable extraction schemas.

Possible fields:

- Customer intent.
- Call purpose.
- Questions answered.
- Customer objections.
- Appointment interest.
- Appointment preference.
- Purchase interest.
- Required follow-up.
- Escalation requirement.
- Call outcome.
- Customer sentiment, if supported.
- Confidence.
- Supporting transcript evidence.

Do not require every schema to contain every field.

#### 15A.2 Agent-specific extraction

Allow authorized agent definitions or workflow definitions to specify structured output requirements.

Examples:

Appointment agent:
- Appointment requested.
- Preferred date.
- Preferred time.
- Confirmation status.
- Follow-up needed.

Lead qualification agent:
- Product interest.
- Budget range, if volunteered and appropriate.
- Qualification answers.
- Lead readiness.
- Follow-up status.

Support agent:
- Issue category.
- Resolution status.
- Escalation reason.
- Required action.

#### 15A.3 Output validation

Validate AI-generated structured output against the expected schema.

Handle:

- Missing fields.
- Invalid data types.
- Invalid enum values.
- Malformed JSON.
- Unsupported claims.
- Low confidence.
- Missing evidence.

Do not trust model output without validation.

#### 15A.4 Evidence and confidence

Where possible, reference transcript segments or timestamps supporting extracted information.

Store:

- Extraction version.
- Schema version.
- Model identifier where available.
- Confidence.
- Evidence references.
- Processing timestamp.

Do not invent confidence values when the model does not supply a meaningful basis.

#### 15A.5 Human review

Implement a review state for uncertain or consequential results.

Support:

- Pending review.
- Approved.
- Corrected.
- Rejected.
- Reviewed by.
- Review timestamp.

Do not let uncertain extraction automatically trigger high-impact external actions.

#### 15A.6 Quality assurance

Build on existing QA services.

Support configurable criteria:

- Script adherence.
- Required questions.
- Required disclosures.
- Outcome consistency.
- Handoff correctness.
- Escalation requirements.
- Data extraction quality.

Preserve existing shadow-mode and rollout safeguards.

#### 15A.7 Acceptance criteria

- Structured extraction is schema-validated.
- Results include provenance.
- Uncertain information can be reviewed.
- Existing post-call pipeline remains functional.
- Automated actions respect confidence and approval thresholds.

--------------------------------------------------
15B. INTELLIGENT TELEGRAM BOT
--------------------------------------------------

OBJECTIVE:

Make the Telegram Bot an intuitive operating assistant rather than merely a command collection.

Preserve existing commands and workflows.

#### 15B.1 Command discovery

Improve help and command discovery.

Provide:

- Available commands.
- Short explanations.
- Required permissions.
- Example usage.
- Contextual suggestions.
- Guidance for incomplete operations.

Do not advertise unavailable functionality.

#### 15B.2 Guided task workflows

Improve guided interactions for:

- Creating an agent.
- Configuring an agent.
- Validating a runtime.
- Preparing an outbound call.
- Checking provider status.
- Reviewing call history.
- Creating an approved workflow.
- Inspecting campaign status.
- Reviewing failed executions.

Reuse existing API services.

Do not duplicate backend business logic in Bot command handlers.

#### 15B.3 Context-aware sessions

Improve conversation session management.

Support:

- Task identification.
- Session ownership.
- Conversation state.
- Expiration.
- Safe continuation.
- Cancellation.
- Restart recovery.
- Concurrent interactions.

Do not rely on a user's Telegram display name as an identity mechanism.

Do not allow stale sessions to trigger old actions.

#### 15B.4 Smart defaults

Where authorized and useful, suggest:

- Previously selected agents.
- Approved provider preferences.
- Existing runtime configurations.
- Commonly used workflows.
- Preferred language.

Suggestions must not override explicit user choices or bypass validation.

#### 15B.5 Action summaries

Before sensitive actions, present a clear summary:

- What will happen.
- Which organization is involved.
- Which agent is selected.
- Which provider is selected.
- Which destination is involved.
- Relevant restrictions.
- Whether an action is reversible.
- Whether an external action will occur.

Require explicit confirmation for real outbound calls and other sensitive external operations.

#### 15B.6 Execution progress

Provide useful progress messages.

Examples:

- Validating configuration.
- Checking provider availability.
- Waiting for approval.
- Submitting request.
- Provider accepted request.
- Reconciling provider state.
- Processing call outcome.
- Workflow completed.
- Action requires attention.

Do not report completion prematurely.

#### 15B.7 Error recovery

Map internal API errors into clear user-facing messages.

Examples:

- Provider configuration is incomplete.
- This agent is incompatible with the selected runtime.
- You do not have permission for this operation.
- The destination is not eligible.
- The request is being reconciled.
- The operation needs administrator review.

Never expose internal stack traces, tokens, provider secrets, or sensitive response payloads.

#### 15B.8 Notifications

Improve event-driven Bot notifications.

Support authorized notifications for:

- Call completed.
- Call failed.
- Workflow completed.
- Workflow failed.
- Campaign paused.
- Campaign requires approval.
- Provider configuration problem.
- Reconciliation requires attention.
- Human review required.

Prevent duplicate notifications.

Allow sensible notification preferences where existing user settings support them.

#### 15B.9 Natural-language assistance

If the repository already includes an AI/chat capability, extend it carefully.

Otherwise, inspect existing model integrations before proposing a new dependency.

Natural-language assistance may help users:

- Discover commands.
- Understand platform functionality.
- Prepare configurations.
- Explain errors.
- Retrieve authorized information.
- Navigate workflows.

Do not allow a language model to bypass API authorization.

Do not let model-generated instructions directly execute arbitrary commands or privileged operations.

All sensitive operations must pass through validated API services and explicit authorization.

#### 15B.10 Acceptance criteria

- Existing Bot commands remain functional.
- Task flows are understandable.
- Sessions can safely resume.
- Sensitive actions require explicit confirmation.
- Notifications are idempotent.
- Natural-language assistance cannot bypass security.
- API remains the source of truth.

==================================================
PHASE 16 — ENTERPRISE CONFIGURATION, USAGE INTELLIGENCE, AND DEVELOPER EXPERIENCE
==================================================

PRIORITY: HIGH

OBJECTIVE:

Make Voicednut easier to configure, monitor, integrate, and operate as an enterprise platform.

--------------------------------------------------
16.1 CENTRALIZED CONFIGURATION MANAGEMENT
--------------------------------------------------

Inspect current environment and provider configuration mechanisms.

Improve configuration management without introducing a competing configuration store.

Support:

- Provider configuration.
- Organization-level settings.
- Runtime configuration.
- Agent defaults.
- Workflow defaults.
- Notification preferences.
- Operational policies.
- Feature flags where appropriate.

Validate configuration before use.

Separate:

- Secret values.
- Non-sensitive configuration.
- Organization settings.
- Environment settings.

Use secure secret references or existing secret management facilities.

Never return plaintext secrets from configuration APIs.

--------------------------------------------------
16.2 CONFIGURATION VERSIONING
--------------------------------------------------

Where configuration changes can affect active executions, preserve version references.

Support:

- Configuration version.
- Change history.
- Validation.
- Approval where necessary.
- Rollback.
- Actor attribution.

Do not silently change an active campaign's pinned agent or runtime configuration.

--------------------------------------------------
16.3 USAGE ACCOUNTING
--------------------------------------------------

Inspect existing usage, billing, and provider cost models.

Extend existing systems rather than creating duplicate accounting.

Track available data for:

- Calls.
- Call duration.
- Provider usage.
- AI model usage.
- TTS usage.
- STT usage.
- Token usage.
- Transcription.
- Recording.
- Campaign execution.
- Workflow execution.

Each usage record should include appropriate correlation and organization references.

Distinguish:

- Provider-reported actual cost.
- Estimated cost.
- Internal cost.
- Unknown cost.

Do not invent prices.

Do not assume provider-reported duration equals billable duration.

--------------------------------------------------
16.4 USAGE LIMITS AND ALERTS
--------------------------------------------------

Where the existing billing architecture supports it, introduce:

- Organization usage limits.
- Configurable warning thresholds.
- Usage alerts.
- Campaign usage limits.
- Safe dispatch restrictions.
- Administrative override with audit trail.

Do not silently block unrelated operations because one provider's billing data is delayed.

Use explicit unknown or pending usage states.

--------------------------------------------------
16.5 ANOMALY DETECTION
--------------------------------------------------

Introduce rule-based anomaly detection before introducing complex ML.

Identify patterns such as:

- Sudden increases in call volume.
- Repeated provider failures.
- Unusual dispatch retries.
- Abnormal campaign consumption.
- Repeated webhook failures.
- Repeated authorization failures.
- Unusual workflow execution patterns.

Generate actionable alerts.

Do not automatically suspend legitimate customer activity based solely on a weak anomaly signal.

High-impact responses should require configured policies or human approval.

--------------------------------------------------
16.6 API CONTRACT STANDARDIZATION
--------------------------------------------------

Review existing API routes and response conventions.

Improve consistency for:

- Success responses.
- Error responses.
- Error codes.
- Pagination.
- Filtering.
- Sorting.
- Idempotency.
- Authentication.
- Authorization.
- Request correlation.
- Validation errors.

Preserve existing API compatibility where feasible.

If a breaking API change is unavoidable:

1. Document the reason.
2. Identify affected consumers.
3. Introduce a compatibility layer or versioning strategy.
4. Add tests.
5. Document migration steps.

--------------------------------------------------
16.7 OPENAPI AND DEVELOPER DOCUMENTATION
--------------------------------------------------

Improve API documentation based on actual implemented contracts.

Document:

- Authentication.
- Authorization.
- Agents.
- Calls.
- Providers.
- Call lifecycle.
- Contacts.
- Workflows.
- Campaigns.
- Events.
- Webhooks.
- Usage.
- Errors.
- Idempotency.
- Pagination.

Do not document endpoints that do not exist.

Use the actual repository route and validation definitions as the source of truth.

If OpenAPI tooling already exists, extend it.

Do not introduce redundant documentation systems.

--------------------------------------------------
16.8 WEBHOOK MANAGEMENT
--------------------------------------------------

Improve outgoing webhook support where existing architecture permits.

Support:

- Authorized webhook subscriptions.
- Event filters.
- Endpoint validation.
- Delivery history.
- Signature verification.
- Retry policy.
- Delivery timeout.
- Idempotency.
- Replay controls.
- Endpoint disablement after configured failure thresholds.

Protect against SSRF and unsafe destinations.

Validate destination URLs and resolved network addresses using a safe policy.

Do not allow webhook replay to trigger uncontrolled duplicate external actions.

--------------------------------------------------
16.9 SDK-READY API
--------------------------------------------------

Design stable API contracts that can later support official SDKs.

Do not create an SDK merely for appearance.

First establish:

- Consistent schemas.
- Stable identifiers.
- Versioned contracts.
- Idempotency.
- Authentication scopes.
- Reliable error codes.
- Documented pagination.
- Webhook event contracts.

Prepare a developer integration guide with realistic examples.

--------------------------------------------------
16.10 ACCEPTANCE CRITERIA
--------------------------------------------------

- Configuration is validated and auditable.
- Secrets remain protected.
- Usage data has clear provenance.
- Cost estimates are not confused with actual charges.
- API responses are consistent.
- Webhook delivery is observable and retryable.
- Documentation reflects actual implementation.
- API contracts are suitable for future SDKs.

==================================================
4. CROSS-PHASE INTEGRATION REQUIREMENTS
==================================================

The six phases must work together.

Do not implement them as six disconnected projects.

Ensure these integration paths work.

A. CALL EXECUTION

Telegram Bot
  -> API
  -> Execution Context
  -> Agent Validation
  -> Runtime Compatibility
  -> Consent and Authorization
  -> Provider Selection
  -> Provider Dispatch
  -> Canonical Call Lifecycle
  -> Reconciliation
  -> Completion Processing

B. POST-CALL AUTOMATION

Provider Event
  -> Webhook Verification
  -> Canonical Lifecycle
  -> Durable Event
  -> Transcript Processing
  -> Structured Extraction
  -> Human Review if Required
  -> Workflow Evaluation
  -> Authorized Actions
  -> Telegram Notification

C. CUSTOMER INTELLIGENCE

Contact
  -> Organization Scope
  -> Interaction History
  -> Approved Context Retrieval
  -> Agent Runtime
  -> New Interaction
  -> Structured Outcome
  -> Updated Interaction History

D. CAMPAIGN EXECUTION

Campaign
  -> Validation
  -> Consent Check
  -> Approval
  -> Explicit Dispatch Authorization
  -> Mission Worker
  -> Provider Execution
  -> Lifecycle Tracking
  -> Reconciliation
  -> Post-Call Processing
  -> Campaign Results

E. DEVELOPER INTEGRATION

External Application
  -> Authenticated API
  -> Validated Request
  -> Idempotent Execution
  -> Provider/Workflow
  -> Canonical Event
  -> Authorized Webhook Delivery
  -> Delivery History

==================================================
5. SECURITY AND GOVERNANCE REQUIREMENTS
==================================================

All phases must respect the following.

1. Organization isolation.
2. Actor-level authorization.
3. Server-side permission enforcement.
4. Consent and destination policies.
5. Provider-specific webhook authentication.
6. CALL-E unsigned webhook limitations.
7. Replay prevention.
8. Idempotency.
9. Secret protection.
10. Data retention.
11. Audit history.
12. Rate limits.
13. Input validation.
14. Safe workflow execution.
15. Human approval for consequential actions.

Never let the AI layer bypass any of these controls.

Never execute arbitrary code from workflow definitions or user prompts.

Never allow an untrusted transcript to become executable instructions.

Treat customer-provided content and retrieved data as untrusted input.

==================================================
6. DATABASE AND MIGRATION REQUIREMENTS
==================================================

Before changing database models:

- Inspect existing schemas.
- Inspect migration mechanisms.
- Inspect database access conventions.
- Inspect transaction support.
- Inspect indexes.
- Inspect test database setup.

Reuse existing tables where practical.

Avoid duplicate models for:

- Contacts.
- Calls.
- Call events.
- Workflows.
- Workflow executions.
- Provider configurations.
- Usage.
- Audit events.

Any required migration must:

- Be additive where possible.
- Preserve existing data.
- Have a recovery strategy.
- Be tested on isolated databases.
- Be compatible with the existing application.
- Be documented.

Do not assume the database should be migrated from SQLite to MySQL.

Do not modify production databases.

==================================================
7. TESTING STRATEGY
==================================================

Every phase must include automated tests.

Prioritize:

A. ORCHESTRATION

- Execution context creation.
- Correlation propagation.
- Invalid transitions.
- Interrupted execution.
- Safe recovery.
- Duplicate execution prevention.

B. PROVIDER INTELLIGENCE

- Capability compatibility.
- Missing credentials.
- Unsupported voice.
- Runtime mismatch.
- Provider unavailable.
- Ambiguous dispatch.
- Reconciliation.
- Failover safety.

C. WORKFLOW ENGINE

- Event persistence.
- Duplicate events.
- Event replay.
- Condition validation.
- Invalid action.
- Action authorization.
- Worker interruption.
- Retry limits.
- Workflow cancellation.
- Dead-letter processing.

D. CUSTOMER INTELLIGENCE

- Organization isolation.
- Contact matching.
- Ambiguous matching.
- Duplicate prevention.
- Provenance.
- Access control.
- Retention behavior.

E. AI EXTRACTION

- Valid output.
- Invalid JSON.
- Missing fields.
- Unsupported claims.
- Low confidence.
- Evidence references.
- Human review.
- Duplicate extraction.

F. TELEGRAM BOT

- Guided task workflows.
- Session ownership.
- Expired sessions.
- Concurrent callbacks.
- Restart recovery.
- Confirmation.
- Cancellation.
- Duplicate submission.
- API failures.
- Notifications.
- Unauthorized actions.

G. ENTERPRISE OPERATIONS

- Configuration validation.
- Secret redaction.
- Usage aggregation.
- Duplicate usage events.
- Cost classification.
- API response contracts.
- Webhook retry.
- SSRF protection.
- Rate limits.

Use temporary databases and mocked external providers.

Automated tests must never create real calls, send SMS, or execute live campaign actions.

==================================================
8. PERFORMANCE AND RELIABILITY
==================================================

Throughout all phases:

- Keep API handlers efficient.
- Use bounded database queries.
- Add indexes only when justified.
- Avoid unbounded worker loops.
- Use bounded retries.
- Use exponential backoff where appropriate.
- Avoid repeated provider polling.
- Prevent duplicate background jobs.
- Support graceful shutdown.
- Handle concurrent operations safely.
- Avoid loading entire transcripts into memory unnecessarily.
- Keep logs structured and sanitized.

Do not introduce expensive external infrastructure without an explicit architecture justification and approval.

==================================================
9. IMPLEMENTATION ORDER AND DEPENDENCIES
==================================================

Implement in this order:

PHASE 11:
Unified platform orchestration.

PHASE 12:
Provider and runtime intelligence.

PHASE 13:
Event-driven workflow automation.

PHASE 14:
Customer and conversation intelligence.

PHASE 15:
Structured AI intelligence and Telegram Bot experience.

PHASE 16:
Enterprise configuration, usage intelligence, and developer experience.

Dependencies:

- Phase 12 depends on existing provider capability and lifecycle foundations.
- Phase 13 depends on reliable execution context and persistence.
- Phase 14 depends on existing contact, organization, and call data models.
- Phase 15 depends on transcript, agent, workflow, and Bot infrastructure.
- Phase 16 depends on actual configuration, usage, and API architecture.

If a dependency is incomplete, implement the missing foundation first.

Do not force a phase to be marked complete when its prerequisites are absent.

==================================================
10. REQUIRED ENGINEERING EXECUTION PROCESS
==================================================

For every phase:

1. Inspect the actual source.
2. Identify existing implementations.
3. Identify missing capabilities.
4. Document architectural decisions.
5. Identify affected files.
6. Identify database changes.
7. Implement incrementally.
8. Add tests.
9. Run relevant tests.
10. Run relevant lint/build/type checks.
11. Inspect the diff.
12. Verify backward compatibility.
13. Update documentation.
14. Report completion status.

Do not stop after creating a plan.

Proceed with implementation using the repository's actual conventions.

Do not unnecessarily ask for approval for routine, reversible code changes within this explicitly authorized scope.

However, stop before any action involving:

- Production data.
- Live calls.
- Real SMS.
- External customer communication.
- Production credentials.
- Production deployments.
- Billable infrastructure.
- Destructive schema changes.
- Irreversible external actions.

==================================================
11. GIT AND CHANGE MANAGEMENT
==================================================

Before changes:

- Inspect git status.
- Record branch and commit.
- Protect existing user modifications.
- Do not reset or clean the repository.
- Do not force-push.
- Do not commit unless requested.

At completion:

- Show changed files.
- Show diff summary.
- Identify new dependencies.
- Identify schema changes.
- Identify environment changes.
- Identify API contract changes.
- Identify tests.
- Identify failures.
- Identify incomplete work.

Do not modify Mini App files.

==================================================
12. FINAL DELIVERABLES
==================================================

Produce a comprehensive implementation report.

A. EXECUTIVE SUMMARY

Explain the improvements and their practical value.

B. ARCHITECTURE REPORT

Document the resulting architecture, service relationships, execution context, event flow, and orchestration.

C. PHASE COMPLETION MATRIX

For Phases 11–16, mark:

- Completed.
- Partially completed.
- Blocked.
- Not started.

D. PROVIDER INTELLIGENCE REPORT

Document provider capabilities, compatibility evaluation, health checks, selection, and failover behavior.

E. AUTOMATION REPORT

Document event processing, workflow definitions, action registry, retries, execution history, and recovery.

F. CUSTOMER INTELLIGENCE REPORT

Document contact resolution, interaction history, provenance, context retrieval, and privacy controls.

G. AI INTELLIGENCE REPORT

Document extraction schemas, evidence, confidence, review, and QA integration.

H. TELEGRAM BOT REPORT

Document new commands, guided workflows, session behavior, notifications, and security.

I. ENTERPRISE OPERATIONS REPORT

Document configuration management, usage accounting, webhook delivery, API contracts, and developer documentation.

J. DATABASE REPORT

Document all migrations, indexes, data compatibility, and recovery procedures.

K. TEST REPORT

Provide exact commands and actual results.

Separate existing failures from newly introduced failures.

L. SECURITY REPORT

Document verified security controls and unresolved risks.

M. DEPLOYMENT READINESS

Prepare a staging and production checklist.

Do not deploy.

N. NEXT RECOMMENDATIONS

Identify the remaining highest-value work based on evidence from the implementation.

==================================================
13. FINAL DIRECTIVE
==================================================

Begin by inspecting the real repository and determining which earlier implementation phases have actually been completed.

Then implement Phases 11–16 in order.

The goal is to make Voicednut:

- Unified.
- Intelligent.
- Context-aware.
- Workflow-driven.
- Provider-independent at the platform orchestration layer.
- Secure.
- Recoverable.
- Observable.
- Efficient.
- Enterprise-ready.

The API and Telegram Bot must be the first-class implementation targets.

The Mini App must remain untouched.

Preserve every existing provider and integration.

Do not create a collection of disconnected new features.

Build one cohesive platform in which existing capabilities work together through consistent services, contracts, events, execution context, and automation.

Deliver real implementation, meaningful tests, and evidence-backed documentation.

Never claim production readiness merely because the code builds.
