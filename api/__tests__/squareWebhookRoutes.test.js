const assert = require("node:assert/strict");

const { createSquareWebhookHandler } = require("../services/webhookRoutes");

async function invokeSquareWebhook(
  squarePaymentService,
  { body = {}, rawBody = JSON.stringify(body), headers = {} } = {},
) {
  const handler = createSquareWebhookHandler({ squarePaymentService });
  const req = { body, rawBody, headers };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };

  await handler(req, res);
  return res;
}

describe("Square webhook route", () => {
  it("returns 404 when the Square connector is disabled", async () => {
    let verified = false;
    const response = await invokeSquareWebhook(
      {
        isEnabled: () => false,
        verifyWebhookSignature: async () => {
          verified = true;
          return { ok: true };
        },
        handleWebhookEvent: async () => ({ ok: true }),
      },
      {
        body: { event_id: "evt_disabled", type: "payment.updated" },
      },
    );

    assert.equal(response.statusCode, 404);
    assert.equal(response.body.error, "square_disabled");
    assert.equal(verified, false);
  });

  it("returns 401 when Square signature verification fails", async () => {
    let handled = false;
    const response = await invokeSquareWebhook(
      {
        isEnabled: () => true,
        verifyWebhookSignature: async (rawBody, headers) => {
          assert.equal(rawBody, "{\"event_id\":\"evt_bad_sig\"}");
          assert.equal(headers["x-square-hmacsha256-signature"], "bad-signature");
          return {
            ok: false,
            error: "square_webhook_signature_invalid",
            verification_status: "FAILURE",
          };
        },
        handleWebhookEvent: async () => {
          handled = true;
          return { ok: true };
        },
      },
      {
        body: { event_id: "evt_bad_sig" },
        rawBody: "{\"event_id\":\"evt_bad_sig\"}",
        headers: { "x-square-hmacsha256-signature": "bad-signature" },
      },
    );

    assert.equal(response.statusCode, 401);
    assert.equal(response.body.error, "square_webhook_signature_invalid");
    assert.equal(response.body.verification_status, "FAILURE");
    assert.equal(handled, false);
  });

  it("returns reconciled Square webhook results on success", async () => {
    const response = await invokeSquareWebhook(
      {
        isEnabled: () => true,
        verifyWebhookSignature: async () => ({ ok: true, verification_status: "SUCCESS" }),
        handleWebhookEvent: async (body) => {
          assert.equal(body.event_id, "evt_ok");
          return {
            ok: true,
            duplicate: false,
            event_id: body.event_id,
            event_type: body.type,
            resource_id: "PAYMENT-123",
            status: "COMPLETED",
            updated_sessions: 1,
          };
        },
      },
      {
        body: { event_id: "evt_ok", type: "payment.updated" },
      },
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, "COMPLETED");
    assert.equal(response.body.ok, true);
    assert.equal(response.body.duplicate, false);
    assert.equal(response.body.resource_id, "PAYMENT-123");
    assert.equal(response.body.updated_sessions, 1);
  });

  it("returns duplicate Square webhook events as idempotent success", async () => {
    const response = await invokeSquareWebhook(
      {
        isEnabled: () => true,
        verifyWebhookSignature: async () => ({ ok: true, verification_status: "SUCCESS" }),
        handleWebhookEvent: async () => ({
          ok: true,
          duplicate: true,
          event_id: "evt_duplicate",
          event_type: "payment.updated",
          resource_id: "PAYMENT-123",
          status: "COMPLETED",
          updated_sessions: 0,
        }),
      },
      {
        body: { event_id: "evt_duplicate", type: "payment.updated" },
      },
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, "COMPLETED");
    assert.equal(response.body.ok, true);
    assert.equal(response.body.duplicate, true);
    assert.equal(response.body.updated_sessions, 0);
  });
});
