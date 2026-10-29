const assert = require("assert");
const {
  VoiceProviderRegistry,
  canFailoverAfterProviderError,
  normalizeProviderOperationError,
} = require("../adapters/voiceProviderRegistry");
const CallEVoiceAdapter = require("../adapters/CallEVoiceAdapter");

describe("VoiceProviderRegistry", () => {
  it("normalizes provider errors without exposing provider messages and only permits failover when submission is ruled out", () => {
    const normalized = normalizeProviderOperationError("twilio", "outbound_call.create", {
      code: "econnreset",
      statusCode: 503,
      message: "provider response contained private data",
      retryable: true,
    });

    assert.deepEqual(normalized, {
      provider: "twilio",
      channel: "call",
      operation: "outbound_call.create",
      code: "econnreset",
      statusCode: 503,
      submissionState: "unknown",
      retryable: true,
      message: "Voice provider operation failed",
    });
    assert.equal(canFailoverAfterProviderError({ providerSubmissionState: "not_submitted" }), true);
    assert.equal(canFailoverAfterProviderError({ providerSubmissionState: "rejected" }), true);
    assert.equal(canFailoverAfterProviderError({ providerSubmissionState: "unknown" }), false);
    assert.equal(canFailoverAfterProviderError(new Error("network timeout")), false);
  });

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
    assert.deepStrictEqual(
      registry.preflightOperation("create-only", "outbound_call.create"),
      { ok: true, provider: "create-only", operation: "outbound_call.create", reason: null },
    );
    assert.deepStrictEqual(
      registry.preflightOperation("create-only", "call.active_terminate"),
      {
        ok: false,
        provider: "create-only",
        operation: "call.active_terminate",
        reason: "provider_operation_unsupported",
      },
    );
    assert.deepStrictEqual(registry.preflightOperation("missing", "call.read"), {
      ok: false,
      provider: "missing",
      operation: "call.read",
      reason: "provider_not_registered",
    });
    assert.deepStrictEqual(registry.preflightOperation("create-only", "unknown"), {
      ok: false,
      provider: "create-only",
      operation: "unknown",
      reason: "provider_operation_unknown",
    });
    assert.deepStrictEqual(registry.getDescriptor("create-only"), {
      provider: "create-only",
      channel: "call",
      capabilities: [],
      operations: {
        "outbound_call.create": true,
        "outbound_task.create": false,
        "outbound_task.cancel_before_submission": false,
        "call.read": false,
        "call.events.read": false,
        "call.active_terminate": false,
      },
    });
  });

  it("routes task calls through a separate capability and rejects generic calls and active termination", async () => {
    let received;
    let cancelRequest;
    const adapter = new CallEVoiceAdapter({
      async createTaskCall(request) {
        received = request;
        return {
          localCallId: "call_e_local-1",
          providerCallId: "call_provider-1",
          status: "queued",
        };
      },
      async cancelTaskCall(request) {
        cancelRequest = request;
        return { id: request.providerCallId, status: "canceled" };
      },
      async getCall({ providerCallId }) { return { id: providerCallId }; },
      async listCallEvents({ providerCallId }) { return { object: "list", data: [], call_id: providerCallId }; },
    });
    const registry = new VoiceProviderRegistry().register("call_e", adapter);

    assert.equal(registry.getDescriptor("call_e").operations["outbound_call.create"], false);
    assert.equal(registry.getDescriptor("call_e").operations["outbound_task.create"], true);
    assert.equal(registry.getDescriptor("call_e").operations["outbound_task.cancel_before_submission"], true);
    assert.equal(registry.getDescriptor("call_e").operations["call.active_terminate"], false);
    assert.equal(registry.getDescriptor("call_e").operations["call.read"], true);
    assert.equal(registry.getDescriptor("call_e").operations["call.events.read"], true);
    assert.deepEqual(registry.getCapabilities("call_e"), [
      "outbound_task",
      "cancel_before_submission",
      "call_status",
      "transcript",
      "structured_result",
      "outcome",
      "event_history",
    ]);
    const result = await registry.createTaskCall("call_e", { task: "approved task" });
    assert.deepEqual(received, { task: "approved task" });
    assert.equal(result.operation, "outbound_task.create");
    assert.equal(result.callId, "call_e_local-1");
    assert.equal(result.localCallId, "call_e_local-1");
    assert.equal(result.providerCallId, "call_provider-1");
    assert.deepEqual(await registry.cancelTaskCall("call_e", { providerCallId: "call_provider-1" }), {
      id: "call_provider-1",
      status: "canceled",
    });
    assert.deepEqual(cancelRequest, { providerCallId: "call_provider-1" });
    await assert.rejects(registry.createOutboundCall("call_e"), (error) => error.code === "provider_operation_unsupported");
    await assert.rejects(registry.endCall("call_e"), (error) => error.code === "provider_operation_unsupported");
  });

  it("rejects unsupported operations before invoking an adapter", async () => {
    let invoked = false;
    const registry = new VoiceProviderRegistry().register("create-only", {
      createOutboundCall: async () => {
        invoked = true;
        return { callId: "local-1" };
      },
    });

    await assert.rejects(registry.endCall("create-only"), (error) => {
      assert.equal(error.code, "provider_operation_unsupported");
      assert.equal(error.providerSubmissionState, "not_submitted");
      return true;
    });
    assert.equal(invoked, false);
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
