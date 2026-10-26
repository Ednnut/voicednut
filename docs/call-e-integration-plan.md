# CALL-E Integration Plan for VOICEDNUT

**Status:** Phase A contract audit complete. Phase B source audit and compatibility mapping are recorded, and a sanitized read-only audit exporter is implemented; exact persisted-template classification awaits an approved sanitized deployment database export. Phase C no-call compiler is implemented. Phase D client/service scaffolding, mocked lifecycle coverage, and the gated one-call dispatch path are implemented. Phase E has authenticated preview, exact operator confirmation, and an explicitly gated Mini App dispatch action. Phase F has bounded event reconciliation, additive SQLite persistence, an admin-only route, and Mini App reconciliation scoped to current business operator membership. Phase G pilot runbook and readiness gates are documented; the live pilot is **NO-GO** pending the listed approvals and missing prerequisites. No CALL-E credentials, provider resources, production database operations, or live calls were used or created.
**Scope:** Add CALL-E as an optional phone-task execution integration while retaining VOICEDNUT as the product, template, policy, and operational system of record.
**Relationship to the existing roadmap:** This plan extends the provider and template architecture in [Phase 2](phase2-architecture-matrix.md), the initial abstraction in [Phase 3](phase3-provider-template-abstractions.md), and the Vapi-focused work through [Phase 20](phase20-vapi-call-campaign-drafts.md). It does not replace or reorder existing Vapi work.

## 1. Product and architecture decision

VOICEDNUT owns the customer experience and business workflow. CALL-E is an optional external phone-task execution provider, alongside the existing telephony providers and Vapi. CALL-E must not become a second VOICEDNUT template catalog or the authority for VOICEDNUT permissions, approvals, business state, billing, or audit history.

```text
Mini App / Bot / Internal API client
                 |
         VOICEDNUT API + auth
                 |
     Call workflow and policy gate
       - template ID + immutable version
       - consent / eligibility / approval
       - provider capability check
       - idempotency reservation
                 |
        Provider dispatch boundary
          /                    \
 Existing providers + Vapi     CALL-E adapter
          \                    /
          VOICEDNUT call record,
          normalized outcomes,
          audit and usage records
```

CALL-E’s integration repository documents agent plugins, MCP, CLI, SDKs, and a direct API. For VOICEDNUT’s customer-facing runtime, prefer a **server-side API/SDK adapter** so existing authentication, authorization, template versioning, call correlation, and operational controls stay in the application. MCP and agent plugins are useful for development or explicitly supervised internal operations; they are not a bypass around VOICEDNUT’s product API.

Official references: [CALL-E integrations](https://github.com/CALLE-AI/call-e-integrations), [CALL-E Developer Docs](https://docs.heycall-e.com/), [official example apps and contribution catalog](https://github.com/CALLE-AI/awesome-phone-call-agents).

## 2. Goals and non-goals

### Goals

- Add explicit, reversible CALL-E execution for templates proven compatible with a documented CALL-E interface.
- Keep `call_templates` and `call_template_versions` as the only persisted VOICEDNUT voice-template catalog.
- Preserve current provider selection, Vapi behavior, existing provider-specific call features, and current API contracts.
- Normalize CALL-E execution and result state into existing VOICEDNUT call/outcome records without conflating provider status with business success.
- Use sample-app safety patterns: no-call simulation by default; visible call preview and consent/authorization; durable idempotency; masked PII; bounded calls; transcript-grounded evidence; human review for consequential actions; explicit cancellation/reconciliation.
- Build a narrow first slice that proves the provider boundary before adding broad campaign or workforce functionality.

### Non-goals for initial integration

- Replacing Vapi, Twilio, Plivo, Vonage, AWS, or existing runtime paths.
- Automatically migrating or synchronizing every call template.
- Treating an AI-generated result as authorization to make a payment, change customer data, book/dispatch resources, or take another consequential action.
- Importing or synchronizing CALL-E contacts, campaigns, phone numbers, or Goals until ownership, permissions, and lifecycle semantics are designed.
- Automatic fallback/redial to another provider after uncertain CALL-E acceptance or execution.
- Exposing CALL-E credentials or raw provider transcripts in the Mini App, bot, browser storage, analytics, or logs.

## 3. Fit with CALL-E interfaces

CALL-E documents two distinct workflows. They must remain distinct in code and mapping records:

| Interface | Contract described in official docs | VOICEDNUT use |
|---|---|---|
| Calls API V2 | One destination per call, immediate execution, required `task`, `phone`, flat scalar-object `result_schema`, and required `Idempotency-Key`; create returns durable acceptance (`202`), not proof of connection or success. The official reference also documents read, event-list, and cancel endpoints. | First candidate for a minimal, one-recipient template execution slice, after current contract and account eligibility are verified. |
| Reusable Goal Runs | A published Goal owns its run input/result schemas; each run supplies a phone, variables, and an idempotency key. | Potential later mapping for stable reusable workflows. Store a Goal ID as provider mapping metadata against a pinned VOICEDNUT template version; never let it replace local template identity or lifecycle. |
| MCP / CLI / plugins | Agent-facing tools and setup paths; integration repo describes current and legacy tool flows. | Internal operator/developer use only unless a future product requirement justifies an audited, tenant-scoped product flow. |

**Contract caution:** CALL-E docs and examples evolve, and the repository documents more than one interface generation. Phase A reviewed the official docs and server SDK/integration repository on 2026-10-26. Recheck the production/test hosts, authentication, request/response schemas, supported locales/regions, idempotency semantics, result readiness, cancellation, event/webhook behavior, and error/retry behavior against current official sources during implementation. Do not infer V2 features from legacy `/v1/calls`, Goals, MCP, or community app code.

## 4. Sample-app engineering guidelines adopted here

The CALL-E community repo is a catalog of independent examples, not a canonical SDK contract. The recurring patterns in its app descriptions and contribution guidance are adopted as project requirements where they fit VOICEDNUT:

1. **Safe by default:** local preview, fixture, or fake-provider mode works without a CALL-E API key and cannot dial. Live execution is separately configured and explicitly initiated.
2. **Visible side effects:** show the intended objective, destination in masked form, provider, template/version, and actions that may follow. Require explicit authorization before dispatch. Make it clear which live actions create phone calls and may incur charges.
3. **Exact authorization scope:** the approved request binds one template version, one destination, one task/Goal, bounded variables, and one idempotency key. Changing any bound input requires a new preview and authorization.
4. **Durable duplicate protection:** reserve local execution before provider dispatch; persist the exact request fingerprint and key; on timeout, reconcile or replay unchanged with the same key. Never blindly create a second call.
5. **Fail closed on uncertainty:** voicemail, no answer, refusal, conflicting evidence, missing result, invalid schema, provider timeout, and incomplete event delivery are distinct outcomes. Uncertainty must not be translated into success or trigger an automatic redial.
6. **Evidence-linked decisions:** separate provider-reported outcome, CALL-E structured result, transcript, and VOICEDNUT policy decision. Where an action depends on what was said, retain a minimal transcript reference/turn evidence and require deterministic validation; route unresolved cases to a human.
7. **Privacy by construction:** mask phone numbers in UI and logs, minimize task variables, avoid persisting unnecessary free text, set retention rules, and redact operational errors. Never log API keys, raw authorization headers, or full transcripts by default.
8. **No hidden workflows:** disclose scheduled/retry/recurring behavior, eligibility rules, calling windows, attempt caps, and cancellation behavior. No background campaign dispatch in the first integration slice.
9. **Human owns consequential decisions:** CALL-E may return proposed facts or outcomes. VOICEDNUT’s established connector and approval layers remain responsible for any downstream writes or commitments.
10. **Reproducible examples and tests:** fake transport and synthetic fixtures cover the full lifecycle. Tests never make live calls. Any later sample app should document setup, side effects, supported interfaces, safety limits, cancellation, and rollback.

These patterns are consistent with the official repository’s contribution guidance: describe compatibility and side effects, include setup/tests/cancellation or rollback, use fictional or masked numbers, do not conceal calls or recurring jobs, and validate contributions. See [Awesome Phone Call Agents: Contributing](https://github.com/CALLE-AI/awesome-phone-call-agents#contributing) and its [apps catalog](https://github.com/CALLE-AI/awesome-phone-call-agents#apps).

## 5. VOICEDNUT feature and template compatibility policy

CALL-E compatibility is **per local template version and interface**, never a provider-wide boolean. A structurally mappable prompt is not proof that runtime behavior is compatible.

Initial mapping dispositions:

| Template/workflow behavior | Initial CALL-E disposition | Reason / required evidence |
|---|---|---|
| Simple, one-recipient outbound task with a bounded scalar result | Candidate for `CALL-E-COMPATIBLE` after preview, provider test, and result validation | Verify all required fields map losslessly and destination/language are supported. |
| Reusable workflow represented by a published CALL-E Goal | `CALL-E-COMPATIBLE-WITH-ADAPTER` only after an explicit Goal-to-template mapping | Goal input/result schemas and publication/version behavior differ from local template lifecycle. |
| Template needing live VOICEDNUT tools, connector access, or mutable context | `HYBRID` or `EXISTING-PROVIDER-ONLY` until a narrow authenticated tool bridge is designed | The provider must not receive direct authority to bypass local authorization, approval, or idempotency. |
| DTMF, OTP, identity verification, payment, regulated/high-impact workflow, transfer, or provider-specific runtime behavior | `EXISTING-PROVIDER-ONLY` initially | Requires behavior-level security, data handling, call control, and audit validation; prompt translation is insufficient. |
| Batch, scheduled, recurring, or campaign workflow | VOICEDNUT-orchestrated only in a later gated phase | Calls API V2 is single-target/immediate. Phase 20 campaigns are draft-only and have no contact/consent dispatch foundation yet. |
| Inbound phone routing or CALL-E number ownership | Out of initial scope | Requires verified product, number, webhook, tenant, and operational lifecycle requirements. |

No existing template should be marked compatible from a profile name or README description alone. Persist compatibility evidence against the local template ID, exact version, configuration fingerprint, selected CALL-E interface, provider mapping identifier, and validation date. A template edit invalidates prior compatibility evidence.

## 6. Target implementation shape

Names below are proposed. Reuse existing project naming and route conventions during implementation rather than creating duplicate abstractions.

### API boundary

- `api/services/callERestClient.js` or equivalent: server-only HTTP/SDK wrapper, explicit base URL allowlist for production/test, bounded timeout, sanitized errors, no automatic retry of mutating requests, and methods only for verified contracts.
- `api/services/callEOutboundCallService.js`: validate mapping/version, reserve local idempotency, compile the exact CALL-E request, submit once, reconcile uncertain outcomes, persist provider IDs/status, and return normalized state.
- `api/adapters/callETemplateAdapter.js`: compile a pinned local template snapshot to a supported Calls or Goal request and return `mapped`, `missing`, `unsupported`, plus a deterministic fingerprint. Reject unknown fields and lossy mappings.
- `api/adapters/voiceProviderRegistry.js`: add CALL-E only if the registry contract is extended compatibly. Do not pretend the current `createOutboundCall`/`endCall` pair alone models asynchronous result readiness. Prefer explicit capabilities and provider-specific optional operations such as `getCall`, `cancelCall`, and `parseTerminalEvent`; unsupported capabilities must fail clearly.
- `api/services/callRoutes.js`: retain existing routes and request compatibility. Add an explicit `provider: "call-e"` dispatch only after authentication, authorization, template pinning, capability checks, and idempotency are in place. Do not route through Vapi code.
- `api/services/webhookRoutes.js`: current CALL-E webhooks are unsigned, so do not add them as trusted status inputs in the initial integration. Prefer authenticated polling and the API event-list endpoint. Reconsider a webhook receiver only if a verifiable sender-authentication mechanism is officially documented and approved. Any future receiver must validate size/schema, correlate locally, deduplicate durably, and use retry-appropriate responses.

### Persistence

Before migration, inspect the deployed SQLite schema and any user changes. A possible additive model may be needed for CALL-E mappings and call idempotency, but reuse existing provider mapping/call records if their constraints support it. Do not create a second template table.

Any mapping/execution record should be scoped to the available ownership model and contain only what is needed:

- local template ID, pinned version, and configuration fingerprint;
- provider name (`call-e`), interface kind (`calls_v2` or `goal_run`), provider resource/Goal ID, compatibility and sync/deployment state;
- local call ID, provider resource ID, idempotency key or safe digest, immutable request fingerprint, and execution/result state;
- normalized outcome timestamps and minimal error code;
- event IDs for durable deduplication, if verified event delivery is implemented.

Do not store API secrets, credentials, unnecessary phone plaintext, complete provider payloads, or full transcript copies in the mapping table. Match existing call-record retention and access rules. Provide additive migration and documented rollback; keep records unless safe removal is proven.

### Mini App

Only after the server API is stable, extend the existing call/template controls rather than creating a standalone CALL-E console:

- show CALL-E as an optional provider only for enabled and compatible template versions;
- display compatibility reason, mapped interface, and last validation state;
- preview masked destination, task summary, schema, pinned local template/version, expected side effects, and estimated provider behavior when available;
- require a separate explicit user action to place the call; never dispatch on preview or page load;
- display queued/ringing/in-progress/completed execution separately from call outcome and result readiness;
- provide a human review state for unavailable, ambiguous, or policy-sensitive outcomes;
- keep control hidden/disabled when feature flags, mapping, authorization, or provider readiness are missing.

The Mini App must never receive a CALL-E API key or use browser-side provider API calls.

## 7. Phased delivery and acceptance gates

### CALL-E Phase A — Contract and workflow audit

**Deliverable:** a concise contract note in this document or a follow-up implementation record with exact official CALL-E interface behavior; map Calls V2 vs Goal Runs vs MCP/legacy paths. Identify provider state, authentication, webhook signature, result schema, idempotency, retries, cancellation, rate/concurrency, supported regions/locales, billing effects, and test environment.

**Acceptance:** every contract claim links to an official current doc or pinned SDK/source; unknowns are explicitly listed; no credentials or live requests are used. Confirm the repo’s sample app rules and record the chosen patterns.

**Phase A result (2026-10-26): complete.** The following contract facts are verified in the official Calls API reference, Quickstart, migration guide, billing docs, and official integration/SDK repository:

- Production Calls V2 base URL is `https://api.heycall-e.com`; the Quickstart identifies `https://test-api.heycall-e.com` for tests with a test-compatible key. Authentication is bearer API-key authentication. Keys belong on the server. Account and line configuration still affect destination availability.
- `POST /v2/calls` accepts one E.164 phone and an immediate task. `task`, `phone`, and `result_schema` are required; `region` and spoken `locale` can be inferred when omitted. The closed result object supports up to 32 scalar properties (`string`, `boolean`, `integer`, `number`); nested objects, arrays, nulls, schema combinators, and selected property constraint keywords are unsupported. Application-side validation must enforce constraints not expressible in this schema profile.
- Create requires `Idempotency-Key` and returns `202` after durable acceptance. A repeated same-owner/project/key/exact-input request returns the same Call resource; changed inputs conflict. Reuse the exact original request and key after an uncertain create response. Do not change omitted inferred fields on a replay. Preparation may return a validation rejection before a Call exists.
- Call resource `id` is used for API reads/events/cancellation; telephone `call_id` is a different identifier intended for Billing lookup. `status`, `call_outcome`, and `result_status` are separate. `status=completed` is not result readiness or business success. Poll until `result_status` is terminal; `unavailable` is a terminal result state even when both result and technical error are null. An empty object can be an available result.
- `GET /v2/calls/{id}` is a persisted read and does not dial or perform extraction. `GET /v2/calls/{id}/events` returns durable paginated JSON event pages, not SSE. Events can arrive late; deduplicate by event ID; retain cursor/last event ID across empty pages. ASR/speech events can be partial or revised and are not a final transcript; do not build a transcript by concatenating them.
- `POST /v2/calls/{id}/cancel` is only useful before provider submission. It does not hang up an active phone call; after provider submission it can return `409 call_cannot_cancel`. Therefore VOICEDNUT must not present this operation as an in-call hangup control.
- The current CALL-E webhook contract is **unsigned**. Official integration docs say current webhook deliveries do not use a webhook secret, signature, or timestamp; the SDK identifies signature verification as legacy and incompatible with current unsigned deliveries. A caller-supplied event ID can support deduplication but does not authenticate the sender. **Do not add or rely on CALL-E webhooks for trusted status updates or side effects in the initial integration.** Prefer authenticated API polling and the durable event-list endpoint. Revisit only if CALL-E documents an authenticated delivery mechanism or a separately verified secure transport is agreed.
- Current Calls V2 is one target and immediate only; no batch recipient, schedule, or recurrence. Goals are a separate interface with separate IDs, input/result schemas, and lifecycle. Existing legacy calls and IDs are not automatically adopted by V2. Keep the interface kind with each local mapping/call and do not use one interface to recover IDs from another.
- Billing is a combination of carrier and model usage. Model preparation/pre-connection can be billable even when a call does not connect; carrier billing increments differ for domestic and international routes. Do not use marketing examples as a cost guarantee. A pilot needs current account-level rates, destination, line, limits, and a spending cap confirmed in the dashboard/provider agreement.
- Supported regions and spoken languages are documented but availability depends on account and line configuration; region and language mismatch can reject the request. A static region table is not sufficient authorization or readiness evidence.
- The official integration repo documents current CLI/SDK install versions and MCP/legacy flows. The community apps repo is inspiration and safety guidance only, not the normative API contract. Adopted patterns are listed in Section 4.

**Phase A unresolved items before any live pilot:** confirm the account’s test-key provisioning, account/line-level supported regions and languages, current rates and spending/concurrency limits, applicable call permissions/consent requirements, data retention/deletion behavior, whether cancellation-before-submission is exposed through the selected SDK version, and whether the provider offers any future authenticated webhook option. These require dashboard/account or current contract evidence; no credentials were accessed and no CALL-E API/SDK request was made.

**Phase A implementation decision:** use server-authenticated polling as the initial status/result path. Do not implement a CALL-E webhook receiver in the first slice. Keep Goals out of the initial API adapter until their run contract and operational semantics are independently audited and mapped. No CALL-E SDK dependency is selected yet; the next phase is a local compatibility and domain mapping, then a no-call preview.

### CALL-E Phase B — VOICEDNUT domain and compatibility mapping

**Source-only result (2026-10-26):** the repository confirms the existing `call_templates` and `call_template_versions` lifecycle, code-defined profile packs, bot starter prompts, `templateExecution` context, and a Vapi-specific mapping/audit implementation. The existing profile inventory and runtime-data limitations are recorded in [Phase 1](phase1-audit.md); CALL-E will reuse that catalog and version history rather than creating another template system.

The local `call_templates` schema includes prompt and first message, version, business ID, voice model, objective tags, default profile, expected length, digit/OTP/terminator behavior, payment fields, and review/live lifecycle fields. `call_template_versions` stores a JSON snapshot by template/version. The existing Vapi mapping pattern stores compatibility, mapping/sync state, fingerprint, provider resource ID/version, and a summarized mapping result. These are relevant patterns, but Vapi mapping code and Vapi-specific schema must not be reused as though they were CALL-E contracts.

To make the pending data review repeatable, added `api/scripts/export-call-e-template-audit.js`. It accepts only an explicitly supplied SQLite path, opens it using immutable read-only mode, reads the template and version snapshot fields needed by the local compiler, and emits a sanitized JSON audit with content hashes, dependency/feature booleans, synthetic Calls V2 compatibility findings, and aggregate per-version counts from known Vapi event/campaign and CALL-E reconciliation tables. It omits template names, business IDs, prompt/message/payment text, provider call IDs, destinations, and database paths. Hashes remain controlled audit evidence. It does not read call/job payload rows, does not establish tenant ownership, and does not classify any candidate as approved for live execution.

After an approved sanitized SQLite copy is supplied, generate the audit with `cd api && node scripts/export-call-e-template-audit.js --db /secure/path/approved-sanitized-copy.sqlite > /secure/path/call-e-template-audit.json`. Review and retain the output under the approved evidence controls; do not point the tool at a production database or publish the generated hashes.

| VOICEDNUT asset or behavior | CALL-E fit from the verified contract | Phase B disposition |
|---|---|---|
| Persisted call script prompt + first message | Could be compiled into a single task only if instructions, disclosure, boundaries, and runtime context are preserved; CALL-E task preparation can request missing facts and reject incomplete input. | Candidate mapping field, but no local row is approved without exact-version review. |
| `call_template_versions` snapshot | Necessary anchor for reproducibility and rollback. | Preserve as the canonical version; any CALL-E mapping binds template ID + version + stable fingerprint. |
| `default_profile` and the 15 profile packs | Packs carry runtime policy/routing and companion style layers; flattening them into a task can lose precedence and executable policy behavior. | Unsupported by default. Require pack-specific compiled-task review and retain local policy gates. |
| `objective_tags`, flow metadata, expected length | Can inform task compilation, but tags do not become structured results automatically. | Map only reviewed task guidance; do not infer unsupported result fields or runtime limits. |
| `voice_model` and voice settings | No lossless mapping established from the local field to CALL-E locale/voice behavior. | Unsupported until exact model/voice semantics and account support are verified. |
| Structured call outcomes | Calls V2 requires a closed, flat scalar result schema; local call outcome data is not itself proof of an equivalent schema. | Define a per-template result schema and local validator before execution. Unsupported if required output is nested, array-valued, nullable, or outside the supported profile. |
| Tools, connector actions, mutable context | CALL-E can return call results, but VOICEDNUT tools own local permissions, approvals, and business writes. No CALL-E tool bridge is verified for the first slice. | Existing-provider-only until a narrow server-mediated tool contract is designed and reviewed. |
| Payment and payment connector fields | CALL-E's result extraction does not replace VOICEDNUT payment authorization, confirmation, connector, or reconciliation paths. | Explicitly incompatible for initial integration. Never include payment credentials/card data in a task. |
| Digit capture, DTMF, OTP, terminator rules | Calls V2 documentation does not establish compatibility with VOICEDNUT's digit-capture state machine, masking, keypad provider guard, or terminator behavior. | Explicitly incompatible for initial integration; preserve existing execution path. |
| Transfer and escalation behavior | CALL-E Calls contract reviewed here does not establish VOICEDNUT-compatible transfer semantics or active-call hangup; cancel cannot end an active call. | Unsupported for initial integration; use existing provider path for templates that require it. |
| Inbound routing / number ownership | Not established as compatible with current VOICEDNUT ingress and number configuration. | Out of scope pending product/account/tenant and number lifecycle audit. |
| Campaigns and scheduled calls | Calls V2 is single-destination and immediate. VOICEDNUT Phase 20 stores Vapi campaign drafts only; campaign dispatch prerequisites remain open. | No CALL-E campaign execution. Do not create per-recipient calls until the shared contact, consent, DNC, queue, and retry foundation exists. |
| Result events/webhooks | CALL-E webhooks are unsigned; the durable authenticated API event-list endpoint is available. | Use API polling/event-list only. Do not trust webhook payloads as status or authorization evidence. |

**Template-level decision:** no persisted template is currently classified `CALL-E-COMPATIBLE`. The local database file and deployment template export are unavailable in this workspace; source profiles and starter prompts are not equivalent to deployed rows. In particular, the starter prompt for a profile is not proof that a live script lacks payment, OTP, tools, custom context, or other behavior.

**Phase B gate remains open:** before naming a first pilot template, obtain and review an approved sanitized export; enumerate all relevant referenced calls/jobs and active usage beyond the aggregate tables covered by the local exporter; inspect each exact template snapshot under approved controls; and record its disposition and rollback path. Do not access or print production credentials or raw customer data to perform this audit.

**Phase B implementation decision:** retain `call_templates` as sole local catalog; maintain provider-specific mapping records separate from template content; treat profile/policy execution, payment, OTP/digits, transfers, connectors, and campaigns as incompatible until independently proven. With the source-level constraints established, the next code phase can be a no-call compiler/preview using synthetic fixtures only; live execution remains gated on real-template review and account-specific evidence.

### CALL-E Phase C — No-call adapter preview

**Status (2026-10-26): complete for the pure compiler scope.** Added the pure adapter `api/adapters/callETemplateAdapter.js` and its focused test file `api/__tests__/callETemplateAdapter.test.js`.

The adapter builds a local Calls V2 preview from an explicitly supplied template snapshot, destination, and result schema. It does not import an HTTP client, read credentials, contact CALL-E, dispatch a call, create an audit/database record, or configure a webhook. The preview includes local template ID/version, a deterministic SHA-256 fingerprint, missing/unsupported fields, schema errors, method/path, masked phone, task preview, and result property names. The fingerprint binds the business identifier, lifecycle, task and configuration inputs, payment policy fields, destination, region/locale, and result schema, so a relevant snapshot change invalidates a future confirmation. `dispatchEnabled` is always `false`.

The compiler accepts only a closed flat object schema with up to 32 string, boolean, integer, or number fields, rejects unrecognized schema keywords and unsupported constraints, validates required fields/enums and extracted values, requires an E.164 destination and pinned local template version for compatibility, and fails closed on profile, voice-model, objective-tag, payment, digit/OTP, terminator, malformed configuration, and unknown configuration behavior. It does not assert any actual stored VOICEDNUT template is compatible.

**Verification:** `cd api && ./node_modules/.bin/mocha __tests__/callETemplateAdapter.test.js --reporter dot` — 7 passing. Tests use synthetic input and make no network requests. No live CALL-E operation occurred.

**Phase C boundary:** this is an internal pure function, not an API endpoint or user-facing feature. No runtime template rows were passed through it. The authenticated preview route and Mini App review flow belong to Phase E; lifecycle/provider-response fixtures belong to Phase D. Ensure a returned task preview is visible only to an authorized reviewer. Phase D must remain disabled for live dispatch until a sanitized row is reviewed and account/test-host preconditions are satisfied.

### CALL-E Phase D — Server client and durable call lifecycle

**Status (2026-10-26): gated dispatch route implemented; pilot remains NO-GO.** Added `api/services/callEClient.js` and `api/services/callEOutboundCallService.js`; added `CALLE_ENABLED=false`, the independent `CALLE_DISPATCH_ENABLED=false` kill switch, exact-preview approval fields, and `CALLE_PILOT_READINESS_REVIEWED=false` to `api/.env.example`.

The client only permits the documented production and test API origins, uses server-side bearer authentication, bounds request timeouts, exposes create/read/cancel/event-list methods for the documented Calls V2 paths, returns sanitized errors, and never retries automatically. CALL-E is disabled unless `CALLE_ENABLED=true` and a valid server key/base URL are configured. Product dispatch also requires `CALLE_DISPATCH_ENABLED=true`, a valid unexpired approval reference bound to one exact preview fingerprint, the authenticated operator's matching confirmation, and `CALLE_PILOT_READINESS_REVIEWED=true` after account, destination, consent, and recovery reviews. All gates are off or empty by default. The admin-only status route reports local gate states without exposing credentials or approval references.

The outbound service requires an exact live template snapshot, a CALL-E-compatible no-call preview, a matching explicitly confirmed preview fingerprint, an idempotency key, and an exact E.164 destination in `CALLE_ALLOWED_DESTINATIONS`. The fingerprint is recomputed from current inputs and mismatch blocks before idempotency reservation. The allowlist is empty by default; an empty or nonmatching list blocks submission before idempotency reservation. It reuses the existing `outbound_call_idempotency` table and methods; no new table or schema migration was added. Local and provider idempotency keys are namespaced. It stores only correlation/fingerprint and a minimal create response, not the destination, result, or transcript. After uncertain acceptance, a retry can only replay the unchanged request with the same key. A corrected body may reuse the key only after a recognized provider response explicitly establishes that no Call was created. Status reads keep execution status, phone outcome, and result readiness separate; an available structured result is validated against the pinned local schema.

The provider client includes the documented cancel operation, but no service/UI cancellation control is exposed. CALL-E says cancellation cannot hang up an active call, so this method must not be used as an active-call termination control. The client exposes event-list reads for reconciliation; unsigned webhook ingestion remains excluded.

**Verification:**

- Focused CALL-E adapter, client, outbound, reconciliation, offline rehearsal, and sanitized template-audit export tests — **35 passing**. Network operations use injected stubs; persistence tests use temporary SQLite databases.
- Full API suite (`cd api && npm test -- --reporter dot`) — **254 passing**.
- `node --check` passed for `api/adapters/callETemplateAdapter.js`, `api/services/callEClient.js`, `api/services/callEOutboundCallService.js`, `api/scripts/export-call-e-template-audit.js`, `api/db/db.js`, `api/__tests__/callEClient.test.js`, and `api/__tests__/callEOutboundCallService.test.js`.
- No credentials were accessed; no CALL-E API/SDK request, remote write, or phone call occurred.

**Remaining Phase D work:** none for the code-level single-recipient path; the gated Mini App route and operational prerequisites are documented under Phase E and the pilot runbook. Live pilot use remains blocked on Phase B sanitized template/account evidence, verified test-key/region eligibility, an allowlisted authorized test destination, reviewed consent and written owner approval. Local-call correlation and durable status reconciliation were subsequently implemented under Phase F. No production database backup was needed for this code-only change; rollback is to disable `CALLE_DISPATCH_ENABLED` and preserve existing idempotency and reconciliation rows.

### CALL-E Phase B — VOICEDNUT domain and compatibility mapping

**Deliverable:** capability matrix delta and per-template compatibility workflow. Verify database schema assumptions and inventory real template rows from an approved, sanitized export when available.

**Acceptance:** each candidate is mapped by template ID + immutable version + fingerprint; high-risk features are excluded until individually assessed; existing provider paths remain unchanged; no remote writes occur.

### CALL-E Phase C — No-call adapter preview

**Status:** implemented; see Phase C result above.

**Deliverable:** deterministic local compiler/preview. It shows mapped/missing/unsupported fields and a redacted request summary. Provider lifecycle fixtures and fake transport are part of Phase D.

**Acceptance:** compiler works offline without CALL-E credentials; cannot dial; unknown config fails closed; schema limitations are checked locally; test inputs use synthetic data and returned phone output is masked. No runtime template is declared compatible from synthetic fixtures.

### CALL-E Phase D — Server client and durable call lifecycle

**Status:** client/service scaffolding implemented; product route and live pilot remain out of scope. See Phase D result above.

**Deliverable:** server-only API client and explicitly selected one-recipient call path, initially for test environment and an allowlisted test destination. Persist/reserve idempotency before dispatch; store correlation; provide query/reconcile behavior. Use a fake transport and synthetic lifecycle fixtures for accepted, pending, no-answer, unavailable result, malformed response, timeout, and uncertain acceptance. Add only the verified operation set.

**Acceptance:** mocked tests prove unchanged retry reuses the original key/request; changed request conflicts; timeout does not create a second call; `status=completed` does not imply result readiness; unavailable/empty/invalid result paths remain distinct; secrets and PII do not appear in logs. No production call or automatic provider failover.

### CALL-E Phase E — Authenticated API and operator preview

**Status (2026-10-26): preview and gated dispatch implemented; execution remains disabled by default.** Added an authenticated `/api/call-scripts/:id/call-e-preview` endpoint and exposed it through the existing `caller_flags_manage` Mini App action bridge. The Script Designer accepts an E.164 destination and flat scalar result schema, then displays the compiler response with a masked destination. Preview performs no provider request. Dispatch is a separate explicit action and is blocked unless every server gate and the readiness review are active.

**Phase E implementation:** the Mini App dispatch action now re-fetches a live template, derives business scope server-side, requires current operator membership and a matching append-only confirmation by the authenticated Telegram actor, recomputes the exact preview, checks the separate kill switch and unexpired exact-fingerprint approval, then delegates to the existing outbound service. That service enforces the allowlist, consent/opt-out policy, idempotency, lifetime one-call reservation, and concurrency across API processes. The UI requires a separate explicit call action with a charge warning and keeps it disabled unless server status reports the technical gates ready. No CALL-E request occurred during implementation. Approval is a configuration pointer only; it does not prove written approval, lawful consent, account eligibility, or reviewer sign-off. Phase E is implemented but awaiting pilot evidence review and deployment verification.

Business-scoped evidence routes allow global admins to grant/revoke business operator roles through append-only membership events, while authenticated Mini App users with `provider_manage` and a `policy_manager` membership can record consent or opt-out for a template. These routes record operator-supplied evidence metadata; they do not verify legal sufficiency or provide recipient self-service opt-out. The policy is checked against the template's server-derived business; opt-out is sticky and expired/missing evidence fails closed. The deployment status reports the kill switch, approval state, external readiness attestation, provider config, and allowlist state. `pilotReady` remains false by default and becomes true only when all code-level gates and the external readiness attestation are configured. This does not validate Telegram WebView behavior.

The `call_e_pilot_dispatch_guard` table is additive and created idempotently at startup. Existing versions ignore it; rollback must preserve the table and any consumed or unresolved reservation. Before production rollout, follow the backup and integrity-check sequence in the pilot runbook. No production database migration was performed.

The append-only `call_e_contact_policy_events`, `call_e_business_operator_events`, and `call_e_operator_confirmation_events` tables are additive. Policy rows store E.164 destinations, opaque consent evidence references, and the authenticated operator Telegram ID; membership rows record admin-token grants and revocations; confirmation rows store business/template/version, the preview fingerprint, and authenticated operator, but no destination. The policy actor column is added idempotently to existing policy tables. Retention, deletion, encryption-at-rest, and evidence adequacy require review before production use. Opt-outs are intentionally sticky; the API exposes no clear-opt-out operation. Preserve policy, membership, and confirmation events during rollback and do not treat the stored evidence reference as proof that consent is legally sufficient.

**Deliverable:** guarded API request flow and Mini App preview/explicit execution UX. Enforce existing auth and current business membership; bind approval and operator confirmation to the exact request fingerprint and destination.

**Acceptance:** authorization-denied, incompatible template, stale version, disabled either feature flag, expired/mismatched approval, unsupported region, and reused confirmation fail closed; Mini App requires a separate charge-warning action; preview and confirmation alone never dispatch. Live pilot remains blocked until the runbook evidence gates are closed.

### CALL-E Phase F — Event/result reconciliation

**Status (2026-10-26): bounded reconciliation, durable local state, admin access, and business-scoped Mini App access implemented.** Added `api/services/callEReconciliationService.js` with bounded page reads, stable event-ID deduplication, persisted cursor state, cursor preservation for empty pages, foreign-call validation, result-schema validation, and event metadata projection that drops message/details content. The additive `call_e_reconciliation` SQLite table stores the local/provider IDs, immutable business scope, pinned template/schema fingerprint, cursor/deduplication state, and normalized lifecycle statuses; it has no destination, transcript, raw event, or result columns. Outbound registration persists the template's business scope before provider submission. Mini App reconciliation rechecks current membership in that business before provider reads and returns not-found for missing or unauthorized calls. The existing admin-token endpoint remains available for global administrators. Responses contain execution/outcome/result readiness and sanitized event metadata only. The authenticated CALL-E API docs confirm that event pages can contain late arrivals and should be deduplicated by stable event ID; callers must retain the last event ID and must not concatenate partial ASR/speech updates into a transcript. See the [official Calls API reference](https://docs.heycall-e.com/api-reference/calls).

An offline end-to-end rehearsal in `api/__tests__/callEIntegrationRehearsal.test.js` runs a fake accepted Call through the real SQLite idempotency/reconciliation storage, verifies exact replay creates one fake request, reconciles a synthetic completed/available result and event page, and asserts transcript/result content is not persisted or returned.

There is no customer-facing transcript/result exposure and no background polling. Mini App operators can reconcile only records carrying a business ID for which they currently hold `policy_manager` or `call_operator` membership. Existing rows created before business-scope capture remain unscoped and are not visible through the operator action; no automatic backfill is attempted. Database creation and nullable-column migration are additive and idempotent at API startup; the documented backup and rollback procedure below is required before production rollout.

**Database compatibility and recovery plan:** the CALL-E reconciliation record is additive and optional; the nullable `business_id` column is added idempotently and existing rows remain unchanged. Older application versions ignore the column. Before production rollout, take the approved SQLite online backup, verify it with `PRAGMA integrity_check`, deploy code that adds the column idempotently, then verify schema and restart health. Rollback is an application rollback while retaining the additive column and rows; do not drop the table or column. Restore the backup only for confirmed corruption, after preserving a copy of the failed DB and reviewing writes made after backup. No production database was read, changed, or backed up for this code-only work.

**Deliverable:** bounded authenticated polling and durable event-list reconciliation. Current webhooks are unsigned, so they are excluded as trusted inputs. Normalize persisted API state into local call status, transcript access, outcomes, and usage where supported.

**Acceptance:** duplicate/out-of-order event pages are harmless; API reads are scoped to the locally authorized Call ID; late/missing terminal updates reconcile; result and execution statuses remain separate; transcript PII is protected; event data cannot approve business writes.

### CALL-E Phase G — Controlled workflow pilot

**Status (2026-10-26): pilot runbook prepared; execution is NO-GO.** See [CALL-E pilot runbook](call-e-pilot-runbook.md) for the readiness matrix, bounded first-run envelope, run sequence, stop/recovery steps, and approval record. The authenticated dispatch and tenant-scoped operator reconciliation paths are implemented behind default-off gates. Sanitized template/account evidence, explicit destination and consent, written approval, and deployment-owner backup/recovery verification are still missing. Do not enable a flag or credential until the runbook gates are satisfied.

**Deliverable:** one approved, low-risk, opt-in template in a non-production or specifically approved pilot scope. Add operator runbook, usage limits, kill switch, support/reconciliation procedure, and rollback steps.

**Acceptance:** written owner approval for any real test call; documented consent/eligibility and opt-out checks; validated costs and regions; manual review of results; success, failure, no-answer, and ambiguous flows exercised; existing provider rollback confirmed.

### Later phases — Goals, campaigns, analytics, inbound, and workforce

Treat each as a separately scoped phase only after its product prerequisites exist. Goal Runs need immutable mapping/version semantics. Campaign execution needs owned contacts, consent records, voice DNC/opt-out controls, eligibility snapshots, timezone-aware calling windows, rate/concurrency controls, per-recipient idempotency, retry policies, cancellation, queue/worker ownership, audit, and a kill switch. Inbound/numbers need number ownership and tenant routing. Analytics/usage require a shared normalized ledger and a documented billing reconciliation policy. None should be inferred from the existence of the CALL-E API or community samples.

## 8. API and normalized lifecycle contract

Provider lifecycle data should preserve raw provider distinctions while presenting stable VOICEDNUT meanings. Exact provider fields must be mapped from verified contracts, not guessed.

| VOICEDNUT concept | Rule |
|---|---|
| `execution_status` | Queued, in progress, terminal, failed, or canceled according to the verified provider state. This only describes execution. |
| `call_outcome` | Reached/completed, no answer, busy, declined, or unknown only when supported by provider evidence. Do not infer business success. |
| `result_status` | Pending, available, unavailable, or not applicable. A terminal call can still have a pending/unavailable result. |
| `business_result` | Locally validate against the pinned template’s supported schema. Reject or quarantine invalid provider output; never coerce missing values into success. |
| `transcript` | Keep access-controlled and retention-limited. Prefer structured turns/references and redact where possible; do not expose in generic logs. |
| `provider_call_id` | Correlation-only provider identifier; local VOICEDNUT call ID remains the internal API resource. |
| `idempotency` | One stable key per logical operation. Retry only the exact immutable request with that key; an intentional new call needs a new authorization and key. |
| `error` | Sanitized stable code/category, retryable only when the provider contract establishes safe retry. No raw response body or credential data. |

Do not add CALL-E-specific fields to existing public APIs without compatibility review. Prefer additive optional provider selection and existing error envelope conventions. Provider selection must be explicit for CALL-E; global provider defaults do not silently opt current traffic in.

## 9. Security, privacy, and operational controls

- Store `CALLE_API_KEY` only in the approved API runtime secret store/environment. Keep test and production credentials/base URLs separate. Never commit real values or expose them to bot/Mini App clients.
- Use request-level authorization and template ownership checks before exposing mapping IDs or call IDs. The current schema and admin-token setup may not provide organization-level ownership; document that gap and do not imply tenant isolation until implemented.
- Validate E.164 destinations, supported region/locale, task size, flat result-schema limits, metadata allowlist, webhook URL policy, and all unknown keys. Treat provider responses and transcripts as untrusted input.
- Add per-user/IP/provider rate limits and in-flight/concurrency limits before enabling live dispatch. Keep a fast kill switch that prevents new calls without corrupting existing call records.
- Retain purpose, consent/eligibility evidence, opt-out state, and authorization provenance without collecting extra personal information. Check applicable provider and jurisdiction calling constraints before pilot.
- Use PII-aware structured logging. Record request IDs, provider, local template/version, correlation ID, sanitized code, and timings only. Do not log full task strings, phone numbers, API keys, raw events, or transcript text by default.
- If CALL-E webhook security is not verified or lacks required authenticity/replay guarantees, do not use webhook data to authorize side effects. Reconcile by authenticated API read/polling, or stop and surface manual review.
- A provider timeout after submission is an **unknown outcome**, not a failed call. Preserve the reservation and reconcile before any later attempt.
- No retry or fallback may create a second phone call automatically when CALL-E may already have accepted the request.
- Never perform real phone calls, provider writes, or billing-impacting validation without explicit authorization and an agreed test destination.

## 10. Observability and support

Record low-PII operational signals against the local call record:

- provider and interface type;
- template/version/fingerprint and mapping state;
- time from local reservation to acceptance and terminal/result availability;
- execution/outcome/result status counts;
- normalized provider error categories and reconciliation age;
- webhook/poll deduplication and mismatch counts;
- usage/cost only where documented and reconciled to provider billing.

Operations need views for disabled/unconfigured state, mapping incompatibility, stale version, unresolved acceptance, long-pending result, unavailable result, and failed event/reconciliation. Provide an operator action to inspect a redacted request summary and safely resume status lookup. Do not expose transcript text in broad analytics.

## 11. Test strategy

All tests must stub CALL-E network calls. No test should accidentally use production host credentials or dial a phone.

### Unit and contract tests

- template compilation, deterministic fingerprint, supported schema and fail-closed unknown fields;
- provider capability discovery and unsupported-operation errors;
- request authentication, timeout, sanitized error mapping, test/prod base URL isolation;
- idempotency reservation, exact replay, changed-input conflict, concurrent create, uncertain acceptance, reconciliation;
- status mapping and separation of execution/outcome/result;
- structured result schema validation, unavailable result, empty valid object, invalid result;
- webhook validation, body limits, event ID dedupe, duplicate/out-of-order delivery, and auth failures if hooks are used;
- opt-out, unsupported destination, feature flags, authorization, rate/concurrency bounds, and kill switch.

### API and integration tests

- use the existing call route and error envelope without changing legacy provider requests;
- verify only explicit `provider: "call-e"` dispatches CALL-E;
- verify stale/incompatible template versions cannot execute;
- verify call record and correlation survive process interruption and duplicate request;
- verify payment, OTP, transfer, and tool-backed templates are denied until a specific adapter capability is approved;
- verify Vapi, Twilio, Plivo, Vonage, and other existing paths remain unchanged.

### Mini App E2E and accessibility

After UI implementation, use Playwright for desktop/mobile preview, masked destination, no-call mode, authorization errors, explicit execute confirmation, loading/polling, cancellation/reconciliation messaging, unavailable result, and human-review state. Do not run browser tests against live provider credentials.

### Live validation

Not part of ordinary CI. Requires explicit authorization, a dedicated test environment/key, an authorized test phone, a per-run spending cap, operator supervision, and confirmation of provider rules. Record actual result without exposing personal data.

## 12. Feature flags and rollout

Suggested flags; use existing configuration conventions and avoid inventing organization-level targeting until the identity model supports it:

- `CALLE_ENABLED=false` — master server-side guard;
- `CALLE_TEST_MODE=true` — select only approved test host/mock behavior;
- `CALLE_PREVIEW_ENABLED=false` — allow local no-call compatibility preview;
- `CALLE_CALLS_ENABLED=false` — permit explicitly authorized Calls API creation;
- `CALLE_GOALS_ENABLED=false` — enable only after Goal mapping and version semantics are complete;
- `CALLE_WEBHOOKS_ENABLED=false` — enable only after authentication/replay contract review;
- per-template allowlist/mapping — exact local template ID + version + fingerprint.

Rollout: offline mock → contract tests → test-host validation → approved internal test call → opt-in low-risk template pilot → broader template allowlist only after review. Production remains on existing execution paths until a specific version is explicitly enabled. No percentage-based traffic split until call duplication and tenant ownership constraints are understood.

## 13. Rollback and recovery

1. Disable `CALLE_CALLS_ENABLED` / `CALLE_ENABLED` to prevent new requests. Do not delete mappings, idempotency reservations, call records, or audit events.
2. Keep status retrieval and reconciliation available for already accepted calls, if safe and verified; disabling dispatch must not erase uncertainty.
3. Route new work only to the previously configured provider after explicit selection. Never automatically replay a CALL-E operation on another provider if acceptance is uncertain.
4. Preserve template version, CALL-E mapping, request fingerprint, provider call ID, and status history for support and audit.
5. Revert the additive adapter/routes/UI behind flags if necessary; retain additive database history unless a reviewed migration proves records are safe to remove.
6. If a template’s CALL-E mapping becomes stale or unsupported, mark it disabled and keep the existing provider mapping available. Do not silently remap or rewrite the local template.

Database rollback: any future schema changes must be additive, backward-compatible, and documented with backup/restore instructions before application. Do not drop CALL-E tables or columns during rollback if they may contain operational history.

## 14. Required phase report

For every implementation phase, append a dated report recording:

1. Objective, acceptance criteria, and exact interface contract sources checked.
2. What changed and why; files, API routes, environment flags, and additive database changes.
3. Existing features, providers, template behavior, and public APIs preserved.
4. Candidate template IDs/versions assessed and compatibility evidence; never list secret or customer content.
5. Tests and exact commands/outcomes; mocked versus live status.
6. Mini App/Playwright results if user-visible behavior changed.
7. Security/privacy review and call/billing side effects.
8. Known gaps, risks, rollback and recovery steps.
9. Explicit statement whether any real provider call or external write occurred.

## 15. Definition of done

CALL-E integration is not complete merely because an API request succeeds. The first production-ready slice requires all of the following:

- explicit opt-in provider dispatch for a pinned compatible template version;
- existing provider paths remain behaviorally intact;
- server-only credentials, authorization, validation, rate/concurrency limits, consent/opt-out checks, idempotency, and uncertain-outcome reconciliation;
- clearly separate execution state, telephone outcome, validated business result, and transcript/evidence;
- bounded and secure status/event ingestion with durable deduplication;
- no-call default tests and explicit live-call gates;
- observable local correlation, error state, usage policy, operator recovery, and kill switch;
- accurate user-facing preview and side-effect disclosure;
- documented migration compatibility and rollback;
- verified test results and no unapproved live operations.

Later claims such as campaign execution, inbound routing, number management, multi-step autonomous tasks, or cross-provider fallback require separate capability evidence and acceptance gates.

## 16. Official CALL-E sources

- [Official CALL-E GitHub organization](https://github.com/CALLE-AI)
- [CALL-E integrations and package layout](https://github.com/CALLE-AI/call-e-integrations)
- [Official developer docs](https://docs.heycall-e.com/)
- [Calls API reference, including read, cancel, and durable event endpoints](https://docs.heycall-e.com/api-reference/calls)
- [Quickstart and idempotency guidance](https://docs.heycall-e.com/quickstart)
- [Calls/Goals migration guide](https://docs.heycall-e.com/migration)
- [Billing model and call-preparation charges](https://docs.heycall-e.com/billing)
- [Official integration README and current/legacy MCP and webhook notes](https://github.com/CALLE-AI/call-e-integrations)
- [TypeScript server SDK and webhook contract notes](https://github.com/CALLE-AI/server-sdk-typescript)
- [Python server SDK and webhook contract notes](https://github.com/CALLE-AI/server-sdk-python)
- [Official sample-app catalog and contribution guidelines](https://github.com/CALLE-AI/awesome-phone-call-agents)

Re-check these sources during implementation. The contract, SDKs, package versions, examples, and service availability can change.
