const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const Database = require("../db/db");
const {
  PostCallWorkflowDefinitionService,
  normalizeWorkflowDefinition,
} = require("../services/postCallWorkflowDefinitionService");

function validDefinition(overrides = {}) {
  return {
    schema_version: 1,
    workflow_id: "post_call_followup",
    name: "Post-call follow-up",
    trigger_event: "post-call.completed",
    start_step_id: "route",
    steps: [
      { id: "route", type: "branch", condition: { field: "outcome", equals: "completed" }, true_step_id: "wait", false_step_id: "stop" },
      { id: "wait", type: "wait", seconds: 60, next_step_id: "approval" },
      { id: "approval", type: "approval", next_step_id: "email" },
      { id: "email", type: "action", action_type: "send_email", config: { subject: "Follow up" }, next_step_id: "done" },
      { id: "stop", type: "end" },
      { id: "done", type: "end" },
    ],
    ...overrides,
  };
}

describe("PostCallWorkflowDefinitionService", () => {
  let db;
  let dbPath;
  let service;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `voicednut-workflow-definitions-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    service = new PostCallWorkflowDefinitionService({ db });
  });

  afterEach(async () => {
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
  });

  it("normalizes versioned workflow definitions with bounded branch, wait, approval, action, and end steps", () => {
    const definition = normalizeWorkflowDefinition(validDefinition());
    assert.equal(definition.schema_version, 1);
    assert.equal(definition.trigger_event, "post_call_completed");
    assert.equal(definition.steps.find((step) => step.type === "wait").seconds, 60);
    assert.equal(definition.steps.length, 6);
    assert.equal(normalizeWorkflowDefinition(definition).trigger_event, "post_call_completed");
  });

  it("binds business-scoped builder drafts to the authenticated business", async () => {
    const draft = await service.createDraft(validDefinition(), "123456", "biz-42");
    assert.equal(draft.business_id, "biz-42");
    assert.equal(draft.definition.business_id, "biz-42");
    assert.throws(() => normalizeWorkflowDefinition(validDefinition({ business_id: "bad business id" })), /business_id is invalid/);
    await assert.rejects(
      service.createDraft(validDefinition({ business_id: "biz-other" }), "123456", "biz-42"),
      (error) => error.code === "conflict",
    );
  });

  it("rejects cycles, unsupported steps, excessive waits, and credential-shaped fields", () => {
    const loop = validDefinition({
      steps: [
        { id: "first", type: "wait", seconds: 1, next_step_id: "second" },
        { id: "second", type: "approval", next_step_id: "first" },
      ],
      start_step_id: "first",
    });
    assert.throws(() => normalizeWorkflowDefinition(loop), /cannot contain loops/);
    assert.throws(() => normalizeWorkflowDefinition(validDefinition({ steps: [{ id: "x", type: "call_now" }] })), /Unsupported workflow step type/);
    const invalidCondition = validDefinition();
    invalidCondition.steps[0].condition = { field: "status", regex: "complete" };
    assert.throws(() => normalizeWorkflowDefinition(invalidCondition), /exactly one supported operator/);
    const invalidActionConfig = validDefinition();
    invalidActionConfig.steps.find((step) => step.type === "action").config.unreviewed_field = true;
    assert.throws(() => normalizeWorkflowDefinition(invalidActionConfig), /contains unsupported field/);
    assert.throws(() => normalizeWorkflowDefinition(validDefinition({
      steps: [{ id: "wait", type: "wait", seconds: 2_592_001, next_step_id: "end" }, { id: "end", type: "end" }],
      start_step_id: "wait",
    })), /between 1 second and 30 days/);
    const secret = validDefinition();
    secret.steps.find((step) => step.type === "action").config.api_key = "must-not-persist";
    assert.throws(() => normalizeWorkflowDefinition(secret), /cannot contain credential or token fields/);
  });

  it("rejects trigger types without an implemented execution adapter", () => {
    const classification = normalizeWorkflowDefinition(validDefinition({
      trigger_event: "post_call_outcome_classified",
    }));
    assert.equal(classification.trigger_event, "post_call_outcome_classified");
    assert.throws(
      () => normalizeWorkflowDefinition(validDefinition({ trigger_event: "payment_succeeded" })),
      /not supported for workflow execution/,
    );
  });

  it("accepts bounded enum-index classifications only on a business and template-version scope", () => {
    const definition = normalizeWorkflowDefinition(validDefinition({
      workflow_id: "result_classifier",
      business_id: "biz-42",
      template_id: 19,
      template_version: 3,
      trigger_event: "call_e_result_ready",
      start_step_id: "finish",
      steps: [{ id: "finish", type: "end" }],
      result_classifications: [
        { id: "booking_outcome", field: "booking_status", enum_index: 1, label: "requires_review" },
      ],
    }));
    assert.deepEqual(definition.result_classifications, [
      { id: "booking_outcome", field: "booking_status", enum_index: 1, label: "requires_review" },
    ]);
    assert.equal(definition.template_id, 19);
    assert.equal(definition.template_version, 3);

    assert.throws(() => normalizeWorkflowDefinition(validDefinition({
      business_id: "biz-42",
      trigger_event: "call_e_result_ready",
      result_classifications: [{ id: "result", field: "status", enum_index: 0, label: "raw-provider-value" }],
    })), /pinned template_id/);
    assert.throws(() => normalizeWorkflowDefinition(validDefinition({
      trigger_event: "post_call_completed",
      template_id: 1,
      template_version: 1,
    })), /only supported for CALL-E result-ready/);
    assert.throws(() => normalizeWorkflowDefinition(validDefinition({
      business_id: "biz-42",
      template_id: 19,
      template_version: 3,
      trigger_event: "call_e_result_ready",
      result_classifications: [
        { id: "result", field: "status", enum_index: 0, label: "positive", equals: "secret raw result" },
      ],
    })), /unsupported field/);
  });

  it('allows only approval-gated create-ticket actions for scoped CALL-E result workflows', () => {
    const base = {
      workflow_id: 'result_followup_ticket', business_id: 'biz-42', template_id: 19, template_version: 3,
      trigger_event: 'call_e_result_ready', start_step_id: 'review',
      steps: [
        { id: 'review', type: 'approval', next_step_id: 'ticket' },
      { id: 'ticket', type: 'action', action_type: 'create_ticket', config: { provider: 'hubspot' }, next_step_id: 'done' },
        { id: 'done', type: 'end' },
      ],
    };
    assert.equal(normalizeWorkflowDefinition(validDefinition(base)).steps[1].action_type, 'create_ticket');
    assert.throws(() => normalizeWorkflowDefinition(validDefinition({ ...base, start_step_id: 'ticket', steps: base.steps.slice(1) })), /per-run human approval/);
    assert.throws(() => normalizeWorkflowDefinition(validDefinition({ ...base, steps: base.steps.map((step) => step.id === 'ticket' ? { ...step, action_type: 'send_email', config: { subject: 'x' } } : step) })), /only the create_ticket action/);
  });

  it('requires an immutable policy approval before listing result actions as executable', async () => {
    const resultDefinition = normalizeWorkflowDefinition(validDefinition({
      workflow_id: 'result_ticket_rule', business_id: 'biz-result', template_id: 7, template_version: 2,
      trigger_event: 'call_e_result_ready', start_step_id: 'review',
      steps: [
        { id: 'review', type: 'approval', next_step_id: 'ticket' },
        { id: 'ticket', type: 'action', action_type: 'create_ticket', config: { provider: 'hubspot' }, next_step_id: 'done' },
        { id: 'done', type: 'end' },
      ],
    }));
    await service.createDraft(resultDefinition, '111');
    assert.equal((await db.listApprovedPostCallWorkflowDefinitions('call_e_result_ready', 'biz-result')).length, 0);
    const approved = await db.approveCallEResultWorkflowActions({
      workflow_id: 'result_ticket_rule', version: 1, business_id: 'biz-result', approved_by: '222', request_hash: 'a'.repeat(64),
    });
    assert.equal(approved.approved, true);
    assert.equal((await db.listApprovedPostCallWorkflowDefinitions('call_e_result_ready', 'biz-result')).length, 1);
    await assert.rejects(new Promise((resolve, reject) => db.db.run(
      'UPDATE call_e_result_workflow_action_approvals SET approved_by = ? WHERE workflow_id = ?', ['333', 'result_ticket_rule'],
      (error) => error ? reject(error) : resolve(),
    )), /append-only/);
  });

  it("lists generic approved workflows and workflow runs only within the requested business", async () => {
    const draft = await service.createDraft(validDefinition({ business_id: "biz-42" }), "123456");
    await service.approveVersion(draft.workflow_id, draft.version, "123456", "biz-42");
    assert.equal((await db.listApprovedPostCallWorkflowDefinitions("post_call_completed", "biz-42")).length, 1);
    assert.equal((await db.listApprovedPostCallWorkflowDefinitions("post_call_completed", "biz-other")).length, 0);
    assert.equal((await db.listApprovedPostCallWorkflowDefinitions("post_call_completed")).length, 0);

    await db.createPostCallWorkflowRun({
      run_id: "run_biz_42",
      workflow_id: draft.workflow_id,
      workflow_version: draft.version,
      business_id: "biz-42",
      trigger_event: "post_call_completed",
      idempotency_key: "workflow-biz-42-run",
      current_step_id: "route",
      payload_json: "{}",
    });
    assert.ok(await db.getPostCallWorkflowRun("run_biz_42", "biz-42"));
    assert.equal(await db.getPostCallWorkflowRun("run_biz_42", "biz-other"), null);
  });

  it("persists immutable draft versions and records approval without starting a run", async () => {
    const first = await service.createDraft(validDefinition(), "admin_token");
    assert.equal(first.version, 1);
    assert.equal(first.status, "draft");
    assert.equal(first.created_by, "admin_token");

    const approved = await service.approveVersion(first.workflow_id, first.version, "admin_token");
    assert.equal(approved.status, "approved");
    assert.equal(approved.approved_by, "admin_token");
    assert.ok(approved.approved_at);
    await assert.rejects(() => service.approveVersion(first.workflow_id, first.version), (error) => error.code === "conflict");

    const second = await service.createDraft({ ...validDefinition(), name: "Post-call follow-up v2" });
    assert.equal(second.version, 2);
    assert.equal(second.status, "draft");
    const versions = await service.listVersions(first.workflow_id);
    assert.deepEqual(versions.map((version) => [version.version, version.status]), [[2, "draft"], [1, "approved"]]);
    assert.equal("execute" in service, false);
  });
});
