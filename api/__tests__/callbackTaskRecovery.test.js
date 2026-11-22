const assert = require("node:assert/strict");
const { __testables } = require("../services/callRoutes");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function makeHandler({ job, dlqEntry = null } = {}) {
  const calls = [];
  const storedJob = { id: 7, job_type: "callback_call", status: "pending", run_at: "2026-11-22T15:00:00.000Z", payload: "{}", ...job };
  const handler = __testables.createUpdateCallbackTaskStatusHandler({
    parseBoundedInteger: (value) => Number(value),
    db: {
      async getCallJob() { return storedJob; },
      async getCallJobDlqEntryByJobId() { return dlqEntry; },
      async updatePendingCallbackJob(...args) {
        calls.push(args);
        return 1;
      },
    },
  });
  return { handler, calls };
}

describe("callback task recovery controls", () => {
  it("does not let a DLQ callback be moved back to pending", async () => {
    const fixture = makeHandler({
      job: { status: "failed", last_error: "worker_interrupted_requires_review" },
      dlqEntry: { dead_letter_reason: "worker_interrupted_requires_review" },
    });
    const res = response();

    await fixture.handler(
      { params: { taskId: "7" }, body: { status: "pending", run_at: "2026-11-22T16:00:00.000Z" } },
      res,
    );

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "callback_task_requires_review");
    assert.equal(fixture.calls.length, 0);
  });

  it("only reschedules pending callback jobs through the guarded DB operation", async () => {
    const fixture = makeHandler();
    const res = response();

    await fixture.handler(
      { params: { taskId: "7" }, body: { status: "pending", run_at: "2026-11-22T16:00:00.000Z" } },
      res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0][0], 7);
    assert.equal(fixture.calls[0][1], "pending");
    assert.equal(fixture.calls[0][2], "2026-11-22T16:00:00.000Z");
  });

  it("rejects mutation if a worker claims the task before the guarded update", async () => {
    const fixture = makeHandler();
    fixture.calls.length = 0;
    fixture.handler = __testables.createUpdateCallbackTaskStatusHandler({
      parseBoundedInteger: (value) => Number(value),
      db: {
        async getCallJob() { return { id: 7, job_type: "callback_call", status: "running" }; },
        async getCallJobDlqEntryByJobId() { return null; },
        async updatePendingCallbackJob() { return 0; },
      },
    });
    const res = response();

    await fixture.handler(
      { params: { taskId: "7" }, body: { status: "failed" } },
      res,
    );

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "callback_task_state_changed");
  });
});
