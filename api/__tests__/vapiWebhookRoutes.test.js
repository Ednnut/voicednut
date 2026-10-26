const assert = require("node:assert/strict");
const { __testables, createVapiWebhookHandler } = require("../services/webhookRoutes");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe("Vapi webhook route authentication policy", () => {
  it("returns the Vapi assistant-request response shape directly", async () => {
    const handler = createVapiWebhookHandler({
      db: { async getVapiInboundAssistantByPhoneNumberId() { return { vapi_assistant_id: "asst_route_1" }; } },
    });
    const res = response();
    await handler({ body: { message: { type: "assistant-request", call: { phoneNumberId: "pn_1" } } } }, res);
    assert.deepEqual(res.body, { assistantId: "asst_route_1" });
  });

  it("returns tool-call results at the Vapi-required top level", async () => {
    const handler = createVapiWebhookHandler({ db: { async recordVapiCallEvent() { throw new Error("must not persist tool requests"); } } });
    const res = response();
    await handler({ body: { message: { type: "tool-calls", toolCallList: [{ id: "tool-1", function: { name: "lookup" } }] } } }, res);
    assert.deepEqual(res.body, {
      results: [{ name: "lookup", toolCallId: "tool-1", result: "This tool is not enabled in VOICEDNUT." }],
    });
  });

  it("rejects malformed tool-call requests without acknowledging them", async () => {
    const handler = createVapiWebhookHandler({ db: {} });
    const res = response();
    await handler({ body: { message: { type: "tool-calls", toolCallList: "not-an-array" } } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  });

  it("fails closed when the Vapi verifier is not configured", () => {
    let called = false;
    const guard = __testables.createWebhookAuthGuard({});
    const handler = guard("vapi_events", () => { called = true; });
    const res = response();
    handler({ path: "/webhook/vapi", requestId: "req-test" }, res);
    assert.equal(called, false);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
  });

  it("does not handle Vapi events after the verifier rejects a request", () => {
    let called = false;
    const guard = __testables.createWebhookAuthGuard({
      requireValidVapiWebhook(_req, res) {
        res.status(401).json({ success: false });
        return false;
      },
    });
    const handler = guard("vapi_events", () => { called = true; });
    const res = response();
    handler({ path: "/webhook/vapi", requestId: "req-test" }, res);
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
  });
});
