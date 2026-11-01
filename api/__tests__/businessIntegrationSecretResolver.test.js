const assert = require("node:assert/strict");
const {
  BusinessIntegrationSecretResolver,
  SECRET_REFERENCE_PREFIX,
} = require("../services/businessIntegrationSecretResolver");

describe("BusinessIntegrationSecretResolver", () => {
  it("resolves only explicitly namespaced environment references", async () => {
    const secret = "synthetic-provider-token";
    const resolver = new BusinessIntegrationSecretResolver({
      env: { BUSINESS_INTEGRATION_SECRET_BUSINESS_A_CRM: secret, OTHER_SECRET: "not-visible" },
    });

    assert.equal(await resolver.resolve(`${SECRET_REFERENCE_PREFIX}BUSINESS_INTEGRATION_SECRET_BUSINESS_A_CRM`), secret);
  });

  it("rejects arbitrary environment names and malformed references", async () => {
    const resolver = new BusinessIntegrationSecretResolver({ env: { OPENAI_API_KEY: "synthetic-token" } });
    for (const reference of [
      "OPENAI_API_KEY",
      "env://OPENAI_API_KEY",
      "env://BUSINESS_INTEGRATION_SECRET_",
      "env://BUSINESS_INTEGRATION_SECRET_business_a",
      "env://BUSINESS_INTEGRATION_SECRET_A/../../OPENAI_API_KEY",
      `env://${"BUSINESS_INTEGRATION_SECRET_A"}${"_A".repeat(100)}`,
    ]) {
      await assert.rejects(
        resolver.resolve(reference),
        (error) => error.code === "business_integration_secret_reference_invalid" && !error.message.includes("OPENAI_API_KEY"),
      );
    }
  });

  it("fails closed for missing or blank secret values without exposing the reference", async () => {
    const reference = "env://BUSINESS_INTEGRATION_SECRET_MISSING_CRM";
    const resolver = new BusinessIntegrationSecretResolver({
      env: { BUSINESS_INTEGRATION_SECRET_BLANK: "  " },
    });

    for (const secretReference of [reference, "env://BUSINESS_INTEGRATION_SECRET_BLANK"]) {
      await assert.rejects(
        resolver.resolve(secretReference),
        (error) => error.code === "business_integration_secret_unavailable" && !error.message.includes(secretReference),
      );
    }
  });
});
