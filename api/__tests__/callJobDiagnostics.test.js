const assert = require("node:assert/strict");
const request = require("supertest");
const config = require("../config");
const { app, __testables } = require("../app");
const { buildCallJobDlqDiagnostic } = require("../services/callJobDiagnostics");

describe("call-job DLQ diagnostics", () => {
  it("marks call outcomes unknown and never includes payloads or raw errors", () => {
    const diagnostic = buildCallJobDlqDiagnostic({
      id: 12,
      job_id: 7,
      job_type: "outbound_call",
      status: "open",
      attempts: 2,
      dead_letter_reason: "non_retryable_error",
      payload: '{"to":"+12015550123"}',
      last_error: "private provider response",
    });

    assert.equal(diagnostic.external_outcome, "unknown");
    assert.equal(diagnostic.retry_safety, "blocked_pending_review");
    assert.match(diagnostic.recommended_next_action, /provider state/);
    assert.doesNotMatch(JSON.stringify(diagnostic), /\+12015550123|private provider response/);
  });

  it("does not claim replay is safe for non-call jobs without evidence", () => {
    const diagnostic = buildCallJobDlqDiagnostic({
      job_type: "sms_scheduled_send",
      dead_letter_reason: "max_attempts_exceeded",
    });

    assert.equal(diagnostic.external_outcome, "not_verified");
    assert.equal(diagnostic.retry_safety, "requires_operator_assessment");
  });

  it("serves diagnostics only through the authenticated admin API", async () => {
    const previousAdminToken = config.admin.apiToken;
    config.admin.apiToken = "call-job-diagnostic-test-token";
    __testables.setDbForTests({
      async getCallJobDlqEntry() {
        return {
          id: 12,
          job_id: 7,
          job_type: "callback_call",
          status: "open",
          attempts: 1,
          dead_letter_reason: "worker_interrupted_requires_review",
          payload: '{"to":"+12015550123"}',
          last_error: "private provider response",
        };
      },
    });

    try {
      const denied = await request(app).get("/admin/call-jobs/dlq/12/diagnostic");
      assert.equal(denied.status, 403);

      const response = await request(app)
        .get("/admin/call-jobs/dlq/12/diagnostic")
        .set("x-admin-token", config.admin.apiToken);
      assert.equal(response.status, 200);
      assert.equal(response.body.diagnostic.retry_safety, "blocked_pending_review");
      assert.equal(Object.hasOwn(response.body.diagnostic, "payload"), false);
      assert.equal(Object.hasOwn(response.body.diagnostic, "last_error"), false);
    } finally {
      __testables.setDbForTests(null);
      config.admin.apiToken = previousAdminToken;
    }
  });
});
