const assert = require("node:assert/strict");

const { buildTwilioOutboundCallPayload } = require("../adapters/twilioVoiceCallPayload");

describe("Twilio Voice provider contract", () => {
  it("builds the existing outbound Call resource payload and lifecycle callbacks", () => {
    const payload = buildTwilioOutboundCallPayload({
      host: "api.example.com",
      to: "+15555550123",
      from: "+15555550100",
      machineDetection: "Enable",
      machineDetectionTimeout: 20,
    });

    assert.equal(payload.url, "https://api.example.com/incoming");
    assert.equal(payload.to, "+15555550123");
    assert.equal(payload.from, "+15555550100");
    assert.equal(payload.statusCallback, "https://api.example.com/webhook/call-status");
    assert.deepEqual(payload.statusCallbackEvent, [
      "initiated", "ringing", "answered", "completed", "busy", "no-answer", "canceled", "failed",
    ]);
    assert.equal(payload.statusCallbackMethod, "POST");
    assert.equal(payload.machineDetection, "Enable");
    assert.equal(payload.machineDetectionTimeout, 20);
  });
});
