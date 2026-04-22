const assert = require("node:assert/strict");

const {
  getDomainFlowPolicyDecision,
  applyDomainFlowPolicyDecision,
} = require("../functions/domainFlowPolicy");

function assertSubset(actual, expected) {
  Object.entries(expected).forEach(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assertSubset(actual[key], value);
      return;
    }
    assert.deepEqual(actual[key], value);
  });
}

function createSpy({ async = false } = {}) {
  const calls = [];
  const spy = (...args) => {
    calls.push(args);
    return async ? Promise.resolve() : undefined;
  };
  spy.calls = calls;
  return spy;
}

describe("domainFlowPolicy", () => {
  it("allows calls with no normalized domain", () => {
    assertSubset(
      getDomainFlowPolicyDecision({
        domain: "",
        source: "unit_test",
        callSid: "CA_no_domain",
        domainFlowsConfig: {},
      }),
      {
        allowed: true,
        shadowMode: false,
        reason: "no_domain",
        bucket: null,
        payload: null,
      },
    );
  });

  it("blocks on kill switch before applying allowlist compatibility", () => {
    assertSubset(
      getDomainFlowPolicyDecision({
        domain: "tax_support",
        source: "unit_test",
        callSid: "CA_kill_switch",
        domainFlowsConfig: {
          enabled: true,
          killSwitch: true,
          rolloutPercent: 100,
          allowlist: ["profile:tax_support"],
        },
      }),
      {
        allowed: false,
        shadowMode: false,
        reason: "kill_switch",
        payload: {
          status: "blocked",
          domain: "tax_support",
          policyReason: "kill_switch",
          shadowMode: false,
        },
      },
    );
  });

  it("allows an explicit profile allowlist entry even when the global flag is disabled", () => {
    assertSubset(
      getDomainFlowPolicyDecision({
        domain: "tax-support",
        source: "unit_test",
        callSid: "CA_allowlisted",
        domainFlowsConfig: {
          enabled: false,
          rolloutPercent: 0,
          allowlist: ["profile:tax_support"],
        },
      }),
      {
        allowed: true,
        shadowMode: false,
        reason: "allowlist",
        allowlisted: true,
        domain: "tax_support",
      },
    );
  });

  it("blocks disabled profiles when shadow mode is not enabled", () => {
    assertSubset(
      getDomainFlowPolicyDecision({
        domain: "fraud_review",
        source: "unit_test",
        callSid: "CA_disabled",
        domainFlowsConfig: {
          enabled: false,
          shadowMode: false,
          rolloutPercent: 100,
        },
      }),
      {
        allowed: false,
        shadowMode: false,
        reason: "disabled",
        payload: {
          status: "blocked",
          domain: "fraud_review",
          policyReason: "disabled",
          shadowMode: false,
        },
      },
    );
  });

  it("allows shadow mode execution even when rollout would otherwise be off", () => {
    assertSubset(
      getDomainFlowPolicyDecision({
        domain: "collections_servicing",
        source: "unit_test",
        callSid: "CA_shadow_mode",
        domainFlowsConfig: {
          enabled: false,
          shadowMode: true,
          rolloutPercent: 0,
        },
      }),
      {
        allowed: true,
        shadowMode: true,
        reason: "shadow_mode",
        domain: "collections_servicing",
      },
    );
  });

  it("blocks enabled profiles with zero rollout percent outside shadow mode", () => {
    assertSubset(
      getDomainFlowPolicyDecision({
        domain: "bank_servicing",
        source: "unit_test",
        callSid: "CA_rollout_zero",
        domainFlowsConfig: {
          enabled: true,
          shadowMode: false,
          rolloutPercent: 0,
        },
      }),
      {
        allowed: false,
        shadowMode: false,
        reason: "rollout_zero",
        payload: {
          status: "blocked",
          domain: "bank_servicing",
          policyReason: "rollout_zero",
          shadowMode: false,
        },
      },
    );
  });

  it("applies per-profile overrides ahead of the global rollout defaults", () => {
    assertSubset(
      getDomainFlowPolicyDecision({
        domain: "fraud-review",
        source: "unit_test",
        callSid: "CA_profile_override",
        domainFlowsConfig: {
          enabled: true,
          shadowMode: false,
          rolloutPercent: 100,
          enabledByProfile: {
            fraud_review: false,
          },
        },
      }),
      {
        allowed: false,
        shadowMode: false,
        reason: "disabled",
        domain: "fraud_review",
      },
    );
  });
});

describe("applyDomainFlowPolicyDecision", () => {
  function createDependencies() {
    return {
      db: {
        updateCallState: createSpy({ async: true }),
        setCallDisposition: createSpy({ async: true }),
        logServiceHealth: createSpy({ async: true }),
      },
      webhookService: {
        addLiveEvent: createSpy(),
      },
    };
  }

  it("records blocked side effects and returns the blocked payload", async () => {
    const dependencies = createDependencies();
    const decision = getDomainFlowPolicyDecision({
      domain: "tax_support",
      source: "unit_test",
      callSid: "CA_blocked_effects",
      domainFlowsConfig: {
        enabled: false,
        shadowMode: false,
        rolloutPercent: 100,
      },
    });

    const result = await applyDomainFlowPolicyDecision({
      decision,
      callSid: "CA_blocked_effects",
      ...dependencies,
    });

    assertSubset(result, {
      allowed: false,
      shadowMode: false,
      reason: "disabled",
      payload: {
        status: "blocked",
        domain: "tax_support",
        policyReason: "disabled",
        shadowMode: false,
      },
    });

    assert.equal(dependencies.db.updateCallState.calls.length, 1);
    assert.equal(dependencies.db.setCallDisposition.calls.length, 1);
    assert.equal(dependencies.db.logServiceHealth.calls.length, 1);
    assert.equal(dependencies.webhookService.addLiveEvent.calls.length, 1);

    assert.deepEqual(
      dependencies.db.updateCallState.calls[0].slice(0, 2),
      ["CA_blocked_effects", "domain_flow_policy_blocked"],
    );
    assertSubset(dependencies.db.updateCallState.calls[0][2], {
      domain: "tax_support",
      source: "unit_test",
      reason: "disabled",
    });

    assert.deepEqual(
      dependencies.db.setCallDisposition.calls[0].slice(0, 2),
      ["CA_blocked_effects", "policy_blocked"],
    );
    assertSubset(dependencies.db.setCallDisposition.calls[0][2], {
      domain: "tax_support",
      source: "unit_test",
      reason: "disabled",
    });

    assert.deepEqual(
      dependencies.db.logServiceHealth.calls[0].slice(0, 2),
      ["domain_flows", "blocked"],
    );
    assertSubset(dependencies.db.logServiceHealth.calls[0][2], {
      domain: "tax_support",
      source: "unit_test",
      reason: "disabled",
    });

    assert.deepEqual(
      dependencies.webhookService.addLiveEvent.calls[0],
      [
        "CA_blocked_effects",
        "🛑 Tax Support flow blocked by rollout policy",
        { force: true },
      ],
    );
  });

  it("records shadow mode side effects without creating a blocked disposition", async () => {
    const dependencies = createDependencies();
    const decision = getDomainFlowPolicyDecision({
      domain: "collections_servicing",
      source: "unit_test",
      callSid: "CA_shadow_effects",
      domainFlowsConfig: {
        enabled: false,
        shadowMode: true,
        rolloutPercent: 0,
      },
    });

    const result = await applyDomainFlowPolicyDecision({
      decision,
      callSid: "CA_shadow_effects",
      ...dependencies,
    });

    assertSubset(result, {
      allowed: true,
      shadowMode: true,
      reason: "shadow_mode",
    });

    assert.equal(dependencies.db.updateCallState.calls.length, 1);
    assert.equal(dependencies.db.setCallDisposition.calls.length, 0);
    assert.equal(dependencies.db.logServiceHealth.calls.length, 1);
    assert.equal(dependencies.webhookService.addLiveEvent.calls.length, 1);

    assert.deepEqual(
      dependencies.db.updateCallState.calls[0].slice(0, 2),
      ["CA_shadow_effects", "domain_flow_shadow_mode"],
    );
    assertSubset(dependencies.db.updateCallState.calls[0][2], {
      domain: "collections_servicing",
      source: "unit_test",
      reason: "shadow_mode",
    });

    assert.deepEqual(
      dependencies.db.logServiceHealth.calls[0].slice(0, 2),
      ["domain_flows", "shadow_mode"],
    );
    assertSubset(dependencies.db.logServiceHealth.calls[0][2], {
      domain: "collections_servicing",
      source: "unit_test",
      reason: "shadow_mode",
    });

    assert.deepEqual(
      dependencies.webhookService.addLiveEvent.calls[0],
      [
        "CA_shadow_effects",
        "👁 Collections Servicing flow running in shadow mode",
        { force: false },
      ],
    );
  });

  it("returns immediately for no-domain decisions without side effects", async () => {
    const dependencies = createDependencies();
    const decision = getDomainFlowPolicyDecision({
      domain: "",
      source: "unit_test",
      callSid: "CA_no_domain_effects",
      domainFlowsConfig: {},
    });

    const result = await applyDomainFlowPolicyDecision({
      decision,
      callSid: "CA_no_domain_effects",
      ...dependencies,
    });

    assert.deepEqual(result, {
      allowed: true,
      shadowMode: false,
      reason: "no_domain",
      bucket: null,
    });

    assert.equal(dependencies.db.updateCallState.calls.length, 0);
    assert.equal(dependencies.db.setCallDisposition.calls.length, 0);
    assert.equal(dependencies.db.logServiceHealth.calls.length, 0);
    assert.equal(dependencies.webhookService.addLiveEvent.calls.length, 0);
  });
});
