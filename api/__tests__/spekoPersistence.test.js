const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../db/db");

describe("Speko persistent lifecycle ordering", () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `voicednut-speko-sequence-${Date.now()}-${Math.random()}.sqlite`,
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

  it("atomically advances sequence numbers and ignores duplicate or stale events", async () => {
    const callSid = "speko_internal_test";
    assert.deepEqual(
      await db.advanceSpekoCallSequence({
        call_sid: callSid,
        sequence_number: 4,
      }),
      { advanced: true },
    );
    assert.deepEqual(
      await db.advanceSpekoCallSequence({
        call_sid: callSid,
        sequence_number: 4,
      }),
      { advanced: false },
    );
    assert.deepEqual(
      await db.advanceSpekoCallSequence({
        call_sid: callSid,
        sequence_number: 3,
      }),
      { advanced: false },
    );
    assert.deepEqual(
      await db.advanceSpekoCallSequence({
        call_sid: callSid,
        sequence_number: 5,
      }),
      { advanced: true },
    );
  });

  it("stores call and leg mappings and deduplicates safe human call-control events", async () => {
    await db.saveSpekoHumanCall({ call: {
      id: "human-call-1", direction: "outbound", status: "ringing",
      legs: [{ controlId: "opaque-browser-leg", kind: "browser", brokerId: "broker-1", status: "ringing", phoneNumber: "+15551234567" }],
    } });
    assert.equal((await db.getSpekoHumanCallLeg({ control_id: "opaque-browser-leg" })).call_id, "human-call-1");
    const event = {
      event_id: "human-event-1", call_id: "human-call-1", control_id: "opaque-browser-leg",
      event_type: "call.answered", occurred_at: "2026-01-01T00:00:00.000Z",
      details: { status: "active", digits: "1234", phoneNumber: "+15551234567" },
    };
    assert.deepEqual(await db.recordSpekoHumanCallEvent(event), { inserted: true });
    assert.deepEqual(await db.recordSpekoHumanCallEvent(event), { inserted: false });
    await db.recordSpekoHumanCallEvent({ ...event, event_id: "human-event-old", event_type: "call.ringing", occurred_at: "2025-12-31T23:59:00.000Z" });
    await db.recordSpekoHumanCallEvent({ ...event, event_id: "human-event-undated", event_type: "call.ringing", occurred_at: null });
    const row = await new Promise((resolve, reject) => db.db.get(
      "SELECT safe_details FROM speko_human_call_events WHERE event_id=?", [event.event_id], (err, result) => err ? reject(err) : resolve(result),
    ));
    assert.deepEqual(JSON.parse(row.safe_details), { status: "active" });
    const call = await db.getSpekoHumanCall({ call_id: "human-call-1" });
    assert.equal(call.status, "active");
    assert.equal(call.legs[0].status, "active");
    assert.equal(call.latest_event_id, event.event_id);
    assert.equal(call.latest_event_at, event.occurred_at);
    assert.equal(call.legs[0].latest_event_at, event.occurred_at);
    assert.equal(JSON.stringify(call).includes("+15551234567"), false);

    await db.saveSpekoHumanCall({ call: {
      id: "human-call-undated-first", status: "initiating",
      legs: [{ controlId: "undated-first-leg", kind: "browser", brokerId: "broker-1", status: "initiating" }],
    } });
    await db.recordSpekoHumanCallEvent({
      event_id: "undated-first-event", call_id: "human-call-undated-first",
      control_id: "undated-first-leg", event_type: "call.ringing",
    });
    const undatedFirst = await db.getSpekoHumanCall({ call_id: "human-call-undated-first" });
    assert.equal(undatedFirst.status, "ringing");
    assert.equal(undatedFirst.latest_event_id, "undated-first-event");
  });

  it("keeps an attributed, payload-free administrator control audit", async () => {
    const id = await db.startSpekoHumanCallControlAudit({
      operation: "dtmf", call_id: "human-call-audit", control_id: "opaque-control",
      actor_hint: "operator-7", actor_source: "named_admin_token", request_id: "request-7", digits: "9876",
    });
    await db.finishSpekoHumanCallControlAudit({ id, status: "failed", error_code: "speko_provider_timeout" });
    const [row] = await db.listSpekoHumanCallControlAudit({ call_id: "human-call-audit", limit: 10 });
    assert.equal(row.status, "failed");
    assert.equal(row.actor_hint, "operator-7");
    assert.equal(row.actor_source, "named_admin_token");
    assert.equal(JSON.stringify(row).includes("9876"), false);
  });

  it("enforces an explicit one-to-one broker to Telegram owner assignment", async () => {
    await db.setSpekoHumanBrokerOwner({
      broker_id: "broker-assigned", telegram_user_id: "100200300", assigned_by: "ops-admin",
    });
    const owner = await db.getSpekoHumanBrokerOwner({ telegram_user_id: "100200300" });
    assert.equal(owner.broker_id, "broker-assigned");
    assert.equal(owner.telegram_user_id, "100200300");
    assert.equal(owner.assigned_by, "ops-admin");
    await db.saveSpekoHumanCall({ call: {
      id: "owned-call", direction: "outbound", status: "ringing",
      legs: [{ controlId: "owned-browser", kind: "browser", brokerId: "broker-assigned", status: "ringing" }],
    } });
    assert.equal(await db.isSpekoHumanCallOwnedByBroker({ call_id: "owned-call", broker_id: "broker-assigned" }), true);
    assert.equal(await db.isSpekoHumanCallOwnedByBroker({ call_id: "owned-call", broker_id: "broker-other" }), false);
    await assert.rejects(db.setSpekoHumanBrokerOwner({ broker_id: "broker-other", telegram_user_id: "100200300" }));
    assert.equal(await db.deleteSpekoHumanBrokerOwner({ broker_id: "broker-assigned" }), 1);
  });

  it("serializes in-flight event sequences and releases failed claims for retry", async () => {
    const callSid = "speko_internal_claim_test";
    const firstClaim = await db.claimSpekoCallSequence({
      call_sid: callSid,
      sequence_number: 10,
      event_key: "webhook-10",
    });
    assert.equal(firstClaim.claimed, true);

    const overlapping = await db.claimSpekoCallSequence({
      call_sid: callSid,
      sequence_number: 11,
      event_key: "webhook-11",
    });
    assert.equal(overlapping.claimed, false);
    assert.equal(overlapping.busy, true);

    await db.releaseSpekoCallSequenceClaim({
      call_sid: callSid,
      sequence_number: 10,
      event_key: "webhook-10",
    });
    const retryClaim = await db.claimSpekoCallSequence({
      call_sid: callSid,
      sequence_number: 11,
      event_key: "webhook-11",
    });
    assert.equal(retryClaim.claimed, true);
    assert.deepEqual(
      await db.finishSpekoCallSequence({
        call_sid: callSid,
        sequence_number: 11,
        event_key: "webhook-11",
      }),
      { advanced: true },
    );
    assert.equal(await db.getSpekoCallSequence({ call_sid: callSid }), 11);
    assert.deepEqual(
      await db.claimSpekoCallSequence({
        call_sid: callSid,
        sequence_number: 10,
        event_key: "old-webhook",
      }),
      { claimed: false, stale: true, busy: false },
    );
  });

  it("allows only one concurrent reservation for a repeated outbound idempotency key", async () => {
    const attempts = await Promise.all([
      db.reserveOutboundCallIdempotency({
        idempotency_key: "speko-concurrent-key",
        provider: "speko",
        request_hash: "same-request",
      }),
      db.reserveOutboundCallIdempotency({
        idempotency_key: "speko-concurrent-key",
        provider: "speko",
        request_hash: "same-request",
      }),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.reserved).length, 1);
    assert.equal(attempts.filter((attempt) => !attempt.reserved).length, 1);
  });

  it("uses an expiring application attempt lease to block concurrent retries", async () => {
    const claims = await Promise.all([
      db.claimOutboundCallAttempt({
        idempotency_key: "speko-attempt-lease",
        lease_seconds: 60,
      }),
      db.claimOutboundCallAttempt({
        idempotency_key: "speko-attempt-lease",
        lease_seconds: 60,
      }),
    ]);
    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    assert.equal(claims.filter((claim) => !claim.claimed).length, 1);
    await db.releaseOutboundCallAttempt({
      idempotency_key: "speko-attempt-lease",
    });
    assert.deepEqual(
      await db.claimOutboundCallAttempt({
        idempotency_key: "speko-attempt-lease",
        lease_seconds: 60,
      }),
      { claimed: true },
    );
  });

  it("allows only one concurrent Speko call reconciliation per call", async () => {
    const claims = await Promise.all([
      db.claimSpekoReconciliation({ call_sid: "speko_reconcile_1" }),
      db.claimSpekoReconciliation({ call_sid: "speko_reconcile_1" }),
    ]);
    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    assert.equal(claims.filter((claim) => !claim.claimed).length, 1);
    await db.releaseSpekoReconciliation({ call_sid: "speko_reconcile_1" });
    assert.deepEqual(
      await db.claimSpekoReconciliation({ call_sid: "speko_reconcile_1" }),
      { claimed: true },
    );
  });

  it("resolves a persisted Speko session to its Voicednut call record", async () => {
    await db.createCall({
      call_sid: "speko_tool_lookup_test",
      phone_number: "+12015550100",
      prompt: "Support",
      first_message: "Hello",
      user_chat_id: null,
      direction: "outbound",
    });
    await db.updateCallState("speko_tool_lookup_test", "call_created", {
      provider: "speko",
      provider_metadata: { speko_session_id: "speko_session_tool_test" },
    });

    const call = await db.getSpekoCallBySessionId("speko_session_tool_test");
    assert.equal(call.call_sid, "speko_tool_lookup_test");
    assert.equal(call.provider, "speko");
    assert.equal(await db.getSpekoCallBySessionId("unknown_session"), null);
  });

  it("aggregates Speko call metrics without returning metric payloads", async () => {
    await db.createCall({
      call_sid: "speko_metrics_test",
      phone_number: "+12015550100",
      prompt: "Support",
      first_message: "Hello",
      user_chat_id: null,
      direction: "outbound",
    });
    await db.addCallMetric("speko_metrics_test", "speko_webhook_event", 1, {
      event_type: "call.status",
      status: "completed",
      session_id: "session_metrics_test",
      sensitive_payload: "must not be returned",
    });
    await db.addCallMetric("speko_metrics_test", "speko_call_duration_seconds", 42, {
      event_type: "call.report",
    });
    await db.addCallMetricOnce("speko_metrics_test", "speko_call_created", 1, {
      event_type: "call.pre_call",
    });
    await db.addCallMetricOnce("speko_metrics_test", "speko_call_created", 1, {
      event_type: "call.pre_call",
    });

    const metrics = await db.getSpekoOperationalMetrics(24);
    assert.equal(metrics.period_hours, 24);
    assert.deepEqual(
      metrics.events.map((event) => [event.event, event.count, event.total]),
      [
        ["call.pre_call", 1, 1],
        ["call.status:completed", 1, 1],
        ["speko_call_duration_seconds", 1, 42],
      ],
    );
    assert.equal(JSON.stringify(metrics).includes("must not be returned"), false);
    assert.equal((await db.getSpekoOperationalMetrics(9999)).period_hours, 720);
  });
});
