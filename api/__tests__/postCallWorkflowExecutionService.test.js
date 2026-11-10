const assert = require("node:assert/strict");
<<<<<<< HEAD
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
=======
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite3 = require("sqlite3").verbose();
const Database = require("../db/db");
const { PostCallWorkflowDefinitionService } = require("../services/postCallWorkflowDefinitionService");
const { PostCallWorkflowExecutionService } = require("../services/postCallWorkflowExecutionService");

function definition(id = "workflow_run_test") {
  return {
    schema_version: 1,
    workflow_id: id,
    name: "Workflow execution test",
    trigger_event: "post_call.completed",
    start_step_id: "review",
    steps: [
      { id: "review", type: "approval", next_step_id: "route" },
      { id: "route", type: "branch", condition: { field: "outcome", equals: "completed" }, true_step_id: "email", false_step_id: "done" },
      { id: "email", type: "action", action_type: "send_email", config: { subject: "Follow up" }, next_step_id: "done" },
      { id: "done", type: "end" },
    ],
  };
}

describe("PostCallWorkflowExecutionService", () => {
  let db;
  let dbPath;
  let definitions;
  let calls;
  let service;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `voicednut-workflow-runs-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    definitions = new PostCallWorkflowDefinitionService({ db });
    calls = [];
    service = new PostCallWorkflowExecutionService({
      db,
      definitionService: definitions,
      automationService: { async executeAction(...args) { calls.push(args); return { type: "send_email", status: "ok", message_id: "private-id" }; } },
    });
  });

  afterEach(async () => {
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
  });

  async function approved() {
    const draft = await definitions.createDraft(definition());
    return definitions.approveVersion(draft.workflow_id, draft.version);
  }

  it("starts only approved versions, pauses for human approval, and executes an approved action once", async () => {
    const draft = await definitions.createDraft(definition());
    await assert.rejects(() => service.start({ workflow_id: draft.workflow_id, version: 1, trigger_event: "post_call.completed", idempotency_key: "workflow-start-0001" }), (error) => error.code === "conflict");
    await definitions.approveVersion(draft.workflow_id, 1);
    const run = await service.start({ workflow_id: draft.workflow_id, version: 1, trigger_event: "post_call.completed", idempotency_key: "workflow-start-0001", payload: { outcome: "completed" } });
    assert.equal(run.status, "awaiting_approval");
    assert.equal(run.current_step_id, "review");
    const completed = await service.approveStep(run.run_id, "review", "admin_token");
    assert.equal(completed.status, "completed");
    assert.equal(completed.state.steps.email.status, "completed");
    assert.equal("message_id" in completed.state.steps.email.result, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][5], `workflow:${run.run_id}:email`);
  });

  it("deduplicates the same idempotent request and rejects reusing the key for different input", async () => {
    await approved();
    const input = { workflow_id: "workflow_run_test", version: 1, trigger_event: "post_call.completed", idempotency_key: "workflow-start-0002", payload: { outcome: "missed" } };
    const first = await service.start(input);
    const replay = await service.start(input);
    assert.equal(replay.run_id, first.run_id);
    assert.equal(replay.status, "awaiting_approval");
    await assert.rejects(() => service.start({ ...input, payload: { outcome: "completed" } }), (error) => error.code === "conflict");
    assert.equal(calls.length, 0);
  });

  it("queues one admin-approved retry for a failed email step using its original idempotency key", async () => {
    await approved();
    let attempts = 0;
    service.automationService.executeAction = async (...args) => {
      calls.push(args);
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("temporary email enqueue failure");
        error.code = "timeout";
        throw error;
      }
      return { type: "send_email", status: "ok", deduped: true };
    };
    const run = await service.start({
      workflow_id: "workflow_run_test", version: 1, trigger_event: "post_call.completed",
      idempotency_key: "workflow-email-retry-0001", payload: { outcome: "completed" },
    });
    const failed = await service.approveStep(run.run_id, "review");
    assert.equal(failed.status, "failed");
    assert.equal(failed.state.steps.email.retry_count || 0, 0);

    const queued = await service.retryFailedEmailStep(run.run_id, "email", "admin_token");
    assert.equal(queued.status, "queued");
    assert.equal(queued.state.steps.email.status, "retry_queued");
    assert.equal(queued.state.steps.email.retry_count, 1);
    assert.equal(queued.state.steps.email.retry_requested_by, "admin_token");
    const jobs = await db.listCallJobs({ job_type: "post_call_workflow_resume", limit: 10 });
    assert.equal(jobs.length, 1);
    assert.equal(JSON.parse(jobs[0].payload).run_id, run.run_id);

    const completed = await service.resumeRun(run.run_id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.state.steps.email.retry_count, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][5], `workflow:${run.run_id}:email`);
    assert.equal(calls[1][5], calls[0][5]);
    await assert.rejects(() => service.retryFailedEmailStep(run.run_id, "email"), (error) => error.code === "conflict");
  });

  it("does not permit retrying a CRM action with an ambiguous external result", async () => {
    const value = definition("workflow_crm_retry_test");
    value.start_step_id = "crm";
    value.steps = [
      { id: "crm", type: "action", action_type: "crm_sync", config: {}, next_step_id: "done" },
      { id: "done", type: "end" },
    ];
    const draft = await definitions.createDraft(value);
    await definitions.approveVersion(draft.workflow_id, 1);
    service.automationService.executeAction = async () => { throw new Error("ambiguous result"); };
    const run = await service.start({
      workflow_id: draft.workflow_id, version: 1, trigger_event: "post_call.completed",
      idempotency_key: "workflow-crm-retry-0001",
    });
    assert.equal(run.status, "needs_review");
    await assert.rejects(() => service.retryFailedEmailStep(run.run_id, "crm"), (error) => error.code === "conflict");
  });

  it("queues durable workflow events and dispatches only the latest approved version once", async () => {
    const firstDraft = await definitions.createDraft({ ...definition(), trigger_event: "post_call_completed" });
    await definitions.approveVersion(firstDraft.workflow_id, firstDraft.version);
    const secondDraft = await definitions.createDraft({ ...definition(), trigger_event: "post_call_completed", name: "Workflow execution v2" });
    const event = { trigger_event: "post_call_completed", idempotency_key: "call-completed:CA_TEST_123", outcome: "completed" };

    const first = await service.enqueueEvent(event);
    const replay = await service.enqueueEvent({ ...event, context: { delivery_attempt: 2 } });
    assert.equal(first.status, "pending");
    assert.equal(replay.event_id, first.event_id);
    const firstJobs = await db.listCallJobs({ job_type: "post_call_workflow_event", limit: 10 });
    assert.equal(firstJobs.length, 1);
    await new Promise((resolve, reject) => db.db.run(
      "DELETE FROM call_jobs WHERE job_type = 'post_call_workflow_event'",
      (error) => error ? reject(error) : resolve(),
    ));
    await new Promise((resolve, reject) => db.db.run(
      "UPDATE post_call_workflow_events SET last_enqueued_at = '2000-01-01 00:00:00' WHERE event_id = ?",
      [first.event_id],
      (error) => error ? reject(error) : resolve(),
    ));
    assert.equal(await service.reconcilePendingEvents(), 1);
    assert.equal((await db.listCallJobs({ job_type: "post_call_workflow_event", limit: 10 })).length, 1);
    await definitions.approveVersion(secondDraft.workflow_id, secondDraft.version);
    const processed = await service.processEvent(first.event_id);
    assert.equal(processed.status, "completed");
    assert.equal(processed.result.matched, 1);
    assert.equal(processed.result.runs[0].workflow_version, 1);
    const storedEvent = await db.getPostCallWorkflowEvent(first.event_id);
    assert.equal(storedEvent.payload_json, "{}");
    assert.deepEqual(JSON.parse(storedEvent.definition_versions_json), [{ workflow_id: firstDraft.workflow_id, version: 1 }]);
    assert.equal((await service.processEvent(first.event_id)).status, "completed");
    assert.equal(calls.length, 0);

    const nextEvent = await service.enqueueEvent({ ...event, idempotency_key: "call-completed:CA_TEST_456" });
    const afterApproval = await service.processEvent(nextEvent.event_id);
    assert.equal(afterApproval.result.matched, 1);
    assert.equal(afterApproval.result.runs[0].workflow_version, 2);
    assert.equal(calls.length, 0);
  });

  it("isolates automatic triggers and run reads by business scope", async () => {
    const first = await definitions.createDraft(definition("workflow_tenant_a"), "manager-1", "business-a");
    const second = await definitions.createDraft(definition("workflow_tenant_b"), "manager-2", "business-b");
    await definitions.approveVersion(first.workflow_id, first.version, "manager-1", "business-a");
    await definitions.approveVersion(second.workflow_id, second.version, "manager-2", "business-b");

    const event = await service.enqueueEvent({
      trigger_event: "post_call.completed",
      idempotency_key: "tenant-call-event-0001",
      business_id: "business-a",
      outcome: "missed",
    });
    const stored = await db.getPostCallWorkflowEvent(event.event_id);
    assert.equal(stored.business_id, "business-a");
    const processed = await service.processEvent(event.event_id);
    assert.equal(processed.result.matched, 1);
    assert.equal(processed.result.runs[0].workflow_id, first.workflow_id);
    const runId = processed.result.runs[0].run_id;
    assert.equal((await service.getRun(runId, "business-a")).workflow_id, first.workflow_id);
    await assert.rejects(() => service.getRun(runId, "business-b"), (error) => error.code === "not_found");

    const unscoped = await service.enqueueEvent({ trigger_event: "post_call.completed", idempotency_key: "global-call-event-0001" });
    const globalResult = await service.processEvent(unscoped.event_id);
    assert.equal(globalResult.result.matched, 0);
  });

  it("requires a source event idempotency key before dispatching approved workflows", async () => {
    await assert.rejects(() => service.enqueueEvent({ trigger_event: "post_call_completed" }), /idempotency_key is required/);
  });

  it("does not execute an event against a draft definition", async () => {
    await definitions.createDraft({ ...definition(), trigger_event: "post_call_completed" });
    const event = await service.enqueueEvent({ trigger_event: "post_call_completed", idempotency_key: "call-completed:CA_DRAFT_ONLY" });
    const result = await service.processEvent(event.event_id);
    assert.equal(result.status, "completed");
    assert.equal(result.result.matched, 0);
    assert.equal((await db.listPostCallWorkflowRuns(20)).length, 0);
    assert.equal(calls.length, 0);
  });

  it("persists bounded waits as durable resume jobs and permits cancellation before resume", async () => {
    const value = definition("workflow_wait_test");
    value.start_step_id = "wait";
    value.steps = [
      { id: "wait", type: "wait", seconds: 30, next_step_id: "done" },
      { id: "done", type: "end" },
    ];
    const draft = await definitions.createDraft(value);
    await definitions.approveVersion(draft.workflow_id, 1);
    const run = await service.start({ workflow_id: draft.workflow_id, version: 1, trigger_event: "post_call.completed", idempotency_key: "workflow-wait-0001" });
    assert.equal(run.status, "waiting");
    assert.ok(run.next_run_at);
    const jobs = await db.listCallJobs({ job_type: "post_call_workflow_resume", limit: 10 });
    assert.equal(jobs.length, 1);
    assert.equal(JSON.parse(jobs[0].payload).run_id, run.run_id);
    assert.equal((await service.cancelRun(run.run_id)).status, "canceled");
  });

  it("reconciles stale runs and records a terminal operator decision without replaying actions", async () => {
    await approved();
    const run = await service.start({ workflow_id: "workflow_run_test", version: 1, trigger_event: "post_call.completed", idempotency_key: "workflow-start-0003", payload: { outcome: "completed" } });
    await new Promise((resolve, reject) => db.db.run(
      "UPDATE post_call_workflow_runs SET status = 'running', execution_owner = NULL, lease_expires_at = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE run_id = ?",
      [run.run_id],
      (error) => error ? reject(error) : resolve(),
    ));
    assert.equal(await service.reconcileInterruptedRuns(), 1);
    const needsReview = await service.getRun(run.run_id);
    assert.equal(needsReview.status, "needs_review");
    const resolved = await service.reviewRun(run.run_id, "confirm_failed", "admin_token");
    assert.equal(resolved.status, "failed");
    assert.equal(resolved.review_decision, "confirm_failed");
    assert.equal(resolved.reviewed_by, "admin_token");
    assert.equal(resolved.state.operator_review.decision, "confirm_failed");
    await assert.rejects(() => service.reviewRun(run.run_id, "confirm_completed"), (error) => error.code === "conflict");
    assert.equal(calls.length, 0);
  });

  it("keeps runs with a live lease out of startup reconciliation", async () => {
    await approved();
    const run = await service.start({ workflow_id: "workflow_run_test", version: 1, trigger_event: "post_call.completed", idempotency_key: "workflow-start-0004" });
    await new Promise((resolve, reject) => db.db.run(
      "UPDATE post_call_workflow_runs SET status = 'running', execution_owner = 'active-worker', lease_expires_at = ? WHERE run_id = ?",
      [new Date(Date.now() + 60_000).toISOString(), run.run_id],
      (error) => error ? reject(error) : resolve(),
    ));
    assert.equal(await service.reconcileInterruptedRuns(), 0);
    assert.equal((await service.getRun(run.run_id)).status, "running");
  });

  it("adds lease and review columns to a prior run table idempotently without rewriting rows", async () => {
    const legacy = new Database();
    legacy.db = new sqlite3.Database(":memory:");
    try {
      await new Promise((resolve, reject) => legacy.db.run(
        "CREATE TABLE post_call_workflow_runs (run_id TEXT PRIMARY KEY, status TEXT, updated_at DATETIME)",
        (error) => error ? reject(error) : resolve(),
      ));
      await new Promise((resolve, reject) => legacy.db.run(
        "INSERT INTO post_call_workflow_runs (run_id, status, updated_at) VALUES ('legacy-run', 'running', '2000-01-01 00:00:00')",
        (error) => error ? reject(error) : resolve(),
      ));
      await legacy.ensurePostCallWorkflowRunColumns();
      await legacy.ensurePostCallWorkflowRunColumns();
      const columns = await new Promise((resolve, reject) => legacy.db.all(
        "PRAGMA table_info(post_call_workflow_runs)",
        (error, rows) => error ? reject(error) : resolve(rows),
      ));
      const row = await new Promise((resolve, reject) => legacy.db.get(
        "SELECT run_id, status FROM post_call_workflow_runs WHERE run_id = 'legacy-run'",
        (error, value) => error ? reject(error) : resolve(value),
      ));
      assert.ok(columns.some((column) => column.name === "execution_owner"));
      assert.ok(columns.some((column) => column.name === "review_decision"));
      assert.equal(row.status, "running");
    } finally {
      await new Promise((resolve) => legacy.db.close(resolve));
    }
  });

  it("adds nullable workflow and call business scope columns without rewriting legacy rows", async () => {
    const legacy = new Database();
    legacy.db = new sqlite3.Database(":memory:");
    try {
      await new Promise((resolve, reject) => legacy.db.exec(
        "CREATE TABLE post_call_workflow_definitions (workflow_id TEXT, version INTEGER, status TEXT, trigger_event TEXT); CREATE TABLE post_call_workflow_events (event_id TEXT, event_key TEXT, status TEXT, updated_at TEXT); CREATE TABLE calls (call_sid TEXT); INSERT INTO post_call_workflow_definitions VALUES ('legacy', 1, 'approved', 'post_call.completed');",
        (error) => error ? reject(error) : resolve(),
      ));
      await legacy.ensurePostCallWorkflowScopeColumns();
      await legacy.ensurePostCallWorkflowScopeColumns();
      await legacy.ensureCallColumns(["business_id"]);
      const definition = await new Promise((resolve, reject) => legacy.db.get(
        "SELECT workflow_id, status, business_id FROM post_call_workflow_definitions WHERE workflow_id = 'legacy'",
        (error, row) => error ? reject(error) : resolve(row),
      ));
      const columns = await new Promise((resolve, reject) => legacy.db.all(
        "PRAGMA table_info(calls)", (error, rows) => error ? reject(error) : resolve(rows),
      ));
      assert.deepEqual(definition, { workflow_id: "legacy", status: "approved", business_id: null });
      assert.ok(columns.some((column) => column.name === "business_id"));
    } finally {
      await new Promise((resolve) => legacy.db.close(resolve));
    }
>>>>>>> 95a068c (updated)
  });
});
