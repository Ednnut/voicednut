const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../db/db");

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.db.run(sql, params, function(error) {
      if (error) reject(error);
      else resolve(this.lastID || this.changes || 0);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null));
  });
}

describe("stale call job quarantine", () => {
  let db;
  let dbPath;
  let otherDb;

  async function openDatabase() {
    const instance = new Database();
    instance.dbPath = dbPath;
    await instance.initialize();
    return instance;
  }

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `voicednut-call-job-recovery-${Date.now()}-${Math.random()}.sqlite`,
    );
    db = await openDatabase();
  });

  afterEach(async () => {
    for (const instance of [db, otherDb]) {
      if (instance?.db) await new Promise((resolve) => instance.db.close(() => resolve()));
    }
    otherDb = null;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(`${dbPath}${suffix}`); } catch (_) {}
    }
  });

  it("moves only stale running jobs into review without making them runnable", async () => {
    const cutoff = new Date(Date.now() - 60000).toISOString();
    const staleLock = new Date(Date.now() - 5 * 60000).toISOString();
    const freshLock = new Date(Date.now() - 10000).toISOString();
    const staleId = await db.createCallJob(
      "callback_call",
      { number: "+12015550123", prompt: "callback" },
      new Date().toISOString(),
    );
    const freshId = await db.createCallJob("outbound_call", {}, new Date().toISOString());
    const pendingId = await db.createCallJob("sms_scheduled_send", {}, new Date().toISOString());
    await run(db, "UPDATE call_jobs SET status='running', locked_at=?, attempts=2 WHERE id=?", [staleLock, staleId]);
    await run(db, "UPDATE call_jobs SET status='running', locked_at=? WHERE id=?", [freshLock, freshId]);

    assert.equal(await db.quarantineStaleRunningCallJobs(cutoff), 1);
    const staleJob = await db.getCallJob(staleId);
    const freshJob = await db.getCallJob(freshId);
    const pendingJob = await db.getCallJob(pendingId);
    const deadLetter = await db.getCallJobDlqEntryByJobId(staleId);

    assert.equal(staleJob.status, "failed");
    assert.equal(staleJob.last_error, "worker_interrupted_requires_review");
    assert.equal(staleJob.locked_at, null);
    assert.equal(freshJob.status, "running");
    assert.equal(pendingJob.status, "pending");
    assert.equal(deadLetter.dead_letter_reason, "worker_interrupted_requires_review");
    assert.equal(deadLetter.attempts, 2);
    assert.match(deadLetter.last_error, /inspect before taking further action/);
    assert.deepEqual(
      await db.replayCallJobDlqEntry(deadLetter.id, { runAt: new Date().toISOString() }),
      { status: "requires_review", deadLetterReason: "worker_interrupted_requires_review" },
    );
    assert.equal(await db.quarantineStaleRunningCallJobs(cutoff), 0);
  });

  it("rolls back the job status if its DLQ insert fails", async () => {
    const cutoff = new Date(Date.now() - 60000).toISOString();
    const staleLock = new Date(Date.now() - 5 * 60000).toISOString();
    const jobId = await db.createCallJob("callback_call", {}, new Date().toISOString());
    await run(db, "UPDATE call_jobs SET status='running', locked_at=? WHERE id=?", [staleLock, jobId]);
    await run(
      db,
      `CREATE TRIGGER reject_recovery_dlq BEFORE INSERT ON call_job_dlq
       BEGIN SELECT RAISE(ABORT, 'simulated DLQ insert failure'); END`,
    );

    await assert.rejects(db.quarantineStaleRunningCallJobs(cutoff), /simulated DLQ insert failure/);
    assert.equal((await db.getCallJob(jobId)).status, "running");
    assert.equal(await db.getCallJobDlqEntryByJobId(jobId), null);

    await run(db, "DROP TRIGGER reject_recovery_dlq");
    assert.equal(await db.quarantineStaleRunningCallJobs(cutoff), 1);
  });

  it("atomically fails a running job with its DLQ record and fences stale tokens", async () => {
    const lockAt = new Date().toISOString();
    const jobId = await db.createCallJob("outbound_call", { number: "+12015550123" }, lockAt);
    await run(db, "UPDATE call_jobs SET status='running', locked_at=? WHERE id=?", [lockAt, jobId]);
    await run(
      db,
      `CREATE TRIGGER reject_failure_dlq BEFORE INSERT ON call_job_dlq
       BEGIN SELECT RAISE(ABORT, 'simulated failure DLQ insert failure'); END`,
    );

    await assert.rejects(
      db.failCallJobToDlq(
        { id: jobId, job_type: "outbound_call", payload: '{"number":"+12015550123"}', attempts: 2 },
        "non_retryable_error",
        "provider rejected request",
        lockAt,
      ),
      /simulated failure DLQ insert failure/,
    );
    assert.equal((await db.getCallJob(jobId)).status, "running");
    assert.equal(await db.getCallJobDlqEntryByJobId(jobId), null);

    await run(db, "DROP TRIGGER reject_failure_dlq");
    assert.equal(
      await db.failCallJobToDlq(
        { id: jobId, job_type: "outbound_call", payload: '{"number":"+12015550123"}', attempts: 2 },
        "non_retryable_error",
        "provider rejected request",
        "stale-lock-token",
      ),
      false,
    );
    assert.equal((await db.getCallJob(jobId)).status, "running");

    assert.equal(
      await db.failCallJobToDlq(
        { id: jobId, job_type: "outbound_call", payload: '{"number":"+12015550123"}', attempts: 2 },
        "non_retryable_error",
        "provider rejected request",
        lockAt,
      ),
      true,
    );
    assert.equal((await db.getCallJob(jobId)).status, "failed");
    assert.equal((await db.getCallJobDlqEntryByJobId(jobId)).dead_letter_reason, "non_retryable_error");
  });

  it("serializes concurrent recovery sweeps and fences late worker updates", async () => {
    const cutoff = new Date(Date.now() - 60000).toISOString();
    const staleLock = new Date(Date.now() - 5 * 60000).toISOString();
    const jobId = await db.createCallJob("callback_call", {}, new Date().toISOString());
    await run(db, "UPDATE call_jobs SET status='running', locked_at=? WHERE id=?", [staleLock, jobId]);
    otherDb = await openDatabase();

    const [first, second] = await Promise.all([
      db.quarantineStaleRunningCallJobs(cutoff),
      otherDb.quarantineStaleRunningCallJobs(cutoff),
    ]);
    assert.equal(first + second, 1);
    assert.equal(await db.completeCallJob(jobId, "completed", null, staleLock), 0);
    assert.equal(await db.rescheduleCallJob(jobId, new Date().toISOString(), null, staleLock), 0);
    assert.equal((await db.getCallJob(jobId)).status, "failed");

    await db.moveCallJobToDlq(
      { id: jobId, job_type: "callback_call", payload: "{}", attempts: 1 },
      "non_retryable_error",
      "late worker result",
    );
    const deadLetter = await db.getCallJobDlqEntryByJobId(jobId);
    assert.equal(deadLetter.dead_letter_reason, "worker_interrupted_requires_review");
  });

  it("issues unique lock tokens when concurrent workers claim due jobs", async () => {
    await db.createCallJob("sms_scheduled_send", {}, new Date(Date.now() - 1000).toISOString());
    await db.createCallJob("sms_scheduled_send", {}, new Date(Date.now() - 1000).toISOString());
    otherDb = await openDatabase();

    const [first, second] = await Promise.all([
      db.claimDueCallJobs(2),
      otherDb.claimDueCallJobs(2),
    ]);
    const claimed = [...first, ...second];
    const tokens = claimed.map((job) => job.locked_at);
    assert.equal(claimed.length, 2);
    assert.equal(new Set(tokens).size, 2);
    assert.ok(tokens.every((token) => /^\d{4}-\d\d-\d\dT.*Z#[0-9a-f-]{36}$/.test(token)));
  });

  it("does not allow operator callback edits to requeue a dead-lettered job", async () => {
    const jobId = await db.createCallJob("callback_call", {}, new Date().toISOString());
    await db.moveCallJobToDlq(
      { id: jobId, job_type: "callback_call", payload: "{}", attempts: 1 },
      "worker_interrupted_requires_review",
      "review required",
    );

    assert.equal(
      await db.updatePendingCallbackJob(jobId, "pending", new Date().toISOString()),
      0,
    );
    assert.equal((await db.getCallJob(jobId)).status, "pending");
  });

  it("returns bounded DLQ summaries without payloads or raw errors", async () => {
    const jobId = await db.createCallJob("outbound_call", { number: "+12015550123" }, new Date().toISOString());
    await db.moveCallJobToDlq(
      { id: jobId, job_type: "outbound_call", payload: '{"number":"+12015550123"}', attempts: 2 },
      "worker_interrupted_requires_review",
      "provider error with sensitive details",
    );

    const [summary] = await db.listCallJobDlqSummaries({ status: "open", limit: 1 });
    assert.equal(summary.job_type, "outbound_call");
    assert.equal(summary.dead_letter_reason, "worker_interrupted_requires_review");
    assert.equal(Object.hasOwn(summary, "payload"), false);
    assert.equal(Object.hasOwn(summary, "last_error"), false);
  });

  it("requires review before replaying any side-effecting call job", async () => {
    for (const jobType of ["outbound_call", "callback_call"]) {
      const jobId = await db.createCallJob(jobType, { number: "+12015550123" }, new Date().toISOString());
      const dlqId = await db.moveCallJobToDlq(
        { id: jobId, job_type: jobType, payload: '{"number":"+12015550123"}', attempts: 1 },
        "non_retryable_error",
        "provider rejected the request",
      );

      assert.deepEqual(
        await db.replayCallJobDlqEntry(dlqId, { runAt: new Date().toISOString() }),
        { status: "requires_review", deadLetterReason: "side_effecting_call_requires_review" },
      );
      assert.equal((await db.getCallJobDlqEntry(dlqId)).status, "open");
    }

    const smsJobId = await db.createCallJob("sms_scheduled_send", {}, new Date().toISOString());
    const smsDlqId = await db.moveCallJobToDlq(
      { id: smsJobId, job_type: "sms_scheduled_send", payload: "{}", attempts: 3 },
      "max_attempts_exceeded",
      "SMS provider failure",
    );
    const smsReplay = await db.replayCallJobDlqEntry(smsDlqId, { runAt: new Date().toISOString() });
    assert.equal(smsReplay.status, "replayed");
  });
});
