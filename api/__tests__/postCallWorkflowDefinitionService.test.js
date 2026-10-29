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
    assert.equal(definition.trigger_event, "post_call.completed");
    assert.equal(definition.steps.find((step) => step.type === "wait").seconds, 60);
    assert.equal(definition.steps.length, 6);
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

  it("persists immutable draft versions and records approval without enabling execution", async () => {
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
