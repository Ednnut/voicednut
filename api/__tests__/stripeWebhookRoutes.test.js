const assert = require("node:assert/strict");

const { createStripeWebhookHandler } = require("../services/webhookRoutes");

async function invokeStripeWebhook(
  stripePaymentService,
  { body = {}, rawBody = JSON.stringify(body), headers = {} } = {},
) {
  const handler = createStripeWebhookHandler({ stripePaymentService });
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

describe("Stripe webhook route", () => {
  it("returns 404 when the Stripe connector is disabled", async () => {
    let verified = false;
    const response = await invokeStripeWebhook(
      {
        isEnabled: () => false,
        verifyWebhookSignature: async () => {
          verified = true;
          return { ok: true };
        },
        handleWebhookEvent: async () => ({ ok: true }),
      },
      {
        body: { id: "evt_disabled", type: "checkout.session.completed" },
      },
    );

    assert.equal(response.statusCode, 404);
    assert.equal(response.body.error, "stripe_disabled");
    assert.equal(verified, false);
  });

  it("returns 401 when Stripe signature verification fails", async () => {
    let handled = false;
    const response = await invokeStripeWebhook(
      {
        isEnabled: () => true,
        verifyWebhookSignature: async (rawBody, headers) => {
          assert.equal(rawBody, "{\"id\":\"evt_bad_sig\"}");
          assert.equal(headers["stripe-signature"], "bad-signature");
          return {
            ok: false,
            error: "stripe_webhook_signature_invalid",
            verification_status: "FAILURE",
          };
        },
        handleWebhookEvent: async () => {
          handled = true;
          return { ok: true };
        },
      },
      {
        body: { id: "evt_bad_sig" },
        rawBody: "{\"id\":\"evt_bad_sig\"}",
        headers: { "stripe-signature": "bad-signature" },
      },
    );

    assert.equal(response.statusCode, 401);
    assert.equal(response.body.error, "stripe_webhook_signature_invalid");
    assert.equal(response.body.verification_status, "FAILURE");
    assert.equal(handled, false);
  });

  it("returns reconciled Stripe webhook results on success", async () => {
    const response = await invokeStripeWebhook(
      {
        isEnabled: () => true,
        verifyWebhookSignature: async () => ({ ok: true, verification_status: "SUCCESS" }),
        handleWebhookEvent: async (body) => {
          assert.equal(body.id, "evt_ok");
          return {
            ok: true,
            duplicate: false,
            event_id: body.id,
            event_type: body.type,
            resource_id: "cs_test_123",
            status: "PAID",
            updated_sessions: 1,
          };
        },
      },
      {
        body: { id: "evt_ok", type: "checkout.session.completed" },
      },
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, "PAID");
    assert.equal(response.body.ok, true);
    assert.equal(response.body.duplicate, false);
    assert.equal(response.body.resource_id, "cs_test_123");
    assert.equal(response.body.updated_sessions, 1);
  });

  it("returns duplicate Stripe webhook events as idempotent success", async () => {
    const response = await invokeStripeWebhook(
      {
        isEnabled: () => true,
        verifyWebhookSignature: async () => ({ ok: true, verification_status: "SUCCESS" }),
        handleWebhookEvent: async () => ({
          ok: true,
          duplicate: true,
          event_id: "evt_duplicate",
          event_type: "checkout.session.completed",
          resource_id: "cs_test_123",
          status: "PAID",
          updated_sessions: 0,
        }),
      },
      {
        body: { id: "evt_duplicate", type: "checkout.session.completed" },
      },
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, "PAID");
    assert.equal(response.body.ok, true);
    assert.equal(response.body.duplicate, true);
    assert.equal(response.body.updated_sessions, 0);
  });
});
