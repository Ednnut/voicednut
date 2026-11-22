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

## Public API URL configuration

`SERVER` must identify the public HTTPS hostname that providers can reach for callbacks (for example `api.example.com`; do not include an application path). The API uses this configured hostname as the canonical callback host, falling back to request host headers only when `SERVER` is absent. In `bot/.env`, `API_URL` and `TEMPLATES_API_URL` must be API origin URLs such as `https://api.example.com`, without a trailing slash or `/api` suffix; the bot appends its route paths itself.

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

## Speko Voice

Speko is the default voice provider in the minimal environment template, setup wizard, and runtime defaults. New Speko setups also enable `SPEKO_EXCLUSIVE_MODE=true`: the admin provider switch is locked to Speko, and Speko-selected calls never fail over to another voice provider. Existing deployments that explicitly set `CALL_PROVIDER=twilio|plivo|vonage` retain that provider unless they enable Speko exclusive mode. Set `SPEKO_EXCLUSIVE_MODE=false` only when an administrator must be able to switch voice providers. SMS stays on its separate provider setting. Inbound Speko call handling is separately disabled by default.

Configure `SPEKO_API_KEY` and `SPEKO_WEBHOOK_SECRET`. `SPEKO_AGENT_ID` is optional and is retained only as a backward-compatible default; when it is unset, the Telegram call flow selects an agent from the Speko workspace for each call. The selected ID is passed per request and is not written to `.env`. `SPEKO_AGENT_VERSION` is an optional legacy pin used only with the matching `SPEKO_AGENT_ID`; for dynamically selected agents, pass `speko_agent_version` on the individual call when version pinning is required. `SPEKO_PHONE_NUMBER` is optional; when set it must be an E.164 number owned by the Speko workspace. `SPEKO_BASE_URL` defaults to `https://api.speko.dev`; request timeout, call duration, and ring timeout use `SPEKO_REQUEST_TIMEOUT_MS`, `SPEKO_MAX_DURATION_SECONDS`, and `SPEKO_RING_TIMEOUT_SECONDS`. Speko is enabled by default when it is the selected call provider; set `SPEKO_ENABLED=false` to disable it explicitly. Run the provider preflight before placing calls; it checks configuration and provider reachability without creating calls.

`SPEKO_BROKER_ID` enables the separate Speko human call-control SDK surface. It is not required for AI-agent phone sessions or inbound routing. Human call control remains separate from the AI-agent call adapter and must not be treated as authorization to mutate calls or workspace state.

The API creates an agent-backed phone session at `POST /v1/sessions/phone`; the selected agent ID is supplied per call (with `SPEKO_AGENT_ID` used only as a legacy fallback), preserving Voicednut's internal call ID separately from Speko's session ID. A supplied `idempotency_key` (or `Idempotency-Key` header) is required for Speko calls. An ambiguous timeout or server error returns `503`; retry the exact request with the same key. The API holds a durable per-key attempt lease to block concurrent retries. If the outcome is still pending, it first searches Speko sessions using the stored `metadata[voicednut_call_id]`; a unique match is recovered into Voicednut, while multiple matches remain uncertain for manual review. When no session is found, any retry still uses the same provider idempotency key. The API never fails over to another carrier after an uncertain submission. Speko voice-session webhooks are received at `POST /webhook/speko`; register that HTTPS URL in Speko's workspace settings for `call.status`, `call.report`, `call.analysis`, `call.recording`, and transfer lifecycle events, using Standard Webhooks signing. Sequence ordering is tracked per Speko session. Reports are treated as updates, including the later recording-ready delivery; short-lived recording URLs are not persisted. There is no per-call webhook URL. An optional `speko_options` object on the outbound call request passes through the documented per-call `voice`, `llm`, `ttsOptions`, `sttOptions`, `telephony`, `timezone`, `variables`, and `webhookTags` fields. Unknown option names are rejected; credentials and caller metadata remain server-side.

To opt into inbound calls, set `SPEKO_INBOUND_ENABLED=true`, set `SPEKO_INBOUND_PHONE_NUMBER` to the E.164 Speko number, and add that number to the existing `INBOUND_NUMBER_ROUTES` map. Assign that number to the intended agent in the Speko workspace and subscribe `/webhook/speko` to `call.pre_call` as well as the lifecycle events above. Voicednut accepts pre-call events only for the configured inbound number and an existing `INBOUND_NUMBER_ROUTES` entry. A route may include `speko_agent_id` (or `agent_id`) to enforce an exact agent match; otherwise the signed event's agent ID is recorded without requiring a global `SPEKO_AGENT_ID`. Disabled, unassigned, or explicitly mismatched calls are rejected before the agent starts. The verified pre-call request creates an idempotent Voicednut inbound record and returns its internal call ID as session metadata for later event correlation. This does not buy, import, or route phone numbers in Speko.

If a Speko call remains stale or incomplete, a background reconciler checks calls older than `SPEKO_RECONCILE_STALE_MINUTES` (default 5) every `SPEKO_RECONCILE_INTERVAL_MS` (default 120000), reads Speko call/event history, and applies only newer sequenced events. It does not mutate Speko calls or rerun post-call analysis. Authorized callers can also request reconciliation with `POST /api/calls/:callSid/reconcile`; each call is throttled to one reconciliation per 30 seconds. Calls linked to a Telegram chat also require the matching `x-telegram-chat-id`. For uncertain outbound call jobs, the admin DLQ reconcile route remains read-only by default. An administrator can resolve an entry only when Speko returns the linked session, by sending `resolve: true`, the exact `confirm_session_id`, and a 10–500 character `resolution_reason`; the DB records the resolution and audit event atomically. A missing or ambiguous provider result remains open and uncertain.

Read-only preflight authenticates to Speko and verifies the configured agent and optional caller number. It does not create calls or change workspace settings:

```bash
npm run preflight:provider --prefix api -- --channel call --provider speko --network 1 --reachability 1
```

The shared provider capability registry is derived from the supported provider flow declarations and drives provider selection, keypad capability checks, compatibility reporting, and call/SMS provider lists. Speko currently supports outbound voice, opt-in inbound handling for an explicitly mapped number, signed lifecycle webhooks, post-call transcript/report/analysis/recording state ingestion, and on-demand recording-link retrieval via `GET /api/calls/:callSid/recording`. Calls associated with a Telegram chat require the matching `x-telegram-chat-id` (or the existing `chat_id` query parameter) before a short-lived recording link is issued. Admin Speko routes list and inspect agents/tools, inspect agent drafts and versions, update or discard a Speko draft, deploy a reviewed draft, and roll back to a version. Draft writes use Speko's draft API; they do not call the live-agent PATCH endpoint. Draft fields are restricted to Speko's documented snapshot fields, and Speko validates the draft on write. Review the returned `changed_fields` and `draft_version_number` before deploying. When `SPEKO_AGENT_RELEASE_GATE_REQUIRED=true` (enabled by default for Speko-exclusive setups), deployment requires the admin token, `confirm_live_deploy` equal to the agent ID, the exact reviewed `confirmed_draft_version_number`, and a matching manual `release_gate` checklist with `draft_diff_reviewed`, `simulated_test_reviewed`, `failure_paths_reviewed`, and `rollback_ready` all true. `reviewed_draft_version_number` in the checklist must match the confirmed version; the route re-reads and rejects missing, stale, or changed drafts. These checks are operator attestations; Speko evaluations remain a separate simulated CLI workflow because the installed SDK has no evaluation API. Rollback requires `confirm_live_rollback` equal to `<agent-id>:<target-version-number>`. These two routes cause live Speko changes when explicitly called; Voicednut never calls them automatically and does not set Speko's reliability-gate `override`. Agent creation, tool management, and phone-number assignment remain outside this staged workflow because those operations are not covered by the draft snapshot API (tools and phone assignments are not versioned). Admin-only AI-call transfer routes support blind/warm transfer and warm-transfer completion/cancellation under `/admin/speko/calls/:callSid/transfers/...`. Separate human-call-control routes under `/admin/speko/call-control/...` require `SPEKO_CALL_CONTROL_ENABLED=true`, `SPEKO_BROKER_ID`, and the admin token; they cover human-call dial/read/events, answer/hangup/bridge/hold/unhold/mute/unmute/DTMF/transfer commands, and presence management. These endpoints are global administrator operations: they do not provide tenant-level ownership authorization and must not be exposed as tenant-facing controls without adding workspace ownership checks. Transfer lifecycle state is synchronized from signed Speko webhooks. `GET /admin/speko/usage` exposes provider-reported usage to administrators only, and `GET /admin/speko/metrics?hours=24` provides aggregated call and webhook counts/duration metrics plus Speko health events. These metrics use existing call/health tables and do not include raw event payloads. `SPEKO_MONTHLY_SPEND_LIMIT_USD` pauses new calls when provider-reported month-to-date spend reaches the limit, and `SPEKO_LOW_BALANCE_ALERT_USD` enables throttled admin Telegram alerts to the configured admin chat; with either threshold enabled, a background monitor checks usage every 15 minutes. The cap is best-effort because concurrent/in-flight calls can settle after the usage snapshot. Agent creation and tool CRUD methods are available in the adapter, but only draft deployment/rollback and read-only tool callback functionality are exposed through the current Voicednut admin/runtime flows. Voicednut does not expose keypad collection or native payment flows for Speko. To unlock another voice provider, set `SPEKO_EXCLUSIVE_MODE=false` and configure its credentials and webhook routes. Keep the current provider in `CALL_PROVIDER` if it should be the startup default.

Speko agent lifecycle API references: [Agents](https://docs.speko.ai/concepts/agents), [draft API](https://docs.speko.ai/api-reference/agent-draft), and [versions, deployment, and rollback](https://docs.speko.ai/api-reference/agent-versions). The installed `@spekoai/sdk` does not expose these lifecycle methods, so the adapter calls only these documented HTTPS endpoints directly; no calls to them are made during setup or tests.

The admin routes are `GET /admin/speko/agents/:agentId/draft`, `PUT` and `DELETE` on that same path, `GET /admin/speko/agents/:agentId/versions`, `POST /admin/speko/agents/:agentId/deploy`, and `POST /admin/speko/agents/:agentId/rollback`. Deploy body when the release gate is required: `{"confirm_live_deploy":"<agentId>","confirmed_draft_version_number":<reviewedVersion>,"release_gate":{"reviewed_draft_version_number":<reviewedVersion>,"draft_diff_reviewed":true,"simulated_test_reviewed":true,"failure_paths_reviewed":true,"rollback_ready":true}}`. Use simulated evaluations for the test review and never configure test cases to dial real numbers. Rollback body: `{"confirm_live_rollback":"<agentId>:<targetVersion>","target_version_number":<targetVersion>}`. All routes require `x-admin-token`. Live operations return the resulting version and write a sanitized version/agent record to application logs; do not set or pass the Speko reliability-gate override.

### Human call control (separate from AI calls)

The dedicated `SpekoCallControlService` uses the shared SDK client while keeping browser/PSTN human calls separate from `speko.voice.dial()` AI-agent sessions. Global admin endpoints support human dialing, calls/events inspection, commands, and presence management. The global admin dial endpoint additionally requires `confirm_to` to exactly match the trimmed E.164 `to` destination. Every global admin control command requires `confirm_command` equal to `<command>:<control-id>`; transfer, bridge, and DTMF confirmations append the exact destination, bridge target, or digit sequence. The confirmation field is stripped before dispatch. The Mini App also has owner-scoped human call routes and a softphone at `#/speko-softphone`. Before use, a named admin must assign the configured `SPEKO_BROKER_ID` to an authorized Telegram operator/admin with `PUT /admin/speko/call-control/brokers/:brokerId/owner` and `{ "telegramUserId": "..." }`; this is a one-to-one broker-to-user assignment, not workspace ownership. Mini App users can only list/read calls containing their assigned broker leg, join that broker's leg, and control legs on those calls. Presence/join credentials are short-lived and returned with `Cache-Control: no-store`; the Speko API key remains on the server. Configure `ADMIN_API_USER_TOKENS` as a JSON map of administrator IDs to distinct random tokens (minimum 32 characters); generate each secret with a cryptographically secure generator such as `openssl rand -hex 32`, then install the JSON value in the API deployment environment. Send that token in `x-admin-token`; the shared admin token remains accepted for legacy global routes but is intentionally rejected for broker assignment and has no individual audit identity. The example in `.env.example` is a placeholder and must be replaced. Call summaries and opaque leg mappings are persisted separately from AI sessions; phone numbers and join credentials are excluded. Signed human call-control events use a distinct idempotency source and an allowlisted event store. Since Speko does not retry these events, `POST /admin/speko/call-control/calls/:callId/reconcile` reads the current provider call and oldest-first event history to recover gaps with event-ID deduplication. Mutating admin and Mini App call-control operations write durable outcome audit entries; `GET /admin/speko/call-control/audit` reads them. Named administrator IDs and verified Mini App Telegram IDs are stored as audit actors; caller-supplied `x-admin-user` is ignored. Workspace-scoped controls still require a persisted, authoritative workspace membership model; existing email `tenant_id` metadata is not an authorization source. The softphone uses `livekit-client` directly in the Mini App; validate microphone permissions, autoplay, reconnect, presence expiry, and audio routing on each supported Telegram client before production. Speko hold can be silent without music-on-hold configuration, and desk phones/SIP registration are unsupported by the documented browser/PSTN human-calling model.

### Simulated agent evaluations

Speko supports simulated agent evaluations through its official CLI. Install/use `@spekoai/cli` separately from the Voicednut API dependency, authenticate with an authorized Speko workspace account, then run `speko-cli eval generate --agent <agent-id>` to preview cases and `speko-cli eval run --agent <agent-id>` to run the stored suite. Add `--persist` to `eval generate` only when you intend to save generated cases. These are Speko-hosted evaluations, not Voicednut unit tests. Do not use test cases configured as real phone calls; Speko documents those as dialing a real number. The CLI reports exit code 6 for behavior regressions, which CI can distinguish from infrastructure failures. Voicednut does not yet automate these evaluations in its CI pipeline. See the [Speko CLI evaluation guide](https://docs.speko.ai/cli/evals) and [simulated testing guide](https://docs.speko.ai/agents/testing).

### Speko agent tools

The tool callback is opt-in: set `SPEKO_AGENT_TOOLS_ENABLED=true` and configure `SPEKO_AGENT_TOOL_WEBHOOK_SECRET` with the exact signing secret used when registering the tools in Speko. Point registered tools at `https://<public-host>/webhook/speko/tools` and use Speko's default request envelope (custom body templates are not accepted). The handler verifies the original raw body, signature and timestamp, checks `webhook-id` against Speko's `<session_id>:<tool_call_id>` idempotency key, resolves the session to an existing non-terminal Voicednut Speko call, validates arguments against trusted JSON Schemas from the connector pack, and persists delivery idempotency for 24 hours. Tool execution is capped at 3.5 seconds and results at 8 KB. Only the existing read-only `kb_search`, `runbook_lookup`, `policy_lookup`, and `product_doc_lookup` connectors are exposed. Unknown tools, extra argument properties, unlinked sessions, replayed delivery IDs, and expired signatures are rejected or safely deduplicated. Side-effecting CRM, messaging, payment, scheduling, and call-control tools are not enabled through this endpoint; add them only with their normal authorization, approval, and replay-safe behavior.

Speko's official [tool calling guide](https://docs.speko.ai/guides/tool-calling) documents the signed `{tool,args,idempotency_key,session_id,tool_call_id}` envelope, callback timing limits, and per-tool secret. Callback registration remains a manual Speko dashboard/API operation; Voicednut does not make provider calls during setup or tests.

Reference docs:

- Plivo Voice Call API: https://www.plivo.com/docs/voice/api/call/overview
- Plivo Message API: https://www.plivo.com/docs/messaging/api/message/send-a-message
- Plivo Audio Stream protocol: https://www.plivo.com/docs/voice/audio-streaming/audio-streaming
- Speko phone agents: https://docs.speko.ai/guides/phone-agents
- Speko SDK voice calls: https://docs.speko.ai/sdk/voice
- Speko workspace webhooks: https://docs.speko.ai/guides/webhooks

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

Post-call automation rules can now be seeded with the default payment receipt, missed-booking follow-up, and escalation case summary workflows. Runs store the original payload so failed automations can be inspected and retried safely.

Manual API controls:

- `POST /post-call/automation/rules/defaults` installs the default rules. Use `{ "overwrite": true }` to refresh existing default rule definitions.
- `GET /post-call/automation/rules` lists configured rules.
- `POST /post-call/automation/rules` creates or updates a rule.
- `POST /post-call/automation/preview` shows matching rules without executing actions.
- `POST /post-call/automation/run` evaluates and executes matching rules.
- `GET /post-call/automation/runs` lists stored runs by `call_sid`, `rule_id`, `status`, `trigger_event`, or `retry_of_run_id`.
- `POST /post-call/automation/runs/:run_id/retry` retries a failed run with stable action idempotency.
- `POST /crm/contact-sync` syncs a contact plus post-call note.
- `POST /crm/contact-sync/health` checks whether the configured CRM provider can run in native mode.

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

Manual API controls:

- `GET /api/qa/summary`
- `GET /api/calls/:callSid/qa`
- `POST /api/calls/:callSid/qa/evaluate?force=1`

The existing authorized call-details response (`GET /api/calls/:callSid`) also includes a bounded `qa` summary when a report exists: score/status, profile/version, evaluator finding and recommendation codes, and allowlisted aggregate metrics. It does not include transcript evidence or arbitrary report fields. Telegram's existing Call Details view renders this summary for authorized call-log users.

## Adaptive Persona and Mood Profiles

The API ships with adaptive persona handling that inspects call metadata (business domain, purpose, channel, urgency, and mood signals) and produces the appropriate system prompt and greeting. Personality and profile logic currently live in:

- `api/functions/PersonalityEngine.js`
- `api/routes/gpt.js`

Voice calls and SMS conversations automatically fall back to the default adaptive prompt when no persona is supplied, so free-form prompts continue to work as before.

## Setting up for Development

### Prerequisites
Sign up for the following services and get an API key for each:
- [Deepgram](https://console.deepgram.com/signup)
- [OpenAI](https://platform.openai.com/signup)

If you're hosting the app locally, we also recommend using a tunneling service like [ngrok](https://ngrok.com) so that Twilio can forward audio to your app.

### 1. Start Ngrok
Start an [ngrok](https://ngrok.com) tunnel for port `3000`:

```bash
ngrok http 3000
```
Ngrok will give you a unique URL, like `abc123.ngrok.io`. Copy the URL without http:// or https://. You'll need this URL in the next step.

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and configure the minimal variables first.
If you need runtime tuning, copy specific overrides from `.env.advanced.example`.

```bash
# Your ngrok or server URL
# E.g. 123.ngrok.io or myserver.fly.dev (exlude https://)
SERVER="yourserverdomain.com"

# Service API Keys
OPENROUTER_API_KEY="YOUR-OPENROUTER-API-KEY"
DEEPGRAM_API_KEY="YOUR-DEEPGRAM-API-KEY"
API_SECRET="change-me"

# Configure your Twilio credentials if you want
# to make test calls using '$ npm test'.
TWILIO_ACCOUNT_SID="YOUR-ACCOUNT-SID"
TWILIO_AUTH_TOKEN="YOUR-AUTH-TOKEN"
FROM_NUMBER='+12223334444'
```

### 3. Install Dependencies with NPM
Install the necessary packages:

```bash
npm install
```

### 4. Start Your Server in Development Mode
Run the following command:
```bash
npm run dev
```
This will start your app using `nodemon` so that any changes to your code automatically refreshes and restarts the server.

### 5. Configure an Incoming Phone Number

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
