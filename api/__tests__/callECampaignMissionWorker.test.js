"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../db/db");
const { CallECampaignMissionWorker } = require("../services/callECampaignMissionWorker");

const missionId = `mission_${"b".repeat(64)}`;
const campaignId = `campaign_${"a".repeat(64)}`;
const baseConfig = {
  enabled: true,
  missionId,
  businessId: "business-a",
  actorId: "123456789",
  workerId: "mission-worker-test-1",
  intervalMs: 1000,
};

describe("CALL-E campaign mission worker", () => {
  it("is disabled by default and refuses incomplete explicit mission scope", async () => {
    let attempts = 0;
    const disabled = new CallECampaignMissionWorker({ db: {}, createMissionService: async () => { attempts += 1; } });
    assert.deepEqual(await disabled.drain(), { state: "disabled", provider_requests: 0 });
    const incomplete = new CallECampaignMissionWorker({ config: { ...baseConfig, missionId: "" }, db: {}, createMissionService: async () => { attempts += 1; } });
    assert.deepEqual(await incomplete.drain(), { state: "not_configured", provider_requests: 0 });
    assert.equal(attempts, 0);
    assert.equal(disabled.start(), false);
  });

  it("does not run a service when another worker holds the durable lease", async () => {
    let serviceCalls = 0;
    const worker = new CallECampaignMissionWorker({
      config: baseConfig,
      db: {
        async getCallECampaignMissionWorkerControl() { return { paused: false }; },
        async acquireCallECampaignMissionWorkerLease() { return false; },
        async releaseCallECampaignMissionWorkerLease() { assert.fail("must not release an unowned lease"); },
      },
      async createMissionService() { serviceCalls += 1; },
      randomBytesFn: () => Buffer.alloc(24, 0xaa),
    });
    assert.deepEqual(await worker.drain(), { state: "lease_busy", provider_requests: 0 });
    assert.equal(serviceCalls, 0);
  });

  it("advances one step under the configured operator identity and releases in finally", async () => {
    const calls = [];
    const worker = new CallECampaignMissionWorker({
      config: baseConfig,
      db: {
        async getCallECampaignMissionWorkerControl() { return { paused: false }; },
        async acquireCallECampaignMissionWorkerLease(input) { calls.push({ type: "acquire", input }); return true; },
        async releaseCallECampaignMissionWorkerLease(input) { calls.push({ type: "release", input }); return true; },
      },
      async createMissionService() {
        return { async advance(input) { calls.push({ type: "advance", input }); return { state: "call_accepted", provider_requests: 1, local_call_id: "call_e_private" }; } };
      },
      randomBytesFn: () => Buffer.alloc(24, 0xaa),
    });
    const result = await worker.drain();
    assert.deepEqual(result, { state: "call_accepted", provider_requests: 1, error_code: null });
    assert.equal(calls.filter((entry) => entry.type === "advance").length, 1);
    assert.deepEqual(calls.find((entry) => entry.type === "advance").input, {
      mission_id: missionId,
      business_id: "business-a",
      actor_id: "123456789",
      source: "worker",
    });
    assert.equal(calls[0].input.mission_id, missionId);
    assert.equal(calls[0].input.business_id, "business-a");
    assert.equal(calls[0].input.lease_token, "aa".repeat(24));
    assert.equal(calls.at(-1).type, "release");
    assert.equal(calls.at(-1).input.state, "call_accepted");
    assert.equal(JSON.stringify(calls).includes("call_e_private"), false);
  });

  it("sanitizes service errors and still releases the lease", async () => {
    let releaseInput;
    const worker = new CallECampaignMissionWorker({
      config: baseConfig,
      db: {
        async getCallECampaignMissionWorkerControl() { return { paused: false }; },
        async acquireCallECampaignMissionWorkerLease() { return true; },
        async releaseCallECampaignMissionWorkerLease(input) { releaseInput = input; },
      },
      async createMissionService() { return { async advance() { throw Object.assign(new Error("phone +14155550123 and transcript"), { code: "CALL_E_PROVIDER_FAILED" }); } }; },
      randomBytesFn: () => Buffer.alloc(24, 0xbb),
    });
    const result = await worker.drain();
    assert.deepEqual(result, { state: "error", provider_requests: 0, error_code: "call_e_provider_failed" });
    assert.equal(releaseInput.state, "error");
    assert.equal(releaseInput.error_code, "call_e_provider_failed");
    assert.equal(JSON.stringify(result).includes("+14155550123"), false);
    assert.equal(JSON.stringify(result).includes("transcript"), false);
  });

  it("supports start and stop without retaining a timer", async () => {
    let timerCallback;
    let cleared = null;
    let serviceCalls = 0;
    const worker = new CallECampaignMissionWorker({
      config: baseConfig,
      db: {
        async getCallECampaignMissionWorkerControl() { return { paused: false }; },
        async acquireCallECampaignMissionWorkerLease() { return false; },
        async releaseCallECampaignMissionWorkerLease() {},
      },
      async createMissionService() { serviceCalls += 1; },
      setIntervalFn(callback, intervalMs) { timerCallback = callback; return { intervalMs, unref() {} }; },
      clearIntervalFn(timer) { cleared = timer; },
    });
    assert.equal(worker.start(), true);
    assert.equal(worker.start(), true);
    assert.equal(typeof timerCallback, "function");
    const timer = worker.timer;
    await worker.stop();
    assert.equal(worker.timer, null);
    assert.equal(cleared, timer);
    assert.equal(serviceCalls, 0);
  });

  it("acquires an atomic, scope-bound SQLite lease and only the lease owner can release it", async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-call-e-worker-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    try {
      await db.initialize();
      await new Promise((resolve, reject) => db.db.run(
        `INSERT INTO call_e_campaign_reviews (
          campaign_id, business_id, template_id, template_version, schema_fingerprint, request_hash,
          created_by, status, recipient_count, ready_count, blocked_count
        ) VALUES (?, 'business-a', 1, 1, ?, ?, '123456789', 'approved', 1, 1, 0)`,
        [campaignId, "c".repeat(64), "d".repeat(64)],
        (error) => error ? reject(error) : resolve(),
      ));
      await new Promise((resolve, reject) => db.db.run(
        `INSERT INTO call_e_campaign_missions (
          mission_id, business_id, campaign_id, template_id, template_version, result_schema_json,
          created_by, request_hash, status, reviewed_by, recipient_count, encryption_key_version
        ) VALUES (?, 'business-a', ?, 1, 1, '{}', '123456789', ?, 'approved', '222222222', 1, 1)`,
        [missionId, campaignId, "e".repeat(64)],
        (error) => error ? reject(error) : resolve(),
      ));
      const leaseA = { mission_id: missionId, business_id: "business-a", worker_id: "worker-a", lease_token: "a".repeat(48), lease_ms: 60000 };
      const leaseB = { ...leaseA, worker_id: "worker-b", lease_token: "b".repeat(48) };
      const races = await Promise.all([
        db.acquireCallECampaignMissionWorkerLease(leaseA),
        db.acquireCallECampaignMissionWorkerLease(leaseB),
      ]);
      assert.equal(races.filter(Boolean).length, 1);
      const acquired = races[0] ? leaseA : leaseB;
      const other = races[0] ? leaseB : leaseA;
      assert.equal(await db.acquireCallECampaignMissionWorkerLease(other), false);
      assert.equal(await db.releaseCallECampaignMissionWorkerLease({ ...acquired, state: "call_accepted" }), true);
      assert.equal(await db.releaseCallECampaignMissionWorkerLease({ ...acquired, state: "error" }), false);
      assert.equal(await db.acquireCallECampaignMissionWorkerLease(other), true);
      const status = await db.getCallECampaignMissionWorkerLeaseStatus(missionId, "business-a");
      assert.equal(status.active, true);
      assert.equal(status.lease_owner, other.worker_id);
      assert.equal(status.last_state, "leased");
      assert.equal("lease_token" in status, false);
      assert.equal(await db.acquireCallECampaignMissionWorkerLease({ ...other, business_id: "wrong-business" }), false);
      assert.equal(await db.getCallECampaignMissionWorkerLeaseStatus(missionId, "wrong-business"), null);
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(file); } catch (_) {} }
    }
  });
});
