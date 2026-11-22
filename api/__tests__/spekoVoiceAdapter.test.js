const assert = require("node:assert/strict");
const { SpekoVoiceAdapter } = require("../adapters/spekoVoiceAdapter");
const { verifySpekoWebhook } = require("../adapters/spekoWebhookSecurity");
const {
  createSpekoWebhookHandler,
  __testables: webhookRouteTestables,
} = require("../services/webhookRoutes");
const { normalizeSpekoCallStatus } = webhookRouteTestables;

const validConfig = {
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://api.speko.dev",
  agentId: "agent_test",
  brokerId: "broker_test",
  callControlEnabled: true,
  runMode: "s2s",
  s2sModel: "openai:gpt-live-1.1",
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
      metadata: { campaign: "spring" },
      spekoOptions: {
        voice: "voice_123",
        llm: { temperature: 0.2, maxTokens: 128 },
        telephony: { amd: { mode: "agent", timeoutSeconds: 8 }, dtmf: "ww1w8" },
        turnHandling: { onMachine: "leave_message", voicemailMessage: "Please call us back." },
        variables: { customer_name: "Sam" },
        toolSecrets: { access_token: "not-logged-or-prompted" },
        metadata: { campaign: "spring" },
      },
    });
    assert.equal("systemPrompt" in requestBody, false);
    assert.equal("firstMessage" in requestBody, false);
    assert.equal(requestBody.voice, "voice_123");
    assert.equal(requestBody.telephony.amd.mode, "agent");
    assert.equal(requestBody.telephony.dtmf, "ww1w8");
    assert.equal(requestBody.turnHandling.onMachine, "leave_message");
    assert.equal(requestBody.toolSecrets.access_token, "not-logged-or-prompted");
    assert.deepEqual(requestBody.metadata, {
      campaign: "spring",
      voicednut_call_id: "voicednut_456",
    });
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

  it("reads call detail and durable event history through the SDK", async () => {
    const requested = [];
    const adapter = new SpekoVoiceAdapter({
      config: validConfig,
      clientFactory: async () => ({
        calls: {
          get: async (sessionId) => {
            requested.push(["get", sessionId]);
            return { id: sessionId, status: "ended" };
          },
          events: async (sessionId) => {
            requested.push(["events", sessionId]);
            return { events: [{ id: "evt_1", event_type: "call.hangup" }] };
          },
        },
      }),
    });
    const detail = await adapter.getCall("session_789");
    const events = await adapter.getCallEvents("session_789");
    assert.equal(detail.status, "ended");
    assert.equal(events.length, 1);
    assert.deepEqual(requested, [
      ["get", "session_789"],
      ["events", "session_789"],
    ]);
  });

  it("provides read-only usage and agent visibility through the SDK", async () => {
    const calls = [];
    const adapter = new SpekoVoiceAdapter({
      config: validConfig,
      clientFactory: async () => ({
        usage: {
          get: async (params) => {
            calls.push(["usage", params]);
            return { totalSessions: 3, totalMinutes: 12.5, totalCost: 4.25 };
          },
        },
        agents: {
          list: async () => {
            calls.push(["agents.list"]);
            return [{ id: "agent_test", name: "Support" }];
          },
          get: async (agentId) => {
            calls.push(["agents.get", agentId]);
            return { id: agentId, name: "Support" };
          },
          tools: {
            list: async (agentId, signal, options) => {
              calls.push(["agents.tools.list", agentId, signal, options]);
              return [{ id: "tool_1", name: "lookup_customer" }];
            },
          },
        },
      }),
    });

    const usage = await adapter.getUsage({
      from: "2026-11-01",
      to: "2026-11-22",
    });
    assert.equal(usage.totalCost, 4.25);
    assert.deepEqual((await adapter.listAgents())[0], {
      id: "agent_test",
      name: "Support",
    });
    assert.equal((await adapter.getAgent("agent_test")).name, "Support");
    assert.equal(
      (await adapter.listAgentTools("agent_test", { available: true })).length,
      1,
    );
    assert.deepEqual(calls, [
      ["usage", { from: "2026-11-01", to: "2026-11-22" }],
      ["agents.list"],
      ["agents.get", "agent_test"],
      ["agents.tools.list", "agent_test", undefined, { available: true }],
    ]);
  });

  it("supports explicit agent, tool, and human call-control SDK operations", async () => {
    const calls = [];
    const adapter = new SpekoVoiceAdapter({
      config: validConfig,
      clientFactory: async () => ({
        agents: {
          create: async (params) => {
            calls.push(["agents.create", params]);
            return { id: "agent_created" };
          },
          update: async (agentId, params) => {
            calls.push(["agents.update", agentId, params]);
            return { id: agentId, name: "Updated" };
          },
          delete: async (agentId) => {
            calls.push(["agents.delete", agentId]);
            return { deleted: true };
          },
          listCalls: async (agentId, params) => {
            calls.push(["agents.listCalls", agentId, params]);
            return { calls: [], entries: [] };
          },
          tools: {
            create: async (agentId, params) => {
              calls.push(["agents.tools.create", agentId, params]);
              return { id: "tool_created" };
            },
            get: async (agentId, toolId) => {
              calls.push(["agents.tools.get", agentId, toolId]);
              return { id: toolId };
            },
            update: async (agentId, toolId, params) => {
              calls.push(["agents.tools.update", agentId, toolId, params]);
              return { id: toolId };
            },
            delete: async (agentId, toolId) => {
              calls.push(["agents.tools.delete", agentId, toolId]);
              return { deleted: true };
            },
          },
        },
      }),
    });

    assert.equal((await adapter.createAgent({
      name: "Support",
      systemPrompt: "Help callers",
      intent: { language: "en" },
    })).id, "agent_created");
    assert.equal((await adapter.updateAgent("agent_test", { name: "Updated" })).name, "Updated");
    assert.equal((await adapter.deleteAgent("agent_test")).deleted, true);
    assert.equal((await adapter.listAgentCalls("agent_test", { limit: 10 })).calls.length, 0);
    assert.equal((await adapter.createAgentTool("agent_test", {
      name: "lookup",
      description: "Look up a customer",
      parameters: { type: "object", properties: {} },
      source: { type: "webhook", url: "https://example.com/tool" },
    })).id, "tool_created");
    assert.equal((await adapter.getAgentTool("agent_test", "tool_1")).id, "tool_1");
    assert.equal((await adapter.updateAgentTool("agent_test", "tool_1", { description: "Updated" })).id, "tool_1");
    assert.equal((await adapter.deleteAgentTool("agent_test", "tool_1")).deleted, true);

  });

  it("supports blind and warm AI-call transfers and rejects disabled call control", async () => {
    const calls = [];
    const adapter = new SpekoVoiceAdapter({
      config: validConfig,
      clientFactory: async () => ({
        calls: {
          blindTransfer: async (sessionId, params) => {
            calls.push(["blind", sessionId, params]);
            return { transferId: "transfer_blind" };
          },
          warmTransfer: async (sessionId, params) => {
            calls.push(["warm", sessionId, params]);
            return { transferId: "transfer_warm" };
          },
          completeWarmTransfer: async (sessionId, transferId, params) => {
            calls.push(["complete", sessionId, transferId, params]);
            return { transferId };
          },
          cancelWarmTransfer: async (sessionId, transferId, params) => {
            calls.push(["cancel", sessionId, transferId, params]);
            return { transferId };
          },
        },
      }),
    });

    await adapter.blindTransfer("session_1", {
      to: "+12015550123",
      ringingTimeout: 25,
    });
    await adapter.warmTransfer("session_1", {
      to: "+12015550124",
      screeningPrompt: "A caller needs assistance.",
      ringingTimeout: 25,
    });
    await adapter.completeWarmTransfer("session_1", "transfer_warm", {
      summary: "Caller verified.",
    });
    await adapter.cancelWarmTransfer("session_1", "transfer_warm", {
      reason: "recipient unavailable",
      tryNext: false,
    });

    assert.deepEqual(calls, [
      ["blind", "session_1", { to: "+12015550123", ringingTimeout: 25 }],
      ["warm", "session_1", {
        to: "+12015550124",
        screeningPrompt: "A caller needs assistance.",
        ringingTimeout: 25,
      }],
      ["complete", "session_1", "transfer_warm", { summary: "Caller verified." }],
      ["cancel", "session_1", "transfer_warm", {
        reason: "recipient unavailable",
        tryNext: false,
      }],
    ]);

  });
});

describe("Speko webhook verification and lifecycle mapping", () => {
  it("routes human call-control events through separate durable idempotency", async () => {
    const reservations = [];
    const recorded = [];
    const handler = createSpekoWebhookHandler({
      config: { speko: { webhookSecret: validConfig.webhookSecret } },
      shouldProcessProviderEventAsync: async (source, event) => (reservations.push([source, event]), true),
      recordSpekoHumanCallControlEvent: async (event) => recorded.push(event),
    });
    const body = JSON.stringify({ type: "call.answered", event_id: "human-event-1", data: {
      call_id: "human-call-1", control_id: "opaque-leg", occurred_at: "2026-01-01T00:00:00Z",
      payload: { status: "active", digits: "1234", phone_number: "+15551234567" },
    } });
    const response = makeResponse();
    await handler(makeRequest(validConfig.webhookSecret, body, { webhookId: "webhook-delivery-1" }), response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(reservations, [["speko_human_call_control", { webhook_id: "webhook-delivery-1" }]]);
    assert.equal(recorded[0].event_id, "human-event-1");
    assert.deepEqual(recorded[0].details, { status: "active" });
  });

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

  it("rejects a missing raw request body instead of signing a re-serialized body", async () => {
    let processed = false;
    const handler = createSpekoWebhookHandler({
      config: { speko: { webhookSecret: validConfig.webhookSecret } },
      handleSpekoPreCall: async () => {
        processed = true;
        return {};
      },
    });
    const request = makeRequest(validConfig.webhookSecret, JSON.stringify({
      type: "call.pre_call",
      direction: "inbound",
      to: validConfig.phoneNumber,
    }));
    delete request.rawBody;
    const response = makeResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 401);
    assert.equal(processed, false);
  });

  it("fails closed when a shared webhook guard has no verifier", () => {
    const guard = webhookRouteTestables.createWebhookAuthGuard({});
    let processed = false;
    const wrapped = guard("twilio_call_status", (_req, res) => {
      processed = true;
      res.status(200).send("OK");
    });
    const response = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    wrapped({ headers: {}, requestId: "guard-test" }, response);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { error: "webhook_verifier_unavailable" });
    assert.equal(processed, false);
  });

  it("keeps shared webhook guards on the existing provider verification path", () => {
    let verified = 0;
    let processed = 0;
    const guard = webhookRouteTestables.createWebhookAuthGuard({
      requireValidTwilioSignature: () => {
        verified += 1;
        return true;
      },
    });
    const wrapped = guard("twilio_call_status", () => {
      processed += 1;
    });
    wrapped({ headers: {}, requestId: "twilio-regression" }, {});
    assert.equal(verified, 1);
    assert.equal(processed, 1);
  });

  it("deduplicates verified events and releases reservations when processing fails", async () => {
    let processed = 0;
    let released = 0;
    let sequence = 0;
    let duplicate = false;
    let recordedMetrics = 0;
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
      recordSpekoWebhookMetric: async () => {
        recordedMetrics += 1;
      },
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
    assert.equal(recordedMetrics, 1);

    duplicate = true;
    const third = makeResponse();
    await handler(request, third);
    assert.equal(third.body.duplicate, true);
    assert.equal(processed, 2);
    assert.equal(recordedMetrics, 1);

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

  it("passes authenticated pre-call payloads to the inbound route and fails closed", async () => {
    let acceptedEvent = null;
    const acceptedHandler = createSpekoWebhookHandler({
      config: { speko: { webhookSecret: validConfig.webhookSecret } },
      handleSpekoPreCall: async (event) => {
        acceptedEvent = event;
        return { metadata: { voicednut_call_id: "speko_in_test" } };
      },
    });
    const body = JSON.stringify({
      type: "call.pre_call",
      session_id: "session_inbound",
      direction: "inbound",
      to: "+12015550199",
    });
    const accepted = makeResponse();
    await acceptedHandler(
      makeRequest(validConfig.webhookSecret, body),
      accepted,
    );
    assert.equal(accepted.statusCode, 200);
    assert.equal(acceptedEvent.session_id, "session_inbound");
    assert.equal(accepted.body.metadata.voicednut_call_id, "speko_in_test");

    const deniedHandler = createSpekoWebhookHandler({
      config: { speko: { webhookSecret: validConfig.webhookSecret } },
      handleSpekoPreCall: async () => {
        const error = new Error("unassigned");
        error.code = "speko_inbound_number_unassigned";
        error.status = 403;
        throw error;
      },
    });
    const denied = makeResponse();
    await deniedHandler(
      makeRequest(validConfig.webhookSecret, body, { webhookId: "evt_denied" }),
      denied,
    );
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.error, "speko_inbound_number_unassigned");
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

  it("uses Speko's draft and version endpoints without updating live agents", async () => {
    const requests = [];
    const responses = [
      { has_draft: false, agent_id: "agent_1" },
      { has_draft: true, changed_fields: ["systemPrompt"], draft_version_number: 2 },
      [{ version_number: 1, status: "live" }],
      { published_draft: true, version_number: 2 },
      { version_number: 3, status: "live" },
    ];
    const adapter = new SpekoVoiceAdapter({
      config: validConfig,
      fetch: async (url, options) => {
        requests.push({ url, options });
        return createResponse(200, responses.shift());
      },
    });

    await adapter.getAgentDraft("agent/1");
    await adapter.updateAgentDraft("agent/1", { systemPrompt: "Updated prompt" });
    await adapter.listAgentVersions("agent/1");
    await adapter.deployAgentDraft("agent/1");
    await adapter.rollbackAgent("agent/1", 1);

    assert.deepEqual(requests.map(({ url, options }) => [
      url.replace("https://api.speko.dev", ""),
      options.method || "GET",
    ]), [
      ["/v1/agents/agent%2F1/draft", "GET"],
      ["/v1/agents/agent%2F1/draft", "PUT"],
      ["/v1/agents/agent%2F1/versions", "GET"],
      ["/v1/agents/agent%2F1/deploy", "POST"],
      ["/v1/agents/agent%2F1/rollback", "POST"],
    ]);
    assert.deepEqual(JSON.parse(requests[1].options.body), { systemPrompt: "Updated prompt" });
    assert.deepEqual(JSON.parse(requests[3].options.body), {});
    assert.deepEqual(JSON.parse(requests[4].options.body), { target_version_number: 1 });
    assert.equal(requests.some(({ url }) => /\/v1\/agents\/agent%2F1$/.test(url)), false);
  });

  it("rejects unsupported agent draft fields and invalid rollback versions locally", async () => {
    const adapter = new SpekoVoiceAdapter({
      config: validConfig,
      fetch: async () => {
        throw new Error("Draft validation should not make a request");
      },
    });
    await assert.rejects(
      adapter.updateAgentDraft("agent_test", { outboundDtmf: true }),
      { code: "speko_unsupported_agent_draft_field", status: 400 },
    );
    await assert.rejects(
      adapter.updateAgentDraft("agent_test", {}),
      { code: "speko_unsupported_agent_draft_field", status: 400 },
    );
    await assert.rejects(
      adapter.rollbackAgent("agent_test", 0),
      { code: "speko_invalid_agent_version", status: 400 },
    );
  });
});
