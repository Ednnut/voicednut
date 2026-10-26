const assert = require("node:assert/strict");
const { VapiApiError, VapiClient } = require("../services/vapiClient");
const {
  fingerprintVapiTemplateMapping,
  mapCallTemplateToVapiAssistant,
} = require("../adapters/vapiTemplateAdapter");

describe("VapiClient", () => {
  it("sends server-side bearer requests to documented assistant endpoints", async () => {
    const requests = [];
    const client = new VapiClient({
      enabled: true,
      apiKey: "private-test-key",
      fetchFn: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 201, json: async () => ({ id: "asst_test" }) };
      },
    });
    const result = await client.createAssistant({ firstMessage: "Hello" });
    assert.equal(result.id, "asst_test");
    assert.equal(requests[0].url, "https://api.vapi.ai/assistant");
    assert.equal(requests[0].options.headers.Authorization, "Bearer private-test-key");
    assert.deepEqual(JSON.parse(requests[0].options.body), { firstMessage: "Hello" });
  });

  it("blocks requests while disabled or unconfigured", async () => {
    const disabled = new VapiClient({ apiKey: "key", fetchFn: async () => {} });
    await assert.rejects(disabled.createCall({}), (error) => error.code === "vapi_disabled");
    const missing = new VapiClient({ enabled: true, fetchFn: async () => {} });
    await assert.rejects(missing.createCall({}), (error) => error.code === "vapi_not_configured");
  });

  it("supports assistant list, get, and partial update endpoints", async () => {
    const requests = [];
    const client = new VapiClient({
      enabled: true,
      apiKey: "key",
      fetchFn: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ id: "asst_a" }) };
      },
    });
    await client.listAssistants({ limit: 1000 });
    await client.getAssistant("asst/a");
    await client.updateAssistant("asst_a", { firstMessage: "Hello" });
    assert.match(requests[0].url, /\/assistant\?limit=1000$/);
    assert.equal(requests[1].url, "https://api.vapi.ai/assistant/asst%2Fa");
    assert.equal(requests[2].options.method, "PATCH");
  });

  it("lists phone numbers through the documented paginated v2 endpoint", async () => {
    const requests = [];
    const client = new VapiClient({
      enabled: true,
      apiKey: "key",
      fetchFn: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ results: [{ id: "pn_1" }] }) };
      },
    });
    const result = await client.listPhoneNumbers({ page: 2, limit: 50, search: "support" });
    assert.equal(result.results[0].id, "pn_1");
    assert.match(requests[0].url, /^https:\/\/api\.vapi\.ai\/v2\/phone-number\?/);
    assert.match(requests[0].url, /page=2/);
    assert.match(requests[0].url, /limit=50/);
    assert.match(requests[0].url, /search=support/);
    assert.equal(requests[0].options.headers.Authorization, "Bearer key");
  });

  it("gets and partially updates a phone number using the documented endpoints", async () => {
    const requests = [];
    const client = new VapiClient({
      enabled: true,
      apiKey: "key",
      fetchFn: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ id: "pn-uuid" }) };
      },
    });
    await client.getPhoneNumber("pn-uuid");
    await client.updatePhoneNumber("pn-uuid", { assistantId: null });
    assert.equal(requests[0].url, "https://api.vapi.ai/phone-number/pn-uuid");
    assert.equal(requests[0].options.method, "GET");
    assert.equal(requests[1].options.method, "PATCH");
    assert.deepEqual(JSON.parse(requests[1].options.body), { assistantId: null });
  });

  it("normalizes HTTP errors without retaining response content or credentials", async () => {
    const client = new VapiClient({
      enabled: true,
      apiKey: "secret",
      fetchFn: async () => ({ ok: false, status: 429, json: async () => ({ message: "private detail" }) }),
    });
    await assert.rejects(client.createCall({}), (error) => {
      assert.ok(error instanceof VapiApiError);
      assert.equal(error.status, 429);
      assert.equal(error.retryable, true);
      assert.equal(error.message.includes("private detail"), false);
      return true;
    });
  });

  it("loads a call and sends the documented end-call control without sending private API credentials to the control host", async () => {
    const requests = [];
    const client = new VapiClient({
      enabled: true,
      apiKey: "private-vapi-key",
      fetchFn: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ id: "call-123", status: "in-progress" }) };
      },
    });
    await client.getCall("call-123");
    await client.endCall("https://region-production-phone-call-websocket.vapi.ai/call-123/control");
    assert.equal(requests[0].url, "https://api.vapi.ai/call/call-123");
    assert.equal(requests[1].options.method, "POST");
    assert.deepEqual(JSON.parse(requests[1].options.body), { type: "end-call" });
    assert.equal(requests[1].options.headers.Authorization, undefined);
  });

  it("rejects unsafe live call control URLs before making a request", async () => {
    let requests = 0;
    const client = new VapiClient({ enabled: true, apiKey: "key", fetchFn: async () => { requests += 1; } });
    await assert.rejects(client.endCall("http://127.0.0.1/control"), (error) => error.code === "vapi_invalid_control_url");
    assert.equal(requests, 0);
  });

  it("sends a documented live transfer request without adding private call data to logs", async () => {
    const requests = [];
    const client = new VapiClient({
      enabled: true,
      apiKey: "secret",
      fetchFn: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      },
    });
    await client.transferCall(
      "https://region-production.vapi.ai/call-123/control",
      { type: "number", number: "+14155550111" },
      "Connecting you now.",
    );
    assert.equal(requests[0].options.method, "POST");
    assert.equal(requests[0].options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      type: "transfer",
      destination: { type: "number", number: "+14155550111" },
      content: "Connecting you now.",
    });
  });
});

describe("Vapi template mapping", () => {
  it("includes webhook delivery configuration in the mapping fingerprint", () => {
    const base = fingerprintVapiTemplateMapping({ id: 1, version: 1 }, {}, {});
    const withWebhook = fingerprintVapiTemplateMapping(
      { id: 1, version: 1 },
      {},
      {},
      { url: "https://api.example.test/webhook/vapi", credentialId: "cred_1" },
    );
    assert.notEqual(base, withWebhook);
  });

  it("maps explicit prompt/model/voice settings and retains template identity", () => {
    const result = mapCallTemplateToVapiAssistant({
      id: "tpl-1",
      version: 3,
      prompt: "Be helpful",
      first_message: "Hi there",
      configuration: { vapi: { model: { provider: "openai", model: "gpt-4o" }, voice: { provider: "11labs", voiceId: "voice-a" } } },
    });
    assert.equal(result.compatible, true);
    assert.equal(result.sourceTemplateId, "tpl-1");
    assert.equal(result.sourceTemplateVersion, 3);
    assert.equal(result.assistant.model.messages[0].content, "Be helpful");
    assert.equal(result.assistant.firstMessage, "Hi there");
    assert.equal(result.assistant.voice.voiceId, "voice-a");
  });

  it("does not invent model settings and reports unsupported template behavior", () => {
    const result = mapCallTemplateToVapiAssistant({
      id: "legacy",
      prompt: "Existing prompt",
      configuration: { tools: [{ name: "local-tool" }] },
    });
    assert.equal(result.compatible, false);
    assert.deepEqual(result.missing, ["firstMessage", "vapi.model", "vapi.voice"]);
    assert.deepEqual(result.unsupported, ["tools"]);
    assert.equal(result.assistant.model, undefined);

    const unknownField = mapCallTemplateToVapiAssistant({
      prompt: "Prompt",
      configuration: { vapi: { model: { provider: "openai", model: "gpt-4o" } }, localWorkflow: { steps: [] } },
    });
    assert.equal(unknownField.compatible, false);
    assert.deepEqual(unknownField.unsupported, ["configuration.localWorkflow"]);
  });

  it("marks existing call-template capabilities as unmapped for Vapi", () => {
    const result = mapCallTemplateToVapiAssistant({
      prompt: "Verify the caller",
      first_message: "Hello",
      voice_model: "aura-2-andromeda-en",
      supports_digit_capture: 1,
      requires_otp: 1,
      objective_tags: ["verify_identity"],
      payment_enabled: 1,
      payment_connector: "stripe",
      default_profile: "verification",
      allow_terminator: 1,
    });
    assert.equal(result.compatible, false);
    assert.deepEqual(result.unsupported, [
      "voice_model_mapping",
      "payment_workflow",
      "digit_capture",
      "payment_configuration",
      "conversation_profile",
      "terminator_behavior",
      "objective_flow",
    ]);
  });

  it("omits unreviewed Vapi model and voice settings from the mapped payload", () => {
    const result = mapCallTemplateToVapiAssistant({
      prompt: "Prompt",
      configuration: {
        vapi: {
          model: { provider: "openai", model: "gpt-4o", apiKey: "must-not-echo", temperature: 0.2 },
          voice: { provider: "11labs", voiceId: "voice-a", apiKey: "must-not-echo" },
        },
      },
    });
    assert.equal(result.compatible, false);
    assert.deepEqual(result.unsupported, ["voice_settings_fields", "model_settings_fields"]);
    assert.equal(JSON.stringify(result.assistant).includes("must-not-echo"), false);
  });
});
