const assert = require("node:assert/strict");
const request = require("supertest");
const crypto = require("node:crypto");
const config = require("../config");
const { app, __testables } = require("../app");
const { __testables: callRouteTestables } = require("../services/callRoutes");

describe("call job failure classification", () => {
  it("persists stable idempotency keys on scheduled call jobs", async () => {
    const scheduled = [];
    __testables.setDbForTests({
      async createCallJob(jobType, payload, runAt) {
        scheduled.push({ jobType, payload, runAt });
        return scheduled.length;
      },
    });

    try {
      const callerPayload = { number: "+12015550123" };
      await __testables.scheduleCallJob("outbound_call", callerPayload, "later");
      await __testables.scheduleCallJob("callback_call", {
        number: "+12015550124",
        idempotency_key: "callback-key-1",
      });
      await __testables.scheduleCallJob("sms_scheduled_send", callerPayload);

      assert.match(scheduled[0].payload.idempotency_key, /^[0-9a-f-]{36}$/i);
      assert.equal(callerPayload.idempotency_key, undefined);
      assert.equal(scheduled[0].runAt, "later");
      assert.equal(scheduled[1].payload.idempotency_key, "callback-key-1");
      assert.equal(scheduled[2].payload, callerPayload);
    } finally {
      __testables.setDbForTests(null);
    }
  });

  it("assigns a fresh idempotency key to each explicit manual retry", async () => {
    __testables.setDbForTests({
      async getCall(callSid) {
        return { call_sid: callSid, phone_number: "+12015550123", prompt: "Retry" };
      },
      async getLatestCallState() {
        return null;
      },
    });

    try {
      const first = await __testables.buildRetryPayload("CA123");
      const second = await __testables.buildRetryPayload("CA123");
      assert.match(first.idempotency_key, /^[0-9a-f-]{36}$/i);
      assert.notEqual(first.idempotency_key, second.idempotency_key);
    } finally {
      __testables.setDbForTests(null);
    }
  });

  it("recognizes provider submission timeouts and server failures as ambiguous", () => {
    assert.equal(
      __testables.isAmbiguousOutboundCallError({ code: "call_provider_timeout" }),
      true,
    );
    assert.equal(
      __testables.isAmbiguousOutboundCallError({ status: 502 }),
      true,
    );
    assert.equal(
      __testables.isAmbiguousOutboundCallError({ status: 408 }),
      true,
    );
    assert.equal(
      __testables.isAmbiguousOutboundCallError(new Error("Socket timed out")),
      true,
    );
    assert.equal(
      __testables.isAmbiguousOutboundCallError({ status: 429 }),
      false,
    );
  });

  it("quarantines an outbound timeout instead of retrying it", () => {
    assert.deepEqual(
      __testables.classifyCallJobFailure(
        { job_type: "outbound_call" },
        { code: "call_job_timeout" },
      ),
      {
        retryable: false,
        deadLetterReason: "ambiguous_outbound_outcome",
      },
    );
  });

  it("quarantines uncertain callback submissions and provider server errors", () => {
    for (const error of [
      { code: "provider_submission_unknown", uncertain: true },
      { status: 503 },
    ]) {
      const disposition = __testables.classifyCallJobFailure(
        { job_type: "callback_call" },
        error,
      );
      assert.equal(disposition.retryable, false);
      assert.equal(disposition.deadLetterReason, "ambiguous_outbound_outcome");
    }
  });

  it("holds retryable or unclassified outbound failures for review", () => {
    for (const error of [
      { status: 429, code: "rate_limited" },
      { code: "provider_specific_transient_error" },
      new Error("unclassified provider failure"),
    ]) {
      assert.deepEqual(
        __testables.classifyCallJobFailure({ job_type: "outbound_call" }, error),
        {
          retryable: false,
          deadLetterReason: "ambiguous_outbound_outcome",
        },
      );
    }
  });

  it("preserves the existing retry policy for scheduled SMS jobs", () => {
    assert.deepEqual(
      __testables.classifyCallJobFailure(
        { job_type: "sms_scheduled_send" },
        { code: "sms_provider_timeout" },
      ),
      { retryable: true, deadLetterReason: "non_retryable_error" },
    );
  });

  it("keeps definite validation errors non-retryable without calling them ambiguous", () => {
    assert.deepEqual(
      __testables.classifyCallJobFailure(
        { job_type: "outbound_call" },
        { status: 400, code: "invalid_phone_number" },
      ),
      { retryable: false, deadLetterReason: "non_retryable_error" },
    );
  });

  it("returns a distinct 503 response for an ambiguous non-Speko call result", async () => {
    let apiError;
    const handler = callRouteTestables.createOutboundCallHandler({
      sendApiError: (_res, status, code, message) => {
        apiError = { status, code, message };
        return apiError;
      },
      resolveHost: () => "api.example.test",
      config: { server: { hostname: "api.example.test" } },
      placeOutboundCall: async () => {
        const error = new Error("Provider timed out after submission");
        error.code = "outbound_call_outcome_unknown";
        error.uncertain = true;
        error.status = 503;
        throw error;
      },
      buildErrorDetails: (error) => ({ code: error.code }),
    });
    const res = {};

    await handler(
      {
        body: {
          number: "+12015550123",
          prompt: "Help the caller.",
          first_message: "Hello.",
        },
        headers: {},
        requestId: "request-1",
      },
      res,
    );

    assert.equal(apiError.status, 503);
    assert.equal(apiError.code, "outbound_call_outcome_unknown");
    assert.match(apiError.message, /Do not retry/);
    assert.doesNotMatch(apiError.message, /Speko/);
  });

  it("preserves a provider rate limit and retry guidance in the API response", async () => {
    let apiError;
    const handler = callRouteTestables.createOutboundCallHandler({
      sendApiError: (_res, status, code, message, _requestId, extra) => {
        apiError = { status, code, message, extra };
        return apiError;
      },
      resolveHost: () => "api.example.test",
      config: { server: { hostname: "api.example.test" } },
      placeOutboundCall: async () => {
        const error = new Error("Speko rate limited the request");
        error.code = "rate_limited";
        error.status = 429;
        error.retryable = true;
        error.retryAfterSeconds = 12;
        throw error;
      },
      buildErrorDetails: (error) => ({ code: error.code }),
    });

    await handler({
      body: { number: "+12015550123", prompt: "Prompt", first_message: "Hello" },
      headers: {},
      requestId: "request-rate-limit",
    }, {});

    assert.equal(apiError.status, 429);
    assert.equal(apiError.code, "rate_limited");
    assert.equal(apiError.extra.retryable, true);
    assert.equal(apiError.extra.retry_after_seconds, 12);
  });

  it("blocks generic DLQ replay for call jobs that require review", async () => {
    const previousAdminToken = config.admin.apiToken;
    config.admin.apiToken = "call-job-replay-test-token";

    try {
      for (const reason of [
        "ambiguous_outbound_outcome",
        "worker_interrupted_requires_review",
        "side_effecting_call_requires_review",
      ]) {
        __testables.setDbForTests({
          async replayCallJobDlqEntry() {
            return { status: "requires_review", deadLetterReason: reason };
          },
        });
        const response = await request(app)
          .post("/admin/call-jobs/dlq/42/replay")
          .set("x-admin-token", config.admin.apiToken)
          .send({});
        assert.equal(response.status, 409);
        assert.equal(response.body.dead_letter_reason, reason);
      }
    } finally {
      __testables.setDbForTests(null);
      config.admin.apiToken = previousAdminToken;
    }
  });

  it("serves the redacted DLQ summary only with admin authorization", async () => {
    const previousAdminToken = config.admin.apiToken;
    config.admin.apiToken = "call-job-summary-test-token";
    __testables.setDbForTests({
      async listCallJobDlqSummaries() {
        return [{
          id: 12,
          job_id: 7,
          job_type: "outbound_call",
          attempts: 2,
          dead_letter_reason: "worker_interrupted_requires_review",
          status: "open",
          created_at: "2026-11-22T00:00:00.000Z",
        }];
      },
      async getCallJobDlqEntry() {
        return { payload: JSON.stringify({ idempotency_key: "summary-key", number: "+12015550123" }) };
      },
      async getOutboundCallIdempotency() {
        return { provider: "speko" };
      },
    });

    try {
      const denied = await request(app).get("/admin/call-jobs/dlq/summary?limit=3");
      assert.equal(denied.status, 403);

      const response = await request(app)
        .get("/admin/call-jobs/dlq/summary?status=open&limit=3")
        .set("x-admin-token", config.admin.apiToken);
      assert.equal(response.status, 200);
      assert.equal(response.body.rows.length, 1);
      assert.equal(Object.hasOwn(response.body.rows[0], "provider"), false);
      assert.equal(Object.hasOwn(response.body.rows[0], "payload"), false);
      assert.equal(Object.hasOwn(response.body.rows[0], "last_error"), false);

      const withProvider = await request(app)
        .get("/admin/call-jobs/dlq/summary?status=open&limit=3&provider_details=true")
        .set("x-admin-token", config.admin.apiToken);
      assert.equal(withProvider.body.rows[0].provider, "speko");
      assert.equal(Object.hasOwn(withProvider.body.rows[0], "payload"), false);
    } finally {
      __testables.setDbForTests(null);
      config.admin.apiToken = previousAdminToken;
    }
  });

  it("reconciles an open Speko call DLQ entry without replaying or exposing its payload", async () => {
    const previousAdminToken = config.admin.apiToken;
    config.admin.apiToken = "call-job-reconcile-test-token";
    const key = "speko-dlq-operation-42";
    const expectedCallId = `speko_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
    const lookups = [];
    __testables.setDbForTests({
      async getCallJobDlqEntry(id) {
        assert.equal(id, 42);
        return {
          id: 42,
          job_id: 7,
          job_type: "outbound_call",
          status: "open",
          payload: JSON.stringify({ idempotency_key: key, number: "+12015550123", prompt: "private" }),
        };
      },
      async getOutboundCallIdempotency(foundKey) {
        assert.equal(foundKey, key);
        return { provider: "speko" };
      },
      async logServiceHealth(_service, action, details) {
        lookups.push([action, details]);
      },
    });
    __testables.setSpekoVoiceAdapterForTests({
      async findCallByInternalId(callId) {
        assert.equal(callId, expectedCallId);
        return { sessionId: "session_found", status: "active" };
      },
    });

    try {
      const response = await request(app)
        .post("/admin/call-jobs/dlq/42/reconcile/speko")
        .set("x-admin-token", config.admin.apiToken)
        .send({});
      assert.equal(response.status, 200);
      assert.equal(response.body.outcome, "provider_operation_found");
      assert.equal(response.body.session_id, "session_found");
      assert.equal(response.body.retry_safe, false);
      assert.equal(response.body.requires_operator_review, true);
      assert.doesNotMatch(JSON.stringify(response.body), /12015550123|private|idempotency_key/);
      assert.equal(lookups[0][0], "dlq_speko_reconciled");
    } finally {
      __testables.setDbForTests(null);
      __testables.setSpekoVoiceAdapterForTests(null);
      config.admin.apiToken = previousAdminToken;
    }
  });

  it("keeps a missing provider result uncertain and blocks non-Speko entries", async () => {
    const previousAdminToken = config.admin.apiToken;
    config.admin.apiToken = "call-job-reconcile-negative-token";
    let sessionResult = null;
    __testables.setDbForTests({
      async getCallJobDlqEntry() {
        return { id: 43, job_id: 8, job_type: "callback_call", status: "open", payload: JSON.stringify({ idempotency_key: "key-43" }) };
      },
      async getOutboundCallIdempotency() {
        return { provider: "speko" };
      },
    });
    __testables.setSpekoVoiceAdapterForTests({ async findCallByInternalId() { return sessionResult; } });
    try {
      const missing = await request(app)
        .post("/admin/call-jobs/dlq/43/reconcile/speko")
        .set("x-admin-token", config.admin.apiToken)
        .send({});
      assert.equal(missing.status, 200);
      assert.equal(missing.body.outcome, "not_found_still_uncertain");
      assert.equal(missing.body.retry_safe, false);

      sessionResult = { sessionId: "should-not-be-used", status: "active" };
      __testables.setDbForTests({
        async getCallJobDlqEntry() {
          return { id: 43, job_id: 8, job_type: "callback_call", status: "open", payload: JSON.stringify({ idempotency_key: "key-43" }) };
        },
        async getOutboundCallIdempotency() { return { provider: "twilio" }; },
      });
      const nonSpeko = await request(app)
        .post("/admin/call-jobs/dlq/43/reconcile/speko")
        .set("x-admin-token", config.admin.apiToken)
        .send({});
      assert.equal(nonSpeko.status, 409);
    } finally {
      __testables.setDbForTests(null);
      __testables.setSpekoVoiceAdapterForTests(null);
      config.admin.apiToken = previousAdminToken;
    }
  });
});
