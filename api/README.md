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

The current integration uses PayPal REST APIs through the existing `payment_link_generate`, `invoice_create`, `payment_intent_status`, `payment_session_history`, and `refund_request_initiate` tool surface. Configure the PayPal app webhook URL as `https://your-app.example/webhook/paypal`; incoming events are verified with `PAYPAL_WEBHOOK_ID`, deduplicated by PayPal event ID, and reconciled into `paypal_payment_sessions` for checkout order, capture, refund, and invoice status updates. Agents can call `payment_session_history` to inspect local PayPal session and webhook history by order, invoice, refund, or call SID without making a live PayPal API request.

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

The Stripe connector supports hosted Checkout Session creation through `payment_link_generate`, invoice creation/finalization/sending through `invoice_create`, live status lookups through `payment_intent_status`, local session/event history through `payment_session_history`, and guarded refunds through `refund_request_initiate`. Configure the Stripe webhook URL as `https://your-app.example/webhook/stripe`; incoming events are verified with `STRIPE_WEBHOOK_SECRET`, deduplicated by Stripe event ID, and reconciled into `stripe_payment_sessions`.

Smoke validation is available with `npm run smoke:stripe --prefix api`. The default run validates configuration only; set `STRIPE_SMOKE_LIVE=1` to create and read back a test-mode Checkout Session. Readiness can also be checked with:

```bash
npm run preflight:provider --prefix api -- --channel payment --provider stripe --network 0 --reachability 0
```

For promotion, run it with `--network 1 --reachability 1` so preflight verifies Stripe credentials, HTTPS callback generation, `STRIPE_WEBHOOK_SECRET`, and `POST /webhook/stripe` route registration.

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
