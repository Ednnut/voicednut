VOICEDNUT — Cartesia Advanced Integration Foundation & Unified Voice Orchestration Engine

ROLE

Act as a principal software architect, senior TypeScript/backend engineer, senior frontend engineer, AI voice infrastructure engineer, and enterprise platform engineer.

Your mission is to evolve the existing VOICEDNUT codebase into a production-grade AI Voice Operations Platform by integrating Cartesia’s advanced voice and telephony capabilities into the existing architecture.

Think and work like a senior engineer responsible for a mission-critical, multi-provider AI calling platform.

1. PRIMARY OBJECTIVE

Design and implement a first-class Cartesia integration and unified voice orchestration foundation.

Integrate the relevant Cartesia capabilities:

* Cartesia Managed Phone Agents.
* Inbound and outbound phone calling.
* Cartesia Sonic text-to-speech.
* Cartesia Ink speech-to-text.
* Cartesia Line SDK and agent runtime.
* SIP trunking and carrier interoperability.
* Phone-number management and agent assignment.
* Real-time audio streaming and interruption handling.
* Agent tools and multi-agent handoffs.
* Batch calling and campaign capabilities.
* Webhooks, call events and observability.
* Voice testing and agent evaluation.

Build these capabilities as an additional provider and infrastructure layer within VOICEDNUT.

Do not treat Cartesia as a replacement for existing providers.

2. NON-NEGOTIABLE PRESERVATION REQUIREMENTS

Preserve all existing:

* Project structure and architectural conventions.
* Frameworks, languages and package-management conventions.
* Backend and frontend functionality.
* API endpoints and existing integrations.
* Database architecture and existing migrations.
* Authentication and authorization systems.
* User interfaces and navigation.
* Environment configuration conventions.
* Existing development workflows and scripts.

Existing integrations that must remain operational:

1. Twilio.
2. Plivo.
3. Vonage.
4. CALL-E.

Do not rewrite, remove, rename, replace, or unnecessarily refactor existing integrations.

Do not introduce a competing architecture when the repository already contains an appropriate abstraction.

Inspect before deciding where code belongs.

3. FIRST TASK — READ-ONLY REPOSITORY AUDIT

Before changing anything, inspect the entire repository.

Identify:

* Frameworks and programming languages.
* Frontend and backend architecture.
* Existing provider adapters and interfaces.
* Current telephony and voice-agent workflows.
* Existing AI model and speech integrations.
* Database schema and persistence conventions.
* Authentication, authorization and secret management.
* Existing webhook architecture.
* Call lifecycle and event handling.
* Background jobs and queues.
* Existing dashboards and components.
* Existing tests and CI/CD workflows.
* Dependencies and package versions.
* Existing documentation and developer tooling.

Inspect the current implementations of Twilio, Plivo, Vonage and CALL-E.

Determine how Cartesia should integrate without introducing duplicate abstractions or breaking existing functionality.

Audit deliverables

Produce:

1. Repository architecture report.
2. Existing provider integration comparison.
3. Cartesia capability-to-codebase mapping.
4. Recommended integration architecture.
5. Required files and modules.
6. Database changes, if any.
7. Dependency and compatibility assessment.
8. Security and operational risk assessment.
9. Testing strategy.
10. Phased implementation roadmap.

STOP after the audit. Do not modify files or install packages until I approve the proposed implementation.

4. OFFICIAL CARTESIA DOCUMENTATION

Use current official Cartesia documentation and verify every API contract before implementation.

Reference:

* Documentation: https://docs.cartesia.ai/
* API overview: https://docs.cartesia.ai/get-started/overview
* AI Phone Agent: https://www.cartesia.ai/product/ai-phone-agent
* Line SDK: https://github.com/cartesia-ai/line
* SIP trunking: https://www.cartesia.ai/learn/sip-trunking
* Cartesia MCP: https://github.com/cartesia-ai/cartesia-mcp

Verify:

* Current API version.
* Authentication requirements.
* Official SDK availability and compatibility.
* Actual endpoint paths and HTTP methods.
* Request and response schemas.
* Webhook event formats.
* Streaming protocols.
* Supported audio codecs and sample rates.
* Phone-number and SIP requirements.
* Rate limits and concurrency restrictions.
* Regional and country availability.
* Pricing and usage implications.

Never invent endpoints, SDK methods, configuration properties, or unsupported capabilities.

Use official documentation as the source of truth.

5. TARGET ARCHITECTURE

Build around a unified orchestration architecture:

VOICEDNUT Platform
    |
    v
Unified Voice Orchestration Engine
    |
    +-- Telephony Provider Layer
    |     +-- Cartesia
    |     +-- Twilio
    |     +-- Plivo
    |     +-- Vonage
    |     +-- CALL-E
    |
    +-- Speech Provider Layer
    |     +-- Cartesia Sonic
    |     +-- Cartesia Ink
    |     +-- Existing compatible providers
    |
    +-- Agent Runtime Layer
    |     +-- VOICEDNUT Runtime
    |     +-- Cartesia Managed Agents
    |     +-- Cartesia Line
    |     +-- Existing compatible runtimes
    |
    +-- Shared Platform Services
          +-- Agent Management
          +-- Call Management
          +-- Tool Execution
          +-- Webhooks
          +-- Workflows
          +-- Analytics
          +-- Security
          +-- Billing and Usage

Use capability-aware adapters rather than assuming every provider supports every operation.

Keep telephony, speech, LLM, agent runtime and orchestration responsibilities separate.

6. CARTESIA PROVIDER ADAPTER

Implement a dedicated Cartesia provider adapter following existing VOICEDNUT conventions.

Required capabilities:

* Provider registration.
* Server-side API authentication.
* Configuration validation.
* Health and connectivity checks.
* Inbound call support.
* Outbound call support.
* Call lifecycle management.
* Phone-number operations where supported.
* Agent assignment.
* Webhook processing.
* Error normalization.
* Usage reporting where available.
* Provider-specific logging and observability.

Expose consistent internal interfaces while preserving provider-specific capabilities.

Use explicit capability declarations, such as:

* inbound_calling
* outbound_calling
* speech_to_text
* text_to_speech
* streaming_audio
* managed_agents
* agent_runtime
* sip_trunking
* batch_calling
* call_transfer
* voicemail_detection
* number_management

Do not advertise capabilities until verified and implemented.

7. INBOUND AND OUTBOUND CALLING

Implement Cartesia inbound and outbound calling as independent, testable capabilities.

Inbound

* Receive and validate incoming call events.
* Associate numbers with the correct agent.
* Load agent configuration and instructions.
* Initialize the appropriate runtime.
* Track call state and lifecycle.
* Handle disconnects, errors and timeouts.
* Persist relevant call metadata.

Outbound

* Initiate approved calls.
* Validate destination numbers.
* Associate calls with agents and workflows.
* Support caller ID configuration where permitted.
* Track initiation and completion.
* Handle busy, failed, unanswered and completed calls.
* Support cancellation where the API permits it.
* Persist call outcomes.

Support both Cartesia Managed Agents and compatible external telephony integrations.

Never assume that an arbitrary existing carrier stream can be connected directly to Cartesia without validating the media and signaling contract.

8. CARTESIA SONIC AND INK

Create a dedicated speech integration layer.

Sonic TTS

Implement:

* Text-to-speech generation.
* Streaming speech output where supported.
* Voice selection.
* Language and model configuration.
* Pronunciation handling.
* Audio format configuration.
* Streaming lifecycle management.
* Error handling and usage tracking.

Ink STT

Implement:

* Speech transcription.
* Streaming transcription where supported.
* Language configuration.
* Audio input validation.
* Transcript normalization.
* Confidence metadata where available.
* Error handling and usage tracking.

Support a provider-independent speech interface so compatible existing speech providers can coexist.

9. CARTESIA LINE AND AGENT RUNTIME

Evaluate Cartesia Line as an additional agent runtime.

Implement only capabilities verified against the current SDK.

Evaluate:

* Real-time conversations.
* Interruption handling.
* Turn-taking.
* Tool calling.
* Multi-agent handoffs.
* DTMF.
* Call transfers.
* Voicemail handling.
* Knowledge-base tools.
* External HTTP tools.
* LLM provider interoperability.

Allow users to select the runtime appropriate for their agent.

Do not force existing VOICEDNUT agents to migrate to Cartesia Line.

10. SIP AND TELEPHONY INTEROPERABILITY

Implement a configurable SIP integration layer where appropriate.

Evaluate:

* SIP trunk registration.
* Bring-your-own-carrier configuration.
* Inbound SIP routing.
* Outbound SIP routing.
* Secure authentication.
* IP allowlisting.
* TLS and SRTP.
* Media encryption policies.
* Number association.
* SIP REFER and call transfer behavior.

Validate carrier-specific limitations.

Never expose SIP passwords or credentials to the frontend.

11. UNIFIED AGENT MANAGEMENT

Enhance the existing agent management experience with Cartesia-compatible settings.

Include:

* Agent name and description.
* System instructions.
* Runtime selection.
* Telephony provider.
* Speech provider.
* Voice and model selection.
* Language settings.
* Conversation objectives.
* Tool configuration.
* Knowledge-base configuration.
* Transfer and escalation rules.
* Testing and deployment status.

Make incompatible configurations impossible to activate.

12. UNIFIED CALL OPERATIONS

Integrate Cartesia into the existing call management experience.

Provide:

* Live call status.
* Call history.
* Provider identification.
* Agent identification.
* Call duration.
* Call outcomes.
* Error details.
* Transcripts where supported.
* Recordings where supported and authorized.
* Call metadata.
* Usage information.
* Search and filtering.

Do not create duplicate dashboards if suitable existing screens can be extended.

13. WEBHOOK AND EVENT ARCHITECTURE

Implement reliable event processing.

Requirements:

* Webhook signature verification.
* Event validation.
* Idempotency.
* Duplicate event protection.
* Retry handling.
* Failure logging.
* Event persistence.
* Delivery monitoring.
* Event-to-call association.
* Safe asynchronous processing.

Support only documented Cartesia event types.

Prevent webhook replay and unauthorized event injection.

14. CAMPAIGNS AND BATCH CALLING

After core calling is stable, extend the existing campaign system or create one following existing architecture.

Potential features:

* Single-call execution.
* Batch campaigns.
* CSV imports.
* Contact validation.
* Scheduling.
* Retry rules.
* Concurrency limits.
* Time-zone restrictions.
* Quiet hours.
* Campaign pause and cancellation.
* Results and analytics.

Validate Cartesia’s actual batch calling limits and current availability.

Implement consent, applicable calling regulations, do-not-call checks, suppression lists and human approval requirements.

Do not initiate live campaigns during development or testing.

15. SECURITY AND ENTERPRISE CONTROLS

Implement:

* Server-side secret storage.
* Strict API-key access controls.
* Encrypted sensitive configuration.
* Role-based permissions.
* Audit logging.
* Rate limiting.
* Request validation.
* Webhook authentication.
* Data retention controls.
* Consent management.
* Call authorization.
* Spend and usage limits.
* Kill switch for calling operations.

Never log API keys, passwords, access tokens or sensitive call credentials.

Never expose provider secrets through frontend responses or browser bundles.

16. TESTING AND QUALITY ASSURANCE

Create a comprehensive automated testing strategy.

Include:

* Unit tests.
* Provider adapter tests.
* API contract tests.
* Integration tests using mocked Cartesia responses.
* Webhook verification tests.
* Call lifecycle tests.
* Speech integration tests.
* Runtime compatibility tests.
* Authorization tests.
* Failure and retry tests.
* Regression tests for Twilio, Plivo, Vonage and CALL-E.

Use mock mode by default.

No test should initiate an actual phone call, purchase a number, consume paid resources or modify production data.

Verify existing functionality before and after each approved implementation phase.

17. DOCUMENTATION

Document:

* Architecture and provider boundaries.
* Cartesia configuration.
* Environment variables.
* API operations.
* Supported capabilities.
* Agent configuration.
* Inbound and outbound workflows.
* Speech integration.
* SIP setup.
* Webhook events.
* Testing procedures.
* Troubleshooting.
* Security requirements.
* Deployment requirements.

Update existing documentation locations instead of creating unnecessary new documentation structures.

18. IMPLEMENTATION PHASES

Follow this order:

Phase	Scope
0	Repository audit and official documentation verification
1	Cartesia provider adapter and unified capability interfaces
2	Inbound and outbound calling
3	Sonic TTS and Ink STT
4	Cartesia Line runtime integration
5	SIP and carrier interoperability
6	Agent management and configuration UI
7	Webhooks and event processing
8	Unified call operations dashboard
9	Batch calling and campaign integration
10	Tool execution and multi-agent orchestration
11	Security, analytics, usage and enterprise controls
12	Complete regression testing and documentation

Each phase requires:

1. Scope confirmation.
2. Repository impact analysis.
3. Implementation plan.
4. Explicit approval.
5. Implementation.
6. Tests.
7. Regression verification.
8. Change summary.
9. Next-phase proposal.

Do not silently advance to another phase.

19. STRICT EXECUTION RULES

* Do not make changes during the initial audit.
* Do not install dependencies without approval.
* Do not modify package manifests without approval.
* Do not create database migrations without approval.
* Do not change production configuration.
* Do not deploy.
* Do not provision or release phone numbers.
* Do not initiate actual phone calls.
* Do not create paid resources.
* Do not delete existing code or files.
* Do not replace existing providers.
* Do not introduce unnecessary root folders.
* Do not fabricate test results.
* Do not claim an integration works without verification.

When implementation is approved, make minimal, focused and reversible changes.

If an existing architectural constraint prevents a feature, explain the issue and propose alternatives before proceeding.

20. DEFINITION OF DONE

The Cartesia foundation is complete when:

* Cartesia is registered as an independent provider.
* Existing providers remain intact.
* Supported inbound and outbound workflows work in mocked integration tests.
* Sonic and Ink integrations follow verified API contracts.
* Cartesia Line is integrated only where compatible.
* SIP integration follows verified security requirements.
* Unified agent and call interfaces work.
* Webhooks are authenticated and idempotent.
* Capability-aware provider selection works.
* Secrets remain server-side.
* Automated tests pass.
* Documentation is updated.
* Existing application functionality passes regression tests.

IMMEDIATE EXECUTION INSTRUCTION

START WITH PHASE 0 ONLY.

Perform a comprehensive read-only audit of the actual VOICEDNUT repository.

If repository access is unavailable, ask me to provide the repository or connect the appropriate GitHub access. Do not pretend to have inspected files you cannot access.

Return the complete audit report, recommended architecture, exact proposed file locations, risks, dependencies and phased implementation plan.

STOP AND WAIT FOR MY EXPLICIT APPROVAL BEFORE MAKING ANY CODE CHANGES.
