const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite3 = require("sqlite3").verbose();
const {
  buildSanitizedTemplateAudit,
  exportTemplateAudit,
  openReadOnly,
} = require("../scripts/export-call-e-template-audit");

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => error ? reject(error) : resolve());
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => error ? reject(error) : resolve());
  });
}

describe("CALL-E sanitized template audit export", () => {
  it("classifies snapshots and emits hashes without template content or identifiers", () => {
    const prompt = "Synthetic private prompt marker";
    const firstMessage = "Synthetic private greeting marker";
    const report = buildSanitizedTemplateAudit([
      {
        id: 7,
        version: 2,
        lifecycle_state: "live",
        prompt,
        first_message: firstMessage,
        business_id: "private-business-marker",
        supports_payment: 0,
        supports_digit_capture: 0,
        requires_otp: 0,
        payment_enabled: 0,
        allow_terminator: 0,
      },
      {
        id: 9,
        version: 1,
        lifecycle_state: "private-lifecycle-marker",
        prompt: prompt,
        first_message: firstMessage,
        supports_payment: 0,
        supports_digit_capture: 0,
        requires_otp: 0,
        payment_enabled: 0,
        allow_terminator: 0,
      },
    ], [
      {
        template_id: 7,
        version: 2,
        snapshot: JSON.stringify({
          prompt,
          first_message: firstMessage,
          business_id: "private-business-marker",
          lifecycle_state: "live",
          config_json: { "private-configuration-key": "must-not-be-output" },
        }),
      },
      { template_id: 7, version: 1, snapshot: "not-json" },
    ]);

    assert.equal(report.rawTemplateContentIncluded, false);
    assert.equal(report.templates.length, 3);
    assert.equal(report.templates[0].snapshotValid, false);
    assert.equal(report.templates[1].compatibility.compatibleWithSyntheticCallsV2Inputs, false);
    assert.match(report.templates[1].contentFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(report.templates[1].featureFlags.paymentEnabled, false);
    assert.deepEqual(report.templates[1].compatibility.unsupported, ["configuration.custom_key"]);
    assert.equal(report.templates[2].lifecycleState, "unknown");
    const output = JSON.stringify(report);
    for (const privateValue of [prompt, firstMessage, "private-business-marker", "private-configuration-key", "must-not-be-output", "private-lifecycle-marker"]) {
      assert.equal(output.includes(privateValue), false);
    }
  });

  it("reads the expected tables from SQLite in immutable read-only mode", async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-calle-template-audit-${Date.now()}-${Math.random()}.sqlite`);
    const writer = new sqlite3.Database(dbPath);
    try {
      await run(writer, `CREATE TABLE call_templates (
        id INTEGER, version INTEGER, lifecycle_state TEXT, prompt TEXT, first_message TEXT,
        voice_model TEXT, objective_tags TEXT, supports_payment INTEGER, supports_digit_capture INTEGER,
        requires_otp INTEGER, default_profile TEXT, allow_terminator INTEGER, terminator_char TEXT,
        payment_enabled INTEGER, payment_connector TEXT, payment_amount TEXT, payment_currency TEXT,
        payment_policy TEXT, payment_description TEXT, payment_start_message TEXT,
        payment_success_message TEXT, payment_failure_message TEXT, payment_retry_message TEXT
      )`);
      await run(writer, `CREATE TABLE call_template_versions (template_id INTEGER, version INTEGER, snapshot TEXT)`);
      await run(writer, `CREATE TABLE vapi_call_events (template_id INTEGER, template_version INTEGER, provider_call_id TEXT)`);
      await run(writer, `CREATE TABLE vapi_call_campaigns (template_id INTEGER, template_version INTEGER, status TEXT)`);
      await run(writer, `CREATE TABLE call_e_reconciliation (template_id INTEGER, template_version INTEGER, provider_call_id TEXT)`);
      await run(writer, `INSERT INTO call_templates (id, version, lifecycle_state, prompt, first_message) VALUES (1, 1, 'live', ?, ?)`, [
        "synthetic prompt must not be exported",
        "synthetic greeting must not be exported",
      ]);
      await run(writer, `INSERT INTO call_template_versions (template_id, version, snapshot) VALUES (1, 1, ?)`, [JSON.stringify({
        prompt: "synthetic prompt must not be exported",
        first_message: "synthetic greeting must not be exported",
        lifecycle_state: "live",
      })]);
      await run(writer, "INSERT INTO vapi_call_events (template_id, template_version, provider_call_id) VALUES (1, 1, 'private-call-id')");
      await run(writer, "INSERT INTO vapi_call_campaigns (template_id, template_version, status) VALUES (1, 1, 'draft')");
      await run(writer, "INSERT INTO call_e_reconciliation (template_id, template_version, provider_call_id) VALUES (1, 1, 'private-calle-id')");
    } finally {
      await close(writer);
    }

    try {
      const readonly = await openReadOnly(dbPath);
      await assert.rejects(run(readonly, "UPDATE call_templates SET version = 99 WHERE id = 1"));
      await close(readonly);

      const report = await exportTemplateAudit(dbPath);
      assert.equal(report.templates.length, 1);
      assert.equal(report.templates[0].templateId, 1);
      assert.equal(report.templates[0].version, 1);
      assert.deepEqual(report.templates[0].usage, {
        vapiCallEvents: 1,
        vapiCampaignDrafts: 1,
        callEReconciliationRecords: 1,
      });
      const output = JSON.stringify(report);
      assert.equal(output.includes("synthetic prompt must not be exported"), false);
      assert.equal(output.includes("synthetic greeting must not be exported"), false);
      assert.equal(output.includes("private-call-id"), false);
      assert.equal(output.includes("private-calle-id"), false);
    } finally {
      try { fs.unlinkSync(dbPath); } catch (_) {}
    }
  });
});
