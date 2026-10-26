const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../db/db");
const { previewCallETemplate } = require("../adapters/callETemplateAdapter");
const { CallEOutboundCallService } = require("../services/callEOutboundCallService");
const { CallEContactPolicyService } = require("../services/callEContactPolicyService");
const { CallEReconciliationService } = require("../services/callEReconciliationService");

describe("CALL-E offline integration rehearsal", () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `voicednut-calle-rehearsal-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
  });

  afterEach(async () => {
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
  });

  it("replays one accepted request, reconciles lifecycle and events, and persists no provider result or transcript", async () => {
    const template = {
      id: 44,
      version: 2,
      business_id: "business_rehearsal_001",
      lifecycle_state: "live",
      prompt: "Ask whether the appointment reminder was received. Do not change the booking.",
      first_message: "Hello, I am calling with a brief appointment reminder.",
      supports_payment: 0,
      supports_digit_capture: 0,
      requires_otp: 0,
      payment_enabled: 0,
      allow_terminator: 0,
    };
    const resultSchema = {
      type: "object",
      additionalProperties: false,
      required: ["received"],
      properties: { received: { type: "boolean" } },
    };
    const contactPolicy = new CallEContactPolicyService({ db });
    const consentAt = new Date().toISOString();
    for (const [phone, eventKey] of [
      ["+14155550123", "consent:rehearsal:0001"],
      ["+14155550124", "consent:rehearsal:0002"],
    ]) {
      await contactPolicy.recordConsent({
        businessId: template.business_id,
        destination: phone,
        eventKey,
        source: "written",
        evidenceReference: `evidence:${eventKey}`,
        occurredAt: consentAt,
      });
    }
    const providerCallId = "call_rehearsal_123";
    let createRequests = 0;
    const client = {
      isConfigured: () => true,
      async createCall() {
        createRequests += 1;
        return {
          id: providerCallId,
          object: "call",
          status: "queued",
          call_outcome: null,
          result_status: "pending",
          result: null,
          error: null,
          transcript: [],
        };
      },
      async getCall(id) {
        assert.equal(id, providerCallId);
        return {
          id,
          object: "call",
          status: "completed",
          call_outcome: "completed",
          result_status: "available",
          result: { received: true },
          error: null,
          transcript: [{ offset_seconds: 1, speaker: "user", text: "private synthetic turn" }],
        };
      },
      async listCallEvents(id, options) {
        assert.equal(id, providerCallId);
        assert.equal(options.limit, 50);
        return {
          object: "list",
          data: [
            { id: "evt_rehearsal_1", type: "call.ended", call_id: id, created_at: "2026-10-26T10:00:01Z", message: "private synthetic text" },
            { id: "evt_rehearsal_2", type: "call.result_ready", call_id: id, created_at: "2026-10-26T10:00:02Z", details: { transcript: "private synthetic text" } },
          ],
          next_cursor: null,
        };
      },
    };
    const outbound = new CallEOutboundCallService({ db, client, allowedDestinations: ["+14155550123", "+14155550124"] });
    const request = {
      template,
      phone: "+14155550123",
      resultSchema,
      idempotencyKey: "offline:rehearsal:0001",
      confirmedFingerprint: previewCallETemplate(template, { phone: "+14155550123", resultSchema }).fingerprint,
    };
    const accepted = await outbound.createOutboundCall(request);
    const replay = await outbound.createOutboundCall(request);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(createRequests, 1);
    await assert.rejects(outbound.createOutboundCall({
      ...request,
      phone: "+14155550124",
      idempotencyKey: "offline:rehearsal:0002",
      confirmedFingerprint: previewCallETemplate(template, {
        phone: "+14155550124",
        resultSchema,
      }).fingerprint,
    }), (error) => error.code === "call_e_pilot_cap_reached");
    assert.equal(createRequests, 1);

    const reconciliation = new CallEReconciliationService({ db, client });
    const snapshot = await reconciliation.reconcileLocalCall(accepted.localCallId);
    assert.equal(snapshot.executionStatus, "completed");
    assert.equal(snapshot.callOutcome, "completed");
    assert.equal(snapshot.resultStatus, "available");
    assert.equal(snapshot.resultAvailable, true);
    assert.deepEqual(snapshot.events.map(({ id }) => id), ["evt_rehearsal_1", "evt_rehearsal_2"]);
    assert.equal(JSON.stringify(snapshot).includes("private synthetic"), false);

    const record = await db.getCallEReconciliationRecord(accepted.localCallId);
    const cursor = await db.getCallEReconciliationState(providerCallId);
    assert.equal(record.execution_status, "completed");
    assert.equal(record.result_status, "available");
    assert.deepEqual(cursor.seenEventIds, ["evt_rehearsal_1", "evt_rehearsal_2"]);
    const rawRow = await new Promise((resolve, reject) => db.db.get(
      "SELECT * FROM call_e_reconciliation WHERE local_call_id = ?",
      [accepted.localCallId],
      (error, row) => error ? reject(error) : resolve(row),
    ));
    assert.equal(JSON.stringify(rawRow).includes("private synthetic"), false);
    assert.equal(JSON.stringify(rawRow).includes('"received":true'), false);
  });
});
