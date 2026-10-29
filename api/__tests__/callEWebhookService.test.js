const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../db/db");
const { createCallEWebhookHandler, normalizeCallEWebhookEnvelope } = require("../services/callEWebhookService");

const event = (overrides = {}) => ({
  id: "evt_terminal_01",
  type: "call.completed",
  data: { id: "call_test_123", object: "call", result_status: "available" },
  ...overrides,
});

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    ended: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
  };
}

describe("CALL-E terminal webhook", () => {
  it("requires matching event ID header and a terminal Calls V2 resource", () => {
    assert.deepEqual(normalizeCallEWebhookEnvelope({ "call-e-event-id": "evt_terminal_01" }, event()), {
      eventId: "evt_terminal_01",
      eventType: "call.completed",
      providerCallId: "call_test_123",
    });
    assert.throws(() => normalizeCallEWebhookEnvelope({}, event()), (error) => error.code === "call_e_webhook_invalid");
    assert.throws(() => normalizeCallEWebhookEnvelope({ "call-e-event-id": "evt_other" }, event()), (error) => error.code === "call_e_webhook_invalid");
    assert.throws(() => normalizeCallEWebhookEnvelope({ "call-e-event-id": "evt_terminal_01" }, event({ type: "call.asr" })), (error) => error.code === "call_e_webhook_invalid");
  });

  it("reconciles through the authenticated client, stores only receipt identifiers, then acknowledges", async () => {
    const records = [];
    let reconciledLocalId;
    const handler = createCallEWebhookHandler({
      db: {
        async getCallEWebhookReceipt() { return null; },
        async getCallEReconciliationRecordByProviderId(id) {
          assert.equal(id, "call_test_123");
          return { local_call_id: "call_e_123e4567-e89b-12d3-a456-426614174000" };
        },
        async recordCallEWebhookReceipt(receipt) { records.push(receipt); },
      },
      service: { async reconcileLocalCall(localId) {
        reconciledLocalId = localId;
        return { resultStatus: "available" };
      } },
    });
    const res = responseRecorder();
    await handler({ headers: { "call-e-event-id": "evt_terminal_01" }, body: event() }, res);
    assert.equal(res.statusCode, 204);
    assert.equal(res.ended, true);
    assert.equal(reconciledLocalId, "call_e_123e4567-e89b-12d3-a456-426614174000");
    assert.deepEqual(records, [{ provider_call_id: "call_test_123", event_id: "evt_terminal_01", event_type: "call.completed" }]);
  });

  it("acknowledges duplicate deliveries without another provider read", async () => {
    let reconciliations = 0;
    const handler = createCallEWebhookHandler({
      db: { async getCallEWebhookReceipt() { return { event_id: "evt_terminal_01" }; } },
      service: { async reconcileLocalCall() { reconciliations += 1; } },
    });
    const res = responseRecorder();
    await handler({ headers: { "call-e-event-id": "evt_terminal_01" }, body: event() }, res);
    assert.equal(res.statusCode, 204);
    assert.equal(reconciliations, 0);
  });

  it("does not acknowledge a provider snapshot that is still pending", async () => {
    let receipts = 0;
    const handler = createCallEWebhookHandler({
      db: {
        async getCallEWebhookReceipt() { return null; },
        async getCallEReconciliationRecordByProviderId() { return { local_call_id: "call_e_123e4567-e89b-12d3-a456-426614174000" }; },
        async recordCallEWebhookReceipt() { receipts += 1; },
      },
      service: { async reconcileLocalCall() { return { resultStatus: "pending" }; } },
    });
    const res = responseRecorder();
    await handler({ headers: { "call-e-event-id": "evt_terminal_01" }, body: event() }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(receipts, 0);
  });

  it("persists one minimal receipt per provider call without raw webhook data", async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-calle-webhook-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    try {
      const localCallId = "call_e_123e4567-e89b-12d3-a456-426614174000";
      await db.upsertCallEReconciliationRecord({
        local_call_id: localCallId,
        provider_call_id: "call_test_123",
        template_id: 12,
        template_version: 1,
        request_hash: "a".repeat(64),
        result_schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
      });
      assert.deepEqual(await db.getCallEReconciliationRecordByProviderId("call_test_123"), { local_call_id: localCallId });
      assert.deepEqual(await db.recordCallEWebhookReceipt({
        provider_call_id: "call_test_123", event_id: "evt_terminal_01", event_type: "call.completed",
      }), { saved: true });
      const receipt = await db.getCallEWebhookReceipt("call_test_123");
      assert.equal(receipt.event_id, "evt_terminal_01");
      assert.equal(receipt.event_type, "call.completed");
      assert.ok(receipt.processed_at);
      assert.deepEqual(await db.recordCallEWebhookReceipt({
        provider_call_id: "call_test_123", event_id: "evt_terminal_01", event_type: "call.completed",
      }), { saved: false });
      const columns = await new Promise((resolve, reject) => db.db.all(
        "PRAGMA table_info(call_e_webhook_receipts)",
        (error, rows) => error ? reject(error) : resolve(rows.map((row) => row.name)),
      ));
      assert.deepEqual(columns.sort(), ["event_id", "event_type", "processed_at", "provider_call_id"].sort());
    } finally {
      await new Promise((resolve) => db.db.close(resolve));
      [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
    }
  });
});
