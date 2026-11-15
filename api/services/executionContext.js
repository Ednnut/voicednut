const crypto = require("crypto");

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const EXECUTION_STATUSES = Object.freeze([
  "created", "validating", "awaiting_approval", "approved", "ready", "dispatching",
  "accepted", "running", "reconciling", "processing", "completed", "failed",
  "canceled", "paused", "requires_attention",
]);
const TERMINAL_EXECUTION_STATUSES = new Set(["completed", "failed", "canceled"]);
const VALID_TRANSITIONS = Object.freeze({
  created: new Set(["validating", "dispatching", "failed", "canceled"]),
  validating: new Set(["awaiting_approval", "approved", "ready", "failed", "canceled", "requires_attention"]),
  awaiting_approval: new Set(["approved", "canceled", "requires_attention"]),
  approved: new Set(["ready", "canceled", "requires_attention"]),
  ready: new Set(["dispatching", "canceled", "failed"]),
  dispatching: new Set(["accepted", "failed", "canceled", "requires_attention"]),
  accepted: new Set(["running", "reconciling", "processing", "completed", "failed", "canceled", "requires_attention"]),
  running: new Set(["reconciling", "processing", "completed", "failed", "canceled", "paused", "requires_attention"]),
  reconciling: new Set(["running", "processing", "completed", "failed", "requires_attention"]),
  processing: new Set(["completed", "failed", "requires_attention"]),
  paused: new Set(["running", "canceled", "requires_attention"]),
  requires_attention: new Set(["reconciling", "processing", "completed", "failed", "canceled"]),
  completed: new Set(),
  failed: new Set(),
  canceled: new Set(),
});

function safeReference(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  return SAFE_REFERENCE.test(normalized) ? normalized : null;
}

function createExecutionContext(input = {}) {
  const now = input.created_at && Number.isFinite(Date.parse(input.created_at))
    ? new Date(input.created_at).toISOString()
    : new Date().toISOString();
  const callId = safeReference(input.internal_call_id || input.call_id);
  const requestId = safeReference(input.request_id);
  const executionId = safeReference(input.internal_execution_id) || `exec_${crypto.randomUUID()}`;
  const rawIdempotencyReference = safeReference(input.idempotency_reference);
  const idempotencyReference = rawIdempotencyReference
    ? /^sha256:[a-f0-9]{64}$/.test(rawIdempotencyReference)
      ? rawIdempotencyReference
      : `sha256:${crypto.createHash("sha256").update(rawIdempotencyReference).digest("hex")}`
    : null;
  const status = EXECUTION_STATUSES.includes(input.status)
    ? input.status
    : "created";
  const stage = safeReference(input.current_stage) || "created";

  return {
    internal_execution_id: executionId,
    request_id: requestId,
    internal_call_id: callId,
    organization_id: safeReference(input.organization_id),
    business_id: safeReference(input.business_id),
    actor_id: safeReference(input.actor_id),
    agent_id: safeReference(input.agent_id),
    agent_version: Number.isSafeInteger(Number(input.agent_version)) && Number(input.agent_version) > 0
      ? Number(input.agent_version)
      : null,
    provider: safeReference(input.provider)?.toLowerCase() || null,
    provider_call_id: safeReference(input.provider_call_id),
    workflow_id: safeReference(input.workflow_id),
    campaign_id: safeReference(input.campaign_id),
    execution_type: safeReference(input.execution_type) || "call",
    status,
    current_stage: stage,
    created_at: now,
    updated_at: input.updated_at && Number.isFinite(Date.parse(input.updated_at))
      ? new Date(input.updated_at).toISOString()
      : now,
    error_classification: safeReference(input.error_classification),
    idempotency_reference: idempotencyReference,
  };
}

function transitionExecutionContext(currentContext, nextStatus, updates = {}) {
  const current = createExecutionContext(currentContext || {});
  if (!EXECUTION_STATUSES.includes(nextStatus)) {
    throw Object.assign(new Error("Execution status is invalid"), { code: "execution_status_invalid" });
  }
  if (current.status !== nextStatus && !VALID_TRANSITIONS[current.status]?.has(nextStatus)) {
    throw Object.assign(new Error(`Execution cannot transition from ${current.status} to ${nextStatus}`), {
      code: "execution_transition_invalid",
      from: current.status,
      to: nextStatus,
      terminal: TERMINAL_EXECUTION_STATUSES.has(current.status),
    });
  }
  return createExecutionContext({
    ...current,
    ...updates,
    internal_execution_id: current.internal_execution_id,
    status: nextStatus,
    created_at: current.created_at,
    updated_at: updates.updated_at || new Date().toISOString(),
  });
}

function classifyExecutionFailure(error = {}) {
  const submissionState = String(error.providerSubmissionState || error.submissionState || "unknown")
    .trim()
    .toLowerCase();
  if (["unknown", "accepted"].includes(submissionState)) {
    return { classification: "ambiguous", retryable: false, requires_reconciliation: true };
  }
  if (["not_submitted", "rejected"].includes(submissionState) && error.retryable === true) {
    return { classification: "retryable", retryable: true, requires_reconciliation: false };
  }
  if (["not_submitted", "rejected"].includes(submissionState)) {
    return { classification: "non_retryable", retryable: false, requires_reconciliation: false };
  }
  return { classification: "ambiguous", retryable: false, requires_reconciliation: true };
}

function buildExecutionStep(context, input = {}) {
  const stepName = safeReference(input.step_name);
  const status = ["started", "completed", "failed", "skipped", "requires_attention"].includes(input.status)
    ? input.status
    : null;
  if (!stepName || !status) {
    throw Object.assign(new Error("Execution step name and status are required"), { code: "execution_step_invalid" });
  }
  const startedAt = Number.isFinite(Date.parse(input.started_at))
    ? new Date(input.started_at).toISOString()
    : status === "started"
      ? new Date().toISOString()
      : null;
  const completedAt = status === "started"
    ? null
    : Number.isFinite(Date.parse(input.completed_at))
      ? new Date(input.completed_at).toISOString()
      : new Date().toISOString();
  const safeResult = ["accepted", "rejected", "pending", "not_applicable", "unknown"].includes(input.result)
    ? input.result
    : null;
  const errorClassification = ["retryable", "non_retryable", "ambiguous"].includes(input.error_classification)
    ? input.error_classification
    : null;
  return {
    execution_id: safeReference(context?.internal_execution_id),
    correlation_id: safeReference(context?.request_id),
    call_id: safeReference(context?.internal_call_id),
    step_name: stepName,
    status,
    started_at: startedAt,
    completed_at: completedAt,
    result: safeResult,
    error_classification: errorClassification,
    retry_count: Number.isSafeInteger(input.retry_count) && input.retry_count >= 0
      ? Math.min(input.retry_count, 1000)
      : 0,
    related_entity: safeReference(input.related_entity),
  };
}

module.exports = {
  createExecutionContext,
  transitionExecutionContext,
  classifyExecutionFailure,
  buildExecutionStep,
  EXECUTION_STATUSES,
  TERMINAL_EXECUTION_STATUSES,
  safeExecutionReference: safeReference,
};
