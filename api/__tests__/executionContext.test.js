const assert = require("node:assert/strict");
const {
  createExecutionContext,
  transitionExecutionContext,
  classifyExecutionFailure,
  buildExecutionStep,
  TERMINAL_EXECUTION_STATUSES,
} = require("../services/executionContext");

describe("shared execution context", () => {
  it("normalizes correlation references and records the current execution stage", () => {
    const context = createExecutionContext({
      internal_execution_id: "exec_existing-1",
      request_id: "request-1",
      internal_call_id: "call-1",
      business_id: "business-1",
      actor_id: "7001",
      provider: "TWILIO",
      execution_type: "outbound_call",
      status: "accepted",
      current_stage: "provider_accepted",
      provider_call_id: "provider-1",
      idempotency_reference: "sha256:9cc91522f977794471b67ba8a1f4c397a9c92f2c8e5749add985bb0ecfd6d7d4",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    assert.deepEqual(context, {
      internal_execution_id: "exec_existing-1",
      request_id: "request-1",
      internal_call_id: "call-1",
      organization_id: null,
      business_id: "business-1",
      actor_id: "7001",
      agent_id: null,
      agent_version: null,
      provider: "twilio",
      provider_call_id: "provider-1",
      workflow_id: null,
      campaign_id: null,
      execution_type: "outbound_call",
      status: "accepted",
      current_stage: "provider_accepted",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      error_classification: null,
      idempotency_reference: "sha256:9cc91522f977794471b67ba8a1f4c397a9c92f2c8e5749add985bb0ecfd6d7d4",
    });
    const updated = createExecutionContext({ ...context, status: "accepted" });
    assert.equal(updated.idempotency_reference, context.idempotency_reference);
    assert.equal(updated.organization_id, null);
    assert.equal(JSON.stringify(updated).includes("request-key-1"), false);
    const scoped = createExecutionContext({ organization_id: "org-1", business_id: "business-1" });
    assert.equal(scoped.organization_id, "org-1");
    assert.equal(scoped.business_id, "business-1");
  });

  it("rejects malformed references and unknown states without failing call creation", () => {
    const context = createExecutionContext({
      request_id: "bad request id",
      internal_call_id: "../private",
      actor_id: "7001",
      status: "finished",
      current_stage: "a stage with spaces",
    });

    assert.equal(context.request_id, null);
    assert.equal(context.internal_call_id, null);
    assert.equal(context.actor_id, "7001");
    assert.equal(context.status, "created");
    assert.equal(context.current_stage, "created");
    assert.match(context.internal_execution_id, /^exec_[a-f0-9-]{36}$/);
  });

  it("enforces valid execution transitions and identifies terminal states", () => {
    let context = createExecutionContext({ status: "created", execution_type: "outbound_call" });
    context = transitionExecutionContext(context, "dispatching", { current_stage: "provider_submission" });
    context = transitionExecutionContext(context, "accepted", { current_stage: "provider_accepted" });
    context = transitionExecutionContext(context, "requires_attention", {
      current_stage: "reconciliation_required",
      error_classification: "provider_timeout",
    });
    context = transitionExecutionContext(context, "reconciling");
    context = transitionExecutionContext(context, "completed");

    assert.equal(context.status, "completed");
    assert.equal(TERMINAL_EXECUTION_STATUSES.has(context.status), true);
    assert.throws(
      () => transitionExecutionContext(context, "running"),
      (error) => error.code === "execution_transition_invalid" && error.terminal === true,
    );
    assert.throws(
      () => transitionExecutionContext(createExecutionContext({ status: "dispatching" }), "completed"),
      (error) => error.code === "execution_transition_invalid" && error.from === "dispatching",
    );
  });

  it("classifies retryable, non-retryable, and ambiguous provider failures", () => {
    assert.deepEqual(classifyExecutionFailure({ submissionState: "not_submitted", retryable: true }), {
      classification: "retryable",
      retryable: true,
      requires_reconciliation: false,
    });
    assert.equal(classifyExecutionFailure({ submissionState: "rejected" }).classification, "non_retryable");
    assert.deepEqual(classifyExecutionFailure({ providerSubmissionState: "unknown", retryable: true }), {
      classification: "ambiguous",
      retryable: false,
      requires_reconciliation: true,
    });
    assert.equal(classifyExecutionFailure({ providerSubmissionState: "accepted" }).requires_reconciliation, true);
  });

  it("builds minimized execution step records with bounded retry and safe references", () => {
    const context = createExecutionContext({ request_id: "request-1", internal_call_id: "call-1" });
    const step = buildExecutionStep(context, {
      step_name: "provider_dispatch",
      status: "requires_attention",
      result: "unknown",
      error_classification: "ambiguous",
      retry_count: 3,
      related_entity: "provider-call-1",
    });
    assert.equal(step.execution_id, context.internal_execution_id);
    assert.equal(step.correlation_id, "request-1");
    assert.equal(step.status, "requires_attention");
    assert.equal(step.error_classification, "ambiguous");
    assert.equal(step.retry_count, 3);
    assert.equal(step.started_at, null);
    assert.ok(step.completed_at);
    assert.equal(Object.hasOwn(step, "transcript"), false);
    assert.throws(() => buildExecutionStep(context, { step_name: "bad name", status: "completed" }), { code: "execution_step_invalid" });
  });
});
