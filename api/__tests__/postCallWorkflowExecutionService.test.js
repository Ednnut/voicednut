const assert = require("node:assert/strict");
const { PostCallWorkflowExecutionService, minimizePayload } = require("../services/postCallWorkflowExecutionService");
const { PostCallWorkflowDefinitionService } = require("../services/postCallWorkflowDefinitionService");

function makeDefinition(steps, startStepId = steps[0].id, triggerEvent = "post_call_completed") {
  return {
    schema_version: 1,
    workflow_id: "workflow_test",
    name: "Test workflow",
    trigger_event: triggerEvent,
    start_step_id: startStepId,
    steps,
  };
}

function createHarness(options = {}) {
  const definition = makeDefinition(options.steps || [{ id: "done", type: "end" }], undefined, options.triggerEvent);
  const workflowRow = {
    workflow_id: definition.workflow_id,
    version: 1,
    status: "approved",
    trigger_event: definition.trigger_event,
    definition_json: JSON.stringify(definition),
  };
  const runs = new Map();
  const steps = new Map();
  const db = {
    async listApprovedPostCallWorkflowDefinitions() { return [workflowRow]; },
    async createPostCallWorkflowRun(input) {
      const prior = [...runs.values()].find((run) => run.idempotency_key === input.idempotency_key);
      if (prior) return { row: prior, created: false };
      const row = { ...input, status: "queued", runner_id: null, lease_expires_at: null };
      runs.set(row.run_id, row);
      return { row, created: true };
    },
    async getPostCallWorkflowDefinition() { return workflowRow; },
    async getPostCallWorkflowRun(runId) { return runs.get(runId) || null; },
    async listPostCallWorkflowRuns() { return [...runs.values()]; },
    async listPostCallWorkflowStepRuns(runId) { return [...steps.values()].filter((step) => step.run_id === runId); },
    async claimNextPostCallWorkflowRun(runnerId) {
      const row = [...runs.values()].find((run) => run.status === "queued" || run.status === "waiting");
      if (!row) return null;
      row.status = "running";
      row.runner_id = runnerId;
      row.lease_expires_at = "2099-01-01 00:00:00";
      return row;
    },
    async heartbeatPostCallWorkflowRun() { return 1; },
    async recoverStalePostCallWorkflowRuns() { return 0; },
    async startPostCallWorkflowStep(input) {
      const key = `${input.run_id}:${input.step_id}`;
      if (steps.has(key)) return false;
      steps.set(key, { ...input, status: input.status || "running" });
      return true;
    },
    async finishPostCallWorkflowStep(runId, stepId, patch) {
      Object.assign(steps.get(`${runId}:${stepId}`), patch);
      return 1;
    },
    async updatePostCallWorkflowRun(runId, patch) {
      Object.assign(runs.get(runId), patch);
      return 1;
    },
    async approvePostCallWorkflowRunStep(runId, stepId, actor, nextStepId) {
      const audit = steps.get(`${runId}:${stepId}`);
      const run = runs.get(runId);
      if (!audit || audit.status !== "waiting_approval" || run.status !== "waiting_approval") return 0;
      Object.assign(audit, { status: "approved", approved_by: actor });
      Object.assign(run, { status: "queued", current_step_id: nextStepId });
      return 1;
    },
    async cancelPostCallWorkflowRun(runId, actor) {
      const run = runs.get(runId);
      if (!run || !["queued", "waiting", "waiting_approval"].includes(run.status)) return 0;
      Object.assign(run, { status: "canceled", canceled_by: actor });
      return 1;
    },
  };
  const actionCalls = [];
  const automationService = {
    async executeAction(action, payload, context, runId, stepId, idempotencyPrefix) {
      actionCalls.push({ action, payload, context, runId, stepId, idempotencyPrefix });
      if (options.hangAction) return new Promise(() => {});
      if (options.actionError) throw Object.assign(new Error("private provider detail"), { code: "provider_timeout" });
      return { status: "ok", email: "private@example.com" };
    },
  };
  const service = new PostCallWorkflowExecutionService({
    db,
    definitionService: new PostCallWorkflowDefinitionService({ db }),
    automationService,
    enabled: true,
    actionTimeoutMs: options.actionTimeoutMs,
    logger: { error() {} },
  });
  return { service, db, runs, steps, actionCalls, definition };
}

describe("PostCallWorkflowExecutionService", () => {
  it("queues approved definitions idempotently and strips private content and credentials from stored payloads", async () => {
    const { service, runs } = createHarness();
    const payload = {
      trigger_event: "post-call.completed",
      call_sid: "call_123",
      summary: "Safe summary",
      transcript: [{ text: "private transcript" }],
      api_key: "private credential",
      customer: { email: "person@example.com", token: "private token" },
    };
    const first = await service.trigger(payload);
    const second = await service.trigger(payload);
    assert.equal(first.matched, 1);
    assert.equal(first.runs[0].deduped, false);
    assert.equal(second.runs[0].deduped, true);
    assert.equal(runs.size, 1);
    assert.equal([...runs.values()][0].trigger_reference, "call_123");
    const stored = [...runs.values()][0].payload_json;
    assert.equal(stored.includes("private transcript"), false);
    assert.equal(stored.includes("private credential"), false);
    assert.equal(stored.includes("private token"), false);
  });

  it("returns workflow run details without stored trigger payloads", async () => {
    const { service, runs } = createHarness();
    const created = await service.trigger({
      trigger_event: "post_call_completed",
      idempotency_key: "safe-run-detail",
      call_sid: "call_safe_detail",
      transcript: [{ text: "private transcript" }],
    });
    const runId = created.runs[0].run_id;
    assert.ok(runs.get(runId).payload_json);

    const run = await service.getRun(runId);
    assert.equal(run.payload_json, undefined);
    assert.equal(JSON.stringify(run).includes("private transcript"), false);
    assert.equal(JSON.stringify(run).includes("payload_json"), false);
  });

  it("routes business call-completion events only to definitions for the same business", async () => {
    const definition = makeDefinition([{ id: "done", type: "end" }]);
    definition.business_id = "biz-42";
    const row = {
      workflow_id: definition.workflow_id,
      version: 1,
      business_id: "biz-42",
      status: "approved",
      definition_json: JSON.stringify(definition),
    };
    const calls = [];
    const service = new PostCallWorkflowExecutionService({
      enabled: true,
      db: {
        async listApprovedPostCallWorkflowDefinitions(...args) { calls.push(["definitions", ...args]); return [row]; },
        async createPostCallWorkflowRun(run) { calls.push(["run", run]); return { row: { ...run, status: "queued" }, created: true }; },
      },
    });
    service.drain = async () => ({ processed: 0 });
    const result = await service.trigger({
      trigger_event: "post_call_completed",
      business_id: "biz-42",
      idempotency_key: "call-completed:call-1",
      call_sid: "call-1",
    });
    assert.equal(result.matched, 1);
    assert.deepEqual(calls[0], ["definitions", "post_call_completed", "biz-42"]);
    assert.equal(calls[1][1].business_id, "biz-42");
  });

  it("processes persisted workflow-event jobs with pinned definitions and idempotent run creation", async () => {
    const definition = makeDefinition([{ id: "done", type: "end" }]);
    definition.business_id = "biz-42";
    const workflowRow = {
      workflow_id: definition.workflow_id,
      version: 1,
      business_id: "biz-42",
      status: "approved",
      trigger_event: "post_call_completed",
      definition_json: JSON.stringify(definition),
    };
    const event = {
      event_id: "event_123",
      event_key: "event-key",
      business_id: "biz-42",
      trigger_event: "post_call_completed",
      definition_versions_json: JSON.stringify([{ workflow_id: definition.workflow_id, version: 1 }]),
      payload_json: JSON.stringify({
        trigger_event: "post_call_completed",
        business_id: "biz-42",
        idempotency_key: "call-event-1",
        call_sid: "call-1",
        transcript: "must not persist",
      }),
      status: "pending",
    };
    const storedRuns = new Map();
    let eventCompleted = false;
    let eventReset = false;
    const service = new PostCallWorkflowExecutionService({
      enabled: true,
      db: {
        async getPostCallWorkflowEvent() { return event; },
        async claimPostCallWorkflowEvent() { return eventCompleted ? 0 : 1; },
        async getPostCallWorkflowDefinition(workflowId, version, businessId) {
          assert.deepEqual([workflowId, version, businessId], [definition.workflow_id, 1, "biz-42"]);
          return workflowRow;
        },
        async createPostCallWorkflowRun(run) {
          const previous = storedRuns.get(run.idempotency_key);
          if (previous) return { row: previous, created: false };
          const row = { ...run, status: "queued" };
          storedRuns.set(run.idempotency_key, row);
          return { row, created: true };
        },
        async completePostCallWorkflowEvent() { eventCompleted = true; return 1; },
        async resetPostCallWorkflowEvent() { eventReset = true; },
      },
    });
    service.drain = async () => ({ processed: 0 });

    const result = await service.processEvent("event_123");
    assert.equal(result.status, "completed");
    assert.equal(result.runs.length, 1);
    assert.equal([...storedRuns.values()][0].business_id, "biz-42");
    assert.equal([...storedRuns.values()][0].payload_json.includes("must not persist"), false);
    assert.equal(eventCompleted, true);
    assert.equal(eventReset, false);
  });

  it("handles legacy workflow-resume jobs by waking the current durable runner", async () => {
    const { service, db, runs } = createHarness();
    const row = {
      run_id: "run_resume",
      workflow_id: "workflow_test",
      workflow_version: 1,
      status: "queued",
      current_step_id: "done",
      payload_json: "{}",
    };
    runs.set(row.run_id, row);
    let drains = 0;
    service.drain = async () => { drains += 1; return { processed: 1 }; };
    const result = await service.resumeRun(row.run_id);
    assert.equal(drains, 1);
    assert.equal(result.run_id, row.run_id);
    assert.deepEqual(await service.resumeRun("missing").catch((error) => error.code), "not_found");
    assert.equal(await db.listPostCallWorkflowStepRuns(row.run_id).then((steps) => steps.length), 0);
  });

  it("uses business scope and stable event idempotency for result-ready workflow runs", async () => {
    const definition = makeDefinition([{ id: "done", type: "end" }], undefined, "call_e_result_ready");
    definition.business_id = "biz-42";
    const row = { workflow_id: definition.workflow_id, version: 2, business_id: "biz-42", status: "approved", definition_json: JSON.stringify(definition) };
    const runs = [];
    let scopeArgs;
    const service = new PostCallWorkflowExecutionService({
      enabled: true,
      db: {
        async listApprovedPostCallWorkflowDefinitions(...args) { scopeArgs = args; return [row]; },
        async createPostCallWorkflowRun(input) { runs.push(input); return { row: input, created: true }; },
      },
    });
    service.drain = async () => ({ processed: 0 });
    const payload = {
      trigger_event: "call_e_result_ready", idempotency_key: "call_provider_123", business_id: "biz-42",
      local_call_id: "call_e_123e4567-e89b-12d3-a456-426614174000", result_status: "available",
      result: { private: "result data" }, transcript: "private transcript",
    };
    await service.triggerCallEResultReady({ ...payload, trigger_event: undefined }, {
      type: "object", additionalProperties: false, required: [], properties: {},
    }, {});
    assert.deepEqual(scopeArgs, ["call_e_result_ready", "biz-42"]);
    assert.equal(runs[0].business_id, "biz-42");
    assert.equal(runs[0].trigger_reference, payload.local_call_id);
    assert.equal(runs[0].idempotency_key, `workflow:${row.workflow_id}:call_e_result_ready:biz-42:${require("crypto").createHash("sha256").update("call_provider_123").digest("hex")}`);
    assert.equal(runs[0].payload_json.includes("private result"), false);
    assert.equal(runs[0].payload_json.includes("private transcript"), false);
  });

  it("does not query or enqueue result-ready workflows without a valid business scope", async () => {
    let queried = false;
    const service = new PostCallWorkflowExecutionService({
      enabled: true,
      db: { async listApprovedPostCallWorkflowDefinitions() { queried = true; return []; } },
    });
    const result = await service.triggerCallEResultReady({ idempotency_key: "call_provider_123" }, {
      type: "object", additionalProperties: false, required: [], properties: {},
    }, {});
    assert.equal(result.reason, "missing_business_scope");
    assert.equal(queried, false);
  });

  it("stores only fixed enum classifications for the pinned business template", async () => {
    const definition = makeDefinition([
      { id: "route", type: "branch", condition: { field: "business_result_classifications.booking_outcome", equals: "positive" }, true_step_id: "done", false_step_id: "done" },
      { id: "done", type: "end" },
    ], "route", "call_e_result_ready");
    Object.assign(definition, {
      business_id: "biz-42",
      template_id: 19,
      template_version: 3,
      result_classifications: [{ id: "booking_outcome", field: "booking_status", enum_index: 0, label: "positive" }],
    });
    const row = {
      workflow_id: definition.workflow_id,
      version: 2,
      business_id: "biz-42",
      status: "approved",
      definition_json: JSON.stringify(definition),
    };
    const storedRuns = new Map();
    let scopeArgs;
    const service = new PostCallWorkflowExecutionService({
      enabled: true,
      db: {
        async listApprovedPostCallWorkflowDefinitions(...args) { scopeArgs = args; return [row]; },
        async createPostCallWorkflowRun(run) {
          const previous = storedRuns.get(run.idempotency_key);
          if (previous) return { row: previous, created: false };
          storedRuns.set(run.idempotency_key, run);
          return { row: run, created: true };
        },
      },
    });
    service.drain = async () => ({ processed: 0 });
    const payload = {
      idempotency_key: "call_provider_123",
      business_id: "biz-42",
      local_call_id: "call_e_123e4567-e89b-12d3-a456-426614174000",
      template_id: 19,
      template_version: 3,
      execution_status: "completed",
      call_outcome: "completed",
      result_status: "available",
    };
    const schema = {
      type: "object", additionalProperties: false, required: ["booking_status", "private_summary"],
      properties: {
        booking_status: { type: "string", enum: ["yes", "no"] },
        private_summary: { type: "string", enum: ["PERSONAL_RAW_VALUE"] },
      },
    };
    const result = { booking_status: "yes", private_summary: "PERSONAL_RAW_VALUE" };

    const first = await service.triggerCallEResultReady(payload, schema, result);
    const second = await service.triggerCallEResultReady(payload, schema, result);
    assert.deepEqual(scopeArgs, ["call_e_result_ready", "biz-42"]);
    assert.equal(first.matched, 1);
    assert.equal(first.runs[0].deduped, false);
    assert.equal(second.runs[0].deduped, true);
    const [stored] = [...storedRuns.values()];
    const storedPayload = JSON.parse(stored.payload_json);
    assert.deepEqual(storedPayload.business_result_classifications, { booking_outcome: "positive" });
    assert.equal(storedPayload.payload, undefined);
    assert.equal(stored.payload_json.includes("PERSONAL_RAW_VALUE"), false);
    assert.equal(stored.payload_json.includes('"yes"'), false);
    assert.equal(stored.payload_json.includes("result_schema"), false);
    assert.equal(stored.business_id, "biz-42");
  });

  it("matches classification workflows only to their pinned template version and rejects unvalidated generic dispatch", async () => {
    let queued = 0;
    const definition = makeDefinition([{ id: "done", type: "end" }], undefined, "call_e_result_ready");
    Object.assign(definition, { business_id: "biz-42", template_id: 19, template_version: 3 });
    const service = new PostCallWorkflowExecutionService({
      enabled: true,
      db: {
        async listApprovedPostCallWorkflowDefinitions() { return [{ workflow_id: "workflow_test", version: 1, business_id: "biz-42", definition_json: JSON.stringify(definition) }]; },
        async createPostCallWorkflowRun() { queued += 1; return { row: { status: "queued" }, created: true }; },
      },
    });
    service.drain = async () => ({ processed: 0 });
    const schema = { type: "object", additionalProperties: false, required: [], properties: {} };
    const mismatchedTemplate = await service.triggerCallEResultReady({
      idempotency_key: "call_provider_123", business_id: "biz-42", local_call_id: "call_e_123e4567-e89b-12d3-a456-426614174000",
      template_id: 20, template_version: 1,
    }, schema, {});
    assert.equal(mismatchedTemplate.matched, 0);
    assert.equal(queued, 0);
    const bypass = await service.trigger({ trigger_event: "call_e_result_ready", business_id: "biz-42", idempotency_key: "call_provider_123" });
    assert.equal(bypass.reason, "validated_result_required");
    assert.equal(queued, 0);
  });

  it("executes bounded approved actions and records step audit without persisting action results", async () => {
    const { service, runs, steps, actionCalls } = createHarness({ steps: [
      { id: "send", type: "action", action_type: "send_email", config: { subject: "Follow up" }, next_step_id: "done" },
      { id: "done", type: "end" },
    ] });
    const { row } = await service.db.createPostCallWorkflowRun({
      run_id: "run_action", workflow_id: "workflow_test", workflow_version: 1,
      trigger_event: "post_call_completed", idempotency_key: "action:event",
      current_step_id: "send", payload_json: JSON.stringify({ trigger_event: "post_call_completed", call_sid: "call_1" }),
    });
    await service.advanceRun(row);
    assert.equal(actionCalls.length, 1);
    assert.match(actionCalls[0].idempotencyPrefix, /^workflow:workflow_test:1:run_action:send$/);
    assert.equal(runs.get("run_action").status, "queued");
    assert.equal(runs.get("run_action").current_step_id, "done");
    assert.equal(steps.get("run_action:send").status, "completed");
    assert.equal(steps.get("run_action:send").result_json, undefined);
  });

  it("pauses for human approval, resumes after approval, and supports cancellation of a waiting run", async () => {
    const { service, db, runs, steps } = createHarness({ steps: [
      { id: "approve", type: "approval", next_step_id: "done" },
      { id: "done", type: "end" },
    ] });
    const { row } = await db.createPostCallWorkflowRun({
      run_id: "run_approval", workflow_id: "workflow_test", workflow_version: 1,
      trigger_event: "post_call_completed", idempotency_key: "approval:event",
      current_step_id: "approve", payload_json: "{}",
    });
    await service.advanceRun(row);
    assert.equal(runs.get("run_approval").status, "waiting_approval");
    const approved = await service.approveRun("run_approval");
    assert.equal(approved.status, "queued");
    assert.equal(steps.get("run_approval:approve").approved_by, "admin_token");
    await service.advanceRun(runs.get("run_approval"));
    assert.equal(runs.get("run_approval").status, "completed");

    const canceledRun = await db.createPostCallWorkflowRun({
      run_id: "run_cancel", workflow_id: "workflow_test", workflow_version: 1,
      trigger_event: "post_call_completed", idempotency_key: "cancel:event",
      current_step_id: "approve", payload_json: "{}",
    });
    await service.advanceRun(canceledRun.row);
    const canceled = await service.cancelRun("run_cancel");
    assert.equal(canceled.status, "canceled");
  });

  it("persists bounded wait state and resumes at the next step after the due time", async () => {
    const { service, db, runs, steps } = createHarness({ steps: [
      { id: "pause", type: "wait", seconds: 60, next_step_id: "done" },
      { id: "done", type: "end" },
    ] });
    const { row } = await db.createPostCallWorkflowRun({
      run_id: "run_wait", workflow_id: "workflow_test", workflow_version: 1,
      trigger_event: "post_call_completed", idempotency_key: "wait:event",
      current_step_id: "pause", payload_json: "{}",
    });
    await service.advanceRun(row);
    assert.equal(runs.get("run_wait").status, "waiting");
    assert.equal(steps.get("run_wait:pause").status, "waiting");
    assert.ok(runs.get("run_wait").next_run_at);

    runs.get("run_wait").status = "running";
    await service.advanceRun(runs.get("run_wait"));
    assert.equal(runs.get("run_wait").status, "queued");
    assert.equal(runs.get("run_wait").current_step_id, "done");
    assert.equal(steps.get("run_wait:pause").status, "completed");
  });

  it("fails closed to needs_review after an external action error and never logs provider text", async () => {
    const { service, runs, steps, actionCalls } = createHarness({ actionError: true, steps: [
      { id: "send", type: "action", action_type: "send_email", config: { subject: "Follow up" }, next_step_id: "done" },
      { id: "done", type: "end" },
    ] });
    const { row } = await service.db.createPostCallWorkflowRun({
      run_id: "run_failure", workflow_id: "workflow_test", workflow_version: 1,
      trigger_event: "post_call_completed", idempotency_key: "failure:event",
      current_step_id: "send", payload_json: "{}",
    });
    await service.advanceRun(row);
    assert.equal(actionCalls.length, 1);
    assert.equal(runs.get("run_failure").status, "needs_review");
    assert.equal(runs.get("run_failure").error_code, "provider_timeout");
    assert.equal(steps.get("run_failure:send").status, "needs_review");
  });

  it("bounds action execution and requires review instead of retrying an ambiguous timeout", async () => {
    const { service, runs, actionCalls } = createHarness({ hangAction: true, actionTimeoutMs: 5, steps: [
      { id: "send", type: "action", action_type: "send_email", config: { subject: "Follow up" }, next_step_id: "done" },
      { id: "done", type: "end" },
    ] });
    const { row } = await service.db.createPostCallWorkflowRun({
      run_id: "run_timeout", workflow_id: "workflow_test", workflow_version: 1,
      trigger_event: "post_call_completed", idempotency_key: "timeout:event",
      current_step_id: "send", payload_json: "{}",
    });
    await service.advanceRun(row);
    assert.equal(actionCalls.length, 1);
    assert.equal(runs.get("run_timeout").status, "needs_review");
    assert.equal(runs.get("run_timeout").error_code, "workflow_action_timeout");
  });

  it("does not replay an action whose durable step audit already exists", async () => {
    const { service, db, runs, actionCalls } = createHarness({ steps: [
      { id: "send", type: "action", action_type: "send_email", config: { subject: "Follow up" }, next_step_id: "done" },
      { id: "done", type: "end" },
    ] });
    const { row } = await db.createPostCallWorkflowRun({
      run_id: "run_interrupted", workflow_id: "workflow_test", workflow_version: 1,
      trigger_event: "post_call_completed", idempotency_key: "interrupted:event",
      current_step_id: "send", payload_json: "{}",
    });
    await db.startPostCallWorkflowStep({
      run_id: row.run_id, step_id: "send", step_type: "action", action_type: "send_email",
      status: "running", idempotency_key: "workflow:interrupted",
    });
    await service.advanceRun(row);
    assert.equal(actionCalls.length, 0);
    assert.equal(runs.get("run_interrupted").status, "needs_review");
    assert.equal(runs.get("run_interrupted").payload_json, "{}");
  });

  it("does not store oversized payloads and is disabled by default", async () => {
    assert.throws(() => minimizePayload({ context: { huge: "x".repeat(25000) } }), /too large/);
    const { service } = createHarness();
    service.enabled = false;
    const result = await service.trigger({ trigger_event: "post_call_completed", call_sid: "call_1" });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "workflow_execution_disabled");
  });

  it("queues the distinct post-call outcome classification trigger and branches on its neutral label", async () => {
    const { service, runs, steps } = createHarness({
      triggerEvent: "post_call_outcome_classified",
      steps: [
        {
          id: "classify",
          type: "branch",
          condition: { field: "outcome_classification", equals: "completed" },
          true_step_id: "completed",
          false_step_id: "not_connected",
        },
        { id: "completed", type: "end" },
        { id: "not_connected", type: "end" },
      ],
    });
    const result = await service.trigger({
      trigger_event: "post_call_outcome_classified",
      idempotency_key: "call-outcome-classified:CA321",
      call_sid: "CA321",
      call_outcome: "completed",
      context: { call_outcome: "completed", outcome_classification: "completed" },
      transcript: "private transcript",
    });
    assert.equal(result.matched, 1);
    const run = runs.get(result.runs[0].run_id);
    assert.equal(run.trigger_event, "post_call_outcome_classified");
    assert.equal(run.payload_json.includes("private transcript"), false);
    await service.advanceRun(run);
    assert.equal(runs.get(run.run_id).current_step_id, "completed");
    assert.equal(steps.get(`${run.run_id}:classify`).result_json, JSON.stringify({ matched: true }));
  });
});
