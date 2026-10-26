# Phase 2 — Capability mapping and target architecture

Date: 2026-10-25  
Inputs: repository source audit in [phase1-audit.md](phase1-audit.md), current official Vapi documentation.  
Status: source-backed architecture decision; persisted production template mappings remain pending database access.

## Decisions

1. VOICEDNUT remains the system of record for script identity, versions, lifecycle/review, business rules, call outcomes, and internal audit/usage records.
2. Existing Twilio, Plivo, Vonage, and AWS execution paths remain available. Vapi is an additive provider; it does not replace the existing provider switchboard.
3. The existing call-script catalog remains the only persisted voice-template catalog. Built-in profile packs remain deployable policy/style assets. A Vapi assistant is a provider resource mapped from a VOICEDNUT script version, not a replacement template record.
4. Provider choice must be explicit at call/template deployment time and stored alongside provider call/resource identifiers. The current global provider setting remains the default for existing callers until per-template rollout is deliberately introduced.
5. Templates with OTP/digit capture, payment writes, approval gates, or runtime policy tools require a VOICEDNUT server-side adapter. They cannot be treated as prompt-only assistant configurations.
6. No script is migrated, published remotely, or switched to Vapi as part of this phase.

## Capability matrix

| VOICEDNUT capability | Existing implementation | Vapi counterpart verified in current docs | Strategy | Risk / constraint |
|---|---|---|---|---|
| Call scripts and built-in prompt assets | SQLite `call_templates`, profile packs, bot starter presets | Reusable assistant config supports prompts, first message, model, voice, transcriber, tools, and call behavior ([Create Assistant](https://docs.vapi.ai/api-reference/assistants/create)) | Preserve local records; add version-pinned export/adapter later | Vapi assistant version and local script version are separate; must pin/match explicitly |
| Call provider selection | In-process provider state for Twilio/Plivo/Vonage, provider flow policy and preflight; AWS paths also exist | Calls can reference saved assistant/squad or transient configuration ([Create Call](https://docs.vapi.ai/api-reference/calls/create)) | Extend provider switchboard with `vapi`; do not translate current global switch to an implicit migration | Provider switch today is global/runtime-oriented, not a template execution-provider mapping |
| Model, voice, STT | Deepgram Voice Agent / Deepgram STT-TTS and OpenRouter/OpenAI paths | Separate model, voice, transcriber config; provider integrations/BYOK are documented ([Core Models](https://docs.vapi.ai/quickstart), [Provider Keys](https://docs.vapi.ai/customization/provider-keys)) | Normalize only what can be expressed losslessly; preserve existing path on incompatibility | Vapi has supported provider/model combinations and provider-specific fields; configs are not assumed equivalent |
| Tools and connectors | `DynamicFunctionEngine`, connector registry/packs, policy gates, approval, idempotency and audits | Built-in, API Request, function/webhook, handoff, query, MCP, and client-side tools ([Tools](https://docs.vapi.ai/tools)) | Expose existing tool executions through authenticated VOICEDNUT function webhooks; keep authorization and business effects server-side | Caller/model arguments are untrusted; sensitive actions need existing validation/approval checks |
| Transfer/escalation | Runtime transfer and routing functions, provider-specific behavior | Transfer and handoff tools; handoffs can target assistants/squads and control context/variables ([Handoff](https://docs.vapi.ai/squads/handoff), [Context and variables](https://docs.vapi.ai/squads/handoff/context-and-variables)) | Map only after recording destination semantics; preserve current provider transfer for unsupported destinations | Physical number/SIP transfer and assistant handoff are distinct behaviors |
| Structured outcomes | `call_outcomes`, post-call QA, transcript and call state records | Call artifact/server events, call analysis/structured extraction options; server events include end-of-call reports ([Server events](https://docs.vapi.ai/server-url/events)) | Normalize incoming reports into existing local outcome/event persistence | No local Vapi webhook exists; need authentication, dedupe, payload validation, PII-aware logs |
| Inbound call routing | Twilio/Vonage/Plivo/AWS ingress, default script, call runtime | Phone-number assignment, server URL assistant selection, call hooks ([Phone number hooks](https://docs.vapi.ai/phone-numbers/phone-number-hooks)) | Keep existing number and ingress configuration unless an explicit Vapi route is assigned | Dynamic assistant-request response has a documented 7.5 second end-to-end requirement; routing may need cached mapping |
| Outbound calls | Existing outbound call APIs/jobs and idempotency | Create-call API supports saved assistant/squad/transient config ([Create Call](https://docs.vapi.ai/api-reference/calls/create)) | Add a Vapi call adapter after idempotency and local call record creation are designed | Avoid duplicate call creation during retry/fallback; provider operation IDs must be correlated locally |
| Phone numbers | Provider-owned number configuration, caller ID and callbacks | Vapi phone-number resources and Twilio number import documented ([Import number from Twilio](https://docs.vapi.ai/phone-numbers/import-twilio)) | Bridge existing numbers where supported; preserve carrier ownership and SMS path | Importing a number does not imply all existing SMS/webhook/DTMF behaviors are preserved |
| Campaigns | No dedicated voice campaign table found; script selection and call jobs exist | Outbound campaigns can use assistants, squads, or workflows and up to 10,000 contacts; campaigns lock config on creation and run once ([Campaigns overview](https://docs.vapi.ai/outbound-campaigns/overview)) | Keep VOICEDNUT campaign/contact orchestration authoritative if added; create Vapi campaign adapter only when lifecycle differences are handled | Vapi campaign cannot be edited after creation; controlled version changes require duplicate/relaunch semantics |
| Multi-agent | No saved agent/squad model found; runtime transfer/tool routing exists | Squads and handoff tools support specialized assistants, context and variable flow ([Squads](https://docs.vapi.ai/squads)) | Future optional capability; do not infer existing transfer as squad compatibility | Requires new VOICEDNUT data model/UX, version pinning and cross-agent tool authorization |
| Knowledge | Profile prompt files and research tools; no general KB asset/model found | Vapi knowledge base files/query tools and custom query server ([Knowledge bases](https://docs.vapi.ai/knowledge-base), [Query tool](https://docs.vapi.ai/knowledge-base/using-query-tool)) | Keep existing prompt packs/research tools; map managed documents only when ownership and access rules exist | No evidence of a persisted VOICEDNUT knowledge corpus to synchronize |
| Versioning/publishing | Local draft/review/approved/live lifecycle, JSON snapshots, diff, rollback | Vapi assistants/tools have drafts, immutable published versions and restore; outbound/web calls can select a version, inbound uses current published version ([Versioning](https://docs.vapi.ai/assistants/versioning)) | VOICEDNUT remains lifecycle authority; record exact Vapi assistant version for each deployed local version | Inbound Vapi version cannot be freely selected per call; publishing/restore must not silently change local production mapping |
| Analytics and observability | Local call/transcript/state/metrics, QA, provider health and audit logs | Vapi call logs, webhook delivery logs, call artifacts and call cost where available ([Call logs](https://docs.vapi.ai/observability/logs/call-logs), [Webhook logs](https://docs.vapi.ai/observability/logs/webhook-logs)) | Ingest provider events into local records; use provider IDs for correlation | Need dedupe, retention, error handling and normalized provider-neutral fields |
| Authentication and secrets | Server-side environment config, internal HMAC, Mini App session, provider callback validation | Server-side Bearer private API key; tool/server webhooks and credentials documented ([Create Assistant](https://docs.vapi.ai/api-reference/assistants/create)) | Add private key only in API service; webhook endpoint auth/signature scheme must be verified against current Vapi contract at implementation | No credential or callback auth should enter Mini App/bot clients |
| Feature rollout | Existing runtime controls, preflight and canary controls | Vapi API resources are independently created/published; no evidence in source of Vapi-specific organization flag | Add environment and per-template allowlist before external resource creation | Must be fail-closed and reversible; no live traffic change by default |

## Subsystem disposition

| Subsystem | Disposition | Rationale / boundary |
|---|---|---|
| Call-template store and script API | PRESERVE + EXTEND | Already owns local lifecycle and template version snapshots; Vapi IDs/revision metadata can be additive after deployed schema compatibility is checked. |
| Profile pack contract | PRESERVE | Runtime policy, tone and context generation extend beyond static assistant prompt fields. |
| Twilio, Plivo, Vonage, AWS call paths | PRESERVE | Existing behavior includes different DTMF, webhook, stream and payment/callback capability. Keep fast rollback. |
| Existing model/voice paths | PRESERVE + ADAPTER | Vapi supports provider selections, but the exact configured voice/model behavior needs per-script verification. |
| Connector/tool registry | ADAPTER | Preserve policy enforcement and tool execution in VOICEDNUT; expose a bounded authenticated Vapi function endpoint. |
| Call outcomes, billing and analytics | BRIDGE | Provider events must normalize into local call/outcome/usage records; do not create a second source of truth. |
| Vapi assistant/resource state | OPTIONAL PROVIDER STATE | Keep only mapping, revision/checksum, sync and error details locally; provider is authoritative only for its execution copy. |
| Agent, workforce, campaign, phone-number product entities | MIGRATE LATER | These are not established local domain models in the source schema. Avoid inventing a second template system or prematurely expanding product scope. |
| Existing provider replacement | REPLACE ONLY IF ABSOLUTELY NECESSARY | No source evidence justifies replacing current paths. |

## Template compatibility and mapping strategy

Profile packs are reusable runtime assets, not persisted call-template rows. They inform compatibility when a `call_templates.default_profile` points to one of them. The default profile pack contract and each named pack have to be preserved along with the selected database script.

| Template/profile class | Existing VOICEDNUT behavior to preserve | Vapi mapping | VOICEDNUT-owned behavior / custom tools | Unsupported or uncertain details | Initial execution strategy | Fallback / rollback |
|---|---|---|---|---|---|---|
| `general` default | Default inbound prompt, voice-output guard, turn-taking directives | System prompt, first message, model/voice/transcriber and call behavior where supported | Local call state, outcome, call authorization and provider telemetry | Verify exact interrupt, silence, recording and timeout semantics per runtime config | Compatible with adapter; shadow/test before selection | Existing active provider; restore prior local script/provider mapping |
| `dating` | Profile prompt/style, relationship stage/vibe/goals context and safety policies | Prompt + first message + function tools | Context update/read tools and profile policy enforcement | Structured dynamic context cannot simply be flattened if it changes during a call | Compatible with adapter; hybrid where live context tools are required | Keep current provider; rollback assistant version and local mapping |
| `celebrity`, `fan` | Transparent identity, engagement stages/goals, anti-impersonation and other profile policies | Prompt + first message + relevant tools | Disclosure/identity and opt-out policy enforcement | Must retain VOICEDNUT representation and policy checks | Compatible with adapter | Existing path; no template/provider state deletion |
| `creator`, `friendship`, `networking`, `community` | Profile-specific stage, tone, goals, safe fallback and context | Prompt + first message; optional webhook tools | Context tools, CRM/scheduling/email/transfer policy when used | Per-script tool assignment and any business integrations unknown without DB row | Compatible with adapter; hybrid if tools are stateful | Existing provider; restore pinned mapping |
| `marketplace_seller`, `real_estate_agent` | Domain prompt, low-pressure qualification and business next-step | Prompt + first message + approved connector tools | CRM/order/calendar/contact writes continue through VOICEDNUT connectors | Vapi integrations are not a substitute for local approval/audit behavior | Compatible with adapter, likely hybrid when connectors enabled | Existing provider and associated tool policies |
| `tax_support`, `tax_resolution`, `bank_servicing`, `fraud_review` | Sensitive-domain prompt boundaries, minimal fact collection and escalation policy | Prompt + first message + narrow function tools | Data minimization, authorization, case routing and audit remain local | No compliance mapping is inferred from vendor fields; no direct migration without requirements review | Adapter/hybrid; manual per-template approval | Existing provider; prior version and path remain selectable |
| `collections_servicing` | Respectful collections flow, payment state and payment approval policy | Prompt + first message + payment status/payment-link tools only when policy allows | Payment switchboard, explicit confirmations, amount limits, provider sessions and audit | No direct card data; Vapi call orchestration must not bypass connector policy | Hybrid execution | Existing payment/provider route; block/rollback if approval or reconciliation diverges |
| `identity_verification_plus` and OTP/digit templates | DTMF/spoken capture, digit masking, retry/timeout behavior, keypad provider compatibility guard | Assistant prompt plus a dedicated tool or compatible keypad plan if semantics match | Digit state machine, masking, verification and provider fallback stay local | Exact keypad plan, DTMF support, timeout and redaction compatibility require live contract validation | Existing-provider-only initially; hybrid only after focused verification | Existing provider remains primary; disable Vapi route per template on any capture mismatch |
| Any persisted `call_templates` row with payment, OTP, digits, transfer, or connector settings | All row fields, profile behavior and lifecycle/version state | Only losslessly mapped assistant fields; custom tools for local effects | Local approvals, tools, webhooks, outcome and ledger | Row-specific feature set and actual production use unknown without DB | No classification until row export; do not migrate | Keep current provider; rollback with saved local snapshot |
| Any simple persisted call template | Prompt, first message, voice model, objectives, lifecycle and local outcomes | Assistant configuration with an explicit local-version-to-Vapi-version mapping | Call attribution and lifecycle remain local | Exact provider/model/voice availability and call behavior must be validated | Candidate for compatible adapter after row audit | Existing provider remains default; restore mapping/version |

The 15 named profiles are represented by these classes: `dating`; `celebrity`/`fan`; `creator`/`friendship`/`networking`/`community`; `marketplace_seller`/`real_estate_agent`; `tax_support`/`tax_resolution`/`bank_servicing`/`fraud_review`; `collections_servicing`; and `identity_verification_plus`. Each corresponding profile pack has its own primary instructions and companion style file. Their exact production call-template rows are not available in this checkout.

### Fields and source of truth

| Data | Source of truth | Provider mapping rule |
|---|---|---|
| Script identity, owner/business scope, lifecycle, local version, review and publish state | VOICEDNUT | Never import remote changes over these values |
| Prompt, first message, objectives, default profile, local variables and business policies | VOICEDNUT | Compile from a specific local version; persist a config fingerprint and mapping result |
| Vapi assistant ID and published version | Vapi execution resource, referenced by local mapping | Store provider ID/version against local script ID/version; never treat remote copy as canonical |
| Provider call ID, call state, reports and provider cost | Provider events plus local normalized call record | Webhook-validate, dedupe, normalize and correlate to local call/script/version/provider |
| Tools, payment permissions, verification, and sensitive action approvals | VOICEDNUT connector registry/policy | Provider receives only minimal tool schemas and server endpoint references |
| Credentials and webhook secrets | Server-side secret configuration | Never in frontend, template export, logs or provider metadata |

## Proposed integration boundaries

These boundaries are target design, not code added in this phase:

```text
Existing Call Script API / call orchestration
              |
      Template execution resolver
      - local script ID + version
      - explicit provider selection
      - compatibility gate
      - fallback eligibility
         /                \
Existing execution       Vapi provider adapter
Twilio/Plivo/Vonage/AWS   - assistant sync/publish
                          - call create/control
                          - number bridge
                          - webhook normalization
                          - capability report
              |
      VOICEDNUT persistence
      calls, outcomes, versions, connector audits, usage
```

The resolver should accept an immutable script snapshot, not fetch mutable current state after call creation. Provider adapters should return normalized IDs/status/errors while retaining provider-specific metadata separately. Provider capabilities should be discoverable; unsupported operations should fail explicitly or continue on the already-selected local execution path.

## Phase sequence and gates

| Phase | Deliverable | Gate before following phase |
|---|---|---|
| 1 — Audit | Source inventory and identified runtime data gaps | Obtain production-safe template record export before per-row migration decisions |
| 2 — Mapping (this document) | Capability matrix, subsystem disposition, template behavior classes, architecture boundaries | Confirm schema assumptions against deployed DB and enumerate every persisted call template |
| 3 — Provider/template abstractions | Small compatible provider interface around existing call creation/status operations; normalized capability/error contract; no provider switch behavior change | Existing provider paths remain behaviorally identical; automated verification and route/manual checks |
| 4 — Vapi foundation | Server-only Vapi client, configuration, credential-safe errors, timeouts and webhook endpoint/auth, feature flags off by default | Safe read/create in test environment, validated current API contracts, no production dispatch |
| 5 — Existing template integration | Per-row compatibility records, template snapshot compiler, sync/publish and rollback mapping | Representative non-production template tests, especially payment/digit/transfer/tool cases |
| Later | Agent/workforce, numbers, campaigns, usage/analytics, tests and docs | Ship only as independently reviewed capabilities with opt-in rollout and rollback |

Phase 3 should not add organization, campaign, agent or migration tables until the deployment schema and product ownership requirements are confirmed. The present checkout’s SQLite schema does not show those entities.

## Verification gaps and required next evidence

- Database export needed for real template rows, version history, default inbound script, lifecycle counts, and references from calls/outcomes.
- Deployment/config inventory needed to distinguish configured providers from code-supported providers and to identify current production routing. Secret values are not needed.
- Current Vapi contract at implementation time must be rechecked for webhook authentication, retry behavior, call create idempotency, assistant version selection, phone-number operations, and any create/update SDK/API calls used. The docs pages below support only the claims in this mapping.
- Every template should receive a per-row disposition after records are available; profile-level classes here are not substitutes for that required row-level matrix.

## Official Vapi references checked

- [Create Assistant API](https://docs.vapi.ai/api-reference/assistants/create)
- [Create Call API](https://docs.vapi.ai/api-reference/calls/create)
- [Tools](https://docs.vapi.ai/tools)
- [Server events](https://docs.vapi.ai/server-url/events)
- [Assistant versioning](https://docs.vapi.ai/assistants/versioning)
- [Phone number hooks](https://docs.vapi.ai/phone-numbers/phone-number-hooks)
- [Import number from Twilio](https://docs.vapi.ai/phone-numbers/import-twilio)
- [Squads](https://docs.vapi.ai/squads)
- [Handoff context and variables](https://docs.vapi.ai/squads/handoff/context-and-variables)
- [Knowledge bases](https://docs.vapi.ai/knowledge-base)
- [Campaigns overview](https://docs.vapi.ai/outbound-campaigns/overview)
- [Call logs](https://docs.vapi.ai/observability/logs/call-logs)
- [Webhook logs](https://docs.vapi.ai/observability/logs/webhook-logs)
- [Model providers](https://docs.vapi.ai/providers/model/overview)

All Vapi claims in this document are based on these current official documentation pages accessed on the audit date. No undocumented endpoint or schema is assumed.
