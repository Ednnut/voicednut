const assert = require("assert");
const { VoiceProviderRegistry } = require("../adapters/voiceProviderRegistry");

describe("VoiceProviderRegistry", () => {
  it("normalizes outbound call results behind one provider contract", async () => {
    const registry = new VoiceProviderRegistry().register(" Example ", {
      capabilities: ["OUTBOUND_VOICE", "outbound_voice"],
      createOutboundCall: async () => ({
        call_id: "local-123",
        provider_call_id: "remote-456",
        status: "IN-PROGRESS",
        metadata: { resource: "remote-456" },
      }),
      endCall: async () => ({ ended: true }),
    });

    const result = await registry.createOutboundCall("EXAMPLE", {});

    assert.deepStrictEqual(registry.list(), ["example"]);
    assert.deepStrictEqual(registry.getCapabilities("example"), ["outbound_voice"]);
    assert.deepStrictEqual(result, {
      provider: "example",
      channel: "call",
      operation: "outbound_call.create",
      submissionState: "accepted",
      callId: "local-123",
      status: "in-progress",
      canonicalStatus: "in-progress",
      providerCallId: "remote-456",
      metadata: { resource: "remote-456" },
    });
    assert.deepStrictEqual(await registry.endCall("example", {}), { ended: true });
  });

  it("reports optional operations instead of requiring termination support", () => {
    const registry = new VoiceProviderRegistry().register("create-only", { createOutboundCall() {} });
    assert.deepStrictEqual(registry.getDescriptor("create-only"), {
      provider: "create-only",
      channel: "call",
      capabilities: [],
      operations: {
        "outbound_call.create": true,
        "call.active_terminate": false,
      },
    });
  });

  it("rejects unknown providers and malformed create results", async () => {
    const registry = new VoiceProviderRegistry().register("empty-result", {
      createOutboundCall: async () => ({ status: "queued" }),
      endCall: async () => undefined,
    });

    await assert.rejects(registry.createOutboundCall("missing"), /Unsupported voice provider/);
    await assert.rejects(registry.createOutboundCall("empty-result"), /returned no local call ID/);
  });
});
