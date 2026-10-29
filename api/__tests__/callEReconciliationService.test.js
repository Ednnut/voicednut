const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../db/db");
const {
  CallEReconciliationService,
  createCallEReconciliationHandler,
  normalizeCallEEventPage,
} = require("../services/callEReconciliationService");

const callId = "call_test_123";
const event = (id, type = "call.in_progress", overrides = {}) => ({
  id,
  type,
  call_id: callId,
  created_at: "2026-10-26T10:00:00Z",
  message: "private transcript fragment",
  details: { text: "private content" },
  ...overrides,
});

describe("CALL-E event reconciliation", () => {
  it("deduplicates stable event IDs and strips untrusted message and detail content", () => {
    const first = normalizeCallEEventPage({ object: "list", data: [event("evt_1"), event("evt_2")], next_cursor: "cursor_2" }, callId);
    const replay = normalizeCallEEventPage({ object: "list", data: [event("evt_1"), event("evt_2")], next_cursor: "cursor_2" }, callId, first.state);
    assert.deepEqual(first.events.map(({ id }) => id), ["evt_1", "evt_2"]);
    assert.deepEqual(replay.events, []);
    assert.equal("message" in first.events[0], false);
    assert.equal("details" in first.events[0], false);
    assert.equal(first.state.lastEventId, "evt_2");
    assert.equal(first.state.nextCursor, "cursor_2");
  });

  it("keeps cursor state on empty pages and incorporates late event IDs without lifecycle inference", () => {
    const previous = { lastEventId: "evt_8", nextCursor: "cursor_8", seenEventIds: ["evt_8"] };
    const empty = normalizeCallEEventPage({ object: "list", data: [], next_cursor: null }, callId, previous);
    assert.deepEqual(empty.state, previous);
    const late = normalizeCallEEventPage({ object: "list", data: [event("evt_4", "call.completed")], next_cursor: null }, callId, previous);
    assert.equal(late.events[0].id, "evt_4");
    assert.equal(late.state.lastEventId, "evt_4");
    assert.equal(late.state.nextCursor, null);
  });

  it("reads a bounded number of pages and persists each page before continuing", async () => {
    const pages = [
      { object: "list", data: [event("evt_1")], next_cursor: "cursor_1" },
      { object: "list", data: [event("evt_2")], next_cursor: "cursor_2" },
      { object: "list", data: [event("evt_3")], next_cursor: "cursor_3" },
    ];
    const requests = [];
    const saved = [];
    const service = new CallEReconciliationService({
      client: { isConfigured: () => true, async listCallEvents(id, options) { requests.push({ id, options }); return pages.shift(); } },
      async loadState() { return {}; },
      async saveState(id, state) { saved.push({ id, state }); },
      maxPages: 2,
    });
    const result = await service.reconcileEventPages(callId);
    assert.equal(result.pagesRead, 2);
    assert.equal(result.hasMore, true);
    assert.deepEqual(requests.map(({ options }) => options.cursor), [undefined, "cursor_1"]);
    assert.equal(saved.length, 2);
    assert.deepEqual(result.events.map(({ id }) => id), ["evt_1", "evt_2"]);
  });

  it("rejects foreign call events and malformed pagination envelopes", () => {
    assert.throws(() => normalizeCallEEventPage({ object: "list", data: [event("evt_x", "call.completed", { call_id: "call_other_123" })] }, callId), (error) => error.code === "call_e_invalid_event");
    assert.throws(() => normalizeCallEEventPage({ object: "collection", data: [] }, callId), (error) => error.code === "call_e_invalid_event_page");
    assert.throws(() => normalizeCallEEventPage({ object: "list", data: [], next_cursor: "x".repeat(513) }, callId), (error) => error.code === "call_e_invalid_cursor");
  });

  it("reconciles only a locally linked Call, validates available results, and persists normalized status only", async () => {
    const storedSnapshots = [];
    const resultSchema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
    const db = {
      async getCallEReconciliationRecord(id) {
        if (id !== "call_e_123e4567-e89b-12d3-a456-426614174000") return null;
        return { provider_call_id: callId, result_schema: resultSchema };
      },
      async updateCallEReconciliationSnapshot(id, snapshot) { storedSnapshots.push({ id, snapshot }); },
      async getCallEReconciliationState() { return {}; },
      async saveCallEReconciliationState() {},
    };
    const service = new CallEReconciliationService({
      db,
      client: {
        isConfigured: () => true,
        async getCall(id) { return { id, object: "call", status: "completed", call_outcome: "completed", result_status: "available", result: { ok: true }, transcript: [{ speaker: "user", text: "private" }], error: null }; },
        async listCallEvents() { return { object: "list", data: [event("evt_done", "call.completed")], next_cursor: null }; },
      },
    });
    const result = await service.reconcileLocalCall("call_e_123e4567-e89b-12d3-a456-426614174000");
    assert.equal(result.executionStatus, "completed");
    assert.equal(result.resultAvailable, true);
    assert.equal("providerCallId" in result, false);
    assert.equal("transcript" in result, false);
    assert.equal("result" in result, false);
    assert.equal(storedSnapshots[0].snapshot.result_status, "available");
    await assert.rejects(service.reconcileLocalCall("call_e_123e4567-e89b-12d3-a456-426614174001"), (error) => error.code === "call_e_call_not_found");
  });

  it("cancels only a business-scoped operator call through the task cancellation capability", async () => {
    const localCallId = "call_e_123e4567-e89b-12d3-a456-426614174000";
    const resultSchema = { type: "object", additionalProperties: false, required: [], properties: {} };
    const snapshots = [];
    const cancelRequests = [];
    const db = {
      async getCallEReconciliationRecord(id) {
        return id === localCallId ? {
          business_id: "business_1",
          provider_call_id: callId,
          result_schema: resultSchema,
        } : null;
      },
      async getCallEBusinessOperator(businessId, telegramId) {
        return businessId === "business_1" && telegramId === "12345" ? { role: "call_operator" } : null;
      },
      async updateCallEReconciliationSnapshot(id, snapshot) { snapshots.push({ id, snapshot }); },
    };
    const service = new CallEReconciliationService({
      db,
      client: { isConfigured: () => true },
      cancelTaskCall: async (request) => {
        cancelRequests.push(request);
        return {
          id: request.providerCallId,
          object: "call",
          status: "canceled",
          call_outcome: null,
          result_status: "not_applicable",
          result: null,
          error: null,
          transcript: [],
        };
      },
    });

    const result = await service.cancelLocalCallForOperator(localCallId, "12345");
    assert.equal(result.executionStatus, "canceled");
    assert.equal(result.resultStatus, "not_applicable");
    assert.equal("transcript" in result, false);
    assert.deepEqual(cancelRequests, [{ providerCallId: callId }]);
    assert.equal(snapshots[0].id, localCallId);
    assert.equal(snapshots[0].snapshot.execution_status, "canceled");
    await assert.rejects(service.cancelLocalCallForOperator(localCallId, "99999"), (error) => error.code === "call_e_call_not_found");
    assert.equal(cancelRequests.length, 1);
  });

  it("returns bounded transcript and schema-validated result only to a current business operator", async () => {
    const localCallId = "call_e_123e4567-e89b-12d3-a456-426614174000";
    const resultSchema = { type: "object", additionalProperties: false, required: ["outcome"], properties: { outcome: { type: "string" } } };
    let providerReads = 0;
    const db = {
      async getCallEReconciliationRecord(id) {
        return id === localCallId ? { business_id: "business_1", provider_call_id: callId, result_schema: resultSchema } : null;
      },
      async getCallEBusinessOperator(businessId, telegramId) {
        return businessId === "business_1" && telegramId === "12345" ? { role: "call_operator" } : null;
      },
    };
    const service = new CallEReconciliationService({
      db,
      client: { isConfigured: () => true },
      providerRegistry: {
        async getCall(provider, request) {
          providerReads += 1;
          assert.equal(provider, "call_e");
          assert.equal(request.providerCallId, callId);
          return {
            id: callId,
            object: "call",
            status: "completed",
            call_outcome: "completed",
            result_status: "available",
            result: { outcome: "confirmed" },
            transcript: [{ offset_seconds: 1.5, speaker: "user", text: "private transcript" }],
            error: null,
          };
        },
      },
    });

    await assert.rejects(service.reviewLocalCallForOperator(localCallId, "99999"), (error) => error.code === "call_e_call_not_found");
    assert.equal(providerReads, 0);
    const review = await service.reviewLocalCallForOperator(localCallId, "12345");
    assert.deepEqual(review.result, { outcome: "confirmed" });
    assert.deepEqual(review.transcript, [{ offsetSeconds: 1.5, speaker: "user", text: "private transcript" }]);
    assert.equal(review.executionStatus, "completed");
    assert.equal("providerCallId" in review, false);
  });

  it("caps private review payloads without returning partial structured results", async () => {
    const localCallId = "call_e_123e4567-e89b-12d3-a456-426614174000";
    const db = {
      async getCallEReconciliationRecord() {
        return {
          business_id: "business_1",
          provider_call_id: callId,
          result_schema: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string" } } },
        };
      },
      async getCallEBusinessOperator() { return { role: "policy_manager" }; },
    };
    const service = new CallEReconciliationService({
      db,
      client: { isConfigured: () => true },
      providerRegistry: {
        async getCall() {
          return {
            id: callId,
            object: "call",
            status: "completed",
            call_outcome: "completed",
            result_status: "available",
            result: { note: "r".repeat(25000) },
            transcript: Array.from({ length: 205 }, (_, index) => ({
              offset_seconds: index,
              speaker: "user",
              text: "t".repeat(1400),
            })),
            error: null,
          };
        },
      },
    });
    const review = await service.reviewLocalCallForOperator(localCallId, "12345");
    assert.equal(review.result, null);
    assert.equal(review.resultOmittedForSize, true);
    assert.equal(review.transcriptTruncated, true);
    assert.ok(review.transcript.length <= 200);
    assert.ok(review.transcript.reduce((total, turn) => total + turn.text.length, 0) <= 30000);
  });
});

describe("CALL-E additive reconciliation persistence", () => {
  let db;
  let dbPath;
  const localCallId = "call_e_123e4567-e89b-12d3-a456-426614174000";
  const resultSchema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `voicednut-calle-reconciliation-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
  });

  afterEach(async () => {
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
  });

  it("stores only the pinned schema, cursor, and normalized lifecycle fields", async () => {
    await db.upsertCallEReconciliationRecord({
      local_call_id: localCallId,
      provider_call_id: "call_provider_123",
      template_id: 12,
      template_version: 4,
      request_hash: "a".repeat(64),
      result_schema: resultSchema,
      execution_status: "completed",
      call_outcome: "no_answer",
      result_status: "pending",
    });
    await db.saveCallEReconciliationState("call_provider_123", {
      lastEventId: "evt_2", nextCursor: null, seenEventIds: ["evt_1", "evt_2"],
    });
    await db.updateCallEReconciliationSnapshot(localCallId, {
      execution_status: "completed", call_outcome: "no_answer", result_status: "unavailable", error_code: null,
    });
    const record = await db.getCallEReconciliationRecord(localCallId);
    const cursor = await db.getCallEReconciliationState("call_provider_123");
    assert.deepEqual(record.result_schema, resultSchema);
    assert.equal(record.result_status, "unavailable");
    assert.equal(record.call_outcome, "no_answer");
    assert.deepEqual(cursor, { nextCursor: null, lastEventId: "evt_2", seenEventIds: ["evt_1", "evt_2"] });
    const columns = await new Promise((resolve, reject) => db.db.all("PRAGMA table_info(call_e_reconciliation)", (err, rows) => err ? reject(err) : resolve(rows.map((row) => row.name))));
    assert.equal(columns.includes("phone"), false);
    assert.equal(columns.includes("transcript"), false);
    assert.equal(columns.includes("result_json"), false);
  });
});

describe("CALL-E reconciliation API handler", () => {
  it("returns only lifecycle and event metadata from the local-call-scoped service", async () => {
    const response = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    const handler = createCallEReconciliationHandler({
      service: { async reconcileLocalCall(id) { return { localCallId: id, executionStatus: "completed", resultAvailable: true, events: [{ id: "evt_1", type: "call.completed" }] }; } },
    });
    await handler({ params: { localCallId: "call_e_123e4567-e89b-12d3-a456-426614174000" } }, response);
    assert.equal(response.body.success, true);
    assert.equal(response.body.result.executionStatus, "completed");
    assert.equal("transcript" in response.body.result, false);
    assert.equal("result" in response.body.result, false);
  });

  it("maps missing local calls to 404 and sanitizes unexpected failures", async () => {
    const makeResponse = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
    const missing = makeResponse();
    await createCallEReconciliationHandler({ service: { async reconcileLocalCall() { const error = new Error("not found"); error.code = "call_e_call_not_found"; throw error; } } })({ params: { localCallId: "call_e_unknown" } }, missing);
    assert.equal(missing.statusCode, 404);
    const failed = makeResponse();
    await createCallEReconciliationHandler({ service: { async reconcileLocalCall() { throw new Error("contains internal provider details"); } } })({ params: { localCallId: "call_e_unknown" } }, failed);
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.body.error.includes("internal provider"), false);
  });
});
