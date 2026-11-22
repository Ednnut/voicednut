const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createSpekoAgentToolHandler, validateToolEnvelope } = require("../services/spekoAgentToolService");

function makeSignedRequest(payload, secret, overrides = {}) {
  const rawBody = JSON.stringify(payload);
  const webhookId = overrides.webhookId || payload.idempotency_key;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(`${webhookId}.${timestamp}.${rawBody}`, "utf8")
    .digest("base64");
  return {
    rawBody,
    body: JSON.parse(rawBody),
    headers: {
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function payload(overrides = {}) {
  return {
    tool: "kb_search",
    args: { query: "password reset", max_results: 2 },
    session_id: "session_123",
    tool_call_id: "tool_call_456",
    idempotency_key: "session_123:tool_call_456",
    ...overrides,
  };
}

describe("Speko agent tool callbacks", () => {
  const secret = "0123456789abcdef0123456789abcdef";

  function createHandler(options = {}) {
    const calls = { resolve: 0, reserve: 0, execute: 0, release: 0 };
    const handler = createSpekoAgentToolHandler({
      config: {
        speko: {
          enabled: true,
          agentToolsEnabled: true,
          agentToolWebhookSecret: secret,
        },
      },
      resolveSessionCall: async () => {
        calls.resolve += 1;
        return { call_sid: "speko_internal_1", provider: "speko", status: "in-progress" };
      },
      shouldProcessToolCall: async () => {
        calls.reserve += 1;
        return options.reserved !== false;
      },
      releaseToolCall: async () => {
        calls.release += 1;
      },
      executeTool: async (input) => {
        calls.execute += 1;
        if (options.executeTool) return options.executeTool(input);
        return { status: "ok", source: "mock", result_count: 1 };
      },
    });
    return { handler, calls };
  }

  it("verifies the raw tool secret and dispatches only the configured read tool", async () => {
    const { handler, calls } = createHandler();
    const response = makeResponse();
    await handler(makeSignedRequest(payload(), secret), response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { status: "ok", source: "mock", result_count: 1 });
    assert.deepEqual(calls, { resolve: 1, reserve: 1, execute: 1, release: 0 });
  });

  it("rejects invalid signatures, unknown tools, and extra argument properties before dispatch", async () => {
    const { handler, calls } = createHandler();
    const invalidSignature = makeSignedRequest(payload(), secret);
    invalidSignature.headers["webhook-signature"] = "v1,AAAA";
    const denied = makeResponse();
    await handler(invalidSignature, denied);
    assert.equal(denied.statusCode, 401);

    const unknownTool = makeResponse();
    await handler(
      makeSignedRequest(payload({ tool: "start_payment" }), secret),
      unknownTool,
    );
    assert.equal(unknownTool.statusCode, 403);

    const unknownArgs = makeResponse();
    await handler(
      makeSignedRequest(payload({ args: { query: "password reset", destination: "+15551234567" } }), secret),
      unknownArgs,
    );
    assert.equal(unknownArgs.statusCode, 400);
    assert.equal(calls.reserve, 0);
    assert.equal(calls.execute, 0);
  });

  it("deduplicates Speko's stable idempotency key and releases failed work for retry", async () => {
    const duplicate = createHandler({ reserved: false });
    const duplicateResponse = makeResponse();
    await duplicate.handler(makeSignedRequest(payload(), secret), duplicateResponse);
    assert.equal(duplicateResponse.statusCode, 200);
    assert.equal(duplicateResponse.body.status, "duplicate");
    assert.equal(duplicate.calls.execute, 0);

    const failed = createHandler({ executeTool: async () => { throw new Error("mock failure"); } });
    const failedResponse = makeResponse();
    await failed.handler(makeSignedRequest(payload(), secret), failedResponse);
    assert.equal(failedResponse.statusCode, 503);
    assert.equal(failed.calls.release, 1);
  });

  it("enforces the documented session/call idempotency contract", () => {
    assert.throws(
      () => validateToolEnvelope(payload({ idempotency_key: "other" })),
      { code: "speko_tool_payload_invalid" },
    );
    assert.throws(
      () => validateToolEnvelope(payload({ tool: "crm_lookup_account" })),
      { code: "speko_tool_not_allowed", status: 403 },
    );
  });
});
