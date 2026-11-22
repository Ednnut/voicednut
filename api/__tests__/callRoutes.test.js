const assert = require("node:assert/strict");
const { __testables } = require("../services/callRoutes");

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function createHandler() {
  let recordingRequests = 0;
  const handler = __testables.createGetSpekoRecordingHandler({
    isSafeId: (value) => /^[a-z0-9_-]{1,128}$/i.test(value),
    db: {
      getCall: async () => ({ call_sid: "call_123", user_chat_id: "owner-1" }),
      getLatestCallState: async () => ({
        provider: "speko",
        provider_metadata: { speko_session_id: "session_123" },
      }),
    },
    getSpekoRecording: async () => {
      recordingRequests += 1;
      return {
        url: "https://recording.example/signed",
        expiresAt: "2026-11-21T12:05:00.000Z",
      };
    },
  });
  return { handler, get recordingRequests() { return recordingRequests; } };
}

describe("Speko recording authorization", () => {
  it("requires an owner identity for calls attached to a chat", async () => {
    const fixture = createHandler();
    const res = response();
    await fixture.handler({ params: { callSid: "call_123" }, headers: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "not_authorized" });
    assert.equal(fixture.recordingRequests, 0);
  });

  it("rejects a different owner before requesting a signed recording URL", async () => {
    const fixture = createHandler();
    const res = response();
    await fixture.handler(
      {
        params: { callSid: "call_123" },
        headers: { "x-telegram-chat-id": "owner-2" },
      },
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.equal(fixture.recordingRequests, 0);
  });

  it("returns a no-store link only to the matching owner", async () => {
    const fixture = createHandler();
    const res = response();
    await fixture.handler(
      {
        params: { callSid: "call_123" },
        headers: { "x-telegram-chat-id": "owner-1" },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(res.body, {
      recording_url: "https://recording.example/signed",
      expires_in: "short-lived",
    });
    assert.equal(fixture.recordingRequests, 1);
  });
});

describe("Speko call reconciliation authorization", () => {
  function createReconcileFixture() {
    let reconcileCalls = 0;
    const handler = __testables.createReconcileSpekoCallHandler({
      isSafeId: (value) => /^[a-z0-9_-]{1,128}$/i.test(value),
      db: {
        getCall: async () => ({ call_sid: "call_123", user_chat_id: "owner-1" }),
      },
      reconcileSpekoCall: async (callSid) => {
        reconcileCalls += 1;
        return { call_sid: callSid, status: "completed" };
      },
    });
    return { handler, get reconcileCalls() { return reconcileCalls; } };
  }

  it("requires the call owner before invoking Speko reconciliation", async () => {
    const fixture = createReconcileFixture();
    const res = response();
    await fixture.handler({
      params: { callSid: "call_123" },
      headers: { "x-telegram-chat-id": "owner-2" },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "call_owner_mismatch" });
    assert.equal(fixture.reconcileCalls, 0);
  });

  it("runs the bounded reconciliation only for an authorized owner", async () => {
    const fixture = createReconcileFixture();
    const res = response();
    await fixture.handler({
      params: { callSid: "call_123" },
      headers: { "x-telegram-chat-id": "owner-1" },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      success: true,
      call_sid: "call_123",
      status: "completed",
    });
    assert.equal(fixture.reconcileCalls, 1);
  });
});
