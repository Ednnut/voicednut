const assert = require("node:assert/strict");
const {
  resolveProviderExecutionOrder,
  classifyProviderSubmissionState,
} = require("../adapters/providerFlowPolicy");

describe("provider execution circuit policy", () => {
  it("treats client rejections as definitive and timeouts/server errors as ambiguous", () => {
    assert.equal(classifyProviderSubmissionState(422), "rejected");
    assert.equal(classifyProviderSubmissionState(429), "rejected");
    assert.equal(classifyProviderSubmissionState(408), "unknown");
    assert.equal(classifyProviderSubmissionState(503), "unknown");
    assert.equal(classifyProviderSubmissionState(null), "unknown");
  });

  it("keeps open-circuit providers out of fallback order while reporting them", () => {
    const plan = resolveProviderExecutionOrder({
      channel: "call",
      preferredProvider: "twilio",
      providers: ["twilio", "plivo", "vonage"],
      readiness: { twilio: true, plivo: true, vonage: true },
      requestedFlow: "outbound_voice",
      isProviderDegraded: (provider) => provider === "plivo",
    });

    assert.deepEqual(plan.healthy_providers, ["twilio", "vonage"]);
    assert.deepEqual(plan.degraded_providers, ["plivo"]);
    assert.deepEqual(plan.attempt_order, ["twilio", "vonage"]);
    assert.equal(plan.selected_provider, "twilio");
  });

  it("does not route while every eligible provider circuit is open", () => {
    const plan = resolveProviderExecutionOrder({
      channel: "call",
      preferredProvider: "twilio",
      providers: ["twilio", "plivo"],
      readiness: { twilio: true, plivo: true },
      requestedFlow: "outbound_voice",
      isProviderDegraded: () => true,
    });

    assert.deepEqual(plan.attempt_order, []);
    assert.equal(plan.selected_provider, null);
    assert.deepEqual(plan.degraded_providers, ["twilio", "plivo"]);
  });

  it("keeps the configured primary when provider failover is disabled", () => {
    const plan = resolveProviderExecutionOrder({
      channel: "call",
      preferredProvider: "twilio",
      providers: ["twilio", "plivo"],
      readiness: { twilio: true, plivo: true },
      requestedFlow: "outbound_voice",
      failoverEnabled: false,
      isProviderDegraded: () => false,
      getProviderHealthScore: (provider) => provider === "plivo" ? 100 : 10,
    });

    assert.deepEqual(plan.healthy_providers, ["twilio", "plivo"]);
    assert.deepEqual(plan.attempt_order, ["twilio"]);
    assert.equal(plan.selected_provider, "twilio");
  });

  it("does not bypass an open primary circuit when failover is disabled", () => {
    const plan = resolveProviderExecutionOrder({
      channel: "call",
      preferredProvider: "twilio",
      providers: ["twilio", "plivo"],
      readiness: { twilio: true, plivo: true },
      requestedFlow: "outbound_voice",
      failoverEnabled: false,
      isProviderDegraded: (provider) => provider === "twilio",
    });

    assert.deepEqual(plan.attempt_order, []);
    assert.equal(plan.selected_provider, null);
  });
});
