const assert = require("node:assert/strict");
const {
  PROVIDER_CAPABILITY_REGISTRY,
  PROVIDER_CHANNELS,
  listProviderCapabilities,
  providerSupportsCapability,
  resolveProviderExecutionOrder,
} = require("../adapters/providerFlowPolicy");
const providerState = require("../adapters/providerState");

describe("provider capability registry", () => {
  it("is the source for provider selection support lists", () => {
    for (const channel of Object.values(PROVIDER_CHANNELS)) {
      assert.deepEqual(
        providerState.getSupportedProviders(channel),
        Object.keys(PROVIDER_CAPABILITY_REGISTRY[channel]),
      );
    }
  });

  it("declares only application-integrated call capabilities", () => {
    assert.equal(providerSupportsCapability("call", "speko", "outbound_voice"), true);
    assert.equal(providerSupportsCapability("call", "speko", "status_webhooks"), true);
    assert.equal(providerSupportsCapability("call", "speko", "digit_capture"), false);
    assert.equal(providerSupportsCapability("call", "speko", "payment_native"), false);
    assert.equal(providerSupportsCapability("call", "vonage", "digit_capture"), false);
    assert.equal(
      providerSupportsCapability("call", "vonage", "digit_capture", {
        vonageDtmfWebhookEnabled: true,
      }),
      true,
    );
    assert.deepEqual(listProviderCapabilities("call", "unknown"), []);
  });

  it("excludes providers that lack a requested capability", () => {
    const plan = resolveProviderExecutionOrder({
      channel: "call",
      providers: ["speko", "twilio"],
      readiness: { speko: true, twilio: true },
      requestedFlow: "outbound_voice",
      requiredCapabilities: ["digit_capture"],
      failoverEnabled: false,
    });
    assert.deepEqual(plan.blocked_providers, [
      {
        provider: "speko",
        reason: "capability_unsupported",
        capability: "digit_capture",
        score: null,
      },
    ]);
    assert.deepEqual(plan.attempt_order, ["twilio"]);
  });
});
