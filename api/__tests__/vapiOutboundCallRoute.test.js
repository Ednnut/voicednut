const assert = require("node:assert/strict");
const { __testables } = require("../services/callRoutes");

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function createHandler(overrides = {}) {
  return __testables.createOutboundCallHandler({
    sendApiError(res, status, code, message) {
      return res.status(status).json({ success: false, code, error: message });
    },
    resolveHost: () => "api.example.test",
    config: { server: { hostname: "api.example.test" } },
    placeOutboundCall: async () => { throw new Error("legacy provider path must not run"); },
    placeVapiOutboundCall: async () => ({
      providerCallId: "call_vapi_1", status: "queued", idempotentReplay: false,
      templateId: 17, templateVersion: 4, mappingId: 91,
    }),
    buildErrorDetails: () => ({}),
    ...overrides,
  });
}

describe("customer outbound Vapi call route", () => {
  it("dispatches only an explicit Vapi request with a template mapping and returns provider correlation", async () => {
    const calls = [];
    const handler = createHandler({
      placeVapiOutboundCall: async (input) => {
        calls.push(input);
        return { providerCallId: "call_vapi_1", status: "queued", idempotentReplay: true, templateId: 17, templateVersion: 4, mappingId: 91 };
      },
    });
    const req = {
      body: { provider: "vapi", number: "+14155550123", script_id: 17, script_version: 4, mapping_id: 91, phone_number_id: "pn_provider_1", idempotency_key: "request-id-0001" },
      headers: {}, requestId: "req-1",
    };
    const res = makeResponse();
    await handler(req, res);
    assert.deepEqual(calls, [{
      templateId: 17, templateVersion: 4, mappingId: 91, phoneNumberId: "pn_provider_1", number: "+14155550123", idempotencyKey: "request-id-0001",
    }]);
    assert.deepEqual(res.body, {
      success: true,
      call_sid: "call_vapi_1",
      provider_call_id: "call_vapi_1",
      to: "+14155550123",
      status: "queued",
      deduped: true,
      provider: "vapi",
      template_id: 17,
      template_version: 4,
      mapping_id: 91,
      business_context: null,
      generated_functions: 0,
      function_types: [],
      enhanced_webhooks: true,
    });
  });

  it("does not fall through to legacy providers when a Vapi mapping is missing or rejected", async () => {
    let providerCalls = 0;
    const handler = createHandler({
      placeVapiOutboundCall: async () => {
        providerCalls += 1;
        const error = new Error("Template mapping is stale");
        error.code = "vapi_mapping_stale";
        throw error;
      },
    });
    const res = makeResponse();
    await handler({
      body: { provider: "vapi", number: "+14155550123", script_id: 17, mapping_id: 91, phone_number_id: "pn_provider_1", idempotency_key: "request-id-0002" },
      headers: {}, requestId: "req-2",
    }, res);
    assert.equal(providerCalls, 1);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "vapi_mapping_stale");
  });

  it("requires explicit mapping and provider phone-number selection", async () => {
    let providerCalls = 0;
    const handler = createHandler({ placeVapiOutboundCall: async () => { providerCalls += 1; } });
    const res = makeResponse();
    await handler({
      body: { provider: "vapi", number: "+14155550123", script_id: 17 }, headers: {}, requestId: "req-3",
    }, res);
    assert.equal(providerCalls, 0);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "vapi_mapping_required");
  });
});
