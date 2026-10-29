const assert = require("node:assert/strict");

const VonageVoiceAdapter = require("../adapters/VonageVoiceAdapter");
const { buildCanonicalCallStatusEvent } = require("../adapters/providerFlowPolicy");

describe("Vonage provider integration", () => {
  it("creates an outbound Voice API v1 call with webhook URLs and an NCCO", async () => {
    const requests = [];
    const adapter = new VonageVoiceAdapter({
      client: {
        voice: {
          async createOutboundCall(payload) {
            requests.push(payload);
            return { uuid: "vonage-call-uuid", status: "started" };
          },
        },
      },
      voice: { fromNumber: "+15555550100", createRetryAttempts: 0 },
    }, { info: () => {}, warn: () => {} });

    const response = await adapter.createOutboundCall({
      to: "+15555550123",
      callSid: "internal-call-sid",
      answerUrl: "https://api.example.com/vonage/answer",
      eventUrl: "https://api.example.com/vonage/events",
      ncco: [{ action: "talk", text: "Test prompt" }],
    });

    assert.equal(response.uuid, "vonage-call-uuid");
    assert.deepEqual(requests, [{
      to: [{ type: "phone", number: "+15555550123" }],
      from: { type: "phone", number: "+15555550100" },
      ncco: [{ action: "talk", text: "Test prompt" }],
      event_url: ["https://api.example.com/vonage/events"],
      event_method: "POST",
    }]);
  });

  it("hangs up through the installed Vonage SDK client operation", async () => {
    const ended = [];
    const adapter = new VonageVoiceAdapter({
      client: { voice: { async hangupCall(uuid) { ended.push(uuid); } } },
      voice: { retryAttempts: 0 },
    }, { info: () => {}, warn: () => {} });

    await adapter.hangupCall("vonage-call-uuid");

    assert.deepEqual(ended, ["vonage-call-uuid"]);
  });

  it("does not retry an ambiguous outbound submission and marks it unknown", async () => {
    let attempts = 0;
    const adapter = new VonageVoiceAdapter({
      client: {
        voice: {
          async createOutboundCall() {
            attempts += 1;
            const error = new Error("temporary provider failure");
            error.statusCode = 503;
            throw error;
          },
        },
      },
      voice: {
        fromNumber: "+15555550100",
        retryAttempts: 3,
        createRetryAttempts: 3,
      },
    }, { info: () => {}, warn: () => {} });

    await assert.rejects(adapter.createOutboundCall({
      to: "+15555550123",
      callSid: "internal-call-sid",
      answerUrl: "https://api.example.com/vonage/answer",
    }), (error) => {
      assert.equal(error.providerSubmissionState, "unknown");
      return true;
    });
    assert.equal(attempts, 1);
  });

  it("marks a definitive Vonage client rejection as safe for controlled failover", async () => {
    const adapter = new VonageVoiceAdapter({
      client: {
        voice: {
          async createOutboundCall() {
            const error = new Error("invalid request");
            error.statusCode = 422;
            throw error;
          },
        },
      },
      voice: { fromNumber: "+15555550100" },
    }, { info: () => {}, warn: () => {} });

    await assert.rejects(adapter.createOutboundCall({
      to: "+15555550123",
      callSid: "internal-call-sid",
      answerUrl: "https://api.example.com/vonage/answer",
    }), (error) => {
      assert.equal(error.providerSubmissionState, "rejected");
      return true;
    });
  });

  it("maps Vonage terminal status without treating answer as completion", () => {
    const answered = buildCanonicalCallStatusEvent("vonage", { status: "answered" }, {
      callSid: "local-call-1",
    });
    const terminal = buildCanonicalCallStatusEvent("vonage", { status: "unanswered" }, {
      callSid: "local-call-2",
    });

    assert.equal(answered.status, "answered");
    assert.equal(terminal.status, "no-answer");
  });
});
