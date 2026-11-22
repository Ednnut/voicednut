const assert = require("node:assert/strict");
const { SECTIONS, selectedSections, buildEnvContent } = require("../setup-env");

describe("API environment setup", () => {
  it("defaults new setups to Speko voice and separate Twilio SMS", () => {
    const providerFields = SECTIONS[0].fields;
    assert.deepEqual(providerFields.map(({ key, defaultValue }) => [key, defaultValue]), [
      ["CALL_PROVIDER", "speko"],
      ["SMS_PROVIDER", "twilio"],
      ["EMAIL_PROVIDER", "sendgrid"],
    ]);
  });

  it("only includes credential prompts for the selected providers", () => {
    const spekoSections = selectedSections({
      CALL_PROVIDER: "speko",
      SMS_PROVIDER: "twilio",
      EMAIL_PROVIDER: "sendgrid",
    });
    const spekoKeys = spekoSections.flatMap((section) => section.fields.map(({ key }) => key));
    assert.ok(spekoKeys.includes("SPEKO_API_KEY"));
    assert.ok(spekoKeys.includes("TWILIO_ACCOUNT_SID"));
    assert.ok(spekoKeys.includes("SENDGRID_API_KEY"));
    assert.equal(spekoKeys.includes("PLIVO_AUTH_ID"), false);
    assert.equal(spekoKeys.includes("VONAGE_APPLICATION_ID"), false);

    const output = buildEnvContent({
      CALL_PROVIDER: "speko",
      SMS_PROVIDER: "twilio",
      EMAIL_PROVIDER: "sendgrid",
      SPEKO_ENABLED: "true",
    });
    assert.match(output, /^CALL_PROVIDER=speko$/m);
    assert.match(output, /^SPEKO_ENABLED=true$/m);
    assert.doesNotMatch(output, /PLIVO_AUTH_ID|VONAGE_APPLICATION_ID/);
  });
});
