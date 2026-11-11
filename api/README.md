# Call GPT: Generative AI Phone Calling

Wouldn't it be neat if you could build an app that allowed you to chat with ChatGPT on the phone?

Twilio gives you a superpower called [Media Streams](https://twilio.com/media-streams). Media Streams provides a Websocket connection to both sides of a phone call. You can get audio streamed to you, process it, and send audio back.

This app serves as a demo exploring two services:
- [Deepgram](https://deepgram.com/) for Speech to Text and Text to Speech
- [OpenAI](https://openai.com) for GPT prompt completion

These service combine to create a voice application that is remarkably better at transcribing, understanding, and speaking than traditional IVR systems.

Features:
- 🏁 Returns responses with low latency, typically 1 second by utilizing streaming.
- ❗️ Allows the user to interrupt the GPT assistant and ask a different question.
- 📔 Maintains chat history with GPT.
- 🛠️ Allows the GPT to call external tools.
- 🎭 Persona composer tailors tone, mood, and phrasing across business domains, channels, and urgency levels.

## Digit Capture Roadmap

For the phased enterprise hardening plan of digit-capture profiles (reprompts, retries, timeout/failure handling, state machine, observability, and security), see:

- `api/docs/digit-capture-enterprise-roadmap.md`

## Plivo Mode

Twilio Media Streams is still supported, and the selectable alternate provider is now Plivo. Flip the provider by setting `CALL_PROVIDER=plivo` and providing the following environment variables:

- `PLIVO_AUTH_ID` and `PLIVO_AUTH_TOKEN`
- `PLIVO_VOICE_FROM_NUMBER` for outbound calls
- `PLIVO_SMS_FROM_NUMBER` for outbound SMS
- `SERVER` or explicit `PLIVO_ANSWER_URL` / `PLIVO_EVENT_URL`
- `PLIVO_WEBHOOK_VALIDATION` and one of:
  - API HMAC headers (`x-api-timestamp`, `x-api-signature`)
  - or `PLIVO_WEBHOOK_SECRET` sent as `x-plivo-webhook-secret`

When running in Plivo mode:

- Outbound calls are initiated through the Plivo Voice REST API with `answer_url` and lifecycle callback URLs.
- `GET` or `POST /plivo/answer` returns Plivo XML with a bidirectional `<Stream>` pointed at `WS /plivo/stream`.
- `POST /plivo/events` normalizes Plivo call lifecycle events into the existing provider status pipeline.
- Outbound SMS uses the Plivo Message API with `src`, `dst`, and `text`.

Known Plivo parity gaps are explicit and should stay visible during rollout:

- Voice: native Twilio payment flow is not available on Plivo; payment must use SMS fallback or remain disabled.
- Voice: DTMF/digit-capture parity should be treated as limited until a live Plivo DTMF webhook path is verified.
- SMS: inbound SMS, delivery receipts, and status reconciliation are not enabled for Plivo in the current route set.

Keep the Twilio credentials in place if you want a rapid rollback path; switching the provider back to `twilio` will re-enable the original websocket-based flow without redeploying code.

Local Plivo smoke command:

```bash
npm run smoke:plivo --prefix api
```

By default this validates local configuration and optional API preflight only. To place a real Plivo call and send a real SMS, configure a public HTTPS `SERVER` or explicit Plivo URLs, set real Plivo credentials and test target numbers, then run:

```bash
PLIVO_SMOKE_LIVE=1 \
PLIVO_SMOKE_TO_NUMBER=+15555550123 \
npm run smoke:plivo --prefix api
```

Production webhook validation should use `PLIVO_WEBHOOK_VALIDATION=strict` with either API HMAC headers through ingress or `PLIVO_WEBHOOK_SECRET` passed as `x-plivo-webhook-secret`.

## Cartesia Managed Agent lifecycle webhooks and call data

Cartesia Agent event webhooks are managed from the private-admin `/cartesia` bot menu. Configure `CARTESIA_ENABLED=true`, a server-side `CARTESIA_API_KEY` (and `CARTESIA_ADMIN_API_KEY` when using a separate platform key), a random `CARTESIA_WEBHOOK_SECRET` of at least 32 characters, and `CARTESIA_WEBHOOK_URL` as the public HTTPS URL ending in `/webhook/cartesia`. The bot creates webhook records using this configured callback URL and secret; neither secret is sent back to the bot. Attach or detach a webhook from an agent through the same menu. Cartesia sends lifecycle events to `POST /webhook/cartesia`; the route verifies `x-webhook-secret`, deduplicates `webhook_request_id`, and stores only event metadata and a payload hash for 30 days, not transcript text.

Cartesia call transcript review remains opt-in. In a private admin chat, the bot can also download a completed call's WAV recording after an exact call-specific confirmation, or delete the provider-side transcript, recording, and logs after a call ends when recording consent is withdrawn. Deletion is irreversible and requires business scope plus a second exact confirmation. Calls protected by Cartesia Zero Data Retention have no retained audio to download.

The private-admin `/cartesia` menu also includes **Cartesia setup readiness**. Its read-only `GET /api/cartesia/studio/readiness` check verifies API authentication by listing one voice, checks agent and webhook inventory, compares the configured HTTPS callback and secret presence with registered webhooks, and summarizes metadata-only webhook events received by VOICEDNUT in the last 30 days. It never returns credentials or event payloads. Callback validation rejects local/private literal hosts but does not resolve DNS or test network reachability. Cartesia's documented API does not expose webhook delivery-attempt history, so local receipts cannot confirm provider-side delivery failures.

Reference docs:

- Plivo Voice Call API: https://www.plivo.com/docs/voice/api/call/overview
- Plivo Message API: https://www.plivo.com/docs/messaging/api/message/send-a-message
- Plivo Audio Stream protocol: https://www.plivo.com/docs/voice/audio-streaming/audio-streaming

## PayPal Payment Connector

Payment tools stay behind the existing connector policy gates: payment feature flags, scoped payment key, write confirmation, amount limits, and refund double-confirmation. To route those tools to PayPal instead of the stub connector, set `payment_connector=paypal` on the call/template or enable `PAYPAL_CONNECTOR_ENABLED=true`.

Required environment:

```bash
PAYPAL_CONNECTOR_ENABLED=true
PAYPAL_ENVIRONMENT=sandbox
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=...
PAYPAL_RETURN_URL=https://your-app.example/paypal/return
PAYPAL_CANCEL_URL=https://your-app.example/paypal/cancel
PAYPAL_AGENT_TOOLKIT_READ_TOOLS=get_invoice,get_order,get_refund,list_invoices
CONNECTOR_PAYMENT_API_KEY=...
```

The current integration uses PayPal REST APIs through the existing `payment_link_generate`, `payment_retry_link_generate`, `invoice_create`, `invoice_reminder_send`, `payment_intent_status`, `payment_session_history`, `payment_failure_summary`, `customer_payment_profile`, and `refund_request_initiate` tool surface. Configure the PayPal app webhook URL as `https://your-app.example/webhook/paypal`; incoming events are verified with `PAYPAL_WEBHOOK_ID`, deduplicated by PayPal event ID, and reconciled into `paypal_payment_sessions` for checkout order, capture, refund, and invoice status updates. Agents can call `payment_session_history` to inspect local PayPal session and webhook history by order, invoice, refund, or call SID without making a live PayPal API request.

The official `@paypal/agent-toolkit` package is integrated behind the same service boundary. Use `paypal_agent_toolkit_manifest` with `payment_connector=paypal` or `PAYPAL_CONNECTOR_ENABLED=true` to inspect the configured AI SDK tool names and descriptions without exposing raw SDK handlers or credentials. Use `paypal_agent_toolkit_execute` only for the allowlisted read-only toolkit tools: `get_invoice`, `get_order`, `get_refund`, and `list_invoices`. `PAYPAL_AGENT_TOOLKIT_READ_TOOLS` can narrow that list for an environment, but unsafe write/payment-mutating toolkit tools are ignored even if included. Direct card data is blocked before toolkit execution; use PayPal-hosted/tokenized flows only. Live payment, invoice creation/sending, and refund execution remain on the existing approval-gated tools above.

PayPal production observability reuses the existing database-backed health and call metric tables. Connector executions, webhook signature checks, and webhook reconciliation outcomes write sanitized `paypal_connector` entries to `service_health_logs`; call-scoped connector executions also write `paypal_connector_event` rows to `call_metrics`. These records include action names, statuses, tool names, event IDs, event types, and update counts only; raw PayPal payloads, tool input, card-like values, credentials, and SDK responses are not logged.

Sandbox smoke validation is available with `npm run smoke:paypal --prefix api`. With credentials present, the default run validates configuration without making live PayPal calls. Set `PAYPAL_SMOKE_LIVE=1` to create a sandbox checkout order through `payment_link_generate` and read it back through the read-only `get_order` Agent Toolkit tool. The smoke script does not capture, refund, or send invoices.

PayPal readiness can also be checked through the provider preflight gate without changing the active call/SMS/email provider:

```bash
npm run preflight:provider --prefix api -- --channel payment --provider paypal --network 0 --reachability 0
```

For promotion, run it with `--network 1 --reachability 1` so the preflight verifies PayPal OAuth credentials and the public callback base URL. The PayPal preflight checks required credentials, `PAYPAL_WEBHOOK_ID` signature validation configuration, `POST /webhook/paypal` route registration, HTTPS webhook URL generation, and the read-only Agent Toolkit allowlist.

## Stripe Payment Connector

Stripe can use the same approval-gated payment tools as PayPal without adding a Stripe SDK dependency. To route tool calls to Stripe, set `payment_connector=stripe` on the call/template or enable `STRIPE_CONNECTOR_ENABLED=true`.

Required environment:

```bash
STRIPE_CONNECTOR_ENABLED=true
STRIPE_ENVIRONMENT=test
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
STRIPE_RETURN_URL=https://your-app.example/stripe/return
STRIPE_CANCEL_URL=https://your-app.example/stripe/cancel
STRIPE_API_VERSION=2026-02-25.clover
CONNECTOR_PAYMENT_API_KEY=...
```

The Stripe connector supports hosted Checkout Session creation through `payment_link_generate` and `payment_retry_link_generate`, invoice creation/finalization/sending through `invoice_create`, invoice sends through `invoice_reminder_send`, live status lookups through `payment_intent_status`, local session/event history through `payment_session_history`, payment health rollups through `payment_failure_summary` and `customer_payment_profile`, and guarded refunds through `refund_request_initiate`. Configure the Stripe webhook URL as `https://your-app.example/webhook/stripe`; incoming events are verified with `STRIPE_WEBHOOK_SECRET`, deduplicated by Stripe event ID, and reconciled into `stripe_payment_sessions`.

Smoke validation is available with `npm run smoke:stripe --prefix api`. The default run validates configuration only; set `STRIPE_SMOKE_LIVE=1` to create and read back a test-mode Checkout Session. Readiness can also be checked with:

```bash
npm run preflight:provider --prefix api -- --channel payment --provider stripe --network 0 --reachability 0
```

For promotion, run it with `--network 1 --reachability 1` so preflight verifies Stripe credentials, HTTPS callback generation, `STRIPE_WEBHOOK_SECRET`, and `POST /webhook/stripe` route registration.

## Square Payment Connector

Square can use the same approval-gated payment connector switchboard without adding a Square SDK dependency. To route tool calls to Square, set `payment_connector=square` on the call/template or enable `SQUARE_CONNECTOR_ENABLED=true`.

Required environment:

```bash
SQUARE_CONNECTOR_ENABLED=true
SQUARE_ENVIRONMENT=sandbox
SQUARE_ACCESS_TOKEN=...
SQUARE_LOCATION_ID=...
SQUARE_WEBHOOK_SIGNATURE_KEY=...
SQUARE_WEBHOOK_URL=https://your-app.example/webhook/square
SQUARE_RETURN_URL=https://your-app.example/square/return
SQUARE_API_VERSION=2026-05-20
CONNECTOR_PAYMENT_API_KEY=...
```

The Square connector supports hosted checkout links through `payment_link_generate` and `payment_retry_link_generate`, live status lookups through `payment_intent_status` by `payment_id`, `payment_link_id`, `order_id`, or `refund_id`, local session/event history through `payment_session_history`, payment health rollups through `payment_failure_summary` and `customer_payment_profile`, and guarded refunds through `refund_request_initiate` using `payment_id`. Square invoices are intentionally not routed through this connector yet, so `invoice_create` and `invoice_reminder_send` continue to use Stripe, PayPal, managed endpoints, or stubs.

Configure the Square webhook URL as `https://your-app.example/webhook/square`. Incoming events are verified with `SQUARE_WEBHOOK_SIGNATURE_KEY` and the exact `SQUARE_WEBHOOK_URL`, deduplicated by Square event ID when persistence helpers are available, normalized with the shared payment event shape, and reconciled into local Square payment session history.

Optional payment connector policy gates can be set globally or per call/template:

```bash
PAYMENT_CONNECTOR_ALLOWED_PROVIDERS=stripe,paypal,square
PAYMENT_CONNECTOR_MAX_PAYMENT_AMOUNT=500
PAYMENT_CONNECTOR_MAX_REFUND_AMOUNT=100
```

Use `payment_connector_policy_evaluate` to inspect whether a proposed connector write would be allowed before requesting write confirmation. These gates run before live provider execution and before scoped payment keys are consumed.

## Provider Preflight Gate and Parity Smoke

Provider activation is fail-closed for `twilio`, `plivo`, and `vonage` on `call` and `sms` channels:

- `POST /admin/provider` now runs provider preflight before activation.
- On preflight failure, activation is blocked and the currently active provider remains in place.
- `GET /admin/provider/preflight` runs read-only preflight checks and returns a detailed report.

Preflight checks include:

- Credential/auth probe (minimal safe provider API call).
- Webhook auth mode + signing secret + validation guard coverage.
- Callback URL configuration and optional reachability probe.
- Required route registration for voice, SMS, and payment webhooks.

CLI helper:

```bash
npm run preflight:provider -- --channel call --provider twilio --network 1 --reachability 1
```

Provider parity smoke suite (no Jest):

```bash
# Fast deterministic offline checks (default)
npm run parity:providers

# Optional live provider auth checks
LIVE_SMOKE=1 npm run parity:providers
```

## Worker Reliability Controls

- `CALL_JOB_TIMEOUT_MS` limits each call job execution window.
- `CALL_JOB_DLQ_ALERT_THRESHOLD` emits health alerts when open call-job DLQ entries exceed the threshold.
- `CALL_JOB_DLQ_MAX_REPLAYS` limits replay attempts for a single call-job DLQ entry.
- `WEBHOOK_TELEGRAM_TIMEOUT_MS` sets Telegram send/edit timeout for notification delivery.
- `EMAIL_REQUEST_TIMEOUT_MS` sets HTTP timeout for SendGrid/Mailgun provider calls.
- `EMAIL_DLQ_ALERT_THRESHOLD` emits health alerts when open email DLQ entries exceed the threshold.
- `EMAIL_DLQ_MAX_REPLAYS` limits replay attempts for a single email DLQ entry.
- Admin DLQ control endpoints:
  - `GET /admin/call-jobs/dlq`
  - `POST /admin/call-jobs/dlq/:id/replay`
  - `GET /admin/email/dlq`
  - `POST /admin/email/dlq/:id/replay`

## Voice Connector Pack Email Follow-Up

When connector packs are enabled, the voice agent can use `email_send_followup` to queue a SendGrid follow-up email after explicit write confirmation. The tool reuses the existing email queue and sender validation, forces `provider=sendgrid`, supports stored email scripts via `script_id`/`template_id`, and records connector audit events without logging full recipient addresses.

Required environment:

- `EMAIL_PROVIDER=sendgrid`
- `SENDGRID_API_KEY`
- `EMAIL_DEFAULT_FROM`
- `EMAIL_VERIFIED_DOMAINS` when sender-domain allowlisting is enforced

Operational email controls:

- `POST /email/provider-health` validates the active email provider credentials, sender identity, template availability, and domain allowlist without sending a production message.
- `POST /email/sendgrid/health-check` runs the same SendGrid-focused validation path.
- `POST /email/templates/select` previews the template the voice agent would choose for call intent, customer, booking, payment, and transcript context.
- SendGrid delivery events are accepted through the existing email provider event/webhook flow and persisted for delivery, bounce, block, drop, spam report, and unsubscribe tracking.

## Post-Call Automation and CRM Sync

Automation run results include an ordered `steps` audit with pending, running, completed, or failed states, persisted in the existing run record. A retry skips previously completed steps. Manual retry is limited to failed email steps using the same per-step idempotency key; an interrupted running step or a failed CRM/ticket action is treated as ambiguous and requires operator review before replay. Older runs without a step audit are blocked from retry when they contain actions that may not be safe to replay.

Post-call automation rules can now be seeded with the default payment receipt, missed-booking follow-up, and escalation case summary workflows. Runs store the original payload so failed automations can be inspected and retried safely.

Manual API controls:

- `POST /post-call/automation/rules/defaults` installs the default rules. Use `{ "overwrite": true }` to refresh existing default rule definitions.
- `GET /post-call/automation/rules` lists configured rules.
- `POST /post-call/automation/rules` creates or updates a rule.
- `POST /post-call/automation/preview` shows matching rules without executing actions.
- `POST /post-call/automation/run` evaluates and executes matching rules.
- `GET /post-call/automation/runs` lists stored runs by `call_sid`, `rule_id`, `status`, `trigger_event`, or `retry_of_run_id`.
- `POST /post-call/automation/runs/:run_id/retry` retries a failed run with stable action idempotency.
- `GET /post-call/workflows` lists versioned workflow definitions (admin token required).
- `GET /post-call/workflows/:workflow_id/versions` lists all versions for a workflow (admin token required).
- `POST /post-call/workflows` stores a validated draft as the next immutable version (admin token required).
- `POST /post-call/workflows/:workflow_id/versions/:version/approve` approves a draft version (admin token required). Approval does not start an immediate run.
- `GET /post-call/workflows/runs` and `GET /post-call/workflows/runs/:run_id` expose run and step audit metadata (admin token required).
- `POST /post-call/workflows/runs/:run_id/approve` resumes a workflow paused at an approval step; `POST /post-call/workflows/runs/:run_id/cancel` cancels queued or paused runs (admin token required).
- `GET /post-call/businesses/:business_id/integrations/connections` lists sanitized business integration connection metadata (admin token required).
- `POST /post-call/businesses/:business_id/integrations/connections` registers a HubSpot connection using a `secret_reference` such as `env://BUSINESS_INTEGRATION_SECRET_ACME_HUBSPOT` (admin token required). The named environment variable must be present and non-empty when the connection is created.
- `POST /post-call/businesses/:business_id/integrations/connections/:connection_id/revoke` revokes the exact connection within that business (admin token required; request body must be empty).
- `POST /crm/contact-sync` syncs a contact plus post-call note.
- `POST /crm/contact-sync/health` checks whether the configured CRM provider can run in native mode.

Workflow definitions use schema version 1 and are stored separately from currently executing automation rules. Branches must form an acyclic, reachable graph; wait steps are bounded to a 30-day total; action types are restricted to the existing email, CRM sync, and ticket actions; credential-shaped fields are rejected. With `POST_CALL_WORKFLOWS_ENABLED=true`, approved definitions become eligible for future `post_call_completed` events. The worker stores per-step status but does not retain action result payloads; interrupted actions stop for manual review and are never automatically replayed.

These endpoints use the repository's shared admin-token authorization. Approval records the `admin_token` principal label, not an individual admin identity, and definitions are not tenant-scoped; retain them as internal admin-only controls until identity and tenant ownership are available.

Active run payloads expire after 90 days and are cleared on completion, cancellation, expiry, or transition to `needs_review`. Run metadata, a call reference when present, and step audit remain for operator review; the run list accepts `workflow_id`, `status`, and `trigger_reference` filters.

CRM provider environment:

- `CRM_PROVIDER=stub|hubspot|airtable|gohighlevel|salesforce|managed`
- `CRM_REQUEST_TIMEOUT_MS=15000`
- `HUBSPOT_API_KEY`
- `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `AIRTABLE_CONTACTS_TABLE`, `AIRTABLE_ACTIVITIES_TABLE`
- `GOHIGHLEVEL_API_KEY`, `GOHIGHLEVEL_LOCATION_ID`
- `SALESFORCE_ACCESS_TOKEN`, `SALESFORCE_INSTANCE_URL`

When native CRM credentials are missing, the sync endpoints keep using local interface persistence and return `pending_provider_adapter` instead of failing the whole post-call workflow.

## Telegram Mini App Replay Validation

Mini App session bootstrap now supports replay validation modes:

- `MINI_APP_REPLAY_VALIDATION=warn` (default): replay is detected and logged, but session issuance continues.
- `MINI_APP_REPLAY_VALIDATION=strict`: replay is rejected with HTTP `409` and code `miniapp_replay_detected`.
- `MINI_APP_REPLAY_VALIDATION=off`: replay detection is disabled.

Related controls:

- `MINI_APP_REPLAY_WINDOW_SECONDS` defines the dedupe window.
- `MINI_APP_INITDATA_MAX_AGE_SECONDS` controls Telegram init-data freshness validation during session bootstrap (recommended: `86400` for production operator consoles to avoid frequent relaunch expiry).
- `MINI_APP_INITDATA_EXPIRY_GRACE_SECONDS` allows bounded post-expiry session bootstrap grace (recommended: `604800` for operator consoles to reduce forced Telegram relaunch loops while replay checks remain enabled).

Recommended rollout:

1. Start with `warn` in production and monitor `miniapp_route` and `miniapp_alert` health events.
2. Switch to `strict` after validating there are no legitimate duplicate launch flows.
3. Keep `off` only for short-term troubleshooting.

## API HMAC Replay Validation

API request HMAC verification now supports replay-validation modes:

- `API_HMAC_REPLAY_VALIDATION=warn` (default): replay is detected and logged, request is still accepted.
- `API_HMAC_REPLAY_VALIDATION=strict`: replay is rejected during HMAC verification.
- `API_HMAC_REPLAY_VALIDATION=off`: replay detection is disabled.

Related controls:

- `API_HMAC_REPLAY_WINDOW_MS` sets the replay dedupe window.
- `API_HMAC_MAX_SKEW_MS` keeps timestamp tolerance bounded.

Recommended rollout:

1. Run `warn` first and monitor `api_auth` health events for replay noise.
2. Move to `strict` only after verifying callers sign each retry with a fresh timestamp.

## Post-Call QA Scoring (Feature-Flagged)

Post-call QA evaluation can now run at call-end with default-safe gates:

- `POST_CALL_QA_ENABLED=false`
- `POST_CALL_QA_SHADOW_MODE=true`
- `POST_CALL_QA_ROLLOUT_PERCENT=0`
- `POST_CALL_QA_ALLOWLIST=`
- `POST_CALL_QA_KILL_SWITCH=false`
- `POST_CALL_QA_PROFILE_THRESHOLDS=` (optional: `collections:78,support:72,sales:74,verification:80`)
- `POST_CALL_QA_RUBRIC_WEIGHTS=` (optional JSON object for rubric weighting)

Approved post-call workflow definitions have a durable execution worker, but execution is disabled by default:

- `POST_CALL_WORKFLOWS_ENABLED=false`
- `POST_CALL_WORKFLOWS_POLL_INTERVAL_MS=1500` (clamped to a bounded interval)
- The `post_call_completed` trigger carries the existing post-call context. The separate `post_call_outcome_classified` trigger carries only the call SID, normalized telephone outcome, a neutral classification (`completed`, `not_connected`, `failed`, `canceled`, or `unknown`), and notification type; it excludes transcript, contact, phone, and CALL-E result data. `completed` does not claim that a person answered. Both use stable event idempotency keys.
- CALL-E's `call_e_result_ready` trigger is scoped to the business recorded on the accepted local call and runs only after authenticated reconciliation confirms `result_status=available` and validates the result against the pinned schema. Its payload contains business/call/template identifiers and execution/outcome/status metadata only; result content, transcript, phone, raw webhook, and provider payload are excluded. Optional result classifications use explicit enum option indices pinned to a template ID/version and add only configured fixed labels (positive, negative, neutral, requires_review, or unknown) under `business_result_classifications`; raw enum values and result schema are never stored in workflow runs. Scope is immutable across workflow versions, and this event currently allows branch, wait, approval, and end steps only; existing external action adapters are not business-scoped. If execution is disabled, the terminal webhook is still acknowledged after reconciliation and that event is not backfilled later.
- CALL-E Goal Runs also trigger `call_e_result_ready` after reconciliation validates the provider result against the published Goal Run schema. The event uses a stable local request/spec idempotency key, retains only business and Goal/spec/status metadata plus configured safe classifications, and can be reconciled repeatedly without creating duplicate workflow runs.
- CALL-E campaign rehearsal saves business-scoped review reports after rechecking operator membership, consent/opt-out, and template compatibility for up to 25 submitted destinations. Reports store masked destinations, readiness, and fixed reason codes; raw campaign numbers and schemas are not persisted. Reports require a different `policy_manager` to approve/reject. Campaign and mission approval decisions are written atomically to an append-only business-scoped audit ledger with the reviewed request fingerprint; prior decisions are backfilled on initialization. Preflight rechecks the exact submitted destinations/schema, live pinned template, and current consent; it never dispatches.
- CALL-E mission destinations are encrypted at rest with versioned keys (`CALLE_MISSION_ENCRYPTION_KEYS`, `CALLE_MISSION_ENCRYPTION_KEY_VERSION`). Keep old key versions until their missions are terminal. `/callmissions`, `/callmissionreview`, `/callmissioninfo`, `/callmissionresolve`, and `/callmissionadvance` are BOT controls. Each advance can submit at most one recipient, and later recipients wait until the prior call execution and result state are terminal. Unknown outcomes reuse the persisted recipient idempotency key; failed calls/results leave the mission in review. A distinct policy manager can auditably continue or cancel a paused mission with `/callmissionresolve`; continuing records the decision but does not itself place a call. The BOT shows a resolution request key before submitting; include that same key when retrying after an uncertain response.
- Mission dispatch is disabled by default. It requires `CALLE_MISSION_DISPATCH_ENABLED=true`, the existing `CALLE_DISPATCH_ENABLED=true` and `CALLE_PILOT_READINESS_REVIEWED=true`, a configured `CALLE_MISSION_APPROVED_ID` and matching `CALLE_MISSION_APPROVED_FINGERPRINT`, a non-expired approval reference/expiry, and `CALLE_MISSION_MAX_RECIPIENTS` covering the complete mission. The automation worker also defaults off; when enabled, it advances only due, scheduled, already-approved missions through the same API service and exact single-mission pilot gate.
- Mission advance additionally requires a business-scoped policy-manager safety policy with a daily CALL-E mission call cap, IANA timezone, optional quiet-hour interval, emergency-stop state, and contact cooldown (0–8760 hours). Missing policy or active stop blocks dispatch. Cooldown checks use a keyed destination digest and reserve the contact before dispatch; confirmed provider rejection releases the reservation, while accepted or uncertain submissions remain suppressed. `/calle` → **Mission safety / worker** configures these controls and shows worker/recovery status.
- `/callmissioncreate` can optionally stage a timezone-qualified launch time and a budget reservation. The budget requires both a total cap and operator-supplied per-recipient cost ceiling in minor currency units; API/SQLite reserves that ceiling before each dispatch and stops when reservations would exceed the cap. This is an operational estimate, not a guarantee of provider charges, which may vary by call duration and provider pricing. A separate policy manager reviews the schedule and budget as part of the immutable mission request.
- Review policy can set a one-time review escalation deadline in minutes. When a mission remains pending approval past that deadline, the automation worker appends a durable escalation event; opted-in operators receive it through the existing mission alert worker. `CALLE_OPS_ALERTS_WORKER_ENABLED=true` is also required for Telegram delivery.
- `GET`/`PUT /api/call-e/mission-report-digest-subscription` lets a current operator opt into daily or weekly private report summaries. `CALLE_MISSION_AUTOMATION_WORKER_ENABLED=false` disables scheduled launches, review escalation processing, and report digests by default. Enable it only after reviewing dispatch gates and Telegram configuration. Digest subscribers are checked against current business membership before delivery.
- Mission advance remains sequential: only one recipient is claimed at a time, and the next waits for terminal call and result state. Current consent, template, approval, business safety, contact cooldown, budget reservation, and provider uncertainty checks run immediately before dispatch. Confirmed provider rejection releases budget/contact reservations; ambiguous outcomes retain them and cannot use the normal retry action.
- `GET /api/call-e/mission-safety` and `PUT /api/call-e/mission-safety` read and update the business safety policy (updates require a policy manager). `GET`/`PUT /api/call-e/missions/:missionId/worker` inspect or pause/resume the worker for a scoped mission. `GET /api/call-e/operations-audit` returns the scoped control and retention audit.
- Sensitive CALL-E mission destinations and Goal Run request/result payloads default to a 90-day retention period (`CALLE_SENSITIVE_DATA_RETENTION_DAYS`). `CALLE_DATA_RETENTION_WORKER_ENABLED=false` keeps scheduled purge off by default; when enabled, the bounded worker clears only expired encrypted payloads and pinned result schemas, marks in-flight records for review, and records aggregate audit metadata while retaining approval/review history and masked operational status. The BOT retention page shows an expiry preview and also supports exact-confirmation, policy-manager scoped purge.
- Provider routing follows `CALL_PROVIDER_ORDER` after the explicitly preferred provider, then considers only providers ready for the requested flow and outside an open circuit. Existing safe failover remains limited to errors known not to have submitted the call; uncertain provider submission never triggers a second provider attempt. The provider menu reports configured order, currently eligible order, readiness blocks, open circuits, and failover mode. Twilio, Plivo, and Vonage provider adapters and their request contracts are unchanged.
- Business-level mission approval policy supports a second, different policy manager above a configurable recipient threshold, approval expiry from 1 to 720 hours, and a review escalation SLA from 0 to 10080 minutes (0 disables escalation). The API enforces approval; a mission awaiting its second reviewer remains `pending_approval`, and expired or incomplete approval blocks dispatch. `/calle` → **Approval policy** edits the policy.
- Mission details include a bounded append-only activity timeline and masked recipient statuses. `/calle` → **Retry rejected recipient** can only requeue a `call_e_request_rejected` recipient after the API confirms there are no active recipients. It does not place a call; a separate mission advance repeats current consent and safety checks. Ambiguous or uncertain provider outcomes cannot be retried through this action.
- `GET`/`PUT /api/call-e/mission-approval-policy` read or update approval threshold, expiry, and review SLA; `GET`/`PUT /api/call-e/provider-routing` read or set a business provider priority; `GET /api/call-e/mission-report` returns bounded aggregate counts for a date range of up to 90 days; and `GET`/`PUT /api/call-e/mission-alert-subscription` plus `/api/call-e/mission-report-digest-subscription` manage per-operator notification preferences. Policy changes require a business `policy_manager`; subscriptions require current membership.
- A business provider priority is used only when an outbound call references a business-owned script. An explicit per-call preferred provider stays first, followed by the business order and global fallback order; readiness, circuit, capability, and uncertain-submission protections still apply. The per-business list does not create credentials or enable an unconfigured provider.
- The policy-manager BOT/API contact-consent center reads a masked destination summary and records append-only consent/withdrawal evidence (`GET /api/call-e/contact-policy`, `POST /api/call-e/contact-policy/events`). Writes use the signed BOT actor assertion and current business membership; the raw destination and evidence reference are not returned in the status response. Recording evidence does not override an opt-out or the final consent check at dispatch.
- The `/calle` review assignment inbox lists escalated, unresolved mission reviews and supports policy-manager assignment and assignee acknowledgement (`GET /api/call-e/mission-review-inbox`, `POST /api/call-e/mission-review-actions`). Assignment and acknowledgement are persisted idempotently in mission activity; an unassigned reviewer cannot acknowledge another operator's work.
- Provider routing preview (`POST /api/call-e/provider-routing/preview`) reports eligible order, readiness and circuit state before the BOT optionally saves a business preference. Preview does not dispatch. Routing still uses existing provider adapters; uncertain submissions never fail over automatically.
- Mission usage records are operator-entered imports (`POST /api/call-e/mission-usage`) and reports are business-scoped (`GET /api/call-e/missions/:missionId/usage`). Amounts use integer minor units and explicit currency; budget alerts compare only matching currencies. The API does not fetch provider billing accounts. Twilio's per-call price can arrive after completion and excludes feature charges, while its Usage Records are account-level aggregates; Plivo and Vonage CDR/report fields also follow provider-specific semantics ([Twilio Call resource](https://www.twilio.com/docs/voice/api/call-resource), [Twilio Usage Records](https://www.twilio.com/docs/usage/api/usage-record), [Plivo Calls CDR](https://www.plivo.com/docs/voice/api/calls), [Vonage Voice API](https://developer.vonage.com/en/api/voice), [Vonage Reports](https://developer.vonage.com/en/reports/overview)). Entries are labeled operator-entered and are not presented as independently reconciled account charges.
- Structured-result follow-up rules use only the existing `create_ticket` action for `call_e_result_ready` and require two distinct approvals: a policy manager approves the action definition, then a current policy manager approves each waiting run. Routes are `/api/call-e/result-follow-up-workflows`, `/api/call-e/result-follow-up-workflows/:workflowId/versions/:version/approve-actions`, and `/api/call-e/result-follow-up-workflows/runs/:runId/approve`. Execution remains on the durable workflow worker after approval; the BOT exposes guided list/create/approve steps with idempotency for action approval.
- Proactive Telegram mission alerts require an operator's explicit per-business subscription and `CALLE_OPS_ALERTS_WORKER_ENABLED=true`; the worker is disabled by default and uses the API server's Telegram bot token. Messages contain only mission IDs, recipient positions, states, and sanitized error codes. When the worker is disabled, the existing `/calle` mission-attention feed remains available.
- `/callplan` previews an existing live template with current consent and clarifications; planning does not dial. `/callresults` lists scoped lifecycle/result summaries. `/callresult <local_call_id>` shows only a schema-validated structured result in a private BOT chat. `/callquality <local_call_id>` returns content-free transcript/result signals and a transcript-based IVR menu heuristic. A documented `call.dtmf` event is recorded as event presence only; VOICEDNUT does not infer the entered digit or claim menu navigation.
- Call script promotion is blocked unless the currently approved content fingerprint has a full passing Agent Lab run with a score of at least 90%. `/api/call-scripts/:id/promotion-readiness` returns blockers and per-scenario status/code summaries; `/api/call-scripts/:id/promote-live` rechecks the gate and current version before promotion. The BOT exposes a read-only readiness summary and shows it again before the separate live-promotion confirmation. Agent Lab cases are deterministic synthetic checks and do not use an LLM judge or make provider requests.
- Agent Lab accepts selected scenario IDs for focused debugging and labels those results `evaluation_scope: focused` with `complete_suite: false`. BOT can rerun only failures from a recent run after an edit; focused runs remain non-promotable, and a complete passing suite for the current approved fingerprint is still required.
- Each successful live promotion atomically records an append-only event with script/version, actor label, passing simulation run/score/fingerprint, timestamp, and the previously live script/version when present. `GET /api/call-scripts/:id/promotion-history` is admin-token protected; it remains available for deleted scripts with retained history. BOT Script Designer provides an interactive **Promotion history** view. The BOT sends its authenticated Telegram numeric user ID as the actor label; for other API clients, `x-admin-user` is a caller-supplied label under the shared admin token, not an independently verified identity. Existing interactive rollback restores a saved snapshot as a draft, requiring review, a fresh Agent Lab pass, and approval before promotion.
- `POST /api/call-e/planner/suggest` ranks live templates for a bounded free-form goal; `/api/call-e/planner/preview` remains a no-call consent/schema preview. `GET /api/call-e/calls/:localCallId/result` returns a size-bounded, schema-validated result only to a current business operator. `GET /api/call-e/calls/:localCallId/quality` returns bounded content-free quality signals. `GET /api/call-e/campaign-rehearsals` lists campaign rehearsal summaries; campaign review actions use the authenticated `calle.campaign.*` action contract. Mission endpoints live under `/api/call-e/missions`; dispatch remains behind business membership, consent, idempotency, exact approval, and budget gates.
- CALL-E campaign draft/list/get/review APIs are available under `/api/call-e/campaigns`; mission APIs are under `/api/call-e/missions`. `/callcampaigncreate`, `/callcampaignreview`, `/callcampaigns`, and `/callmissioncreate` provide the BOT creation/review path. Campaign and mission conversations collect destinations only in private chats, require explicit authorization confirmation and reusable idempotency keys, and stage records without calling. Backend consent checks and distinct policy-manager reviews remain mandatory. `/callreconcile` refreshes a business-scoped call snapshot and durable event cursor using provider reads only; its response omits transcript and destination data.

CALL-E operator routes that accept a Telegram actor ID also require `CALL_E_ACTOR_ASSERTION_SECRET` on both API and BOT. Configure the same randomly generated value of at least 32 characters in each server-side environment. The BOT signs the actor, method, path, and request body; the API verifies the assertion before business membership and policy-manager checks. Requests fail closed if this dedicated secret is missing. Do not configure it in Mini App or client-visible environments.
- Business integration connection records contain metadata and an opaque environment reference only; credential values never enter SQLite or API responses. References must use the `BUSINESS_INTEGRATION_SECRET_` prefix. Connection management is platform-admin-only, and lookup/revocation requires the exact business ID and connection ID. This is metadata and secret-resolution infrastructure only: it does not authorize or dispatch business-scoped CRM actions. Do not set business secret environment variables or create connections in production until the secret lifecycle and operator ownership are reviewed.
- Runs persist a sanitized trigger payload, workflow version, cursor, step audit, bounded waits, and human approval pauses. Interrupted external action steps stop in `needs_review`; they are never replayed automatically.
- Each action is bounded to 60 seconds. If a provider call times out, its outcome is treated as ambiguous and the workflow pauses for review.
- `GET /post-call/workflows/runs` and `GET /post-call/workflows/runs/:run_id` provide admin-token-only audit views. `POST /post-call/workflows/runs/:run_id/approve` resumes a human-approval pause, and `POST /post-call/workflows/runs/:run_id/cancel` cancels queued or paused runs. Running external actions cannot be canceled because their outcome may be ambiguous.
- The direct workflow definition and run endpoints remain admin-token-only. The Mini App also exposes a limited platform-admin surface through its signed session/action bridge (`workflow_manage`, granted only to the `admin` role): admins can save drafts and inspect version/run/step metadata. It does not expose definition approval, run approval, cancellation, or stored trigger/action payloads. This platform-wide admin surface is separate from CALL-E business-operator access.

Manual API controls:

- `GET /api/qa/summary`
- `GET /api/calls/:callSid/qa`
- `POST /api/calls/:callSid/qa/evaluate?force=1`

## Adaptive Persona and Mood Profiles

The API ships with adaptive persona handling that inspects call metadata (business domain, purpose, channel, urgency, and mood signals) and produces the appropriate system prompt and greeting. Personality and profile logic currently live in:

- `api/functions/PersonalityEngine.js`
- `api/routes/gpt.js`

Voice calls and SMS conversations automatically fall back to the default adaptive prompt when no persona is supplied, so free-form prompts continue to work as before.

## Setting up for Development

### Prerequisites
Use Node.js 24 and npm. For local development, the API can start without provider credentials; add credentials only for integrations you plan to use.

### 1. Configure the minimal local environment
If you don't already have a local `.env`, copy `.env.example` to `.env`, then replace the `API_SECRET` placeholder with a unique value (for example, generate one with `openssl rand -hex 32`). Keep `.env` local and never commit it. The `.env.advanced.example` file lists optional integration and runtime settings.

```bash
if [ ! -f .env ]; then cp .env.example .env; fi
```

Set `SERVER` to your public HTTPS hostname only when configuring provider webhooks. A tunnel such as [ngrok](https://ngrok.com) is optional for local webhook testing.

### 2. Install Dependencies with NPM
Install the necessary packages:

```bash
npm ci
```

### 3. Start Your Server in Development Mode
Run the following command:
```bash
npm run dev
```
This will start your app using `nodemon` so that any changes to your code automatically refreshes and restarts the server.

### 4. Optional: Enable the Default Voice Flow

The minimal environment only starts the API. To enable the default Twilio voice flow and its AI/transcription services, add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `FROM_NUMBER`, `DEEPGRAM_API_KEY`, and `OPENROUTER_API_KEY` to `.env`. Configure `SERVER` with the public HTTPS hostname when setting up provider webhooks.

### 5. Optional: Configure an Incoming Phone Number

Connect a phone number using the [Twilio Console](https://console.twilio.com/us1/develop/phone-numbers/manage/incoming).

You can also use the Twilio CLI:

```bash
twilio phone-numbers:update +1[your-twilio-number] --voice-url=https://your-server.ngrok.io/incoming
```
This configuration tells Twilio to send incoming call audio to your app when someone calls your number. The app responds to the incoming call webhook with a [Stream](https://www.twilio.com/docs/voice/twiml/stream) TwiML verb that will connect an audio media stream to your websocket server.

## Application Workflow
CallGPT coordinates the data flow between multiple different services including Deepgram, OpenAI, and Twilio Media Streams:
![Call GPT Flow](https://github.com/twilio-labs/call-gpt/assets/1418949/0b7fcc0b-d5e5-4527-bc4c-2ffb8931139c)


## Modifying the ChatGPT Context & Prompt
Within `gpt-service.js` you'll find the settings for the GPT's initial context and prompt. For example:

```javascript
this.userContext = [
  { "role": "system", "content": "You are an outbound sales representative selling Apple Airpods. You have a youthful and cheery personality. Keep your responses as brief as possible but make every attempt to keep the caller on the phone without being rude. Don't ask more than 1 question at a time. Don't make assumptions about what values to plug into functions. Ask for clarification if a user request is ambiguous. Speak out all prices to include the currency. Please help them decide between the airpods, airpods pro and airpods max by asking questions like 'Do you prefer headphones that go in your ear or over the ear?'. If they are trying to choose between the airpods and airpods pro try asking them if they need noise canceling. Once you know which model they would like ask them how many they would like to purchase and try to get them to place an order. Add a '•' symbol every 5 to 10 words at natural pauses where your response can be split for text to speech." },
  { "role": "assistant", "content": "Hello! I understand you're looking for a pair of AirPods, is that correct?" },
],
```
### About the `system` Attribute
The `system` attribute is background information for the GPT. As you build your use-case, play around with modifying the context. A good starting point would be to imagine training a new employee on their first day and giving them the basics of how to help a customer.

There are some context prompts that will likely be helpful to include by default. For example:

- You have a [cheerful, wise, empathetic, etc.] personality.
- Keep your responses as brief as possible but make every attempt to keep the caller on the phone without being rude.
- Don't ask more than 1 question at a time.
- Don't make assumptions about what values to plug into functions.
- Ask for clarification if a user request is ambiguous.
- Add a '•' symbol every 5 to 10 words at natural pauses where your response can be split for text to speech.

These context items help shape a GPT so that it will act more naturally in a phone conversation.

The `•` symbol context in particular is helpful for the app to be able to break sentences into natural chunks. This speeds up text-to-speech processing so that users hear audio faster.

### About the `content` Attribute
This attribute is your default conversations starter for the GPT. However, you could consider making it more complex and customized based on personalized user data.

In this case, our bot will start off by saying, "Hello! I understand you're looking for a pair of AirPods, is that correct?"

## Using Function Calls with GPT
You can use function calls to interact with external APIs and data sources. For example, your GPT could check live inventory, check an item's price, or place an order.

### How Function Calling Works
Function calling is handled within the `gpt-service.js` file in the following sequence:

1. `gpt-service` loads `function-manifest.js` and requires (imports) all functions defined there from the `functions` directory. Our app will call these functions later when GPT gives us a function name and parameters.
```javascript
tools.forEach((tool) => {
  const functionName = tool.function.name;
  availableFunctions[functionName] = require(`../functions/${functionName}`);
});
```

2. When we call GPT for completions, we also pass in the same `function-manifest` JSON as the tools parameter. This allows the GPT to "know" what functions are available:

```javascript
const stream = await this.openai.chat.completions.create({
  model: 'gpt-4',
  messages: this.userContext,
  tools, // <-- function-manifest definition
  stream: true,
});
```
3. When the GPT responds, it will send us a stream of chunks for the text completion. The GPT will tell us whether each text chunk is something to say to the user, or if it's a tool call that our app needs to execute.  This is indicated by the `deltas.tool_calls` key:
```javascript
if (deltas.tool_calls) {
  // handle function calling
}
```
4. Once we have gathered all of the stream chunks about the tool call, our application can run the actual function code that we imported during the first step. The function name and parameters are provided by GPT:
```javascript
const functionToCall = availableFunctions[functionName];
const functionResponse = functionToCall(functionArgs);
```
5. As the final step, we add the function response data into the conversation context like this:

```javascript
this.userContext.push({
  role: 'function',
  name: functionName,
  content: functionResponse,
});
```
We then ask the GPT to generate another completion including what it knows from the function call. This allows the GPT to respond to the user with details gathered from the external data source.

### Adding Custom Function Calls
You can have your GPT call external data sources by adding functions to the `/functions` directory. Follow these steps:

1. Create a function (e.g. `checkInventory.js` in `/functions`)
1. Within `checkInventory.js`, write a function called `checkInventory`.
1. Add information about your function to the `function-manifest.js` file. This information provides context to GPT about what arguments the function takes.

**Important:** Your function's name must be the same as the file name that contains the function (excluding the .js extension). For example, our function is called `checkInventory` so we have named the the file `checkInventory.js`, and set the `name` attribute in `function-manifest.js` to be `checkInventory`.

Example function manifest entry:

```javascript
{
  type: "function",
  function: {
    name: "checkInventory",
    say: "Let me check our inventory right now.",
    description: "Check the inventory of airpods, airpods pro or airpods max.",
    parameters: {
      type: "object",
      properties: {
        model: {
          type: "string",
          "enum": ["airpods", "airpods pro", "airpods max"],
          description: "The model of airpods, either the airpods, airpods pro or airpods max",
        },
      },
      required: ["model"],
    },
    returns: {
      type: "object",
      properties: {
        stock: {
          type: "integer",
          description: "An integer containing how many of the model are in currently in stock."
        }
      }
    }
  },
}
```
#### Using `say` in the Function Manifest
The `say` key in the function manifest allows you to define a sentence for the app to speak to the user before calling a function. For example, if a function will take a long time to call you might say "Give me a few moments to look that up for you..."

### Receiving Function Arguments
When ChatGPT calls a function, it will provide an object with multiple attributes as a single argument. The parameters included in the object are based on the definition in your `function-manifest.js` file.

In the `checkInventory` example above, `model` is a required argument, so the data passed to the function will be a single object like this:

```javascript
{
  model: "airpods pro"
}
```
For our `placeOrder` function, the arguments passed will look like this:

```javascript
{
  model: "airpods pro",
  quantity: 10
}
```
### Returning Arguments to GPT
Your function should always return a value: GPT will get confused when the function returns nothing, and may continue trying to call the function expecting an answer. If your function doesn't have any data to return to the GPT, you should still return a response with an instruction like "Tell the user that their request was processed successfully." This prevents the GPT from calling the function repeatedly and wasting tokens. 

Any data that you return to the GPT should match the expected format listed in the `returns` key of `function-manifest.js`.

## Utility Scripts for Placing Calls
The `scripts` directory contains two files that allow you to place test calls:
- `npm run inbound` will place an automated call from a Twilio number to your app and speak a script. You can adjust this to your use-case, e.g. as an automated test.
- `npm run outbound` will place an outbound call that connects to your app. This can be useful if you want the app to call your phone so that you can manually test it.

## Using Eleven Labs for Text to Speech
Replace the Deepgram API call and array transformation in tts-service.js with the following call to Eleven Labs. Note that sometimes Eleven Labs will hit a rate limit (especially on the free trial) and return 400 errors with no audio (or a clicking sound).

```
try {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream?output_format=ulaw_8000&optimize_streaming_latency=3`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.XI_API_KEY,
        'Content-Type': 'application/json',
        accept: 'audio/wav',
      },
      body: JSON.stringify({
        model_id: process.env.XI_MODEL_ID,
        text: partialResponse,
      }),
    }
  );
  
  if (response.status === 200) {
    const audioArrayBuffer = await response.arrayBuffer();
    this.emit('speech', partialResponseIndex, Buffer.from(audioArrayBuffer).toString('base64'), partialResponse, interactionCount);
  } else {
    console.log('Eleven Labs Error:');
    console.log(response);
  }
} catch (err) {
  console.error('Error occurred in XI LabsTextToSpeech service');
  console.error(err);
}
```


## Testing with Jest
Repeatedly calling the app can be a time consuming way to test your tool function calls. This project contains example unit tests that can help you test your functions without relying on the GPT to call them.

Simple example tests are available in the `/test` directory. To run them, simply run `npm run test`.

## Deploy via Fly.io
Fly.io is a hosting service similar to Heroku that simplifies the deployment process. Given Twilio Media Streams are sent and received from us-east-1, it's recommended to choose Fly's Ashburn, VA (IAD) region.

> Deploying to Fly.io is not required to try the app, but can be helpful if your home internet speed is variable.

Modify the app name `fly.toml` to be a unique value (this must be globally unique).

Deploy the app using the Fly.io CLI:
```bash
fly launch

fly deploy
```

Import your secrets from your .env file to your deployed app:
```bash
fly secrets import < .env
```

## Cartesia text-to-speech

Deepgram remains the default TTS provider. To opt into Cartesia, set `TTS_PROVIDER=cartesia`, `CARTESIA_API_KEY`, and `CARTESIA_VOICE_ID` in the API server environment. `CARTESIA_TTS_MODEL` defaults to `sonic-3.6`; the API version header defaults to `2026-08-14`. Credentials stay server-side.

The adapter consumes Cartesia's SSE audio chunks, combines them into the existing ordered speech payload, and converts raw PCM16 to μ-law when the telephony stream requests μ-law. The current call bridge does not yet play chunks as they arrive. WAV/container output is rejected because the bridge expects raw audio. Cartesia errors fall back to Deepgram by default; set `CARTESIA_TTS_FALLBACK_TO_DEEPGRAM=false` to disable that fallback.

## Cartesia Managed Agents configuration

Managed Agents use the server-side `CARTESIA_API_KEY` and `CARTESIA_API_VERSION` settings, separately from the `TTS_PROVIDER` selection. The feature is disabled by default; set `CARTESIA_MANAGED_AGENTS_ENABLED=true` only after configuring a standard Cartesia API key (`sk_car_...`). Admin keys are not interchangeable with standard keys. `CARTESIA_MANAGED_AGENTS_TIMEOUT_MS` bounds the read-only credential validation request. The client validates credentials with Cartesia's `GET /v1/agents?limit=1` endpoint and discards the returned agent data. Validation is explicit and is not performed at startup. No call creation or number management is part of this configuration phase.

## Cartesia Managed Agents calls

The admin API provides `GET /api/cartesia/status`, `POST /api/cartesia/calls/preview`, `POST /api/cartesia/calls`, `GET /api/cartesia/calls/:providerCallId`, and `POST /api/cartesia/calls/:providerCallId/cancel`. All require the existing admin token. A call preview checks the business-scoped consent/opt-out ledger and `CARTESIA_ALLOWED_DESTINATIONS`. Dispatch additionally requires `CARTESIA_DISPATCH_ENABLED=true`, `approved: true`, the exact preview `confirmed_fingerprint`, and an idempotency key. Cartesia's create-call endpoint dials immediately and its current contract does not document an idempotency header; VOICEDNUT submits one recipient per request and does not retry ambiguous submissions. A repeated key cannot start a second call.

Cartesia batch calling is available through `POST /api/cartesia/call-batches/preview`, `POST /api/cartesia/call-batches`, `GET /api/cartesia/call-batches`, `GET /api/cartesia/call-batches/:batchId`, `POST /api/cartesia/call-batches/:batchId/reconcile`, `GET /api/cartesia/call-batches/:batchId/records`, and `POST /api/cartesia/call-batches/:batchId/cancel`, all admin-token protected. Batch listing supports Cartesia's `limit` (1–100), `starting_after`, `ending_before`, and `agent_id` query filters and returns the documented `has_more` and `next_page` cursor values. Preview validates every unique E.164 destination against the same business-scoped consent and allowlist policy as one-off calls. The provider supports 1–5,000 recipients; VOICEDNUT rejects duplicates and requires a fresh preview fingerprint, `approved: true`, and an idempotency key for dispatch. Set `CARTESIA_BATCH_DISPATCH_ENABLED=true` only after separately reviewing the batch. It defaults to false. Ambiguous submissions remain unresolved and are never retried automatically. Cartesia's cancel endpoint stops queued calls while calls already in progress continue. Provider retry is intentionally not exposed because it can redial failed or unanswered recipients without per-recipient reapproval. Batch scheduling is not exposed; this workflow submits immediately after approval. Bot commands `/cartesia batch <batch_id>` and `/cartesia cancel-batch <batch_id> CANCEL` provide admin-only reconciliation/status and explicitly confirmed cancellation; status messages omit recipient data.

VOICEDNUT stores batch-level status and recipient attempt snapshots locally. Expected phone numbers are saved with a `awaiting_provider_snapshot` state, then reconciled from Cartesia's batch detail API into provider recipient ID, provider status, call ID, end reason, and an error-present flag. Dynamic variables and free-form provider error messages are never stored. Each batch is associated with the business ID used during preflight, and local recipient reads are joined through that business-scoped batch record. Reconciliation is explicit and repeatable; it uses provider `last_updated_at` to prevent older snapshots from overwriting newer data. The additive tables are created by the normal SQLite schema initializer, require no backfill, and are ignored by older application versions. Keep existing SQLite backup practices before upgrading shared deployments; rollback is an application rollback while retaining the added tables.

Cartesia lifecycle events are accepted at `POST /api/webhooks/cartesia` when `CARTESIA_WEBHOOK_SECRET` is configured. Set `SERVER` to VOICEDNUT's public HTTPS hostname, configure a strong shared secret in `CARTESIA_WEBHOOK_SECRET`, then request `POST /api/cartesia/webhooks/preview`. The preview shows only the endpoint host/path and a confirmation fingerprint. To create the webhook, send `POST /api/cartesia/webhooks` over HTTPS with `approved: true`, the exact `confirmed_fingerprint`, and an idempotency key. This sends the configured secret to Cartesia server-to-server; the response secret is checked against local configuration and discarded. Creation requires `CARTESIA_WEBHOOK_MUTATIONS_ENABLED=true` (default false). Cartesia's create API does not document an idempotency header, so VOICEDNUT uses a durable endpoint-scoped reservation and refuses to repeat a create after an ambiguous outcome. Inspect the Cartesia dashboard and local operation state before recovery from an ambiguous response.

Attach the created webhook to the agent through Cartesia or through the preview/confirmation endpoints `POST /api/cartesia/agents/:agentId/webhook/assignment/preview` and `PUT /api/cartesia/agents/:agentId/webhook/assignment`. Assignment also requires HTTPS, `approved: true`, the exact preview fingerprint, an idempotency key, and `CARTESIA_WEBHOOK_MUTATIONS_ENABLED=true`. The webhook ID can be read from the successful create response or Cartesia's webhook settings; VOICEDNUT never accepts or returns the secret or full webhook URL through these management routes. Because Cartesia omits webhook secrets from read responses, confirm the configured URL and matching secret before attaching. The event handler verifies `x-webhook-secret`, deduplicates `webhook_request_id`, rejects event-ID payload conflicts, and persists call identifiers and lifecycle metadata. It does not persist raw webhook payloads, transcripts, or summaries. Authorized administrators can retrieve current provider call detail through the GET route; Cartesia may omit content when Zero Data Retention is enabled. Creation and attachment attempts are recorded in additive audit tables surfaced through the existing provider-operation audit feed.

All call dispatch settings remain disabled/empty in `.env.example`. Do not enable outbound dispatch until the number and agent are configured in Cartesia and the destination allowlist and consent evidence are verified.

## Cartesia phone number inventory and agent assignment

The admin API exposes `GET /api/cartesia/phone-numbers` with Cartesia's documented cursor filters (`limit`, `q`, `starting_after`, `ending_before`, `agent_id`, `provider_id`, and `type`) and `GET /api/cartesia/phone-numbers/:phoneNumberId`. Responses identify Cartesia-owned, Twilio-imported, and SIP-carrier numbers, and omit provider credential fields.

Inbound assignment is managed with `POST /api/cartesia/phone-numbers/:phoneNumberId/assignment/preview` (`{ "agent_id": "agent_id_here" }`; use `null` to unassign), followed by `PUT /api/cartesia/phone-numbers/:phoneNumberId/assignment` with the same `agent_id`, `approved: true`, the exact `confirmed_fingerprint`, and a caller-generated `idempotency_key`. The write endpoint also requires `CARTESIA_PHONE_NUMBER_MUTATIONS_ENABLED=true`; this is independent from outbound call dispatch and defaults to false. On an ambiguous PATCH response, VOICEDNUT reads the number once to reconcile and does not resubmit the change.

Provider-number import uses `POST /api/cartesia/phone-numbers/import/preview` followed by `POST /api/cartesia/phone-numbers/import` with the same fields, `approved: true`, the preview fingerprint, and an idempotency key. It accepts only an existing Cartesia-linked Twilio or SIP provider ID, E.164 number, and optional Cartesia agent ID. It checks existing number inventory before submission and reconciles ambiguous submissions by number/provider. Import uses the same default-off `CARTESIA_PHONE_NUMBER_MUTATIONS_ENABLED` gate.

Cartesia number provisioning uses `POST /api/cartesia/phone-numbers/provision/preview` and then `/api/cartesia/phone-numbers/provision`. Provisioning has a separate default-off gate, `CARTESIA_PHONE_NUMBER_PROVISIONING_ENABLED=true`, because it may create a billable Cartesia-owned US number. The current Cartesia contract supports inbound and outbound calls to US destinations on these numbers. Execution requires the exact fingerprint, an idempotency key, `approved: true`, and `confirm_label` equal to the unique preview label. Ambiguous submissions reconcile against number inventory and never trigger blind retries.

Number release uses `POST /api/cartesia/phone-numbers/:phoneNumberId/release/preview` followed by `/release` with the exact fingerprint, typed `confirm_number`, approval, and idempotency key. It uses `CARTESIA_PHONE_NUMBER_MUTATIONS_ENABLED`. Cartesia-owned release is permanent; Cartesia-managed and SIP numbers must be unassigned first. Cartesia's API allows deleting Twilio-imported numbers while assigned and attempts, but does not guarantee, clearing the Twilio webhook. Ambiguous DELETE results are reconciled with a read-only lookup and are never retried automatically.

The admin API also exposes `GET /api/cartesia/providers`, `POST /api/cartesia/providers/sip/preview`, and `POST /api/cartesia/providers/sip`. SIP preview and creation require HTTPS because carrier credentials may be submitted to the server. Creation requires `CARTESIA_SIP_PROVIDER_MUTATIONS_ENABLED=true`, explicit approval, the exact preview fingerprint, and an idempotency key. Cartesia requires at least one inbound access control: digest credentials, a source IP allowlist, or allowed E.164 numbers. Prefer digest credentials or an IP allowlist; number-only rules may be weaker against caller-ID spoofing. This supports Twilio Elastic SIP Trunking, which Cartesia documents as requiring its signaling IP ranges instead of inbound digest auth. Credentials are sent only to Cartesia and are omitted from logs, responses, and local persistence. Ambiguous create outcomes are reconciled by a deterministic operation label; the service does not blindly submit a second create.

Twilio provider linking uses `POST /api/cartesia/providers/twilio/preview` and `POST /api/cartesia/providers/twilio`. It requires HTTPS, the independently default-off `CARTESIA_TELEPHONY_PROVIDER_MUTATIONS_ENABLED` flag, an exact preview fingerprint, explicit approval, typed account SID confirmation, and an idempotency key. The API accepts Twilio API key credentials (not an account auth token); Cartesia validates them during linking. VOICEDNUT never persists or returns the API key secret. An ambiguous response is reconciled against provider inventory by account SID and region; it is not resubmitted blindly.

Provider details are available via `GET /api/cartesia/providers/:providerId`; they return normalized configuration metadata only. Twilio credential rotation uses `POST /api/cartesia/providers/twilio/update/preview` and `/update`, requires HTTPS, the provider mutation gate, preview fingerprint, explicit approval, typed provider ID, and idempotency key. The new Twilio API key secret is sent only to Cartesia and is never persisted locally or returned. Cartesia validates updated credentials against assigned-number reachability; the local API deliberately returns sanitized errors.

SIP provider configuration updates use `POST /api/cartesia/providers/sip/update/preview` and `/update`, require HTTPS, `CARTESIA_SIP_PROVIDER_MUTATIONS_ENABLED=true`, exact preview approval, typed provider ID, linked-number count confirmation, and an idempotency key. VOICEDNUT sends the complete validated inbound/outbound configuration rather than a partial patch, and refuses updates that would leave inbound access without digest credentials, an IP allowlist, or allowed E.164 numbers. Credential values are redacted from previews and local persistence. If a trunk has linked numbers, the count must remain unchanged between preview and execution and is shown for operator review.

Provider deletion is available through `POST /api/cartesia/providers/:providerId/delete/preview` and `DELETE /api/cartesia/providers/:providerId`. It uses HTTPS, the same default-off provider mutation gate, explicit preview approval, typed label, and idempotency key. Before preview and again before deletion, VOICEDNUT fully paginates Cartesia's phone-number list filtered by provider ID; deletion is blocked unless the inventory is complete and no numbers remain linked. An ambiguous DELETE is reconciled by provider inventory and is never blindly repeated. Deleting a provider is an externally destructive operation; keep the gate disabled except for a specifically reviewed operation.

The SIP setup validates the outbound carrier hostname, TCP or TLS signaling, country code, and the documented `disabled|allowed|required` SRTP policy. Match the carrier's settings with the selected transport and SRTP requirements before a trunk is used. This code creates the Cartesia provider configuration only; it does not import or route phone numbers through the trunk or configure carrier-side routing. The provider API has no documented active SIP reachability probe, so VOICEDNUT reports configured metadata but does not claim carrier health. Cartesia's SIP guide currently shows `X-API-Key`, but its current API conventions and endpoint reference specify `Authorization: Bearer` and `Cartesia-Version`; the shared Cartesia client uses the current API reference contract.

Cartesia's provider API has no documented active SIP reachability probe, so VOICEDNUT reports configured metadata but does not claim carrier health. Carrier-side routing and encryption configuration remain operator-managed. Cartesia-managed number provisioning may incur a telephony charge, and releasing a Cartesia-owned number is permanent. Keep all mutation gates disabled until an operator has reviewed the target provider/number state and tested the carrier configuration.

Locally reconciled Cartesia batch recipients can be exported by an admin token with `GET /api/cartesia/call-batches/:batchId/records.csv`. The export has fixed columns, excludes dynamic variables and free-form provider errors, neutralizes spreadsheet formulas, and is returned with `Cache-Control: no-store`.

Local batch recipient retention uses `POST /api/cartesia/call-batches/:batchId/retention/preview` and `POST /api/cartesia/call-batches/:batchId/retention`. Both require the admin token. Purging is disabled unless `CARTESIA_BATCH_RETENTION_ENABLED=true` and `CARTESIA_BATCH_RETENTION_DAYS` is set to 1–3650; the default is disabled/0 days. Preview is read-only. Execution requires `approved: true` and the exact eligible preview fingerprint; only recipient rows for old terminal batches are removed. Aggregate batch metadata stays available, and requested/success/failure audit rows contain no phone numbers. No scheduled purge job is enabled.

Restart-safe batch status polling is available with `CARTESIA_BATCH_RECONCILIATION_ENABLED=true` (default false), `CARTESIA_BATCH_RECONCILIATION_INTERVAL_MS` (default 60000, allowed 15000–900000), and `CARTESIA_BATCH_RECONCILIATION_BATCH_SIZE` (default 5, allowed 1–10). It polls only locally persisted pending/in-progress batches using the read-only Cartesia batch-detail endpoint. SQLite leases prevent duplicate workers across API processes, renew during slow detail persistence, and expire after process failure. Transient failures use bounded exponential backoff and stop after eight consecutive failures; inspect the safe error code and use the existing admin reconciliation command/route to recover. Provider batch retry and scheduled calling are not enabled by this worker.
