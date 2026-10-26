const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../db/db");
const { previewCallETemplate } = require("../adapters/callETemplateAdapter");
const { CallEOutboundCallService, normalizeCallResource, parseAllowedDestinations } = require("../services/callEOutboundCallService");

const template = {
  id: 27,
  version: 3,
  lifecycle_state: "live",
  prompt: "Confirm whether the appointment reminder was received. Do not change the booking.",
  first_message: "Hello, I am calling with a brief appointment reminder.",
  voice_model: null,
  default_profile: null,
  objective_tags: null,
  supports_payment: 0,
  supports_digit_capture: 0,
  requires_otp: 0,
  payment_enabled: 0,
  allow_terminator: 0,
  terminator_char: null,
};
const resultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["received"],
  properties: { received: { type: "boolean" } },
};
const callResponse = (id = "call_test_123", resultStatus = "pending") => ({
  id,
  object: "call",
  status: "queued",
  call_outcome: null,
  result_status: resultStatus,
  result: null,
  error: null,
  transcript: [],
  call_id: null,
  created_at: "2026-10-26T00:00:00Z",
  completed_at: null,
});

function createMemoryDb() {
  const rows = new Map();
  const reconciliationRows = new Map();
  return {
    rows,
    reconciliationRows,
    async getOutboundCallIdempotency(key) { return rows.get(key) ? { ...rows.get(key) } : null; },
    async reserveCallEOutboundCall(payload) {
      if (rows.has(payload.idempotency_key)) return { reserved: false };
      rows.set(payload.idempotency_key, {
        idempotency_key: payload.idempotency_key,
        provider: "call_e",
        request_hash: payload.request_hash,
        status: "pending",
        response_payload: JSON.stringify({ localCallId: payload.local_call_id }),
        error_message: null,
      });
      return { reserved: true };
    },
    async resetCallERejectedOutboundCall(payload) {
      const row = rows.get(payload.idempotency_key);
      if (!row || row.provider !== "call_e" || row.status !== "failed" || row.error_message !== "call_e_no_call_created") return { reset: false };
      row.request_hash = payload.request_hash;
      row.status = "pending";
      row.response_payload = JSON.stringify({ localCallId: payload.local_call_id });
      row.error_message = null;
      return { reset: true };
    },
    async upsertCallEReconciliationRecord(payload) {
      reconciliationRows.set(payload.local_call_id, { ...payload });
      return { saved: true };
    },
    async completeOutboundCallIdempotency(payload) {
      const row = rows.get(payload.idempotency_key) || { idempotency_key: payload.idempotency_key, provider: payload.provider };
      Object.assign(row, {
        request_hash: payload.request_hash,
        status: payload.status,
        response_payload: payload.response_payload == null ? null : JSON.stringify(payload.response_payload),
        error_message: payload.error_message || null,
      });
      if (payload.call_sid) row.call_sid = payload.call_sid;
      rows.set(payload.idempotency_key, row);
      return 1;
    },
  };
}

function createInput(overrides = {}) {
  const input = {
    template: { ...template },
    phone: "+14155550123",
    resultSchema,
    idempotencyKey: "reminder:test:0001",
    ...overrides,
  };
  if (overrides.confirmedFingerprint === undefined) {
    input.confirmedFingerprint = previewCallETemplate(input.template, {
      phone: input.phone,
      resultSchema: input.resultSchema,
    }).fingerprint;
  }
  return input;
}

describe("CALL-E outbound call service", () => {
  it("rejects missing or stale request confirmation before reserving or submitting", async () => {
    const db = createMemoryDb();
    let creates = 0;
    const service = new CallEOutboundCallService({
      db,
      allowedDestinations: ["+14155550123"],
      client: { isConfigured: () => true, async createCall() { creates += 1; return callResponse(); } },
    });
    const unconfirmed = createInput();
    delete unconfirmed.confirmedFingerprint;
    await assert.rejects(service.createOutboundCall(unconfirmed), (error) => error.code === "call_e_confirmation_mismatch");
    await assert.rejects(service.createOutboundCall(createInput({ confirmedFingerprint: "a".repeat(64) })), (error) => error.code === "call_e_confirmation_mismatch");
    assert.equal(creates, 0);
    assert.equal(db.rows.size, 0);
  });

  it("requires an exact E.164 destination allowlist before reserving or submitting", async () => {
    assert.deepEqual([...parseAllowedDestinations("")], []);
    assert.deepEqual([...parseAllowedDestinations("+14155550123,invalid,+14155550124")], ["+14155550123", "+14155550124"]);

    const db = createMemoryDb();
    let creates = 0;
    const service = new CallEOutboundCallService({
      db,
      allowedDestinations: ["+14155550123"],
      client: { isConfigured: () => true, async createCall() { creates += 1; return callResponse(); } },
    });
    await assert.rejects(service.createOutboundCall(createInput({ phone: "+14155550124" })), (error) => {
      assert.equal(error.code, "call_e_destination_not_allowlisted");
      assert.equal(error.status, 403);
      return true;
    });
    assert.equal(creates, 0);
    assert.equal(db.rows.size, 0);
  });

  it("reserves before submission and replays an accepted Call without creating another", async () => {
    const db = createMemoryDb();
    const requests = [];
    const client = {
      isConfigured: () => true,
      async createCall(request, key) {
        requests.push({ request, key });
        return { ...callResponse(), transcript: [{ speaker: "user", text: "private synthetic transcript" }] };
      },
    };
    const service = new CallEOutboundCallService({ client, db, allowedDestinations: ["+14155550123"] });
    const first = await service.createOutboundCall(createInput());
    const replay = await service.createOutboundCall(createInput());

    assert.equal(first.provider, "call_e");
    assert.equal(first.providerCallId, "call_test_123");
    assert.match(first.localCallId, /^call_e_[0-9a-f-]{36}$/i);
    assert.equal(first.status, "queued");
    assert.equal(first.resultStatus, "pending");
    assert.equal("transcript" in first, false);
    assert.equal(JSON.stringify(first).includes("private synthetic transcript"), false);
    assert.equal(first.idempotentReplay, false);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.localCallId, first.localCallId);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].key, "voicednut:call-e:reminder:test:0001");
    assert.equal(requests[0].request.metadata.voicednut_call_id, first.localCallId);
    assert.deepEqual(db.reconciliationRows.get(first.localCallId).result_schema, resultSchema);
    assert.equal(db.reconciliationRows.get(first.localCallId).provider_call_id, "call_test_123");
    assert.equal(requests[0].request.webhook_url, undefined);
    assert.equal([...db.rows.values()][0].call_sid, "call_test_123");
    const saved = JSON.stringify([...db.rows.values()][0].response_payload);
    assert.equal(saved.includes("Synthetic response"), false);
    assert.equal(saved.includes("reminder_received"), false);
    assert.equal(saved.includes("+14155550123"), false);
    assert.equal(saved.includes("private synthetic transcript"), false);
  });

  it("repairs a missing reconciliation link from an accepted idempotent replay", async () => {
    const db = createMemoryDb();
    let createCount = 0;
    let failAcceptedLink = true;
    const persist = db.upsertCallEReconciliationRecord;
    db.upsertCallEReconciliationRecord = async (payload) => {
      if (payload.provider_call_id && failAcceptedLink) {
        failAcceptedLink = false;
        throw new Error("temporary reconciliation storage error");
      }
      return persist(payload);
    };
    const service = new CallEOutboundCallService({
      db,
      allowedDestinations: ["+14155550123"],
      client: { isConfigured: () => true, async createCall() { createCount += 1; return callResponse(); } },
    });
    await assert.rejects(service.createOutboundCall(createInput()), /temporary reconciliation storage error/);
    const replay = await service.createOutboundCall(createInput());
    assert.equal(replay.idempotentReplay, true);
    assert.equal(createCount, 1);
    assert.equal(db.reconciliationRows.get(replay.localCallId).provider_call_id, "call_test_123");
  });

  it("conflicts when an idempotency key is reused with changed accepted input", async () => {
    const db = createMemoryDb();
    let creates = 0;
    const service = new CallEOutboundCallService({
      db,
      allowedDestinations: ["+14155550123", "+14155550124"],
      client: { isConfigured: () => true, async createCall() { creates += 1; return callResponse(); } },
    });
    await service.createOutboundCall(createInput());
    await assert.rejects(
      service.createOutboundCall(createInput({ phone: "+14155550124" })),
      (error) => error.code === "call_e_idempotency_conflict",
    );
    assert.equal(creates, 1);
  });

  it("preserves unknown acceptance and replays the exact request with the same provider key", async () => {
    const db = createMemoryDb();
    const calls = [];
    const client = {
      isConfigured: () => true,
      async createCall(request, key) {
        calls.push({ request, key });
        if (calls.length === 1) {
          const error = new Error("timeout details should not escape");
          error.code = "call_e_timeout";
          throw error;
        }
        return callResponse();
      },
    };
    const service = new CallEOutboundCallService({ client, db, allowedDestinations: ["+14155550123"] });
    await assert.rejects(service.createOutboundCall(createInput()), (error) => error.code === "call_e_call_outcome_unknown");
    const pending = [...db.rows.values()][0];
    assert.equal(pending.status, "pending");
    assert.equal(pending.error_message, "call_e_outcome_unknown");
    const recovered = await service.createOutboundCall(createInput());
    assert.equal(calls.length, 2);
    assert.equal(calls[0].key, calls[1].key);
    assert.deepEqual(calls[0].request, calls[1].request);
    assert.equal(recovered.providerCallId, "call_test_123");
  });

  it("allows a corrected request with the same key only after explicit pre-acceptance rejection", async () => {
    const db = createMemoryDb();
    const calls = [];
    const client = {
      isConfigured: () => true,
      async createCall(request, key) {
        calls.push({ request, key });
        if (calls.length === 1) {
          const error = new Error("provider validation text");
          error.code = "call_e_input_incomplete";
          error.noCallCreated = true;
          error.status = 422;
          throw error;
        }
        return callResponse();
      },
    };
    const service = new CallEOutboundCallService({ client, db, allowedDestinations: ["+14155550123"] });
    await assert.rejects(service.createOutboundCall(createInput()), (error) => error.code === "call_e_input_incomplete");
    const corrected = await service.createOutboundCall(createInput({
      template: { ...template, prompt: `${template.prompt} Ask the recipient to clarify if needed.` },
    }));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].key, calls[1].key);
    assert.notEqual(calls[0].request.task, calls[1].request.task);
    assert.equal(corrected.providerCallId, "call_test_123");
  });

  it("fails closed when CALL-E is disabled or the template is not compatible/live", async () => {
    const db = createMemoryDb();
    let creates = 0;
    const disabledService = new CallEOutboundCallService({
      db,
      client: { isConfigured: () => false, async createCall() { creates += 1; } },
    });
    await assert.rejects(disabledService.createOutboundCall(createInput()), (error) => error.code === "call_e_not_configured");
    const enabledService = new CallEOutboundCallService({
      db,
      client: { isConfigured: () => true, async createCall() { creates += 1; } },
    });
    await assert.rejects(enabledService.createOutboundCall(createInput({ template: { ...template, lifecycle_state: "draft" } })), (error) => error.code === "call_e_template_not_live");
    await assert.rejects(enabledService.createOutboundCall(createInput({ template: { ...template, requires_otp: 1 } })), (error) => error.code === "call_e_template_incompatible");
    assert.equal(creates, 0);
  });

  it("normalizes execution, telephone outcome and result readiness separately", () => {
    const normalized = normalizeCallResource({
      ...callResponse("call_test_123", "unavailable"),
      status: "completed",
      call_outcome: "no_answer",
      result: null,
      error: null,
      transcript: [{ offset_seconds: 2, speaker: "user", text: "Synthetic response" }],
    });
    assert.equal(normalized.status, "completed");
    assert.equal(normalized.callOutcome, "no_answer");
    assert.equal(normalized.resultStatus, "unavailable");
    assert.equal(normalized.result, null);
    assert.equal(normalized.transcript[0].text, "Synthetic response");
    assert.equal(normalizeCallResource({ ...callResponse(), status: "completed", result_status: "pending" }).resultStatus, "pending");
    assert.throws(() => normalizeCallResource({ ...callResponse(), status: "unknown" }), /invalid/);
  });

  it("reads the CALL-E contract only through the configured client", async () => {
    const service = new CallEOutboundCallService({
      db: createMemoryDb(),
      client: { isConfigured: () => true, async getCall(id) { return { ...callResponse(id, "available"), status: "completed", result: { received: true } }; } },
    });
    const read = await service.getCall("call_test_123", resultSchema);
    assert.equal(read.resultStatus, "available");
    assert.deepEqual(read.result, { received: true });
    await assert.rejects(service.getCall("../../other"), (error) => error.code === "call_e_invalid_call_id");

    const invalidResultService = new CallEOutboundCallService({
      db: createMemoryDb(),
      client: { isConfigured: () => true, async getCall(id) { return { ...callResponse(id, "available"), status: "completed", result: { received: "maybe" } }; } },
    });
    await assert.rejects(invalidResultService.getCall("call_test_123", resultSchema), (error) => error.code === "call_e_result_invalid");
  });
});

describe("CALL-E idempotency persistence reuses the existing outbound ledger", () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `voicednut-calle-idempotency-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
  });

  afterEach(async () => {
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => {
      try { fs.unlinkSync(file); } catch (_) {}
    });
  });

  it("reserves once and permits key reuse only for a recorded no-call rejection", async () => {
    const key = "voicednut:call-e:reminder:test";
    const localCallId = "call_e_123e4567-e89b-12d3-a456-426614174000";
    const first = await db.reserveCallEOutboundCall({ idempotency_key: key, request_hash: "a".repeat(64), local_call_id: localCallId });
    const duplicate = await db.reserveCallEOutboundCall({ idempotency_key: key, request_hash: "a".repeat(64), local_call_id: "call_e_123e4567-e89b-12d3-a456-426614174001" });
    assert.equal(first.reserved, true);
    assert.equal(duplicate.reserved, false);
    await db.completeOutboundCallIdempotency({
      idempotency_key: key,
      provider: "call_e",
      request_hash: "a".repeat(64),
      status: "failed",
      response_payload: { localCallId },
      error_message: "call_e_no_call_created",
    });
    assert.deepEqual(await db.resetCallERejectedOutboundCall({
      idempotency_key: key,
      request_hash: "b".repeat(64),
      local_call_id: localCallId,
    }), { reset: true });
    const row = await db.getOutboundCallIdempotency(key);
    assert.equal(row.provider, "call_e");
    assert.equal(row.request_hash, "b".repeat(64));
    assert.equal(row.status, "pending");
    assert.equal(row.error_message, null);
  });
});
