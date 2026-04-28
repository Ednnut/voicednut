const assert = require("node:assert/strict");

const {
  buildObjectiveTagsForFlow,
  getAutoAttachedScriptProfileFlow,
  getCallScriptFlowTypes,
  getEffectiveObjectiveTags,
  normalizeCallScriptFlowType,
  resolveScriptProfileRouting,
} = require("../functions/FlowMetadata");

describe("FlowMetadata", () => {
  it("normalizes the new domain flow aliases to canonical flow types", () => {
    assert.equal(normalizeCallScriptFlowType("tax-support-service"), "tax_support");
    assert.equal(normalizeCallScriptFlowType("fraud_review_support"), "fraud_review");
    assert.equal(
      normalizeCallScriptFlowType("identity-verification-plus-flow"),
      "identity_verification_plus",
    );
  });

  it("derives new domain flows from objective tags and default profile fallback", () => {
    assert.deepEqual(
      getCallScriptFlowTypes({
        objective_tags: ["collections_servicing_support"],
      }),
      ["collections_servicing"],
    );

    assert.deepEqual(
      getCallScriptFlowTypes({
        default_profile: "identity-verification-plus",
      }),
      ["identity_verification_plus"],
    );
  });

  it("keeps canonical domain objective tags stable when building effective tags", () => {
    assert.deepEqual(
      buildObjectiveTagsForFlow("bank-servicing", ["customer_requested_callback"]),
      ["customer_requested_callback", "bank_servicing_support"],
    );

    assert.deepEqual(
      getEffectiveObjectiveTags({
        flow_type: "bank-servicing",
        objective_tags: ["customer_requested_callback", "bank_servicing_support"],
      }),
      ["customer_requested_callback", "bank_servicing_support"],
    );
  });

  it("auto-attaches domain profiles for supported primary domain flows", () => {
    assert.equal(getAutoAttachedScriptProfileFlow({ flow_type: "tax_support" }), "tax_support");
    assert.equal(
      getAutoAttachedScriptProfileFlow({
        flow_type: "bank_servicing",
      }),
      "bank_servicing",
    );
    assert.equal(
      getAutoAttachedScriptProfileFlow({
        objective_tags: ["collections_servicing_support"],
      }),
      "collections_servicing",
    );
    assert.equal(
      getAutoAttachedScriptProfileFlow({
        default_profile: "identity-verification-plus",
      }),
      "identity_verification_plus",
    );
  });

  it("auto-attaches the dating profile for dating scripts", () => {
    assert.deepEqual(
      resolveScriptProfileRouting({
        flow_type: "dating",
      }),
      {
        primaryFlow: "dating",
        flowTypes: ["dating"],
        objectiveTags: ["dating_engagement"],
        attachedProfile: "dating",
        autoAttachProfile: true,
        callProfile: "dating",
        conversationProfile: "dating",
        profileLockMode: "locked",
        conversationProfileLock: true,
        purpose: "dating",
        warnings: [],
      },
    );
  });

  it("preserves relationship precedence and skips unsupported flows", () => {
    assert.equal(
      getAutoAttachedScriptProfileFlow({
        flow_types: ["tax_support", "dating"],
      }),
      "dating",
    );
    assert.equal(getAutoAttachedScriptProfileFlow({ flow_type: "general_outreach" }), null);
  });

  it("resolves script profile routing with dating precedence and explicit overrides", () => {
    assert.deepEqual(
      resolveScriptProfileRouting({
        flow_types: ["tax_support", "dating"],
      }),
      {
        primaryFlow: "tax_support",
        flowTypes: ["tax_support", "dating"],
        objectiveTags: ["tax_support_service"],
        attachedProfile: "dating",
        autoAttachProfile: true,
        callProfile: "dating",
        conversationProfile: "dating",
        profileLockMode: "locked",
        conversationProfileLock: true,
        purpose: "dating",
        warnings: [],
      },
    );

    assert.deepEqual(
      resolveScriptProfileRouting(
        { flow_type: "tax_support" },
        {
          callProfile: "fraud_review",
          conversationProfileLock: false,
        },
      ),
      {
        primaryFlow: "tax_support",
        flowTypes: ["tax_support"],
        objectiveTags: ["tax_support_service"],
        attachedProfile: "fraud_review",
        autoAttachProfile: true,
        callProfile: "fraud_review",
        conversationProfile: "fraud_review",
        profileLockMode: "unlocked",
        conversationProfileLock: false,
        purpose: "fraud_review",
        warnings: [],
      },
    );

    assert.deepEqual(
      resolveScriptProfileRouting({
        flow_type: "general_outreach",
      }),
      {
        primaryFlow: "general_outreach",
        flowTypes: ["general_outreach"],
        objectiveTags: ["general_outreach"],
        attachedProfile: null,
        autoAttachProfile: null,
        callProfile: null,
        conversationProfile: null,
        profileLockMode: null,
        conversationProfileLock: null,
        purpose: null,
        warnings: [],
      },
    );
  });

  it("respects explicit script attachment fields for general flows", () => {
    assert.deepEqual(
      resolveScriptProfileRouting({
        flow_type: "general_outreach",
        attached_profile: "bank_servicing",
        auto_attach_profile: false,
        profile_lock_mode: "locked",
      }),
      {
        primaryFlow: "general_outreach",
        flowTypes: ["general_outreach"],
        objectiveTags: ["general_outreach"],
        attachedProfile: "bank_servicing",
        autoAttachProfile: false,
        callProfile: "bank_servicing",
        conversationProfile: "bank_servicing",
        profileLockMode: "locked",
        conversationProfileLock: true,
        purpose: "bank_servicing",
        warnings: [],
      },
    );
  });

  it("locks inferred profile-backed flows and leaves general flows unlocked", () => {
    assert.equal(
      resolveScriptProfileRouting({
        flow_type: "bank_servicing",
      }).conversationProfileLock,
      true,
    );
    assert.equal(
      resolveScriptProfileRouting({
        flow_type: "bank_servicing",
      }).profileLockMode,
      "locked",
    );
    assert.equal(
      resolveScriptProfileRouting({
        flow_type: "general_outreach",
      }).conversationProfileLock,
      null,
    );
    assert.equal(
      resolveScriptProfileRouting({
        flow_type: "general_outreach",
      }).profileLockMode,
      null,
    );
  });
});
