# Phase 1 — Codebase and call-template audit

Audit date: 2026-10-25  
Scope: repository source and configuration only. No runtime database or deployment access was available.

## Executive summary

VOICEDNUT is an existing voice operations product built from a Node.js/Express API, a Telegram bot, and a React Telegram Mini App. It is not a Vapi-based application. Its live voice path already supports Twilio, Plivo, and Vonage provider modes, with Deepgram Voice Agent and a legacy OpenRouter/OpenAI plus Deepgram STT/TTS path. Calls, scripts, provider state, approval lifecycle, version snapshots, and extensive operational records are persisted in SQLite.

The most important template assets are not represented by one single catalog:

1. `call_templates` are persisted, admin-managed call scripts with lifecycle review, version snapshots, simulation, cloning, and rollback.
2. The built-in profile packs under `api/functions/profiles/` are code/deployment assets loaded into runtime prompts and policy; they are not rows in `call_templates`.
3. The Telegram bot also contains starter prompt templates used when creating certain script types.
4. SMS and email have separate template systems and version histories.

Do not collapse these into a new Vapi-only template store. The existing paths and their data remain authoritative until a later phase defines a compatible mapping.

## Repository inventory

The checkout contains 307 tracked/unignored source and asset paths (excluding generated/dependency directories). Main areas:

| Area | Location | Responsibilities |
|---|---|---|
| Voice/API service | `api/app.js`, `api/routes/`, `api/services/` | Express endpoints, webhooks, websocket audio, call lifecycle, provider control, scripts, admin and Mini App bridge |
| Voice/provider adapters | `api/adapters/` | Provider state/policy/preflight plus Plivo and Vonage adapters; Twilio remains integrated directly in the API |
| Runtime AI/functions | `api/functions/`, `api/routes/gpt.js`, `api/routes/stream.js` | Prompt/profile composition, function/tool execution, voice runtime, digit capture, connectors, call memory |
| API persistence | `api/db/db.js` | SQLite schema and persistence for calls, scripts, outcomes, jobs, payments, messaging, automation, CRM sync, and operations |
| Telegram bot | `bot/` | Telegram commands and conversations for calls, users, provider management, call/SMS/email scripts, status and logs |
| Bot persistence | `bot/db/db.js` | Local Telegram user authorization and script version helper table |
| Admin product UI | `miniapp/src/pages/AdminDashboard/` | Provider operations, call log, script studio, personas, users/roles, settings, messaging and incident review |
| Mini App API client/contracts | `miniapp/src/services/admin-dashboard/`, `miniapp/src/contracts/` | Authenticated transport, dashboard view models, API contracts and parity/access contracts |
| Documentation/configuration | root `README.md`, `api/README.md`, `miniapp/README.md`, setup scripts | Deployment/setup guidance, environment configuration, integrations and operational procedures |

No `AGENTS.md` was present in the repository file listing. No SQLite `.db`, `.sqlite`, or `.sqlite3` file was present in this checkout. There is no ORM or migration directory: schema creation and additive column/table initialization live in the API database class, with a separate bot SQLite database.

## Application, data, and workflow findings

### API and application

- One large Express application in `api/app.js` registers REST endpoints and websocket routes. Major behavior is also factored into `api/routes/`, `api/services/`, `api/functions/`, and `api/adapters/`.
- Voice ingress/execution includes Twilio inbound/outbound and Media Streams, Vonage callbacks/websocket streaming, Plivo answer/events/websocket streaming, and documented AWS Connect/Kinesis callback/stream paths. Provider activation has preflight and compatibility policy.
- Call history, transcripts, call state events, outcomes, metrics, digit capture, runtime state, idempotency, job queues/DLQs, QA, and health are database-backed.
- Admin APIs use `ADMIN_API_TOKEN`/admin authorization helpers. Internal bot-to-API script requests use HMAC authentication; Mini App access uses Telegram init-data validation and a signed session. Twilio/provider callback verification is implemented in middleware/services; README documents strict production settings for relevant webhooks.
- The API has no organization/tenant model in the inspected schema. `business_id` appears on call templates, but code/schema inspection alone does not establish tenant isolation or current production ownership.

### Template and script lifecycle

`call_templates` records contain `id`, `name`, `description`, `prompt`, `first_message`, numeric `version`, `business_id`, `voice_model`, objective tags, default profile, expected length, digit/OTP/terminator flags, payment settings/policy/messages, lifecycle/review fields, and timestamps. A related `call_template_versions` table stores JSON snapshots keyed by template and version.

The `/api/call-scripts` API supports list/read/create/update/delete, clone, versions, diff, rollback, submit for review, review, promote-live, and simulation. Live/default inbound script selection is supported. Edits to reviewed/approved/live scripts reset lifecycle to draft and persist a snapshot. The `ScriptStudioPage` and Telegram `/scripts` flow provide user-facing management. The concrete production records and which actions each owner uses require the runtime database.

The database has additional independent `sms_scripts`/`sms_script_versions` and `email_templates`/`email_template_versions` systems. They are not call templates and must not be conflated with the voice template catalog.

### AI and voice behavior represented by templates

- Profile packs define prompt/style layers, runtime routing and policy behavior, safe fallback text, allowed/blocked tool policy, response limits, and profile-specific context. They are loaded through `profileRegistry` and composed by `Dating.js`/the API call runtime.
- General AI runtime is driven by OpenRouter model configuration and OpenAI SDK use; Deepgram supplies STT/TTS and an optional Deepgram Voice Agent path. Deepgram Voice Agent can fall back to the existing legacy pipeline and be bypassed for keypad-required capture behavior.
- Prompt, first message, profile, voice model, objective tags, and relevant payment/digit-capture settings can flow from a call script into call configuration and outcomes. Runtime tools include digit capture, verification, escalation, connector actions, payments, email follow-up, research/lookups, and business-operation surfaces. Actual tool assignment for a particular persisted script must be read from its record/runtime behavior.
- No first-class Vapi integration, assistant mapping, Vapi provider adapter, or Vapi configuration was found in the source inventory.

### Integrations identified in source/config

| Integration | Role / path | Notes |
|---|---|---|
| Twilio | Voice, Media Streams, SMS, callbacks, gather/DTMF | Existing primary/legacy path; API dependency `twilio`; webhook signature middleware |
| Plivo | Voice API, stream callbacks, SMS | Adapter and route support; parity limitations documented for payment/DTMF/inbound SMS/receipts |
| Vonage | Voice API/websocket, SMS | Adapter, signed callbacks, DTMF webhook option and keypad provider guard |
| AWS Connect/Kinesis/Pinpoint | Voice/SMS callback and stream integration | Mentioned in README/config/runtime paths; callback auth and stream auth documented |
| Deepgram | STT, TTS, Voice Agent | Runtime model selection, preflight, turn/tool timeouts and fallback controls |
| OpenRouter | LLM/chat/tool execution | Configurable model, backup, memory and tool safety controls |
| OpenAI | SDK dependency / model API integration path | Present in API dependency/runtime; per-script model selection is not a schema field except `voice_model` |
| Stripe, PayPal, Square | Payment connector execution and webhooks | Approval/policy-gated operations, provider-specific session/event tables and reconciliation |
| SendGrid, Mailgun, SES | Email delivery/templates | Email provider/service paths, queues and delivery operations |
| CRM/business connectors | Contact sync, CRM lookup/lead, tickets, order/calendar tools | Connector registry/packs and post-call CRM contact sync; concrete vendor coverage varies by tool configuration |
| Telegram | Bot interface, notifications, Mini App identity | Bot commands, role/access checks, Telegram init-data/session auth and admin UI |
| Web search/docs/news/crawl | Research/knowledge tools | Connector functionality; no persistent knowledge-base subsystem or Vapi knowledge mapping found |

The integration inventory above is source-derived, not a credential/configuration health report. Environment secrets were not read or printed.

## Existing call-template asset inventory

### Runtime profile packs

All 15 profile directories have a primary `<id>.md` runtime pack and a companion `profile.md` style layer. The primary pack is authoritative for routing/policy; the companion must not override it. Runtime profile definitions also include `general`, making 16 runtime profile types overall, though `general` has no dedicated profile directory and acts as the default.

| ID | Purpose/category | Runtime-specific behavior visible in source | Initial Vapi disposition |
|---|---|---|---|
| `dating` | Relationship/dating conversation | Relationship stage/vibe/goals context, anti-impersonation/harassment/coercion/money-pressure policy | VAPI-COMPATIBLE WITH ADAPTER: preserve runtime context and policy/tool gates |
| `celebrity` | Transparent celebrity/fan engagement | Explicit virtual-assistant positioning, fan context, policy gates | VAPI-COMPATIBLE WITH ADAPTER |
| `fan` | Fan engagement | Fan stage/vibe/goals and policy gates | VAPI-COMPATIBLE WITH ADAPTER |
| `creator` | Creator collaboration/outreach | Prospect/qualification/negotiation context and handoff goal | VAPI-COMPATIBLE WITH ADAPTER |
| `friendship` | Friendly check-in/support | Relationship/support context and policy gates | VAPI-COMPATIBLE WITH ADAPTER |
| `networking` | Professional networking | Intro/follow-up/qualification/scheduling context | VAPI-COMPATIBLE WITH ADAPTER |
| `community` | Community outreach/support | Onboarding/event/support/retention context | VAPI-COMPATIBLE WITH ADAPTER |
| `marketplace_seller` | Seller support/onboarding | Seller context and business-support flows | VAPI-COMPATIBLE WITH ADAPTER |
| `real_estate_agent` | Real estate outreach | Prospect qualification, viewing/callback next step | VAPI-COMPATIBLE WITH ADAPTER |
| `tax_support` | Tax support/routing | Sensitive-data minimization and approved-scope boundaries | VAPI-COMPATIBLE WITH ADAPTER |
| `tax_resolution` | Tax resolution follow-up | Sensitive case handling and approved next steps | VAPI-COMPATIBLE WITH ADAPTER |
| `bank_servicing` | Banking account servicing | Security-sensitive servicing flow | VAPI-COMPATIBLE WITH ADAPTER |
| `fraud_review` | Fraud/security review | Minimal fact gathering and protective next step | VAPI-COMPATIBLE WITH ADAPTER |
| `collections_servicing` | Collections/hardship/payment resolution | Respectful collections context; payment connector gates may apply | VAPI-COMPATIBLE WITH ADAPTER; payment execution stays in VOICEDNUT tools |
| `identity_verification_plus` | High-trust identity verification | OTP/DTMF digit capture, masking and provider compatibility gates | HYBRID EXECUTION pending feature-by-feature validation; keypad flow must retain existing path or tool adapter |
| `general` (default) | General inbound/outbound calls | Default prompt/style, voice output and turn-taking directives | VAPI-COMPATIBLE WITH ADAPTER |

The code-defined starter catalog in `bot/commands/scripts.js` includes starters for dating, celebrity, fan, community, marketplace seller, real estate, tax support, tax resolution, bank servicing, fraud review, collections servicing, and identity verification plus. Other flows (including friendship/networking/creator and core operational flows such as payment collection, appointment confirmation, service recovery, and general outreach) are represented by flow metadata, built-in profiles, or generic script creation rather than necessarily having a dedicated starter prompt object. This is a distinction between starter prompts and the persisted template table.

### Persisted template inventory status and safe strategy

| Asset population | IDs/names/records known in checkout? | Current path | Provisional compatibility / strategy | Rollback |
|---|---|---|---|---|
| Existing rows in `call_templates` | No; database absent | API/SQLite call-template record selected in bot, API, inbound flow, and Mini App | Assess each record using its prompt/profile/objective/payment/digit behavior. Preserve current provider path; use Vapi only after per-record compatibility and test. Likely adapter/hybrid for nontrivial tools and capture. | Restore prior immutable snapshot/version and current provider selection; do not change production rows during audit |
| Built-in profile packs | Yes: 15 directories listed above | Files loaded from `api/functions/profiles`; runtime policy/context is generated server-side | Preserve files/runtime behavior. Any Vapi representation must carry the policy/context and delegate unsupported work back to VOICEDNUT. | Restore source pack and deploy prior application revision |
| General/default behavior | Yes in runtime constants; not a profile pack row | API defaults and prompt composition | Provider-neutralize only after comparing prompt composition and voice/call behavior | Revert provider/config feature selection |
| Bot starter templates | Yes in code; catalog listed above | Used during Telegram call-script creation | Keep as source presets and continue creating normal `call_templates` records | Revert code revision; no persisted template data migration |

For persisted call-template rows, owner, organization, visibility, exact version, created/updated times, campaign/agent/phone-number assignments, production usage, required inputs, per-record tool dependencies, test results, and rollback readiness are **not discoverable without the actual database and operational logs**. The current inspected schema has no explicit `organization_id`, agent/squad entities, campaign entity, phone-number assignment relation, or provider resource ID on a call template. Absence from this schema does not prove no external system or deployment data exists.

No template is recommended for deprecation. Initial classification is provisional and based on code features only; it is not approval to migrate.

## Dependency and package snapshot

- API runtime: Express, SQLite3, Twilio, Vonage SDK, Deepgram SDK, OpenAI SDK, `node-fetch`, `express-ws`, and payment SDK/tooling including PayPal Agent Toolkit. Plivo adapter uses HTTP/fetch-style requests.
- Bot runtime: grammY/conversations, Axios, SQLite3, Zod, Express, dotenv.
- Mini App: React, React Router, Telegram Mini App SDK/UI, TonConnect, Vite, TypeScript, ESLint.
- There are separate package manifests and lockfiles for API, bot, and Mini App. The API dependency install during Phase 3 reported 64 npm audit advisories (3 low, 25 moderate, 34 high, 2 critical); the detailed advisory list has not yet been reviewed, and no package is labeled unused or risky from this result alone.

## Security and operational controls observed

- Server-side provider configuration and credentials are loaded in API config; API HMAC protects internal requests; Telegram Mini App init data is validated and exchanged for session tokens.
- Admin/outbound operations are gated by admin token or outbound authorization. Connector tools have risk classes and explicit approval for sensitive writes/payments. Payment connectors block direct card-like data and verify/deduplicate provider webhooks.
- Provider preflight gates switching; request timeouts, selected retries, idempotency, DLQs, health logs, audit records, webhook validation, and log redaction/masking exist across subsystems.
- A full cross-organization isolation audit is not applicable to current schema evidence: no organization model is evident. This requires resolution before enterprise tenancy claims or provider resources are introduced.
- No Vapi private credential or Vapi webhook path exists in source.

## Product and UX inventory

The Mini App is an admin/operations interface, not a customer-facing AI Employee builder. Current screens/components include operations dashboard, provider control, call log explorer, Script Studio, persona manager, users/roles, settings, mailer, SMS sender, caller-flag moderation, audit/incidents, and messaging investigation. Telegram bot commands provide call, script, provider, user, SMS/email, and call-log operations. No agent builder, workforce/squad UX, Vapi resource browser, template marketplace, or customer self-service tenant area was found.

## Phase 1 findings: open items requiring runtime access

Before the call-template inventory can be considered complete against the implementation brief, obtain a read-only export or authorized read-only access to the deployed API SQLite database and relevant production usage records. Then populate for every call-template row:

- database ID/name/version/lifecycle/timestamps/business ID and full normalized script configuration;
- inbound-default status, execution provider, linked calls and outcomes, and counts by status/date;
- profile/objective tags, payment and digit/OTP requirements, voice model, and all dependencies/variables;
- clone/version/review/rollback evidence and actual simulation/regression status;
- operational owner, organization, campaign/agent/number usage if maintained outside this schema;
- compatibility class, adapter/tool/webhook requirements, fallback safety, and record-specific rollback plan.

Also validate the deployment's actual provider modes, credentials by presence only, feature flags, webhook endpoints, and active environment configuration without exposing secret values. This code audit is complete for the checked-out source; data/deployment-dependent rows remain explicitly unverified rather than inferred.

## Phase 1 conclusion

The safe baseline is to preserve the existing API, provider selection, runtime profile-pack contract, script governance lifecycle, and version snapshots. Treat persisted call scripts and profile packs as separate but connected assets. Any Vapi path should begin as a parallel provider/adapter behind explicit selection and compatibility checks, with VOICEDNUT continuing to own script identity, governance, runtime business rules, and usage attribution. No implementation change or data migration was made in this phase.
