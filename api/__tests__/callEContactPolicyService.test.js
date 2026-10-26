const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../db/db");
const { CallEContactPolicyService, normalizePolicyInput } = require("../services/callEContactPolicyService");

describe("CALL-E contact consent and opt-out policy", () => {
  let db;
  let dbPath;
  let service;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `voicednut-calle-policy-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    service = new CallEContactPolicyService({ db });
  });

  afterEach(async () => {
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
  });

  function consent(overrides = {}) {
    return {
      businessId: "business_policy_001",
      destination: "+14155550123",
      eventKey: "consent:event:0001",
      source: "written",
      evidenceReference: "evidence:record:0001",
      occurredAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("requires explicit evidence metadata and validates scope, destination and timestamps", () => {
    assert.throws(() => normalizePolicyInput(consent({ evidenceReference: "" }), "consent"), (error) => error.code === "call_e_consent_evidence_required");
    assert.throws(() => normalizePolicyInput(consent({ businessId: "" }), "consent"), (error) => error.code === "call_e_contact_policy_invalid");
    assert.throws(() => normalizePolicyInput(consent({ destination: "4155550123" }), "consent"), (error) => error.code === "call_e_contact_policy_invalid");
    assert.throws(() => normalizePolicyInput(consent({ occurredAt: "2026-10-26 10:00:00" }), "consent"), (error) => error.code === "call_e_contact_policy_invalid");
    assert.throws(() => normalizePolicyInput(consent({ expiresAt: "2026-10-25T00:00:00Z" }), "consent"), (error) => error.code === "call_e_consent_expiry_invalid");
  });

  it("allows an active consent only in its business scope and deduplicates evidence events", async () => {
    assert.deepEqual(await service.checkEligibility({ businessId: "business_policy_001", destination: "+14155550123" }), {
      eligible: false,
      reason: "consent_missing",
    });
    const event = consent();
    assert.deepEqual(await service.recordConsent(event), { recorded: true, idempotentReplay: false });
    assert.deepEqual(await service.recordConsent(event), { recorded: false, idempotentReplay: true });
    assert.deepEqual(await service.checkEligibility({ businessId: "business_policy_001", destination: "+14155550123" }), {
      eligible: true,
      reason: null,
    });
    assert.deepEqual(await service.checkEligibility({ businessId: "business_policy_002", destination: "+14155550123" }), {
      eligible: false,
      reason: "consent_missing",
    });
    await assert.rejects(service.recordConsent(consent({ evidenceReference: "evidence:record:0002" })), (error) => error.code === "call_e_contact_policy_idempotency_conflict");
  });

  it("keeps an append-only business-operator grant and revoke history", async () => {
    await new Promise((resolve, reject) => db.db.run(
      "INSERT INTO call_templates (name, business_id) VALUES (?, ?)",
      ["Synthetic scoped template", "business_policy_001"],
      (error) => error ? reject(error) : resolve(),
    ));
    assert.equal(await db.hasCallTemplateBusinessId("business_policy_001"), true);
    assert.equal(await db.hasCallTemplateBusinessId("unknown_business"), false);
    await db.grantCallEBusinessOperator({ business_id: "business_policy_001", telegram_id: "123456789", role: "policy_manager" });
    assert.deepEqual(await db.getCallEBusinessOperator("business_policy_001", "123456789"), { role: "policy_manager" });
    await db.grantCallEBusinessOperator({ business_id: "business_policy_001", telegram_id: "123456789", role: "call_operator" });
    assert.deepEqual(await db.getCallEBusinessOperator("business_policy_001", "123456789"), { role: "call_operator" });
    assert.equal(await db.revokeCallEBusinessOperator({ business_id: "business_policy_001", telegram_id: "123456789" }), true);
    assert.equal(await db.getCallEBusinessOperator("business_policy_001", "123456789"), null);
    const events = await new Promise((resolve, reject) => db.db.all(
      "SELECT event_type, role, actor_type FROM call_e_business_operator_events ORDER BY id",
      [],
      (error, rows) => error ? reject(error) : resolve(rows),
    ));
    assert.deepEqual(events.map(({ event_type, role, actor_type }) => ({ event_type, role, actor_type })), [
      { event_type: "access_granted", role: "policy_manager", actor_type: "admin_token" },
      { event_type: "access_granted", role: "call_operator", actor_type: "admin_token" },
      { event_type: "access_revoked", role: null, actor_type: "admin_token" },
    ]);
  });

  it("denies expired consent and keeps opt-out sticky after later consent evidence", async () => {
    await service.recordConsent(consent({
      businessId: "business_policy_expired",
      destination: "+14155550124",
      eventKey: "consent:expired:0001",
      evidenceReference: "evidence:expired:0001",
      occurredAt: "2025-01-01T00:00:00.000Z",
      expiresAt: "2025-01-02T00:00:00.000Z",
    }));
    assert.deepEqual(await service.checkEligibility({ businessId: "business_policy_expired", destination: "+14155550124" }), {
      eligible: false,
      reason: "consent_expired",
    });

    await service.recordConsent(consent({
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }));
    assert.equal((await service.checkEligibility({ businessId: "business_policy_001", destination: "+14155550123" })).eligible, true);

    await service.recordOptOut({
      businessId: "business_policy_001",
      destination: "+14155550123",
      eventKey: "optout:event:0001",
      source: "recipient_request",
      occurredAt: new Date().toISOString(),
    });
    assert.deepEqual(await service.checkEligibility({ businessId: "business_policy_001", destination: "+14155550123" }), {
      eligible: false,
      reason: "opted_out",
    });

    await service.recordConsent(consent({
      eventKey: "consent:event:0002",
      evidenceReference: "evidence:record:0002",
      occurredAt: new Date().toISOString(),
    }));
    assert.equal((await service.checkEligibility({ businessId: "business_policy_001", destination: "+14155550123" })).reason, "opted_out");
  });

  it("does not activate consent evidence recorded in the future", async () => {
    await service.recordConsent(consent({
      businessId: "business_policy_future",
      destination: "+14155550125",
      eventKey: "consent:future:0001",
      evidenceReference: "evidence:future:0001",
      occurredAt: new Date(Date.now() + 60 * 1000).toISOString(),
    }));
    assert.deepEqual(await service.checkEligibility({ businessId: "business_policy_future", destination: "+14155550125" }), {
      eligible: false,
      reason: "consent_not_effective",
    });
  });

  it("fails closed when the policy store is unavailable", async () => {
    const unavailable = new CallEContactPolicyService({
      db: { async getCallEContactPolicyEligibility() { throw new Error("synthetic storage outage"); } },
    });
    assert.deepEqual(await unavailable.checkEligibility({ businessId: "business_policy_001", destination: "+14155550123" }), {
      eligible: false,
      reason: "policy_storage_unavailable",
    });
  });

  it("stores the authenticated policy manager identity on an evidence event", async () => {
    await service.recordConsent(consent({ recordedByTelegramId: "123456789" }));
    const row = await new Promise((resolve, reject) => db.db.get(
      "SELECT recorded_by_telegram_id FROM call_e_contact_policy_events WHERE event_key = ?",
      ["consent:event:0001"],
      (error, result) => error ? reject(error) : resolve(result),
    ));
    assert.equal(row.recorded_by_telegram_id, "123456789");
  });

  it("adds the actor column to an existing policy-event table during forward migration", async () => {
    await new Promise((resolve, reject) => db.db.run(
      "ALTER TABLE call_e_contact_policy_events DROP COLUMN recorded_by_telegram_id",
      (error) => error ? reject(error) : resolve(),
    ));
    await db.ensureCallEContactPolicyColumns();
    const columns = await new Promise((resolve, reject) => db.db.all(
      "PRAGMA table_info(call_e_contact_policy_events)",
      (error, rows) => error ? reject(error) : resolve(rows || []),
    ));
    assert.equal(columns.some(({ name }) => name === "recorded_by_telegram_id"), true);
  });
});
