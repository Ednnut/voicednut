const assert = require("node:assert/strict");
const Database = require("../db/db");

describe("call job status summary", () => {
  let db;

  beforeEach(async () => {
    db = new Database();
    db.dbPath = ":memory:";
    await db.initialize();
  });

  afterEach(async () => {
    if (db?.db) {
      await new Promise((resolve) => db.db.close(() => resolve()));
    }
  });

  it("counts queue states and open dead letters", async () => {
    const pendingId = await db.createCallJob("outbound_call", {}, new Date().toISOString());
    const runningId = await db.createCallJob("callback_call", {}, new Date().toISOString());
    const failedId = await db.createCallJob("callback_call", {}, new Date().toISOString());
    const failedLockAt = new Date().toISOString();
    await new Promise((resolve, reject) => {
      db.db.run("UPDATE call_jobs SET status='running', locked_at=? WHERE id=?", [failedLockAt, failedId], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await db.completeCallJob(failedId, "failed", "test failure", failedLockAt);
    await new Promise((resolve, reject) => {
      db.db.run("UPDATE call_jobs SET status='running' WHERE id=?", [runningId], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await db.moveCallJobToDlq(
      { id: failedId, job_type: "callback_call", payload: "{}", attempts: 1 },
      "ambiguous_outbound_outcome",
      "provider outcome unknown",
    );

    const summary = await db.getCallJobStatusSummary();
    assert.deepEqual(summary, {
      pending: 1,
      running: 1,
      completed: 0,
      failed: 1,
      open_dead_letters: 1,
    });
    assert.ok(pendingId > 0);
  });
});
