# VOICEDNUT — Complete Cartesia Phone Calling & Multi-Provider Integration

You are the Principal Software Architect, Senior TypeScript/Full-Stack Engineer, Voice AI Infrastructure Engineer, Telephony Integration Engineer, Security Engineer, and QA Engineer responsible for implementing a complete, production-grade Cartesia integration into the existing VOICEDNUT platform.

Your objective is to integrate Cartesia's actual inbound and outbound phone-calling APIs, Managed Agents, Line runtime, Sonic TTS, Ink STT, voice management, SIP connectivity, and related capabilities into VOICEDNUT.

This must be a native, first-class integration within the existing architecture.

## 1. Non-negotiable project preservation requirements

The existing VOICEDNUT project must remain fully functional.

Preserve all existing:
- Project structure and architectural conventions.
- Frontend and backend frameworks.
- Database architecture and existing migrations.
- API routes, services, controllers, and authentication.
- Existing UI components, layouts, and design system.
- Twilio integration.
- Plivo integration.
- Vonage integration.
- CALL-E integration.
- Existing telephony, voice-agent, and automation functionality.

Do not replace existing integrations with Cartesia.

Do not introduce a parallel application, unnecessary framework, duplicate service architecture, or unrelated root-level folders.

Reuse existing abstractions and extend them only where necessary.

Do not:
- Delete or rewrite functioning modules unnecessarily.
- Perform destructive database migrations.
- Change production environment variables.
- Expose provider API keys in frontend code.
- Initiate real inbound/outbound calls during development or tests.
- Purchase phone numbers or create paid resources.
- Modify production telephony routing.
- Deploy or publish anything without explicit approval.

## 2. Phase 0 — Repository and official documentation audit

Start by inspecting the actual VOICEDNUT repository.

Identify:
- Current telephony provider architecture.
- Existing provider adapter interfaces.
- Existing CALL-E implementation.
- Existing agent configuration and runtime.
- Current TTS and STT services.
- Phone number management.
- Inbound call handling.
- Outbound call execution.
- Webhook architecture.
- WebSocket and media-streaming capabilities.
- Database models and migrations.
- Authentication, authorization, and secret management.
- Existing UI pages and navigation.
- Existing tests and development workflows.

Review the official Cartesia resources:

https://docs.cartesia.ai/
https://docs.cartesia.ai/build-with-cartesia/
https://docs.cartesia.ai/line/
https://docs.cartesia.ai/api-reference/
https://www.cartesia.ai/product/ai-phone-agent
https://github.com/cartesia-ai/line

Verify the current official Managed Agents, Phone Numbers, Calls, SIP Providers, Line SDK, Sonic, Ink, and webhook documentation.

Use the actual current API version, endpoint paths, request schemas, authentication requirements, supported events, response formats, and SDK versions.

Do not copy outdated examples or invent unsupported API operations.

Produce an audit identifying:
1. Existing functionality that can be reused.
2. Missing functionality.
3. Exact files and modules requiring changes.
4. Compatibility and migration risks.
5. Provider-specific capability differences.
6. Required dependencies.
7. A safe implementation sequence.

Do not edit any files during this phase. Present the findings and request approval.

## 3. Phase 1 — First-class Cartesia provider architecture

Add Cartesia as a new provider within the existing VOICEDNUT provider architecture.

Support two distinct operating modes:

A. CARTESIA MANAGED PHONE AGENT

Use Cartesia Managed Agents for its supported native phone-call capabilities, including inbound calls, outbound calls, number management, agent assignment, and supported call management.

B. CARTESIA SPEECH AND AGENT INFRASTRUCTURE

Use Cartesia Sonic, Ink, and Line where appropriate with existing telephony providers through documented APIs and supported audio-streaming integrations.

Keep these operating modes separate in the architecture.

Create a provider capability registry that identifies which capabilities are actually supported by each provider.

Do not assume that a speech provider automatically supports PSTN calling or that a telephony provider automatically supports Cartesia's native agent runtime.

## 4. Phase 2 — Cartesia inbound phone calls

Implement Cartesia inbound calling.

Requirements:

- Connect supported Cartesia phone numbers to VOICEDNUT agents.
- Support Cartesia-provisioned numbers where available.
- Support importing eligible existing Twilio numbers.
- Support connecting existing carriers through SIP.
- Associate phone numbers with authorized agents.
- Configure inbound agent assignments.
- Retrieve supported inbound call details and statuses.
- Handle incoming call events and callbacks where officially supported.
- Support caller identification where supplied by the provider.
- Support inbound conversation context.
- Support agent greetings and instructions.
- Support supported language and voice configurations.
- Support DTMF and IVR interactions where available.
- Support interruption handling where available.
- Support call transfers where supported.
- Support human escalation.
- Capture transcripts, summaries, and structured outcomes when available.
- Record provider call identifiers and correlate them with VOICEDNUT records.

Create an inbound routing mechanism that allows administrators to choose which provider and agent receive incoming calls.

Never overwrite an existing number's routing configuration without explicit approval.

## 5. Phase 3 — Cartesia outbound phone calls

Implement Cartesia's official outbound Calls API and supported execution workflows.

Requirements:

- Place outbound calls using eligible Cartesia phone numbers or supported imported/SIP numbers.
- Configure caller ID using verified provider-supported identifiers.
- Select an assigned Cartesia agent.
- Pass recipient details and validated metadata.
- Support agent-specific instructions and business context.
- Support supported voice and language configurations.
- Retrieve execution identifiers and call status.
- Process call completion and terminal outcomes.
- Retrieve supported transcripts and structured results.
- Support cancellation where officially documented.
- Support configurable call timeouts and concurrency limits.
- Support idempotency and duplicate-execution prevention.
- Provide call history and detailed execution records.

Implement a safe outbound call workflow:

1. Validate the recipient and phone number.
2. Validate the selected agent and provider configuration.
3. Verify contact eligibility, consent, suppression and calling-time rules.
4. Validate provider capabilities and account limits.
5. Generate an execution preview.
6. Require explicit authorization for a real call.
7. Submit the request through the server-side Cartesia adapter.
8. Persist the provider call ID and execution metadata.
9. Process status updates and supported webhooks.
10. Store the final result and audit record.

No automated test should initiate a real phone call.

## 6. Phase 4 — Cartesia batch calling

Investigate and implement Cartesia's documented batch outbound-calling functionality.

Support:
- Batch creation.
- Recipient validation.
- Agent assignment.
- Per-recipient execution tracking.
- Batch status.
- Completion and failure reporting.
- Concurrency and pacing controls.
- Partial failure handling.
- Cancellation where supported.
- Duplicate recipient detection.
- Idempotency.
- Safe retry policies.
- Batch result exports.

Cartesia's product documentation advertises batches of up to 5,000 recipients. Verify actual API limits, account entitlements, and current endpoint contracts before implementation.

Build VOICEDNUT's own durable campaign orchestration around the provider's actual supported limits.

Never assume that batch submission means every call has successfully completed.

Default all new batch workflows to dry-run mode. Require explicit approval before real execution.

## 7. Phase 5 — Cartesia phone number management

Integrate official phone-number management capabilities.

Support, where documented and available:

- Provisioning eligible Cartesia phone numbers.
- Importing existing Twilio numbers.
- Connecting SIP carrier numbers.
- Listing phone numbers.
- Retrieving phone-number details.
- Assigning numbers to agents.
- Updating agent assignments.
- Managing inbound and outbound configurations.
- Identifying provider ownership.
- Displaying number status.
- Validating number eligibility.
- Tracking country, region, and capabilities.
- Disconnecting or releasing numbers only through an explicitly approved workflow.

Do not purchase, release, transfer, or modify production phone numbers without explicit approval.

Clearly distinguish:
- Cartesia-owned numbers.
- Twilio-imported numbers.
- External SIP carrier numbers.
- Existing VOICEDNUT provider numbers.

Never assume that an imported number has transferred ownership to Cartesia.

## 8. Phase 6 — SIP trunk integration

Implement Cartesia SIP connectivity using its official documentation.

Support:
- SIP trunk creation and configuration.
- Inbound SIP authentication.
- Outbound SIP configuration.
- SIP transport configuration.
- TLS where supported.
- SRTP/media encryption options.
- Carrier connection settings.
- Number import and association.
- SIP URI configuration.
- Carrier health and configuration validation.
- Secure credential storage.
- SIP connection troubleshooting.
- Transfer and handoff configuration where supported.

Implement strict access controls.

Never expose SIP credentials in browser code, logs, client responses, or Git-tracked configuration.

Never create an unauthenticated public inbound SIP endpoint.

Preserve existing Twilio, Plivo, and Vonage trunk configurations.

Do not modify live carrier routing without explicit approval.

## 9. Phase 7 — Cartesia Sonic TTS integration

Integrate Cartesia Sonic into the existing speech provider architecture.

Implement supported features:

- Text-to-speech generation.
- Streaming TTS.
- HTTP TTS.
- WebSocket TTS.
- Voice selection.
- Voice catalogue.
- Voice search.
- Voice configuration.
- Supported emotion controls.
- Speech speed controls.
- Audio output configuration.
- Supported audio formats.
- Context management.
- Context flushing.
- Chunk tracking and synchronization.
- Supported word timestamps.
- Custom voice workflows.
- Voice cloning, subject to provider permissions and eligibility.
- Pronunciation dictionaries.
- Text replacements.
- Voice localization where available.

Add a reusable speech configuration profile.

Ensure Sonic can be selected for Cartesia-compatible workflows and, where technically supported, existing telephony-provider workflows.

## 10. Phase 8 — Cartesia Ink STT integration

Integrate Cartesia Ink into VOICEDNUT's existing STT architecture.

Support documented capabilities:

- Audio transcription.
- Streaming transcription.
- WebSocket transcription.
- Batch transcription.
- Incremental transcript updates.
- Final transcription results.
- Supported language configuration.
- Word timestamps.
- Speaker information where available.
- Supported domain vocabulary.
- Telephony audio configurations.
- Audio chunk handling.
- Speech recognition error handling.

Allow authorized administrators to configure Cartesia Ink independently from other STT providers.

Do not force existing providers to use Cartesia STT.

## 11. Phase 9 — Cartesia Line agent runtime

Evaluate and integrate the official Cartesia Line SDK as an optional voice-agent runtime.

Support the current SDK architecture and verified capabilities, including:

- LLM agent configuration.
- Custom agent implementations.
- Real-time conversation handling.
- Interruption and barge-in support.
- Turn-taking.
- Tool calling.
- Custom HTTP tools.
- DTMF.
- End-call functionality.
- Supported phone transfers.
- Voicemail handling.
- Knowledge-base tools.
- Web search tools.
- Multi-agent handoffs.
- Session management.
- Event handling.
- Agent deployment.
- Observability.

Provide an explicit runtime selection:

- VOICEDNUT native runtime.
- Cartesia Managed Agents.
- Cartesia Line.
- Other existing compatible runtimes.

Do not run two agent runtimes simultaneously on the same call unless a documented architecture explicitly requires it.

Do not allow Cartesia runtime integration to break existing CALL-E-managed conversations.

## 12. Phase 10 — Telephony and speech interoperability

Create a clear separation between:

1. Telephony provider.
2. Speech provider.
3. LLM provider.
4. Agent runtime.
5. Orchestration engine.

Support combinations only where their actual APIs and media interfaces are compatible.

Examples to evaluate:

- Cartesia Managed Agents + Cartesia phone number.
- Cartesia Managed Agents + imported Twilio number.
- Cartesia Managed Agents + SIP carrier.
- Twilio + Cartesia Sonic and Ink.
- Plivo + Cartesia Sonic and Ink.
- Vonage + Cartesia Sonic and Ink.
- Supported telephony provider + Cartesia Line.
- CALL-E-managed calling + independent VOICEDNUT speech processing where the documented integration permits it.

For each combination, document:
- Media transport.
- Audio encoding.
- Sample rate.
- Channel configuration.
- Authentication.
- Connection lifecycle.
- Audio buffering.
- Interruption behavior.
- Latency characteristics.
- Event handling.
- Error recovery.
- Provider restrictions.

Implement a dedicated media bridge only where required.

Never assume that an arbitrary provider's media stream can be connected directly to Cartesia without checking codec, protocol, event, and audio transport compatibility.

Prevent duplicate audio, feedback loops, audio truncation, broken turn-taking, and disconnected sessions.

## 13. Phase 11 — Unified VOICEDNUT phone operations dashboard

Integrate Cartesia into the existing user interface.

Create or extend the relevant pages:

- Cartesia provider settings.
- Cartesia account connection.
- Cartesia API configuration.
- Phone number management.
- Inbound call management.
- Outbound call management.
- Batch calling.
- SIP trunk management.
- Agent assignments.
- Voice library.
- TTS configuration.
- STT configuration.
- Line runtime settings.
- Call history.
- Call details.
- Transcripts and summaries.
- Provider health.
- Usage and cost analytics.

Use the existing design system.

Provide clear configuration status, validation errors, loading states, empty states, success states, and permission-denied states.

Make the interface responsive and accessible.

Do not expose secrets in the frontend.

## 14. Phase 12 — Unified multi-provider routing

Extend the existing provider-routing system to include Cartesia without replacing existing providers.

Support:
- Provider selection.
- Inbound routing.
- Outbound routing.
- Speech-provider selection.
- Agent-runtime selection.
- Capability-based routing.
- Health checks.
- Concurrency awareness.
- Region restrictions.
- Cost information where verified.
- Failover policies.
- Provider-specific configuration.
- Routing decision logs.

A routing decision must consider whether a call has already been initiated.

Never switch providers after an ambiguous execution outcome because doing so may accidentally create a second call.

Keep CALL-E available for its goal-driven calling workflows.

Keep Twilio, Plivo, and Vonage independently operational.

## 15. Phase 13 — Webhooks and real-time event processing

Implement Cartesia's officially supported webhook and event integrations.

Support:
- Signature verification where available.
- Event validation.
- Duplicate event protection.
- Event correlation.
- Timestamp validation.
- Out-of-order event handling.
- Durable event processing.
- Retry-safe processing.
- Failed-event diagnostics.
- Event delivery records.
- Secure webhook configuration.

Use a normalized internal event model while retaining the original provider payload securely for troubleshooting where appropriate.

Do not invent webhook events or assume that WebSocket events and HTTP webhooks have identical semantics.

## 16. Phase 14 — Agent tools and advanced workflows

Expose Cartesia-compatible agent tools through the existing VOICEDNUT tool architecture.

Support verified operations such as:

- End call.
- Transfer call.
- Send DTMF.
- Voicemail handling.
- HTTP API tools.
- Knowledge-base lookup.
- Web search.
- Human escalation.
- Structured data collection.
- Appointment workflows.
- CRM actions.
- Customer support operations.
- Multi-agent handoffs.

Use permission-controlled tool registration.

Require human approval for consequential business actions.

Validate all tool arguments and enforce tenant permissions on the server.

## 17. Phase 15 — Security and governance

Implement:

- Server-side API-key storage.
- Encrypted provider credentials.
- Credential rotation.
- Tenant isolation.
- Role-based access control.
- Audit logs.
- Consent enforcement.
- Opt-out and suppression handling.
- Calling-hour restrictions.
- Number validation.
- Per-tenant usage limits.
- Rate limits.
- Spending limits.
- Recording and transcript access controls.
- Configurable retention policies.
- Emergency stop controls.

Do not claim legal or regulatory compliance without verified evidence and appropriate review.

## 18. Phase 16 — Testing and quality assurance

Create automated tests for:

- Cartesia authentication.
- API request validation.
- Inbound-call routing.
- Outbound-call preparation.
- Outbound-call execution using mocks.
- Batch processing using fixtures.
- Number assignment.
- SIP configuration validation.
- Agent assignment.
- Sonic TTS.
- Ink STT.
- Line runtime.
- WebSocket connection lifecycle.
- Audio bridge behavior.
- Webhook verification.
- Duplicate events.
- Idempotency.
- Retry handling.
- Cancellation.
- Provider outages.
- Timeout handling.
- Tenant authorization.
- Secret redaction.
- Existing provider regressions.

Use mocks and contract fixtures for all tests that could create calls or paid provider activity.

Run the existing project test suite and compare results with the original baseline.

Do not weaken or remove existing tests to make new tests pass.

## 19. Phase 17 — Documentation and developer experience

Update existing project documentation with:

- Cartesia integration architecture.
- Supported capabilities.
- Setup instructions.
- Required environment variables.
- API authentication.
- Number management.
- Inbound-call setup.
- Outbound-call setup.
- SIP configuration.
- Sonic setup.
- Ink setup.
- Line runtime setup.
- Provider combinations.
- Webhook setup.
- Troubleshooting.
- Local mock testing.
- Deployment requirements.
- Migration and rollback instructions.

Update example environment files without inserting real secrets.

Document which features require Cartesia account entitlements, approved numbers, additional configuration, or provider-specific billing.

## 20. Implementation sequence and approval gates

Work in these phases:

PHASE A: Read-only repository and Cartesia API audit.

PHASE B: Provider architecture and capability registry.

PHASE C: Cartesia authentication and configuration.

PHASE D: Managed Agents inbound and outbound calling.

PHASE E: Phone number management and SIP integration.

PHASE F: Sonic and Ink speech services.

PHASE G: Optional Line runtime.

PHASE H: Telephony interoperability and media bridge.

PHASE I: Unified dashboard and routing.

PHASE J: Webhooks, analytics, security and governance.

PHASE K: Comprehensive regression and production-readiness review.

After each phase:
1. Summarize what will be changed.
2. Identify the exact affected files.
3. Explain compatibility risks.
4. Implement only the approved scope.
5. Run relevant tests.
6. Review the Git diff.
7. Report actual results.
8. Update the implementation checklist.
9. Request approval before the next consequential phase.

## 21. Final definition of done

The integration is complete only when:

- Cartesia inbound calling works through the supported production integration.
- Cartesia outbound calling works through the supported production integration.
- Supported Cartesia batch calling is integrated safely.
- Phone number and SIP management work within verified provider capabilities.
- Sonic and Ink are integrated into the speech architecture.
- Cartesia Line is available as an optional runtime where appropriate.
- Existing Twilio, Plivo, Vonage, and CALL-E functionality remains intact.
- Provider routing is capability-aware.
- Credentials remain secure.
- Duplicate calls and events are prevented.
- Real-time audio interoperability is tested where implemented.
- UI, documentation, and automated tests are complete.
- All existing functionality passes regression checks.
- Deployment instructions and rollback plans are documented.

## IMMEDIATE INSTRUCTION

Start with PHASE A ONLY.

Inspect the actual VOICEDNUT repository and the current official Cartesia documentation.

Pay special attention to the actual Managed Agents inbound and outbound calling APIs, phone-number provider APIs, SIP trunk APIs, batch calling, Line runtime, Sonic, Ink, and supported event/webhook contracts.

Determine how Cartesia can coexist with Twilio, Plivo, Vonage, and CALL-E in the existing architecture.

Produce a detailed repository-specific audit, compatibility assessment, exact file-level implementation plan, and prioritized recommendations.

Do not edit files, install packages, modify configurations, create phone numbers, initiate calls, perform migrations, spend money, or deploy anything during this first phase.

Wait for my explicit approval before beginning implementation.

## Implementation checklist

- [x] Phase A — Read-only repository and official Cartesia documentation audit completed.
- [x] Phase B — Provider capability catalog added. Cartesia vendor-documented capabilities are kept separate from VOICEDNUT implementation status; the catalog does not enable call routing. Focused tests, full API tests, lint, and API catalog validation passed.
- [x] Phase C — Cartesia authentication and configuration. Added a default-off Managed Agents flag, server-only key configuration, bounded request timeout, and explicit mock-tested credential validation via the documented read-only agents endpoint. No provider request is performed at startup.
- [ ] Phase D — Partially implemented: guarded outbound call preview/dispatch, status/detail, approved cancellation, lifecycle event ingestion, and inbound number-to-agent assignment are available. Operators can preview and explicitly create the Cartesia webhook through a default-off, audited endpoint-scoped idempotent server workflow, then preview and attach it to an agent. Creation uses the configured public `SERVER` HTTPS endpoint and `CARTESIA_WEBHOOK_SECRET`; no webhook URL or secret is exposed in the API response. Ambiguous create outcomes remain fenced for operator inspection because Cartesia does not document request idempotency for webhook creation. No live Cartesia inbound call has been verified.
- [ ] Phase 4 — Partially implemented for API and bot: Cartesia batch preview validates 1–5,000 unique recipients (512 KB request cap), reuses per-recipient destination allowlist and business consent checks, and builds a content fingerprint without persistence. Explicit batch dispatch uses a separate default-off `CARTESIA_BATCH_DISPATCH_ENABLED` gate, matching fingerprint, approval, audit record, and the existing durable idempotency table. Additive SQLite tables persist approved recipients and provider attempt snapshots by business scope; explicit admin reconciliation merges provider detail with timestamp protection, and local-record reads omit free-form provider errors and dynamic variables. A bounded default-off background reconciler now uses durable per-batch leases, lease renewal, sequential polling, bounded exponential backoff, and a finite failure limit; expired leases allow recovery after process restart. The fixed-column CSV export is admin-only, no-store, bounded, and formula-safe. A separate retention gate and configured age threshold permit explicit preview-bound deletion only for terminal local batches; deletion removes recipient-level rows, retains aggregate batch metadata, checks snapshot/count freshness, and records metadata-only audit events. Provider retry and provider-side scheduling remain unexposed; durable campaign orchestration and automated retention remain outstanding. Admin Telegram commands reconcile status, cancel queued work, and preview/confirm local recipient retention. Cartesia batches are submitted immediately and provider cancellation does not terminate in-progress calls. No live batch was submitted.
- [x] Phase E — Completed for the documented provider operations: admin-only phone inventory/detail, preview-confirmed agent assignment, number import, separately gated Cartesia-number provisioning and explicit release, provider inventory/detail, gated Twilio credential linking/rotation, gated SIP trunk creation and full validated update, and gated provider deletion with complete linked-number checks are available. Carrier-side configuration remains operator-managed; the current Cartesia API docs do not define an active SIP health probe, so no synthetic health status is exposed.
- [ ] Phase F — Partially implemented: Cartesia Sonic SSE and bytes transports support documented language/locale, accent, normalization, pronunciation dictionary, generation speed/volume/emotion controls; an admin-only paginated voice catalog is available. Ink supports mock-tested bounded batch transcription with optional word timestamps and optional server-side realtime Ink 2 auto-turn transcription behind `STT_PROVIDER=cartesia`. Deepgram remains the default. A server-side preview-confirm-update API now writes a Cartesia speech profile into versioned call-script configuration; Mini App profile editing is not implemented. Sonic WebSocket/context streaming, manual-turn Ink, and voice creation/cloning/localization remain outstanding. Provider Control's voice catalog remains read-only; catalog selection does not modify an active profile. Cartesia SSE chunks stream incrementally through the indexed queue for the Twilio adaptive call path only; bytes transport, Vonage, Plivo, and other paths remain buffered.
- [x] API and bot continuation — Cartesia Ink `turn.start` is surfaced as a speech-start event and interrupts queued Twilio adaptive audio before transcript text arrives; covered with a mocked WebSocket event fixture. Admins can preview and update a script's Cartesia speech profile through the API with runtime validation, preview fingerprint, explicit approval, durable idempotency, optimistic version checks, and existing script lifecycle/version handling. The Telegram bot's admin-only `/cartesia status`, `/cartesia profile`, and `/cartesia apply` commands use the same API preview and confirmation path. Mini App files were not changed in these continuations.
- [x] API/bot batch continuation — Added current-contract Cartesia batch endpoints, per-recipient policy preview, separate default-off dispatch gate, approval fingerprint, durable idempotency, admin audit events using existing dispatch/cancel actions with `batch:<id>` resource tags, additive business-scoped batch and attempt tables, explicit timestamp-safe provider reconciliation, local recipient records, and explicit cancellation. A bounded admin-only CSV export now uses fixed columns, marks responses `no-store`, omits dynamic variables/provider error text, and neutralizes spreadsheet formula cells. Free-form provider errors and dynamic variables are not persisted. Telegram status performs explicit reconciliation and displays aggregates only; cancellation requires the `CANCEL` confirmation word. Retry and scheduling remain unsupported in VOICEDNUT pending per-recipient consent refresh and durable campaign orchestration. Mini App files were not changed.
- [ ] Phase G — Partially implemented: added a server-side Cartesia hosted Managed Agent WebSocket session adapter with documented audio framing, readiness handling, turn events, interruption signals, DTMF input, and bounded client-tool responses. VOICEDNUT can select a hosted agent in the existing Twilio stream path, but does not deploy the standalone Python `cartesia-line` SDK or run arbitrary Line agent code.
- [ ] Phase H — Partially implemented: connected the hosted-agent session adapter to the existing Twilio Media Streams runtime using the directly compatible μ-law/8000 format, inbound-track filtering, Twilio playback buffering/clear behavior, existing backend tool policy, and DTMF forwarding. Selection is restricted to a live script and default-off server gates. No live call was made or qualified.
- [ ] Phase I — Partially implemented: Provider Control has a read-only Cartesia operations snapshot for server configuration flags, capability-registry status, phone inventory, linked provider metadata, and recent stored call lifecycle metadata. Call-history queries can be scoped to one business and require an active `policy_manager` or `call_operator` membership; global metadata/history access remains available to system administrators with `users_manage`. Phone numbers in call records are masked and transcripts/recordings are omitted by default. Authorized operators can explicitly request a locally stored call's private summary/transcript through a no-store review endpoint; scoped reviews require membership and a business-filtered database lookup, and responses are bounded and suppress ZDR content. Review attempts write metadata-only audit events visible to global `users_manage` admins. Global admins can also preview and explicitly confirm inbound phone-number agent assignments when the server's default-off phone mutation gate is enabled; the API records request and outcome events in a separate metadata-only admin-action audit stream. Script Studio can select the existing Twilio-stream Cartesia hosted-agent runtime for a script draft and validate its hosted agent ID. This does not put Cartesia Managed Agents into the generic telephony provider switch planner; the provider modes have different execution contracts. Other mutating dashboard actions, TTS/STT profile editing, audit retention/export/deletion, and full routing controls remain outstanding.
- [ ] Phase J — Partially implemented: private call-review, phone-number, telephony-provider, webhook-agent assignment, and call-operation audit events are stored and recent events are visible to global admins. Coverage includes phone-agent assignment, webhook-agent assignment, number import, provisioning, release, Twilio provider linking/credential rotation, SIP provider creation/update, provider deletion, approved outbound call dispatch, and cancellation. Retention/deletion/export policy and broader analytics/governance are still outstanding.
- [ ] Phase K — Comprehensive regression and production-readiness review.

Phase E local verification: 84 focused Cartesia tests passed, the full API suite passed (462 tests), API lint passed, the API documentation catalog check passed, and `git diff --check` passed. These checks use fake Cartesia I/O only. Provider API calls use `Cartesia-Version: 2026-08-14` and standard Bearer authentication. The integration now supports provider list/detail, Twilio account linking and credential rotation, SIP configuration updates, and provider deletion. Credential writes are HTTPS-only, separately gated by default, preview-confirmed, and idempotent; Twilio and SIP credentials are not returned or persisted. Provider deletion also requires typed label confirmation and a fully paginated check showing no linked numbers; ambiguous deletes reconcile from inventory without repeating a DELETE. SIP updates require the exact preview, typed provider ID and linked-number count, and retain at least one inbound access control. Phone import, Cartesia US number provisioning, number release, SIP creation, and number assignment retain their existing preview/approval and default-off controls.

### Inbound webhook attachment implementation notes

The admin API can inspect a Cartesia agent's current webhook and validate an existing webhook's ID and HTTPS URL without returning that URL, then attach or detach the webhook from the agent after an exact preview confirmation. Mutations require `CARTESIA_WEBHOOK_MUTATIONS_ENABLED=true`, HTTPS, an explicit approval flag, a preview fingerprint, and a durable idempotency key. Ambiguous provider responses are reconciled with a read-only agent lookup; unresolved operations remain pending and cannot be resubmitted with the same key. Provider-operation audit events store only the agent ID, action, outcome, fingerprint, and sanitized error code in a new additive audit table; existing records and tables are preserved and the table is created by the existing schema initializer. This workflow does not create a webhook or receive its secret. Create it in Cartesia's Playground and use the public VOICEDNUT webhook URL and the same `CARTESIA_WEBHOOK_SECRET` configured server-side. Cartesia omits secrets from webhook read responses, so an operator must verify the URL and secret before attaching; VOICEDNUT cannot assert that configuration automatically. No provider request or webhook write was run during implementation.

The webhook create workflow uses Cartesia's `POST /agents/webhooks` contract with `{url, secret}` and validates the one-time returned secret before discarding it. The current API reference and general conventions use server-side Bearer authentication and `Cartesia-Version: 2026-08-14`; the observability guide's `X-API-Key` example conflicts with the API conventions and is not followed. Cartesia documents retry behavior for event deliveries (up to three retries for network errors and selected status codes) and `webhook_request_id` as the deduplication key. It does not document an idempotency header for webhook creation; the local service therefore reserves one creation per endpoint and leaves ambiguous results pending for manual reconciliation rather than issuing another POST.

Focused verification: `cd api && npx mocha __tests__/cartesiaClient.test.js __tests__/cartesiaWebhookConfigService.test.js __tests__/cartesiaCallRoutes.test.js __tests__/cartesiaDashboardRoutes.test.js --reporter dot` passed (62 tests). The full API suite passed (532 tests), API lint passed, Mini App production validation/build passed, and `git diff --check` passed. All provider I/O in tests used mocks. Official contracts reviewed: [Cartesia webhook delivery and event schema](https://docs.cartesia.ai/line/infrastructure/observability), [Create Webhook](https://docs.cartesia.ai/api-reference/agents/webhooks/create), [Get Agent](https://docs.cartesia.ai/api-reference/agents/agents/get), [Update Agent](https://docs.cartesia.ai/api-reference/agents/agents/update), [Get Webhook](https://docs.cartesia.ai/api-reference/agents/webhooks/get), and [API conventions](https://docs.cartesia.ai/use-the-api/api-conventions). The documented Cartesia API version used by the project is `2026-08-14` with server-side Bearer authentication.

The official [provider update contract](https://docs.cartesia.ai/api-reference/agents/providers/update) supports partial SIP updates and documents clear semantics. VOICEDNUT's update workflow instead sends a full validated inbound/outbound configuration so an update cannot silently clear the inbound access controls; it requires typed provider ID and linked-number count confirmation. The current provider API docs do not define an active SIP reachability probe; provider configuration metadata is available, but carrier health remains unverified. Carrier-side routing and encryption configuration remain operator-managed. No Cartesia credentials were accessed, no live provider API request, phone-number/provider write, call, webhook registration, migration, or production change was performed. Number provisioning may create a billable resource, and releasing Cartesia-owned numbers is permanent. No schema change was needed; operations reuse the existing durable idempotency table. See [provider inventory](https://docs.cartesia.ai/api-reference/agents/providers/list), [provider detail](https://docs.cartesia.ai/api-reference/agents/providers/get), [provider creation](https://docs.cartesia.ai/api-reference/agents/providers/create), [provider update](https://docs.cartesia.ai/api-reference/agents/providers/update), [provider deletion](https://docs.cartesia.ai/api-reference/agents/providers/delete), [phone-number inventory](https://docs.cartesia.ai/api-reference/agents/phone-numbers/list), [phone import](https://docs.cartesia.ai/api-reference/agents/phone-numbers/import), [US phone provisioning](https://docs.cartesia.ai/api-reference/agents/phone-numbers/provision), [phone release](https://docs.cartesia.ai/api-reference/agents/phone-numbers/delete), [SIP trunking](https://docs.cartesia.ai/line/integrations/telephony/sip-trunking), and [API conventions](https://docs.cartesia.ai/use-the-api/api-conventions). The SIP guide's `X-API-Key` sample conflicts with current API conventions and is intentionally not followed.

Phases B and C verification used mocked/unit-level tests only. No Cartesia credentials were accessed, no provider API calls were made, and no numbers, calls, or production settings were used or changed. The credential validation method is available to a future authorized server-side workflow but was not run against Cartesia.

### Phase F implementation notes

The Cartesia voice catalog is exposed to the Mini App through `GET /miniapp/cartesia/voices`, which reuses the existing voice-list service, provider-manage capability check, request limiter, query validation, and no-store response policy. The panel supports search and cursor-based loading; it does not persist voice selection or change runtime configuration.

The Twilio adaptive call path can now opt into incremental Sonic SSE playback: validated PCM chunks are converted to the configured raw telephony encoding and sent through the indexed stream queue; response indices advance only after completion. On provider failure after partial playback, no full-response Deepgram fallback is played; Twilio barge-in aborts active Cartesia SSE requests and preserves response-index sequencing across queue flushes. Cache hits and the optional bytes transport still emit complete buffers. Vonage and Plivo retain their provider-specific buffered audio envelopes. Sonic WebSocket continuation/cancellation and direct incremental playback require a separate media-bridge change and are not represented as supported. The Cartesia TTS controls are passed only when explicitly supplied by the server-side voice runtime; `speed` is validated to 0.6–1.5, `volume` to 0.5–2.0, and `emotion` against Cartesia's documented values. Generation settings and transport participate in the cache key.

Ink batch transcription is exposed at `POST /admin/cartesia/speech/transcriptions`. It accepts raw audio using a supported audio media type, rejects files over 15 MB, uses `ink-whisper`, and optionally requests documented word timestamps. Requests require the existing admin-token middleware. Audio is sent to Cartesia but is neither persisted nor logged by this endpoint; transcript responses are normalized and returned to the caller. Voice search/pagination is available at `GET /admin/cartesia/speech/voices`; returned records omit preview URLs and unrelated provider fields. Both routes use the existing Cartesia call rate limiter.

Realtime Ink auto-turn processing can be selected with `STT_PROVIDER=cartesia`; unset/default remains `deepgram`. It uses Cartesia's `ink-2` auto-turn WSS endpoint and maps partial and completed turns to the existing `utterance` and `transcription` events. Cartesia's documented `turn.start` event is emitted as `speechStart`; the Twilio adaptive stream uses it to interrupt queued agent audio immediately, before partial transcript text arrives. It maps VOICEDNUT `linear16` to Cartesia `pcm_s16le` and μ-law to Cartesia's documented `pcm_mulaw`, preserving the sample rate, and keeps the API key in the server-side handshake header. Cartesia currently documents Ink 2 realtime support for English, French, Hindi, Japanese, and Spanish. Verify the chosen number/media path's audio encoding, sample rate, and language against Cartesia account support before enabling it. Ink manual-turn mode is not used because VOICEDNUT's current stream path has no explicit user-turn finalize signal.

The Cartesia `turn.start` handling was added and verified against the current [Ink auto-turn WebSocket event contract](https://docs.cartesia.ai/api-reference/stt/turns/websocket) (checked 2026-11-09). The manual WebSocket contract's literal `finalize` command is not wired because the API stream path has no reliable manual-turn boundary.

The admin API exposes `POST /api/call-scripts/:id/cartesia-speech-profile/preview` with `{ voice_id, expected_version }` and `PUT /api/call-scripts/:id/cartesia-speech-profile` with the same fields plus `approved: true`, the returned `confirmed_fingerprint`, and an `Idempotency-Key` header. Both routes require the existing admin-token authorization and Cartesia request limiter. Preview is non-persistent and performs format/runtime-schema validation only; it does not call Cartesia or prove that the account owns or can use the voice. Update uses optimistic version checking, the existing durable call-script mutation idempotency store, and existing version snapshots. It preserves other runtime settings and returns scripts that were in review/approved/live to draft for the normal review process. Voice IDs are stored in the existing runtime-config column, so no migration is required. The request follows Cartesia's current TTS contract, where the `voice` value is a string ID ([TTS bytes API](https://docs.cartesia.ai/api-reference/tts/bytes), checked 2026-11-09).

The Telegram bot exposes this as `/cartesia profile <script_id> <voice_id>` (preview only) followed by `/cartesia apply <script_id> <voice_id> <expected_version> <preview_fingerprint>` (explicit confirmation). The apply idempotency key is bound to the exact script, expected version, and preview fingerprint, so retrying the same command replays its original result. Both commands require the existing administrator/provider-manage capability; the status command remains read-only.

Phase F focused verification currently covers mock provider responses and socket events only; it does not establish live account entitlements, paid model availability, or end-to-end telephony audio quality. Setup remains optional: configure the existing server-side `CARTESIA_API_KEY` and voice ID for TTS, and set `STT_PROVIDER=cartesia` only after a controlled operator configuration review. No live provider request or real call is performed by tests.

Phase F baseline verification: the focused speech/provider tests passed (28 tests), the full API suite passed (480 tests), API lint passed, the declared `ws` dependency resolved at 8.19.0, and `git diff --check` passed. The later incremental SSE playback continuation passed 14 focused TTS/stream tests, the full API suite (540 tests), lint, syntax checks, and `git diff --check`; an abort-on-barge-in mock regression is included. No database migration was needed.

Official contracts reviewed: [Sonic bytes](https://docs.cartesia.ai/api-reference/tts/bytes), [Sonic SSE](https://docs.cartesia.ai/api-reference/tts/sse), [Sonic WebSocket](https://docs.cartesia.ai/api-reference/tts/websocket), [voice list](https://docs.cartesia.ai/api-reference/voices/list), [Ink batch transcription](https://docs.cartesia.ai/api-reference/stt/transcribe), [Ink manual realtime](https://docs.cartesia.ai/api-reference/stt/websocket), [Ink automatic turn detection](https://docs.cartesia.ai/api-reference/stt/turns/websocket), [API conventions and WebSocket versioning](https://docs.cartesia.ai/use-the-api/api-conventions), [Cartesia's STT encoding contract](https://github.com/cartesia-ai/cartesia-python/blob/main/src/cartesia/types/stt_encoding.py), and [speed, volume, and emotion controls](https://docs.cartesia.ai/build-with-cartesia/capability-guides/volume-speed-emotion).

The batch workflow uses Cartesia's current [Create Call Batch](https://docs.cartesia.ai/api-reference/agents/call-batches/create-call-batch), [List Call Batches](https://docs.cartesia.ai/api-reference/agents/call-batches/list-call-batches), [Get Call Batch](https://docs.cartesia.ai/api-reference/agents/call-batches/get-call-batch), and [Cancel Call Batch](https://docs.cartesia.ai/api-reference/agents/call-batches/cancel-call-batch) contracts. The documented recipient maximum is 5,000; the VOICEDNUT parser applies a 512 KB limit to these paths only. The provider's batch maximum call duration is 480 minutes; VOICEDNUT validates against that range. [Retry Call Batch](https://docs.cartesia.ai/api-reference/agents/call-batches/retry-call-batch) requeues latest failed or unanswered recipients, so it is not wired into VOICEDNUT's current per-recipient consent approval model.

API and bot batch verification: `cd api && npm test -- --reporter dot` passed (584 tests); `cd api && npm run lint` passed; `cd bot && node --test` passed (13 tests); syntax and `git diff --check` passed. All Cartesia I/O in tests is mocked. SQLite tests include pre-batch schema compatibility, prior call preservation, conditional recipient deletion, stale-snapshot refusal, retained batch aggregates, reconciliation leases, crash recovery, and schema upgrade from the earlier batch schema. No live batch, call, Cartesia API request, production configuration change, or production database migration was performed. `CARTESIA_BATCH_DISPATCH_ENABLED`, `CARTESIA_BATCH_RETENTION_ENABLED`, and `CARTESIA_BATCH_RECONCILIATION_ENABLED` default to false. Retention also requires a configured positive `CARTESIA_BATCH_RETENTION_DAYS` value (1–3650). Background reconciliation uses read-only batch detail requests and is separately gated; it is not a call scheduler. The retention workflow remains manual and preview-confirmed.

The background worker follows Cartesia's current [Get Call Batch API](https://docs.cartesia.ai/api-reference/agents/call-batches/get-call-batch): `GET /agents/calls/batches/{batch_id}` with server-side Bearer authentication and `Cartesia-Version: 2026-08-14`. The documented detail response includes `last_updated_at`, aggregate lifecycle status, and recipient attempt details. The worker polls locally recorded nonterminal batches sequentially; it does not use Cartesia's retry endpoint or create calls.

### Phase G implementation notes

Cartesia's current [WebSocket guide](https://docs.cartesia.ai/line/integrations/websocket-api) and [WebSocket API reference](https://docs.cartesia.ai/api-reference/agents/agent-websocket) describe a server-side Node-compatible session for a hosted Managed Agent: `wss://api.cartesia.ai/v1/agents/websocket/{agent_id}`, `X-API-Key`, `cartesia_version` query version, an initial `session_create`, and `session_ready` before audio is sent. `CartesiaLineAgentSession` implements this contract for the server. It normalizes audio and turn events, returns bounded client-tool results, accepts DTMF input, and does not expose credentials in URLs or emitted provider errors. Cartesia's generic `/api-reference/agents/websocket` page currently describes the older `/agents/stream/{agent_id}` event protocol; the implementation follows the current guide and matching `/api-reference/agents/agent-websocket` contract.

The standalone [Cartesia Line SDK](https://github.com/cartesia-ai/line) remains Python (`cartesia-line` 0.2.18 in the official repository's current `pyproject.toml`) and its documented CLI manages Line agent deployment. VOICEDNUT is a Node-only repository, so these changes do not embed the Python SDK or add a second service. The hosted-agent WebSocket is a separate session adapter and is not treated as a deployed Python Line agent automatically. Phase H now routes an explicitly selected hosted agent through the existing Twilio stream bridge; arbitrary Python Line agent deployment remains out of scope for that adapter.

Cartesia documents that agent call recordings and transcripts are retained by default; there is no mid-call recording toggle. A future runtime selection needs an explicit retention/consent policy before routing real customer calls. No live WebSocket, Cartesia API request, phone call, deployment, credential access, migration, or provider write was performed. Focused tests use a fake WebSocket only.

Phase G verification: `cd api && npx mocha __tests__/cartesiaLineAgentSession.test.js __tests__/voiceProviderCapabilityRegistry.test.js --reporter dot` passed (12 tests); `cd api && npm test -- --reporter dot` passed (exit 0); `cd api && npm run lint` passed; `git diff --check` passed. The adapter test covers authentication placement, session readiness, bounded audio/tool payloads, event normalization, DTMF input, and sanitized provider errors. These checks use mock WebSocket behavior only.

Phase H verification: `cd api && npx mocha __tests__/cartesiaLineAgentSession.test.js __tests__/cartesiaLineRuntimePolicy.test.js __tests__/callAgentDefinition.test.js __tests__/voiceProviderCapabilityRegistry.test.js --reporter dot` passed (35 tests); `cd api && npm test -- --reporter min` passed (490 tests); `cd api && npm run lint` passed; `git diff --check` passed. Tests use mocked provider sockets and no real calls. The bridge is not production-qualified: no live Cartesia session or telephony call was run, and enabling it still requires a reviewed retention/consent policy and controlled deployment approval.

### Phase H implementation notes

The existing `/connection` handler now selects Cartesia only when the active Voice Agent mode is enabled, the script is live, that script's validated `voice_agent_settings` explicitly names `provider: "cartesia_line"` and an `agent_id`, and both `CARTESIA_LINE_AGENT_ENABLED` and `CARTESIA_LINE_DATA_HANDLING_REVIEWED` are true. Both flags default false; Cartesia credentials reuse the server-side `CARTESIA_API_KEY`. If any preflight fails, the Cartesia-selected script falls back to the existing legacy runtime and does not silently switch to Deepgram. Plivo, Vonage, CALL-E, and existing Deepgram routing are unchanged.

Twilio inbound media is forwarded only when `media.track` is `inbound`. Twilio and Cartesia both document raw mono μ-law at 8 kHz for this path, so the adapter does not resample or transcode. Cartesia output reuses the existing Twilio StreamService buffering, and its documented `audio_output_clear` event clears the Twilio playback queue. Caller DTMF input is forwarded as Cartesia `dtmf_input`; outbound DTMF actions from the hosted agent and telephony transfer events are not implemented here. Cartesia `client_tool_call` events pass through VOICEDNUT's existing tool allowlist, authorization policy, and timeout handling.

The hosted Cartesia agent's prompt and greeting are configured in Cartesia; the current WebSocket session-create contract does not provide VOICEDNUT's per-call prompt/business context dynamically. Keep agent instructions and tools aligned with the selected live script. The two environment gates record operator enablement and data-handling review; they do not constitute caller consent or legal approval. Cartesia retains call audio and transcripts by default unless the organization has configured its documented Zero Data Retention option. Verify the applicable disclosure, consent, retention, and jurisdiction policy before enabling the gates. No environment file, production setting, or live call was changed. No database migration is required; provider call ID and agent version are stored in the existing call-state event data.

Official contracts reviewed: [Twilio Media Streams WebSocket messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages), [Cartesia WebSocket integration guide](https://docs.cartesia.ai/line/integrations/websocket-api), [Cartesia Agent WebSocket API reference](https://docs.cartesia.ai/api-reference/agents/agent-websocket), and [Cartesia call recording/retention](https://docs.cartesia.ai/line/infrastructure/observability).

### Phase I implementation notes

The new `GET /miniapp/cartesia/overview` route uses the existing Mini App session and `provider_manage` capability, a bounded 1–50 history limit, and the existing Cartesia rate limiter. It returns configuration metadata without credentials, and queries phone/provider inventories only when the server-side Cartesia integration is enabled and configured. Inventory read failures are reported per section with sanitized codes. Call history can be requested with `business_id`; the server resolves the session's Telegram identity against the existing `call_e_business_operator_events` membership history and admits only `policy_manager` and `call_operator` roles. A parameterized `WHERE business_id = ?` query prevents records from other businesses from entering the response. Without a business scope, call history remains available only to sessions with global `users_manage`. Phone numbers are masked and transcript/recording/business fields are excluded. The API uses the existing `cartesia_calls` table; no schema migration is required.

Script Studio’s runtime selector preserves Deepgram as the default, accepts a validated Cartesia hosted agent ID, and saves the selection through the existing call-script draft lifecycle. It does not publish the script or enable the server runtime gates. The generic provider switch planner is unchanged because Cartesia Managed Agents are not a compatible drop-in telephony adapter in the current registry. No provider writes, real calls, production configuration changes, or deployments were performed.

Phase I verification: `cd api && npx mocha __tests__/cartesiaDashboardRoutes.test.js __tests__/cartesiaLineRuntimePolicy.test.js __tests__/callAgentDefinition.test.js --reporter dot` passed (30 tests); `cd api && npm test -- --reporter min` passed (497 tests); `cd api && npm run lint` passed; `cd miniapp && npm run validate:prod` passed; `cd miniapp && npm run test:e2e` passed (8 tests); `cd miniapp && npm run test:a11y` passed (1 test); `git diff --check` passed. All provider reads and calls in tests use local fixtures or mocks.

### Phase I continuation — Protected Cartesia call-detail review

Added `POST /miniapp/cartesia/calls/:providerCallId/review`. It requires the Mini App session, `provider_manage`, `users_manage`, an exact `{ "confirm_private_data_review": true }` request body, and an existing local `cartesia_calls` record before it fetches provider details. The database lookup is read-only and uses the existing table; no schema migration is required. The response sets `Cache-Control: no-store`, masks `from` and `to`, bounds transcript output to at most 200 turns, 2,000 characters per turn and 30,000 total characters, suppresses transcript and summary when Cartesia marks ZDR enabled, and never forwards raw provider errors or unrecognized fields. Private content is fetched only on operator request and is not persisted or logged by this route. Provider errors are returned as sanitized error codes.

The Mini App asks for explicit confirmation before issuing this request, displays Cartesia-provided summary/transcript data as provider output, and provides loading and error feedback. For business-scoped review, it sends the selected business ID; the API verifies the active membership and queries the call using both provider call ID and business ID. Unscoped review remains restricted to global `users_manage` administrators. Browser fixtures use synthetic content and E2E coverage confirms that dismissing the dialog does not reveal content and that selected-business history can be loaded. A metadata-only review audit ledger is now implemented as described below; a membership-aware global call-search experience remains outstanding.

The implementation follows Cartesia's current [Get Call API](https://docs.cartesia.ai/api-reference/agents/calls/get-call), documented as `GET /agents/calls/{call_id}` with Bearer authentication and `Cartesia-Version: 2026-08-14`. Its documented response includes `transcript`, `summary`, `telephony_params`, and `zdr_enabled`; the endpoint does not require a Cartesia SDK dependency. No real provider request or call was made.

Phase I continuation verification for protected review and business-scoped history: `cd api && npx mocha __tests__/cartesiaDashboardRoutes.test.js --reporter dot` passed (15 tests); `cd api && npm test -- --reporter min` passed (505 tests); `cd api && npm run lint` passed; `cd miniapp && npm run validate:prod` passed; `cd miniapp && npm run test:e2e` passed (10 tests); `cd miniapp && npm run test:a11y` passed (1 test); `git diff --check` passed. Tests use a stub call service and fixture-only UI data. No migration or manual provider configuration was required for those slices.

### Phase I continuation — Metadata-only private-review audit ledger

Added the `cartesia_call_review_audit` table through the existing additive schema initialization (`CREATE TABLE IF NOT EXISTS`); no destructive migration or backfill is required. The ledger stores the authenticated actor ID, optional business ID, provider call ID, outcome (`allowed`, `denied`, or `failed`), a safe reason code, and timestamp. It does not store transcripts, summaries, phone numbers, or provider payloads. For successful reviews, the allowed audit record must be written before private call content is returned; if that write fails, the route fails closed. Denied local lookups and provider failures are recorded when the audit store is available.

The no-store operations overview exposes only the latest 25 records to a global, unscoped `users_manage` administrator. Business-scoped users do not receive the cross-business audit list. This is an application-level metadata ledger, not a tamper-proof audit system. Retention, export, and deletion controls remain unimplemented and need a governance decision before production use.

Audit-ledger verification: `cd api && npx mocha __tests__/cartesiaDashboardRoutes.test.js --reporter dot` passed (16 tests); `cd api && npm test -- --reporter min` passed (506 tests); `cd api && npm run lint` passed; `cd miniapp && npm run validate:prod` passed; `cd miniapp && npm run test:e2e` passed (10 tests); `cd miniapp && npm run test:a11y` passed (1 test); `git diff --check` passed. Database and provider behavior are tested with a temporary SQLite database and stub service; UI data is synthetic. No provider calls, migrations against production data, or production configuration changes were performed.

### Phase I continuation — Controlled inbound agent assignment

Provider Control now lets global `provider_manage` plus `users_manage` administrators select one listed Cartesia phone number and a Cartesia agent ID, preview the current and target assignment, and submit only after a second browser confirmation. A blank target means unassign. Both preview and write endpoints use the Mini App session and rate limiter; the write route accepts only `agent_id`, explicit `approved: true`, the exact server-generated preview fingerprint, and an idempotency key. The service's `CARTESIA_PHONE_NUMBER_MUTATIONS_ENABLED` flag remains default-off, and the dashboard hides the action unless the server reports the feature and Cartesia configuration as available. The underlying request uses Cartesia's documented `PATCH /agents/phone-numbers/{id}` with `agent_id`; this API version supports assigning an ID or setting it to `null` to unassign. VOICEDNUT verifies the provider response and reconciles ambiguous network outcomes with one read rather than resubmitting. See Cartesia's current [Update Phone Number API](https://docs.cartesia.ai/api-reference/agents/phone-numbers/update) (Cartesia-Version `2026-08-14`).

The UI does not list or validate Cartesia agents before preview; the administrator supplies the target ID and Cartesia validates the assignment. The workflow changes live inbound routing when the server gate is enabled and the administrator confirms it. No environment flag was enabled and no provider write was performed during implementation. No database migration is required; existing idempotency storage is reused.

Assignment verification: `cd api && npx mocha __tests__/cartesiaDashboardRoutes.test.js --reporter dot` passed (18 tests); `cd api && npm run lint` passed; `cd api && npm test -- --reporter min` passed (508 tests); `cd miniapp && npm run validate:prod` passed; `cd miniapp && npm run test:e2e` passed (11 tests); `cd miniapp && npm run test:a11y` passed (1 test). The browser test verifies preview content, the second confirmation dialog, the resulting assignment state, and mobile-width overflow. API requests use a stub assignment service and UI fixtures; no real Cartesia update was sent.

### Phase J continuation — Cartesia phone-assignment audit events

Added the additive `cartesia_admin_action_audit` table. Before the API invokes the assignment service, it records an intent event containing the authenticated Telegram actor ID, phone-number provider ID, target agent ID, and preview fingerprint. Afterward it appends a success or failure event; ambiguous provider/persistence outcomes are labeled `outcome_unknown`. If the initial audit insert fails, no assignment is attempted. If an outcome insert fails after a provider change, the API reports that the provider may already have changed and directs the operator to refresh inventory; the durable request event remains. Credentials, E.164 phone numbers, request payloads, and the fingerprint are omitted from the audit display. Only a global unscoped `users_manage` admin can read the latest 25 events from the no-store overview.

This table is additive and created by existing schema initialization; no destructive migration or backfill is needed. Audit retention is not configured: the ledger currently has no automatic expiry, export, or deletion operation. A retention period and deletion behavior require an organization policy decision; do not treat the current ledger as production-governed retention.

Assignment audit verification: `cd api && npx mocha __tests__/cartesiaDashboardRoutes.test.js --reporter dot` passed (19 tests); `cd api && npm test -- --reporter min` passed (509 tests); `cd api && npm run lint` passed; `cd miniapp && npm run validate:prod` passed; `cd miniapp && npm run test:e2e` passed (11 tests); `cd miniapp && npm run test:a11y` passed (1 test); `git diff --check` passed. Tests use a temporary SQLite database, mocked route services, and synthetic browser fixtures only. No Cartesia write was sent.

### Phase J continuation — Cartesia phone-number operation audit

The admin API now records intent and outcome events for phone-number import, Cartesia number provisioning, release, and API-based agent assignment. The intent record is written before the existing approved service operation; if audit storage is unavailable, the mutation fails closed. Provider or persistence failures are classified as failed or outcome-unknown, preserving the original idempotency and confirmation checks. The metadata ledger stores Cartesia resource IDs and a request fingerprint, but no E.164 telephone numbers, provider credentials, or raw request payloads. Admin-token actions are attributed to a shared token identity because the current API authentication contract does not identify an individual administrator. The operations overview exposes the latest 25 events only to global, unscoped `users_manage` administrators and labels that shared identity explicitly.

The additive table is created by the existing schema initialization; no destructive migration or backfill is needed. No provider API contract or request payload changed. The implementation follows the documented [phone import](https://docs.cartesia.ai/api-reference/agents/phone-numbers/import), [US number provision](https://docs.cartesia.ai/api-reference/agents/phone-numbers/provision), and [phone number delete/release](https://docs.cartesia.ai/api-reference/agents/phone-numbers/delete) operations. Audit retention, export, and deletion remain unconfigured.

Phone-operation audit verification: `cd api && npx mocha __tests__/cartesiaPhoneNumberRoutes.test.js __tests__/cartesiaDashboardRoutes.test.js --reporter dot` passed (26 tests); `cd api && npm test -- --reporter min` passed (510 tests); `cd api && npm run lint` passed; `cd miniapp && npm run validate:prod` passed; `cd miniapp && npm run test:e2e` passed (11 tests); `cd miniapp && npm run test:a11y` passed (1 test); `git diff --check` passed. All Cartesia operations in these tests use fakes, and browser checks use local fixtures. No live Cartesia API request, number operation, or production change was made.

### Phase J continuation — Cartesia telephony-provider operation audit

The admin API now records intent and outcome metadata for Twilio provider linking, Twilio credential updates, SIP provider creation and updates, and telephony-provider deletion. As with number changes, the requested event is committed before the existing provider service runs; if the audit store is unavailable, the operation fails closed. Failed and ambiguous results are recorded when possible, while success-audit persistence failure returns a refresh-before-retry response because Cartesia may already have applied the change. Existing HTTPS checks, server-side secret handling, preview fingerprints, typed confirmations, feature gates, idempotency and linked-number safeguards remain unchanged. The audit contains only the action, provider ID (or a pending fingerprint-derived reference), outcome, safe error code and request fingerprint; it does not store Twilio credentials, SIP authentication values, or raw requests. The shared admin API token is the only available actor identity.

The operation ledger uses an additive `CREATE TABLE IF NOT EXISTS` schema and exposes only the latest 25 entries to global unscoped `users_manage` administrators. The provider create, update and delete client calls continue to use Cartesia's current `POST`, `PATCH`, and `DELETE /agents/phone-numbers/providers[/{id}]` contracts with Bearer authentication and the configured `Cartesia-Version` header (repository default `2026-08-14`). See Cartesia's [provider create](https://docs.cartesia.ai/api-reference/agents/providers/create), [provider update](https://docs.cartesia.ai/api-reference/agents/providers/update), [provider delete](https://docs.cartesia.ai/api-reference/agents/providers/delete), and [API conventions](https://docs.cartesia.ai/use-the-api/api-conventions). No provider API contract was changed, and no live provider operation was sent.

Provider-operation audit verification: `cd api && npx mocha __tests__/cartesiaCallRoutes.test.js __tests__/cartesiaPhoneNumberRoutes.test.js __tests__/cartesiaDashboardRoutes.test.js __tests__/cartesiaTelephonyProviderService.test.js --reporter dot` passed (57 tests); `cd api && npm test -- --reporter min` passed (512 tests); `cd api && npm run lint` passed; `cd miniapp && npm run validate:prod` passed; `cd miniapp && npm run test:e2e` passed (11 tests); `cd miniapp && npm run test:a11y` passed (1 test); `git diff --check` passed. Tests use temporary SQLite and mocked provider services; browser checks use local fixtures. No Cartesia provider write, migration against deployed data, or production configuration change was performed.

### Phase J continuation — Cartesia call-operation audit

Approved outbound dispatches and call cancellations now write intent and outcome events. Dispatch requires the existing preview fingerprint and idempotency key before audit begins; it records a pending reference, then records the Cartesia call ID after success. Cancellations are logged only for valid call IDs with explicit approval. Retryable or server-side cancellation failures are classified as `outcome_unknown`, prompting status reconciliation rather than an automatic retry. If the initial audit write fails, dispatch or cancellation is not submitted; if the final audit write fails after Cartesia may have acted, the route reports that status must be refreshed before retrying. Events contain the shared admin-token actor, action, call ID or pending reference, outcome, fingerprint, safe error code, and timestamp; they exclude destination numbers, dynamic variables, and raw provider payloads. Only global unscoped `users_manage` admins can view the latest 25 events.

The new `cartesia_call_operation_audit` table is additive and created by normal schema initialization; no destructive migration or backfill is required. The implementation preserves Cartesia's documented `POST /agents/calls` request and per-recipient `calls[].agent_call_id` response and `POST /agents/calls/{call_id}/cancel` endpoint. The outbound create endpoint does not document a provider idempotency key, so VOICEDNUT continues to rely on its existing local durable idempotency reservation and never resubmits an ambiguous dispatch. See Cartesia's [Create Outbound Call](https://docs.cartesia.ai/api-reference/agents/calls/create-outbound-call), [Cancel Call](https://docs.cartesia.ai/api-reference/agents/calls/cancel-call), [Get Call](https://docs.cartesia.ai/api-reference/agents/calls/get-call), and [API conventions](https://docs.cartesia.ai/use-the-api/api-conventions). These endpoints require a standard server-side API key and `Cartesia-Version`; current docs list `2026-08-14`, matching the repository default. No real call or cancellation was made.

Call-operation audit verification: `cd api && npx mocha __tests__/cartesiaCallRoutes.test.js __tests__/cartesiaCallService.test.js __tests__/cartesiaDashboardRoutes.test.js --reporter dot` passed (38 tests); `cd api && npm test -- --reporter min` passed (515 tests); `cd api && npm run lint` passed; `cd miniapp && npm run validate:prod` passed; `cd miniapp && npm run test:e2e` passed (11 tests); `cd miniapp && npm run test:a11y` passed (1 test); `git diff --check` passed. Calls and cancellation are exercised only through mocked services; browser checks use local fixtures. No phone number was called.

### Phase I continuation — Business-scoped Cartesia call history

The overview endpoint now accepts an optional validated `business_id`. Scoped history is available to an authenticated Mini App user with `provider_manage` and an active CALL-E business membership of `policy_manager` or `call_operator`; the request's Telegram identity is taken from the verified session, never from client input. The database filters call rows by both the requested business ID and the requested limit. System administrators with `users_manage` retain the existing unscoped metadata view. When a call review request includes `business_id`, the same membership check runs and the provider call lookup is constrained by both call ID and business ID. Cross-business or unscoped operator lookups return no call details.

The Provider Control panel has an explicit business-ID field and load action. The field is a selector only; it is not treated as authorization. The API enforces membership on every request. The existing session model does not carry a selected business by default, so users must choose the business whose records they intend to view. Existing records without a populated `business_id` remain visible only to global administrators; no backfill was performed. No schema migration was required because Cartesia call rows already include the business ID and the membership event table already exists.

Business-scope verification: `cd api && npx mocha __tests__/cartesiaDashboardRoutes.test.js --reporter dot` passed (15 tests); `cd api && npm test -- --reporter min` passed (505 tests); `cd api && npm run lint` passed; `cd miniapp && npm run validate:prod` passed; `cd miniapp && npm run test:e2e` passed (10 tests); `cd miniapp && npm run test:a11y` passed (1 test); `git diff --check` passed. API tests cover membership authorization, scoped SQL lookups, cross-business rejection, and detail review; browser tests use fixtures and synthetic call data. No calls or provider operations were performed.
