const assert = require("node:assert/strict");
const { SpekoVoiceAdapter } = require("../adapters/spekoVoiceAdapter");
const { verifySpekoWebhook } = require("../adapters/spekoWebhookSecurity");
const {
  createSpekoWebhookHandler,
  __testables: { normalizeSpekoCallStatus },
} = require("../services/webhookRoutes");

const validConfig = {
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://api.speko.dev",
  agentId: "agent_test",
  phoneNumber: "+12015550199",
  webhookSecret: `whsec_${Buffer.from("test-secret").toString("base64")}`,
  requestTimeoutMs: 30000,
  maxDurationSeconds: 300,
  ringTimeoutSeconds: 45,
};

function createResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function makeRequest(secret, body, options = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const webhookId = options.webhookId || "evt_test";
  const digest = require("node:crypto")
    .createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
    .update(`${webhookId}.${timestamp}.${body}`, "utf8")
    .digest("base64");
  return {
    headers: {
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${digest}`,
    },
    rawBody: body,
    body: JSON.parse(body),
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    set(name, value) {
      this.headers = { ...(this.headers || {}), [name]: value };
      return this;
    },
  };
}

describe("Speko voice adapter", () => {
  it("is opt-in and rejects invalid caller and destination numbers", async () => {
    const disabled = new SpekoVoiceAdapter({
      config: { ...validConfig, enabled: false },
      fetch: async () => createResponse(200, {}),
    });
    assert.throws(() => disabled.validateConfig(), {
      code: "speko_disabled",
    });

    const adapter = new SpekoVoiceAdapter({
      config: { ...validConfig, phoneNumber: "not-e164" },
      fetch: async () => createResponse(200, {}),
    });
    assert.throws(() => adapter.validateConfig(), {
      code: "speko_invalid_phone_number",
    });
    const validAdapter = new SpekoVoiceAdapter({
      config: validConfig,
      fetch: async () => createResponse(200, {}),
    });
    await assert.rejects(
      validAdapter.dial({
        to: "555",
        idempotencyKey: "idem-1",
        systemPrompt: "prompt",
        firstMessage: "hello",
      }),
      { code: "speko_invalid_destination" },
    );
    assert.throws(
      () =>
        new SpekoVoiceAdapter({
          config: { ...validConfig, apiKey: "" },
          fetch: async () => createResponse(200, {}),
        }).validateConfig(),
      { code: "speko_missing_api_key" },
    );
    assert.throws(
      () => new SpekoVoiceAdapter({ config: { ...validConfig, baseUrl: "http://api.speko.dev" } }).validateConfig(),
      { message: "SPEKO_BASE_URL must use HTTPS" },
    );
  });

  it("maps only validated dial fields and sends the stable idempotency key", async () => {
    let request;
    const adapter = new SpekoVoiceAdapter({
      config: validConfig,
      fetch: async (url, options) => {
        request = { url, options };
        return createResponse(201, {
          sessionId: "session_123",
          status: "dialing",
          callControlId: "control_123",
        });
      },
    });
    const result = await adapter.dial({
      callId: "voicednut_123",
      to: "+12015550123",
      systemPrompt: "Agent prompt",
      firstMessage: "Hello",
      idempotencyKey: "operation-123",
      webhookTags: { ignored: "untrusted" },
      voice: "ignored",
    });

    assert.equal(request.url, "https://api.speko.dev/v1/sessions/phone");
    assert.equal(request.options.headers["idempotency-key"], "operation-123");
    assert.deepEqual(JSON.parse(request.options.body), {
      to: "+12015550123",
      from: "+12015550199",
      agentId: "agent_test",
      systemPrompt: "Agent prompt",
      firstMessage: "Hello",
      metadata: { voicednut_call_id: "voicednut_123" },
      maxDurationSeconds: 300,
      ringTimeoutSeconds: 45,
    });
    assert.equal(result.sessionId, "session_123");
    assert.equal(result.status, "dialing");
  });

  it("passes through documented per-call settings and rejects unsupported fields", async () => {
    let requestBody;
    const adapter = new SpekoVoiceAdapter({
      config: validConfig,
      fetch: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return createResponse(201, { sessionId: "session_456" });
      },
    });
    await adapter.dial({
      callId: "voicednut_456",
      to: "+12015550123",
      systemPrompt: " ",
      firstMessage: "",
      idempotencyKey: "operation-456",
      spekoOptions: {
        voice: "voice_123",
        llm: { temperature: 0.2, maxTokens: 128 },
        telephony: { amd: { mode: "agent", timeoutSeconds: 8 } },
        variables: { customer_name: "Sam" },
      },
    });
    assert.equal("systemPrompt" in requestBody, false);
    assert.equal("firstMessage" in requestBody, false);
    assert.equal(requestBody.voice, "voice_123");
    assert.equal(requestBody.telephony.amd.mode, "agent");
    assert.equal(requestBody.metadata.voicednut_call_id, "voicednut_456");

    await assert.rejects(
      adapter.dial({
        to: "+12015550123",
        idempotencyKey: "operation-789",
        spekoOptions: { llm: { apiKey: "must-not-pass" } },
      }),
      { code: "speko_unsupported_option" },
    );
  });

  it("reconciles a pending call by Voicednut metadata before attempting another dial", async () => {
    const requests = [];
    const adapter = new SpekoVoiceAdapter({
      config: validConfig,
      fetch: async (url, options) => {
        requests.push({ url: String(url), options });
        if (options.method === "GET") {
          return createResponse(200, {
            sessions: [
              {
                id: "session_recovered",
                status: "active",
                metadata: { voicednut_call_id: "speko_internal_42" },
              },
            ],
          });
        }
        return createResponse(201, { sessionId: "unexpected_new_session" });
      },
    });
    const result = await adapter.createOrRecoverCall({
      callId: "speko_internal_42",
      to: "+12015550123",
      idempotencyKey: "operation-42",
      reconcile: true,
    });
    assert.equal(result.sessionId, "session_recovered");
    assert.equal(result.recovered, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.method, "GET");
    assert.equal(
      new URL(requests[0].url).searchParams.get("metadata[voicednut_call_id]"),
      "speko_internal_42",
    );
  });

  it("uses the same provider idempotency key when reconciliation finds no session", async () => {
    const requests = [];
    const adapter = new SpekoVoiceAdapter({
      config: validConfig,
      fetch: async (url, options) => {
        requests.push({ url: String(url), options });
        return options.method === "GET"
          ? createResponse(200, { sessions: [] })
          : createResponse(201, { sessionId: "session_replayed" });
      },
    });
    const result = await adapter.createOrRecoverCall({
      callId: "speko_internal_43",
      to: "+12015550123",
      idempotencyKey: "operation-43",
      reconcile: true,
    });
    assert.equal(result.sessionId, "session_replayed");
    assert.deepEqual(requests.map(({ options }) => options.method), ["GET", "POST"]);
    assert.equal(requests[1].options.headers["idempotency-key"], "operation-43");
  });

  it("stops for manual reconciliation when multiple sessions match", async () => {
    let dialRequests = 0;
    const adapter = new SpekoVoiceAdapter({
      config: validConfig,
      fetch: async (_url, options) => {
        if (options.method === "POST") dialRequests += 1;
        return createResponse(200, {
          sessions: [
            { id: "one", metadata: { voicednut_call_id: "speko_internal_44" } },
            { id: "two", metadata: { voicednut_call_id: "speko_internal_44" } },
          ],
        });
      },
    });
    await assert.rejects(
      adapter.createOrRecoverCall({
        callId: "speko_internal_44",
        to: "+12015550123",
        idempotencyKey: "operation-44",
        reconcile: true,
      }),
      { uncertain: true, code: "speko_reconciliation_conflict" },
    );
    assert.equal(dialRequests, 0);
  });

  it("marks ambiguous transport and idempotency outcomes as uncertain", async () => {
    const networkFailure = new SpekoVoiceAdapter({
      config: validConfig,
      fetch: async () => {
        throw new Error("transport closed");
      },
    });
    await assert.rejects(
      networkFailure.dial({
        to: "+12015550123",
        systemPrompt: "Prompt",
        firstMessage: "Hello",
        idempotencyKey: "operation-123",
      }),
      { uncertain: true, code: "speko_dial_network_error" },
    );

    const idempotencyPending = new SpekoVoiceAdapter({
      config: validConfig,
      fetch: async () =>
        createResponse(409, { code: "IDEMPOTENCY_KEY_IN_PROGRESS" }),
    });
    await assert.rejects(
      idempotencyPending.dial({
        to: "+12015550123",
        systemPrompt: "Prompt",
        firstMessage: "Hello",
        idempotencyKey: "operation-123",
      }),
      { uncertain: true, code: "IDEMPOTENCY_KEY_IN_PROGRESS" },
    );
  });

  it("checks agent and an explicitly configured number without dialing", async () => {
    const adapter = new SpekoVoiceAdapter({
      config: validConfig,
      clientFactory: async () => ({
        agents: {
          get: async (id) => ({ id }),
        },
        phoneNumbers: {
          list: async () => [{ e164: validConfig.phoneNumber }],
        },
      }),
      fetch: async () => {
        throw new Error("preflight must not dial");
      },
    });
    assert.deepEqual(await adapter.preflight(), {
      agentId: "agent_test",
      phoneNumberConfigured: true,
    });
  });
});

describe("Speko webhook verification and lifecycle mapping", () => {
  it("authenticates Standard Webhooks signatures and rejects stale timestamps", () => {
    const req = makeRequest(validConfig.webhookSecret, '{"type":"call.status"}');
    assert.equal(
      verifySpekoWebhook({
        secret: validConfig.webhookSecret,
        headers: req.headers,
        rawBody: req.rawBody,
      }),
      true,
    );
    assert.equal(
      verifySpekoWebhook({
        secret: validConfig.webhookSecret,
        headers: {
          ...req.headers,
          "webhook-timestamp": String(Math.floor(Date.now() / 1000) - 1000),
        },
        rawBody: req.rawBody,
      }),
      false,
    );
    assert.equal(normalizeSpekoCallStatus({ status: "active" }), "in-progress");
    assert.equal(
      normalizeSpekoCallStatus({
        event_type: "session.ended",
        status: "ended",
        end_reason: "no_answer",
      }),
      "no-answer",
    );
  });

  it("deduplicates verified events and releases reservations when processing fails", async () => {
    let processed = 0;
    let released = 0;
    let sequence = 0;
    let duplicate = false;
    const handler = createSpekoWebhookHandler({
      config: { speko: { webhookSecret: validConfig.webhookSecret } },
      shouldProcessProviderEventAsync: async () => !duplicate,
      releaseProviderEventAsync: async () => {
        released += 1;
      },
      claimSpekoCallSequence: async ({ sequence_number }) =>
        sequence >= sequence_number
          ? { claimed: false, stale: true }
          : { claimed: true, stale: false },
      finishSpekoCallSequence: async ({ sequence_number }) => {
        sequence = sequence_number;
        return { advanced: true };
      },
      releaseSpekoCallSequenceClaim: async () => 1,
      recordCallStatus: async () => {
        processed += 1;
        if (processed === 1) throw new Error("temporary DB failure");
      },
    });
    const body = JSON.stringify({
      type: "call.status",
      data: {
        call_id: "session_123",
        sequence: 7,
        event_type: "call.answered",
        status: "active",
        metadata: { voicednut_call_id: "speko_internal_123" },
      },
    });
    const request = makeRequest(validConfig.webhookSecret, body);
    const first = makeResponse();
    await handler(request, first);
    assert.equal(first.statusCode, 503);
    assert.equal(released, 1);
    assert.equal(sequence, 0);

    const second = makeResponse();
    await handler(request, second);
    assert.equal(second.statusCode, 200);
    assert.equal(sequence, 7);
    assert.equal(processed, 2);

    duplicate = true;
    const third = makeResponse();
    await handler(request, third);
    assert.equal(third.body.duplicate, true);
    assert.equal(processed, 2);

    const invalid = makeResponse();
    await handler(
      { ...request, headers: { ...request.headers, "webhook-signature": "v1,bad" } },
      invalid,
    );
    assert.equal(invalid.statusCode, 401);
  });

  it("returns quickly for authenticated pre-call events without database work", async () => {
    let dedupeCalls = 0;
    const handler = createSpekoWebhookHandler({
      config: { speko: { webhookSecret: validConfig.webhookSecret } },
      shouldProcessProviderEventAsync: async () => {
        dedupeCalls += 1;
        return true;
      },
    });
    const body = JSON.stringify({
      type: "call.pre_call",
      call_id: "session_123",
      session_id: "session_123",
      direction: "inbound",
      metadata: {},
    });
    const response = makeResponse();
    await handler(makeRequest(validConfig.webhookSecret, body), response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {});
    assert.equal(response.headers["Cache-Control"], "no-store");
    assert.equal(dedupeCalls, 0);
  });

  it("persists sequenced report, analysis, recording, and transfer events by session", async () => {
    const sequences = [];
    const events = [];
    let lastSequence = 0;
    const handler = createSpekoWebhookHandler({
      config: { speko: { webhookSecret: validConfig.webhookSecret } },
      shouldProcessProviderEventAsync: async () => true,
      claimSpekoCallSequence: async (claim) => {
        sequences.push(claim.call_sid);
        if (claim.sequence_number <= lastSequence) return { claimed: false, stale: true };
        return { claimed: true, stale: false };
      },
      finishSpekoCallSequence: async (claim) => {
        lastSequence = claim.sequence_number;
        return { advanced: true };
      },
      handleSpekoCallReport: async (_callId, sessionId, data) =>
        events.push(["report", sessionId, data.recording_url || null]),
      handleSpekoCallAnalysis: async (_callId, sessionId, data) =>
        events.push(["analysis", sessionId, data.summary]),
      handleSpekoCallRecording: async (_callId, sessionId, data) =>
        events.push(["recording", sessionId, data.recording.status]),
      handleSpekoCallTransfer: async (_callId, sessionId, eventType) =>
        events.push([eventType, sessionId]),
    });
    const payloads = [
      ["call.report", 1, { summary: "Call ended" }],
      ["call.analysis", 2, { summary: "Qualified" }],
      ["call.recording", 3, { recording: { status: "ready" }, recording_url: "https://signed.example/audio" }],
      ["call.transfer.completed", 4, { transfer_id: "transfer_1", to: "+12015550100", mode: "blind" }],
      ["call.report", 5, { summary: "Call ended", recording_url: "https://signed.example/audio" }],
    ];

    for (const [index, [type, sequence, details]] of payloads.entries()) {
      const body = JSON.stringify({
        type,
        data: {
          call_id: "session_123",
          session_id: "session_123",
          sequence,
          metadata: { voicednut_call_id: "speko_internal_123" },
          ...details,
        },
      });
      const response = makeResponse();
      await handler(
        makeRequest(validConfig.webhookSecret, body, { webhookId: `evt_${index}` }),
        response,
      );
      assert.equal(response.statusCode, 200);
    }

    assert.deepEqual(sequences, Array(5).fill("session_123"));
    assert.equal(events.length, 5);
    assert.deepEqual(events[0], ["report", "session_123", null]);
    assert.deepEqual(events[2], ["recording", "session_123", "ready"]);
    assert.deepEqual(events[4], ["report", "session_123", "https://signed.example/audio"]);
  });
});
