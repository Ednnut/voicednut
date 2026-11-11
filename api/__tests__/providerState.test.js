const assert = require("node:assert/strict");
const {
  getSupportedProviders,
  isCallESelectionReady,
  normalizeProvider,
} = require("../adapters/providerState");
const { listProviderFlows, providerSupportsFlow } = require("../adapters/providerFlowPolicy");

describe("CALL-E provider selection state", () => {
  it("lists only telephony providers as call providers without adding them to SMS providers", () => {
    assert.deepEqual(getSupportedProviders("call"), ["twilio", "plivo", "vonage", "call_e"]);
    assert.deepEqual(getSupportedProviders("sms"), ["twilio", "plivo", "vonage"]);
    assert.equal(getSupportedProviders("call").includes("cartesia"), false);
    assert.throws(() => normalizeProvider("call", "cartesia"), /Unsupported call provider/);
  });

  it("requires all server-side pilot gates before selecting CALL-E", () => {
    const ready = {
      enabled: true,
      dispatchEnabled: true,
      apiKey: "server-only-test-key",
      baseUrl: "https://test-api.heycall-e.com",
      allowedDestinations: ["+14155550100"],
      pilotApprovalFingerprint: "a".repeat(64),
      pilotApprovalReference: "approval:test-001",
      pilotApprovalExpiresAt: "2999-01-01T00:00:00Z",
      pilotReadinessReviewed: true,
    };

    assert.equal(isCallESelectionReady(ready), true);
    assert.equal(isCallESelectionReady({ ...ready, dispatchEnabled: false }), false);
    assert.equal(isCallESelectionReady({ ...ready, baseUrl: "https://untrusted.example" }), false);
    assert.equal(isCallESelectionReady({ ...ready, allowedDestinations: [] }), false);
    assert.equal(isCallESelectionReady({ ...ready, pilotApprovalExpiresAt: "2000-01-01T00:00:00Z" }), false);
  });

  it("advertises task calls while rejecting generic voice and keypad flows", () => {
    assert.deepEqual(listProviderFlows("call", "call_e"), ["outbound_task"]);
    assert.equal(providerSupportsFlow("call", "call_e", "outbound_task"), true);
    assert.equal(providerSupportsFlow("call", "call_e", "outbound_voice"), false);
    assert.equal(providerSupportsFlow("call", "call_e", "digit_capture"), false);
  });

});
