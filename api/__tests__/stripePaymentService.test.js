const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  StripePaymentService,
  shouldApplyStripeWebhookStatus,
} = require("../services/stripePaymentService");

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("StripePaymentService", () => {
  it("creates Stripe Checkout Sessions and stores normalized session state", async () => {
    const calls = [];
    const db = {
      sessions: [],
      async upsertStripePaymentSession(payload) {
        this.sessions.push(payload);
      },
    };
    const service = new StripePaymentService({
      db,
      config: {
        enabled: true,
        secretKey: "sk_test_123",
        returnUrl: "https://example.test/stripe/return",
        cancelUrl: "https://example.test/stripe/cancel",
        defaultCurrency: "USD",
      },
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        assert.ok(String(url).endsWith("/v1/checkout/sessions"));
        return jsonResponse(200, {
          id: "cs_test_123",
          url: "https://checkout.stripe.test/cs_test_123",
          payment_status: "unpaid",
          status: "open",
          amount_total: 1250,
          currency: "usd",
          expires_at: 2_000_000_000,
        });
      },
    });

    const result = await service.execute(
      "payment_link_generate",
      {
        amount: 12.5,
        currency: "usd",
        description: "Balance due",
        idempotency_key: "idem-1",
      },
      { callSid: "CA_stripe_001" },
    );

    assert.equal(result.provider, "stripe");
    assert.equal(result.provider_action, "create_checkout_session");
    assert.equal(result.payment_link_id, "cs_test_123");
    assert.equal(result.payment_url, "https://checkout.stripe.test/cs_test_123");
    assert.equal(result.amount, 12.5);
    assert.equal(result.currency, "USD");
    assert.equal(db.sessions.length, 1);
    assert.equal(db.sessions[0].call_sid, "CA_stripe_001");
    assert.equal(db.sessions[0].external_id, "cs_test_123");
    assert.equal(db.sessions[0].status, "unpaid");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers["idempotency-key"], "idem-1");
    assert.equal(calls[0].options.headers["stripe-version"], "2026-02-25.clover");
    const body = new URLSearchParams(calls[0].options.body);
    assert.equal(body.get("mode"), "payment");
    assert.equal(body.get("line_items[0][price_data][unit_amount]"), "1250");
  });

  it("verifies Stripe webhook signatures using the raw request body", async () => {
    const now = new Date("2026-05-23T12:00:00.000Z");
    const rawBody = JSON.stringify({
      id: "evt_test_123",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_123" } },
    });
    const timestamp = Math.floor(now.getTime() / 1000);
    const secret = "whsec_test";
    const signature = crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`, "utf8")
      .digest("hex");
    const service = new StripePaymentService({
      now: () => now,
      config: {
        enabled: true,
        secretKey: "sk_test_123",
        webhookSecret: secret,
      },
    });

    const verified = await service.verifyWebhookSignature(rawBody, {
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    });
    const rejected = await service.verifyWebhookSignature(rawBody, {
      "stripe-signature": `t=${timestamp},v1=bad`,
    });
    const invalidTimestamp = await service.verifyWebhookSignature(rawBody, {
      "stripe-signature": `t=not-a-number,v1=${signature}`,
    });

    assert.equal(verified.ok, true);
    assert.equal(verified.verification_status, "SUCCESS");
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, "stripe_webhook_signature_invalid");
    assert.equal(invalidTimestamp.ok, false);
    assert.equal(invalidTimestamp.error, "stripe_webhook_timestamp_invalid");
  });

  it("deduplicates Stripe webhook events and reconciles session status", async () => {
    const updates = [];
    const service = new StripePaymentService({
      db: {
        async recordStripePaymentEvent(payload) {
          assert.equal(payload.external_event_id, "evt_1");
          assert.equal(payload.event_type, "checkout.session.completed");
          return { inserted: true };
        },
        async getStripePaymentSession(externalId) {
          assert.equal(externalId, "cs_test_123");
          return { external_id: externalId, status: "OPEN" };
        },
        async updateStripePaymentSessionStatus(externalId, payload) {
          updates.push({ externalId, payload });
          return 1;
        },
      },
      config: {
        enabled: true,
        secretKey: "sk_test_123",
      },
    });

    const result = await service.handleWebhookEvent({
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          payment_status: "paid",
          amount_total: 1250,
          currency: "usd",
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.status, "PAID");
    assert.equal(result.updated_sessions, 1);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].externalId, "cs_test_123");
    assert.equal(updates[0].payload.status, "PAID");
    assert.equal(updates[0].payload.amount, 12.5);
    assert.equal(updates[0].payload.currency, "USD");
  });

  it("returns explicit configuration errors before Stripe HTTP calls", async () => {
    let httpCalls = 0;
    const service = new StripePaymentService({
      config: { enabled: true },
      fetchFn: async () => {
        httpCalls += 1;
        return jsonResponse(200, {});
      },
    });

    const result = await service.execute("payment_intent_status", {
      payment_intent_id: "pi_test_123",
    });

    assert.equal(result.error, "stripe_not_configured");
    assert.equal(httpCalls, 0);
  });

  it("does not regress terminal Stripe webhook status", () => {
    assert.equal(shouldApplyStripeWebhookStatus("PAID", "OPEN"), false);
    assert.equal(shouldApplyStripeWebhookStatus("OPEN", "PAID"), true);
    assert.equal(shouldApplyStripeWebhookStatus("PAID", "REFUNDED"), true);
  });
});
