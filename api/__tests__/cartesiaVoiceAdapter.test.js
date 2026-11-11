"use strict";

const assert = require("node:assert/strict");
const CartesiaVoiceAdapter = require("../adapters/CartesiaVoiceAdapter");
const { VoiceProviderRegistry } = require("../adapters/voiceProviderRegistry");

describe("CartesiaVoiceAdapter", () => {
  it("uses the guarded outbound service and normalizes its call identifier for the provider registry", async () => {
    const request = {
      businessId: "business-1",
      actorId: "7001",
      destination: "+14155550123",
      agentId: "agent-1",
      fromNumberId: "number-1",
      idempotencyKey: "cartesia-request-01",
      approvalToken: "server-issued-approval",
    };
    let received;
    const registry = new VoiceProviderRegistry().register("cartesia", new CartesiaVoiceAdapter({
      async createOutboundCall(input) {
        received = input;
        return { providerCallId: "agent_call_1", status: "queued", idempotentReplay: true };
      },
    }));

    const result = await registry.createOutboundCall("cartesia", request);

    assert.deepEqual(received, request);
    assert.deepEqual(result, {
      provider: "cartesia",
      channel: "call",
      operation: "outbound_call.create",
      submissionState: "accepted",
      callId: "agent_call_1",
      status: "queued",
      canonicalStatus: "queued",
      providerCallId: "agent_call_1",
      metadata: { idempotentReplay: true },
    });
    assert.deepEqual(registry.getCapabilities("cartesia"), ["managed_agent_outbound_call"]);
    assert.equal(registry.supportsOperation("cartesia", "call.active_terminate"), false);
  });

  it("preserves guarded service failures without retrying or hiding them", async () => {
    const failure = Object.assign(new Error("approval is required"), {
      code: "cartesia_approval_required",
      status: 403,
      providerSubmissionState: "not_submitted",
    });
    let calls = 0;
    const registry = new VoiceProviderRegistry().register("cartesia", new CartesiaVoiceAdapter({
      async createOutboundCall() {
        calls += 1;
        throw failure;
      },
    }));

    await assert.rejects(registry.createOutboundCall("cartesia", {}), (error) => error === failure);
    assert.equal(calls, 1);
  });

  it("requires a guarded outbound service handler", () => {
    assert.throws(() => new CartesiaVoiceAdapter(), /requires an outbound call handler/);
  });
});
