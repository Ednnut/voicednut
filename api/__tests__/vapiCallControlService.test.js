const assert = require("node:assert/strict");
const { VapiCallControlService } = require("../services/vapiCallControlService");

describe("VapiCallControlService", () => {
  it("ends a locally correlated active call through its Vapi control URL", async () => {
    const actions = [];
    const service = new VapiCallControlService({
      client: {
        isConfigured: () => true,
        getCall: async (id) => ({ id, status: "in-progress", monitor: { controlUrl: "https://aws-us-west-2-production1-phone-call-websocket.vapi.ai/call/control" } }),
        endCall: async (url) => { actions.push(url); return { accepted: true }; },
      },
      getLocalCall: async (id) => id === "call-123" ? { provider_call_id: id, status: "completed" } : null,
      listEvents: async () => [],
    });

    const result = await service.endCall("call-123");
    assert.deepEqual(result, { providerCallId: "call-123", accepted: true, alreadyEnded: false });
    assert.deepEqual(actions, ["https://aws-us-west-2-production1-phone-call-websocket.vapi.ai/call/control"]);
  });

  it("rejects calls without a local Vapi correlation before contacting Vapi", async () => {
    let providerReads = 0;
    const service = new VapiCallControlService({
      client: { isConfigured: () => true, getCall: async () => { providerReads += 1; } },
      getLocalCall: async () => null,
      listEvents: async () => [],
    });
    await assert.rejects(service.endCall("call-unknown"), (error) => error.code === "vapi_call_not_found");
    assert.equal(providerReads, 0);
  });

  it("does not send controls for calls that are already ended", async () => {
    let controlRequests = 0;
    const service = new VapiCallControlService({
      client: {
        isConfigured: () => true,
        getCall: async (id) => ({ id, status: "ended" }),
        endCall: async () => { controlRequests += 1; },
      },
      getLocalCall: async (id) => ({ provider_call_id: id }),
      listEvents: async () => [{ event_type: "end-of-call-report", provider_status: "ended" }],
    });
    const result = await service.endCall("call-ended");
    assert.equal(result.alreadyEnded, true);
    assert.equal(controlRequests, 0);
  });

  it("refuses an untrusted control URL", async () => {
    let controlRequests = 0;
    const service = new VapiCallControlService({
      client: {
        isConfigured: () => true,
        getCall: async (id) => ({ id, status: "in-progress", monitor: { controlUrl: "https://attacker.example/call/control" } }),
        endCall: async () => { controlRequests += 1; },
      },
      getLocalCall: async (id) => ({ provider_call_id: id }),
      listEvents: async () => [],
    });
    await assert.rejects(service.endCall("call-123"), (error) => error.code === "vapi_control_url_invalid");
    assert.equal(controlRequests, 0);
  });

  it("transfers a locally correlated active call to an explicit E.164 destination", async () => {
    const transfers = [];
    const service = new VapiCallControlService({
      client: {
        isConfigured: () => true,
        getCall: async (id) => ({ id, status: "in-progress", monitor: { controlUrl: "https://region-production.vapi.ai/call-123/control" } }),
        transferCall: async (...args) => { transfers.push(args); },
      },
      getLocalCall: async (id) => ({ provider_call_id: id }),
      listEvents: async () => [],
    });
    const result = await service.transferCall("call-123", { type: "number", number: "+14155550111" }, "Connecting you now.");
    assert.deepEqual(result, { providerCallId: "call-123", accepted: true });
    assert.deepEqual(transfers, [[
      "https://region-production.vapi.ai/call-123/control",
      { type: "number", number: "+14155550111" },
      "Connecting you now.",
    ]]);
  });

  it("rejects invalid transfer destinations and ended calls without sending a control request", async () => {
    let transfers = 0;
    const service = new VapiCallControlService({
      client: {
        isConfigured: () => true,
        getCall: async (id) => ({ id, status: "ended", monitor: { controlUrl: "https://region-production.vapi.ai/call/control" } }),
        transferCall: async () => { transfers += 1; },
      },
      getLocalCall: async (id) => ({ provider_call_id: id }),
      listEvents: async () => [],
    });
    await assert.rejects(service.transferCall("call-123", { type: "number", number: "5550100" }), (error) => error.code === "vapi_transfer_destination_invalid");
    await assert.rejects(service.transferCall("call-123", { type: "sip", sipUri: "sip:user@example.com" }), (error) => error.code === "vapi_call_not_active");
    assert.equal(transfers, 0);
  });

  it("rejects non-text transfer content before contacting Vapi", async () => {
    let providerReads = 0;
    const service = new VapiCallControlService({
      client: { isConfigured: () => true, getCall: async () => { providerReads += 1; } },
      getLocalCall: async (id) => ({ provider_call_id: id }),
      listEvents: async () => [],
    });
    await assert.rejects(service.transferCall("call-123", { type: "number", number: "+14155550111" }, { secret: "value" }), (error) => error.code === "vapi_transfer_content_invalid");
    assert.equal(providerReads, 0);
  });
});
