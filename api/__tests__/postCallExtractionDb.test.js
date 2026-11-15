const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../db/db");

describe("Post-call structured extraction persistence", () => {
  let db;
  let dbPath;
  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `voicednut-extraction-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    await new Promise((resolve, reject) => db.db.run(
      "INSERT INTO calls (call_sid, phone_number, business_id) VALUES (?, ?, ?)",
      ["extract-call-1", "+15555550123", "biz-1"],
      (error) => error ? reject(error) : resolve(),
    ));
  });
  afterEach(async () => {
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
  });

  it("stores provenance and audit records, permits one guarded review, and rejects a second decision", async () => {
    const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
    await db.upsertCallStructuredExtraction({
      call_sid: "extract-call-1", business_id: "biz-1", extraction_version: "structured_extraction_v1",
      schema_version: "support_v2", schema_hash: "a".repeat(64), schema, model_id: "test/model",
      provider_request_id: "gen-openrouter-123", usage_source: "openrouter_chat_completion_response",
      prompt_tokens: 23, completion_tokens: 11, total_tokens: 34,
      status: "pending_review", data: { ok: true }, confidence: 0.5, evidence: [],
      validation_errors: ["low confidence"], processed_at: "2026-11-14T00:00:00.000Z",
    });
    const pending = await db.getCallStructuredExtraction("extract-call-1");
    assert.equal(pending.schema_version, "support_v2");
    assert.equal(pending.data.ok, true);
    assert.equal(pending.status, "pending_review");

    const reviewed = await db.reviewCallStructuredExtraction({
      call_sid: "extract-call-1", decision: "corrected", corrected_data: { ok: false },
      reviewed_by: "admin_token", review_note: "verified", reviewed_at: "2026-11-14T01:00:00.000Z",
    });
    assert.equal(reviewed.status, "corrected");
    assert.deepEqual(reviewed.data, { ok: false });
    await assert.rejects(() => db.reviewCallStructuredExtraction({
      call_sid: "extract-call-1", decision: "approved", reviewed_by: "admin_token",
    }), { code: "conflict" });
    const audit = await new Promise((resolve, reject) => db.db.get(
      "SELECT decision, reviewed_by, review_note FROM call_structured_extraction_reviews WHERE call_sid = ?",
      ["extract-call-1"],
      (error, row) => error ? reject(error) : resolve(row),
    ));
    assert.deepEqual(audit, { decision: "corrected", reviewed_by: "admin_token", review_note: "verified" });
  });

  it("records request-scoped usage separately and deduplicates provider requests", async () => {
    const usage = {
      call_sid: "extract-call-1", business_id: "biz-1", model_id: "test/model",
      provider_request_id: "gen-openrouter-123", usage_source: "openrouter_chat_completion_response",
      prompt_tokens: 23, completion_tokens: 11, total_tokens: 34,
      recorded_at: "2026-11-14T00:00:00.000Z",
    };
    assert.deepEqual(await db.recordCallStructuredExtractionUsage(usage), { recorded: true, duplicate: false });
    assert.deepEqual(await db.recordCallStructuredExtractionUsage(usage), { recorded: false, duplicate: true });
    assert.deepEqual(await db.recordCallStructuredExtractionUsage({ ...usage, provider_request_id: "gen-openrouter-456" }),
      { recorded: true, duplicate: false });
    const rows = await new Promise((resolve, reject) => db.db.all(
      "SELECT call_sid, business_id, model_id, provider_request_id, usage_source, prompt_tokens, completion_tokens, total_tokens, recorded_at, provider FROM call_structured_extraction_usage ORDER BY usage_id",
      (error, result) => error ? reject(error) : resolve(result),
    ));
    assert.deepEqual(rows, [
      { ...usage, provider: "openrouter" },
      { ...usage, provider_request_id: "gen-openrouter-456", provider: "openrouter" },
    ]);
  });
});
