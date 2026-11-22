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
    assert.equal(spekoKeys.includes("SPEKO_AGENT_ID"), false);
    assert.ok(spekoKeys.includes("SPEKO_INBOUND_ENABLED"));
    assert.ok(spekoKeys.includes("SPEKO_INBOUND_PHONE_NUMBER"));
    assert.ok(spekoKeys.includes("INBOUND_NUMBER_ROUTES"));
    assert.ok(spekoKeys.includes("TWILIO_ACCOUNT_SID"));
    assert.ok(spekoKeys.includes("SENDGRID_API_KEY"));
    assert.equal(spekoKeys.includes("PLIVO_AUTH_ID"), false);
    assert.equal(spekoKeys.includes("VONAGE_APPLICATION_ID"), false);

    const output = buildEnvContent({
      CALL_PROVIDER: "speko",
      SMS_PROVIDER: "twilio",
      EMAIL_PROVIDER: "sendgrid",
      SPEKO_ENABLED: "true",
      SPEKO_INBOUND_ENABLED: "true",
      SPEKO_INBOUND_PHONE_NUMBER: "+12015550199",
      INBOUND_NUMBER_ROUTES: '{"+12015550199":{"user_chat_id":"chat-1"}}',
    });
    assert.match(output, /^CALL_PROVIDER=speko$/m);
    assert.match(output, /^SPEKO_ENABLED=true$/m);
    assert.match(output, /^SPEKO_INBOUND_ENABLED=true$/m);
    assert.match(output, /^SPEKO_INBOUND_PHONE_NUMBER=\\+12015550199$/m);
    assert.match(output, /^INBOUND_NUMBER_ROUTES=/m);
    assert.doesNotMatch(output, /PLIVO_AUTH_ID|VONAGE_APPLICATION_ID/);
  });
});
