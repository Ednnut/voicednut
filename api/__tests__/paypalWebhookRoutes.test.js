const assert = require("node:assert/strict");

const { createPaypalWebhookHandler } = require("../services/webhookRoutes");

async function invokePaypalWebhook(paypalPaymentService, { body = {}, headers = {} } = {}) {
  const handler = createPaypalWebhookHandler({ paypalPaymentService });
  const req = { body, headers };
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

describe("PayPal webhook route", () => {
  it("returns 404 when the PayPal connector is disabled", async () => {
    let verified = false;
    const response = await invokePaypalWebhook({
      isEnabled: () => false,
      verifyWebhookSignature: async () => {
        verified = true;
        return { ok: true };
      },
      handleWebhookEvent: async () => ({ ok: true }),
    }, {
      body: { id: "WH-DISABLED", event_type: "CHECKOUT.ORDER.APPROVED" },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.body.error, "paypal_disabled");
    assert.equal(verified, false);
  });

  it("returns 401 when PayPal signature verification fails", async () => {
    let handled = false;
    const response = await invokePaypalWebhook({
      isEnabled: () => true,
      verifyWebhookSignature: async (body, headers) => {
        assert.equal(body.id, "WH-BAD-SIG");
        assert.equal(headers["paypal-transmission-id"], "bad-transmission");
        return {
          ok: false,
          error: "paypal_webhook_signature_invalid",
          verification_status: "FAILURE",
        };
      },
      handleWebhookEvent: async () => {
        handled = true;
        return { ok: true };
      },
    }, {
      body: { id: "WH-BAD-SIG", event_type: "PAYMENT.CAPTURE.COMPLETED" },
      headers: { "paypal-transmission-id": "bad-transmission" },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.body.error, "paypal_webhook_signature_invalid");
    assert.equal(response.body.verification_status, "FAILURE");
    assert.equal(handled, false);
  });

  it("returns reconciled PayPal webhook results on success", async () => {
    const response = await invokePaypalWebhook({
      isEnabled: () => true,
      verifyWebhookSignature: async () => ({ ok: true, verification_status: "SUCCESS" }),
      handleWebhookEvent: async (body) => {
        assert.equal(body.id, "WH-OK");
        return {
          ok: true,
          duplicate: false,
          event_id: body.id,
          event_type: body.event_type,
          resource_id: "ORDER-123",
          status: "COMPLETED",
          updated_sessions: 1,
        };
      },
    }, {
      body: { id: "WH-OK", event_type: "PAYMENT.CAPTURE.COMPLETED" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, "COMPLETED");
    assert.equal(response.body.ok, true);
    assert.equal(response.body.duplicate, false);
    assert.equal(response.body.resource_id, "ORDER-123");
    assert.equal(response.body.updated_sessions, 1);
  });

  it("returns duplicate PayPal webhook events as idempotent success", async () => {
    const response = await invokePaypalWebhook({
      isEnabled: () => true,
      verifyWebhookSignature: async () => ({ ok: true, verification_status: "SUCCESS" }),
      handleWebhookEvent: async () => ({
        ok: true,
        duplicate: true,
        event_id: "WH-DUPLICATE",
        event_type: "CHECKOUT.ORDER.APPROVED",
        resource_id: "ORDER-123",
        status: "APPROVED",
        updated_sessions: 0,
      }),
    }, {
      body: { id: "WH-DUPLICATE", event_type: "CHECKOUT.ORDER.APPROVED" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, "APPROVED");
    assert.equal(response.body.ok, true);
    assert.equal(response.body.duplicate, true);
    assert.equal(response.body.updated_sessions, 0);
  });
});
