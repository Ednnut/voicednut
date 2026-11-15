const assert = require("assert");
const CartesiaVoiceAdapter = require("../adapters/CartesiaVoiceAdapter");
const { VoiceProviderRegistry, canFailoverAfterProviderError } = require("../adapters/voiceProviderRegistry");

describe("CartesiaVoiceAdapter", () => {
  it("requires an injected orchestration handler", () => {
    assert.throws(() => new CartesiaVoiceAdapter(), /outbound call handler/);
  });

  it("registers only outbound creation and preserves distinct call identities", async () => {
    const request = { actorId: "operator-test", businessId: "business-test" };
    const adapter = new CartesiaVoiceAdapter({
      createOutboundCall: async (input) => {
        assert.strictEqual(input, request);
        return { localCallId: "local-test", providerCallId: "remote-test", status: "queued", callId: "wrong-id", idempotentReplay: true };
      },
    });
    const registry = new VoiceProviderRegistry().register("cartesia", adapter);
    assert.deepStrictEqual(registry.getCapabilities("cartesia"), ["outbound_voice"]);
    const operations = registry.getDescriptor("cartesia").operations;
    assert.deepStrictEqual(Object.keys(operations).filter((key) => operations[key]), ["outbound_call.create"]);
    const result = await registry.createOutboundCall("cartesia", request);
    assert.strictEqual(result.callId, "local-test");
    assert.strictEqual(result.localCallId, "local-test");
    assert.strictEqual(result.providerCallId, "remote-test");
    assert.strictEqual(result.metadata.idempotentReplay, true);
  });

  it("preserves submission errors without retrying the handler", async () => {
    const failure = Object.assign(new Error("Submission uncertain"), { providerSubmissionState: "unknown" });
    let attempts = 0;
    const adapter = new CartesiaVoiceAdapter({ createOutboundCall: async () => {
      attempts += 1;
      throw failure;
    } });
    await assert.rejects(adapter.createOutboundCall(), (error) => error === failure);
    assert.strictEqual(attempts, 1);
  });

  for (const result of [undefined, {}, { providerCallId: "remote-test" },
    { localCallId: "local-test" }, { localCallId: "same", providerCallId: "same" }]) {
    it(`blocks incomplete or conflated identities: ${JSON.stringify(result)}`, async () => {
      const adapter = new CartesiaVoiceAdapter({ createOutboundCall: async () => result });
      await assert.rejects(adapter.createOutboundCall(), (error) => {
        assert.strictEqual(error.code, "cartesia_call_outcome_unknown");
        assert.strictEqual(canFailoverAfterProviderError(error), false);
        return true;
      });
    });
  }
});