const assert = require("node:assert/strict");

const {
  evaluatePostCallQuality,
  normalizePostCallQaConfig,
  resolveCallProfile,
} = require("../services/postCallQaService");

const SCORABLE_TRANSCRIPT = [
  { speaker: "user", message: "I need help with a tax notice. What happens next?" },
  { speaker: "ai", message: "I understand. I can review the notice details and confirm the next step." },
  { speaker: "user", message: "Can you send me the checklist?" },
  { speaker: "ai", message: "Yes, please confirm the best delivery method and I will note a follow up." },
  { speaker: "user", message: "Email is fine." },
  { speaker: "ai", message: "Thank you. The case is scheduled for review. Have a good day." },
];

describe("postCallQaService", () => {
  it("resolves the new domain profiles from direct and nested aliases", () => {
    assert.equal(resolveCallProfile({ flow_type: "tax-support-service" }), "tax_support");

    assert.equal(
      resolveCallProfile({
        business_context: JSON.stringify({ profile: "fraud-review-support" }),
      }),
      "fraud_review",
    );

    assert.equal(
      resolveCallProfile({
        ai_analysis: JSON.stringify({
          adaptation: {
            businessContext: {
              conversation_profile: "identity-verification-plus",
            },
          },
        }),
      }),
      "identity_verification_plus",
    );
  });

  it("normalizes threshold aliases for the new domain profiles", () => {
    const config = normalizePostCallQaConfig({
      profileThresholds: {
        "tax-support-service": 81,
        fraud_review_support: 90,
        "identity-verification-plus": 88,
      },
    });

    assert.equal(config.profileThresholds.tax_support, 81);
    assert.equal(config.profileThresholds.fraud_review, 90);
    assert.equal(config.profileThresholds.identity_verification_plus, 88);
  });

  it("uses the new domain profile threshold during quality evaluation", () => {
    const report = evaluatePostCallQuality({
      callSid: "CA_test_tax_resolution",
      call: {
        business_context: JSON.stringify({
          profile: "tax-resolution-service",
        }),
      },
      transcripts: SCORABLE_TRANSCRIPT,
      config: {
        enabled: true,
        shadowMode: true,
        minTurns: 4,
      },
    });

    assert.equal(report.status, "scored");
    assert.equal(report.profile, "tax_resolution");
    assert.equal(report.metrics.threshold_score, 78);
    assert.equal(typeof report.score, "number");
  });
});
