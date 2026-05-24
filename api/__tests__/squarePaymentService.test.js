const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const Database = require("../db/db");
const {
  DEFAULT_API_VERSION,
  SquarePaymentService,
  shouldApplySquareWebhookStatus,
} = require("../services/squarePaymentService");

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("SquarePaymentService", () => {
  it("creates Square payment links and stores normalized session state", async () => {
    const calls = [];
    const db = {
      sessions: [],
      async upsertSquarePaymentSession(payload) {
        this.sessions.push(payload);
      },
    };
    const service = new SquarePaymentService({
      db,
      config: {
        enabled: true,
        accessToken: "sq0atp_test",
        locationId: "L123",
        returnUrl: "https://example.test/square/return",
        defaultCurrency: "USD",
      },
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        assert.ok(String(url).endsWith("/v2/online-checkout/payment-links"));
        return jsonResponse(200, {
          payment_link: {
            id: "plink_test_123",
            url: "https://square.test/pay/plink_test_123",
            order_id: "ORDER-123",
          },
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
      { callSid: "CA_square_001" },
    );

    assert.equal(result.provider, "square");
    assert.equal(result.provider_action, "create_payment_link");
    assert.equal(result.payment_link_id, "plink_test_123");
    assert.equal(result.order_id, "ORDER-123");
    assert.equal(result.payment_url, "https://square.test/pay/plink_test_123");
    assert.equal(result.amount, 12.5);
    assert.equal(result.currency, "USD");
    assert.equal(db.sessions.length, 1);
    assert.equal(db.sessions[0].call_sid, "CA_square_001");
    assert.equal(db.sessions[0].external_id, "plink_test_123");
    assert.equal(db.sessions[0].status, "OPEN");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.authorization, "Bearer sq0atp_test");
    assert.equal(calls[0].options.headers["Square-Version"], DEFAULT_API_VERSION);
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.idempotency_key, "idem-1");
    assert.equal(body.quick_pay.price_money.amount, 1250);
    assert.equal(body.quick_pay.price_money.currency, "USD");
    assert.equal(body.quick_pay.location_id, "L123");
    assert.equal(body.checkout_options.redirect_url, "https://example.test/square/return");
  });

  it("verifies Square webhook signatures using raw body and webhook URL", async () => {
    const rawBody = JSON.stringify({
      event_id: "evt_square_123",
      type: "payment.updated",
      data: { object: { payment: { id: "PAYMENT-123" } } },
    });
    const webhookUrl = "https://api.example.test/webhook/square";
    const signatureKey = "square_signature_key";
    const signature = crypto
      .createHmac("sha256", signatureKey)
      .update(`${webhookUrl}${rawBody}`, "utf8")
      .digest("base64");
    const service = new SquarePaymentService({
      config: {
        enabled: true,
        accessToken: "sq0atp_test",
        locationId: "L123",
        webhookSignatureKey: signatureKey,
        webhookUrl,
      },
    });

    const verified = await service.verifyWebhookSignature(rawBody, {
      "x-square-hmacsha256-signature": signature,
    });
    const rejected = await service.verifyWebhookSignature(rawBody, {
      "x-square-hmacsha256-signature": "bad-signature",
    });

    assert.equal(verified.ok, true);
    assert.equal(verified.verification_status, "SUCCESS");
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, "square_webhook_signature_invalid");
  });

  it("deduplicates Square webhook events and reconciles session status", async () => {
    const updates = [];
    const service = new SquarePaymentService({
      db: {
        async recordSquarePaymentEvent(payload) {
          assert.equal(payload.external_event_id, "evt_square_1");
          assert.equal(payload.event_type, "payment.updated");
          assert.equal(payload.resource_id, "PAYMENT-1");
          assert.equal(payload.normalized_event.provider, "square");
          return { inserted: true };
        },
        async getSquarePaymentSession(externalId) {
          assert.ok(["PAYMENT-1", "ORDER-1"].includes(externalId));
          return { external_id: externalId, status: "OPEN" };
        },
        async updateSquarePaymentSessionStatus(externalId, payload) {
          updates.push({ externalId, payload });
          return 1;
        },
      },
      config: {
        enabled: true,
        accessToken: "sq0atp_test",
        locationId: "L123",
      },
    });

    const result = await service.handleWebhookEvent({
      event_id: "evt_square_1",
      type: "payment.updated",
      data: {
        object: {
          payment: {
            id: "PAYMENT-1",
            order_id: "ORDER-1",
            status: "COMPLETED",
            amount_money: {
              amount: 1250,
              currency: "USD",
            },
          },
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.updated_sessions, 2);
    assert.equal(updates.length, 2);
    assert.deepEqual(
      updates.map((update) => update.externalId).sort(),
      ["ORDER-1", "PAYMENT-1"],
    );
    assert.equal(updates[0].payload.amount, 12.5);
    assert.equal(updates[0].payload.currency, "USD");
  });

  it("returns explicit configuration errors before Square HTTP calls", async () => {
    let httpCalls = 0;
    const service = new SquarePaymentService({
      config: { enabled: true },
      fetchFn: async () => {
        httpCalls += 1;
        return jsonResponse(200, {});
      },
    });

    const result = await service.execute("payment_intent_status", {
      payment_id: "PAYMENT-123",
    });

    assert.equal(result.error, "square_not_configured");
    assert.equal(httpCalls, 0);
  });

  it("does not regress terminal Square webhook status", () => {
    assert.equal(shouldApplySquareWebhookStatus("COMPLETED", "PENDING"), false);
    assert.equal(shouldApplySquareWebhookStatus("OPEN", "COMPLETED"), true);
    assert.equal(shouldApplySquareWebhookStatus("COMPLETED", "REFUNDED"), true);
  });
});

describe("Square payment persistence", () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `voicednut-square-${Date.now()}-${Math.random()}.sqlite`,
    );
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
  });

  afterEach(async () => {
    if (db?.db) {
      await new Promise((resolve) => db.db.close(() => resolve()));
    }
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch (_) {}
    });
  });

  it("upserts Square session state and deduplicates provider events", async () => {
    await db.upsertSquarePaymentSession({
      call_sid: "CA_square_002",
      action: "payment_link_generate",
      external_id: "LINK-456",
      status: "OPEN",
      amount: "20.00",
      currency: "USD",
      approval_url: "https://square.test/checkout/LINK-456",
      metadata: { source: "test", order_id: "ORDER-456" },
    });
    await db.upsertSquarePaymentSession({
      action: "payment_link_generate",
      external_id: "LINK-456",
      status: "COMPLETED",
    });

    const session = await db.getSquarePaymentSession("LINK-456");
    assert.equal(session.call_sid, "CA_square_002");
    assert.equal(session.status, "COMPLETED");
    assert.equal(session.amount, "20.00");
    assert.equal(session.action, "payment_link_generate");

    const relatedSession = await db.findSquarePaymentSessionByRelatedId("ORDER-456");
    assert.equal(relatedSession.external_id, "LINK-456");

    await db.updateSquarePaymentSessionStatus("LINK-456", {
      status: "REFUNDED",
      amount: "20.00",
      currency: "USD",
      metadata: { source: "webhook" },
    });

    const updatedSession = await db.getSquarePaymentSession("LINK-456");
    assert.equal(updatedSession.action, "payment_link_generate");
    assert.equal(updatedSession.status, "REFUNDED");

    const first = await db.recordSquarePaymentEvent({
      external_event_id: "EV-1",
      event_type: "payment.updated",
      resource_id: "LINK-456",
      status: "COMPLETED",
      payload: { event_id: "EV-1" },
    });
    const duplicate = await db.recordSquarePaymentEvent({
      external_event_id: "EV-1",
      event_type: "payment.updated",
    });

    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);

    const sessions = await db.listSquarePaymentSessions({
      call_sid: "CA_square_002",
      limit: 5,
    });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].external_id, "LINK-456");

    const events = await db.listSquarePaymentEvents({
      external_id: "LINK-456",
      limit: 5,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].external_event_id, "EV-1");

    const eventsByCall = await db.listSquarePaymentEvents({
      call_sid: "CA_square_002",
      limit: 5,
    });
    assert.equal(eventsByCall.length, 1);
    assert.equal(eventsByCall[0].external_event_id, "EV-1");
  });

  it("correlates Square payment webhooks to the original payment-link session", async () => {
    await db.upsertSquarePaymentSession({
      call_sid: "CA_square_003",
      action: "payment_link_generate",
      external_id: "LINK-789",
      status: "OPEN",
      amount: "15.00",
      currency: "USD",
      approval_url: "https://square.test/checkout/LINK-789",
      metadata: { connector: "square", order_id: "ORDER-789" },
    });

    const service = new SquarePaymentService({
      db,
      config: {
        enabled: true,
        accessToken: "sq0atp_test",
        locationId: "L123",
      },
    });

    const result = await service.handleWebhookEvent({
      event_id: "evt_square_link_1",
      type: "payment.updated",
      data: {
        object: {
          payment: {
            id: "PAYMENT-789",
            order_id: "ORDER-789",
            status: "COMPLETED",
            amount_money: {
              amount: 1500,
              currency: "USD",
            },
          },
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.resource_id, "LINK-789");
    assert.equal(result.updated_sessions, 1);
    assert.equal(await db.getSquarePaymentSession("PAYMENT-789"), null);
    assert.equal(await db.getSquarePaymentSession("ORDER-789"), null);
    const relatedPaymentSession = await db.findSquarePaymentSessionByRelatedId("PAYMENT-789");
    assert.equal(relatedPaymentSession.external_id, "LINK-789");

    const session = await db.getSquarePaymentSession("LINK-789");
    assert.equal(session.status, "COMPLETED");
    assert.equal(session.amount, "15");
    const metadata = JSON.parse(session.metadata);
    assert.equal(metadata.connector, "square");
    assert.equal(metadata.order_id, "ORDER-789");
    assert.equal(metadata.payment_id, "PAYMENT-789");
    assert.equal(metadata.event_id, "evt_square_link_1");
    assert.equal(metadata.resource_id, "LINK-789");
    assert.equal(metadata.square_resource_id, "PAYMENT-789");

    const events = await db.listSquarePaymentEvents({
      external_id: "LINK-789",
      limit: 5,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].external_event_id, "evt_square_link_1");
  });
});
