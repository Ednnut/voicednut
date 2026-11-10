"use strict";

const assert = require("node:assert/strict");
const { resolveCartesiaLineRuntime } = require("../services/cartesiaLineRuntimePolicy");

const eligibleCall = {
  script_policy: {
    lifecycle_state: "live",
    agent_config: {
      voice_agent_settings: {
        provider: "cartesia_line",
        agent_id: "agent_1234567890",
      },
    },
  },
};
const eligibleConfig = {
  lineAgentEnabled: true,
  dataHandlingReviewed: true,
  apiKey: "mock-server-key",
};

describe("Cartesia hosted-agent runtime policy", () => {
  it("does not change existing runtime selection unless a script explicitly selects Cartesia", () => {
    assert.deepEqual(resolveCartesiaLineRuntime({}, eligibleConfig), {
      selected: false,
      reason: "cartesia_line_not_selected",
    });
  });

  it("requires independent default-off enablement and data-handling review gates", () => {
    assert.equal(resolveCartesiaLineRuntime(eligibleCall, {
      ...eligibleConfig,
      lineAgentEnabled: false,
    }).reason, "cartesia_line_disabled");
    assert.equal(resolveCartesiaLineRuntime(eligibleCall, {
      ...eligibleConfig,
      dataHandlingReviewed: false,
    }).reason, "cartesia_line_data_handling_not_reviewed");
    assert.equal(resolveCartesiaLineRuntime(eligibleCall, {
      ...eligibleConfig,
      apiKey: "",
    }).reason, "cartesia_not_configured");
    const draftCall = structuredClone(eligibleCall);
    draftCall.script_policy.lifecycle_state = "draft";
    assert.equal(resolveCartesiaLineRuntime(draftCall, eligibleConfig).reason, "cartesia_line_script_not_live");
  });

  it("accepts only a valid hosted agent identifier after all gates pass", () => {
    assert.deepEqual(resolveCartesiaLineRuntime(eligibleCall, eligibleConfig), {
      selected: true,
      provider: "cartesia_line",
      agentId: "agent_1234567890",
    });
    const invalid = structuredClone(eligibleCall);
    invalid.script_policy.agent_config.voice_agent_settings.agent_id = "https://example.test/agent";
    assert.equal(resolveCartesiaLineRuntime(invalid, eligibleConfig).reason, "cartesia_line_agent_id_invalid");
  });
});
