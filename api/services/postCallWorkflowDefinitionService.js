const WORKFLOW_SCHEMA_VERSION = 1;
const MAX_STEPS = 50;
const MAX_DEFINITION_BYTES = 64 * 1024;
const MAX_TOTAL_WAIT_SECONDS = 30 * 24 * 60 * 60;
const SUPPORTED_ACTIONS = new Set(["send_email", "crm_sync", "create_ticket"]);
const ACTION_CONFIG_KEYS = Object.freeze({
  send_email: new Set([
    "to", "from", "provider", "subject", "text", "html", "script_id", "template_id",
    "select_template", "template_context", "variables", "metadata", "is_marketing",
  ]),
  crm_sync: new Set(["provider", "metadata"]),
  create_ticket: new Set(["provider", "contact_id", "summary", "metadata"]),
});
const SENSITIVE_KEY_PATTERN = /(?:secret|password|credential|token|api[_-]?key|authorization|private[_-]?key)/i;
const ROOT_KEYS = new Set([
  "schema_version",
  "workflow_id",
  "name",
  "trigger_event",
  "start_step_id",
  "steps",
]);

function fail(message, code = "validation_error") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unsupported field: ${key}`);
  }
}

function assertSafeData(value, depth = 0) {
  if (depth > 8) fail("Workflow definition nesting exceeds the supported limit");
  if (Array.isArray(value)) {
    if (value.length > 100) fail("Workflow definition contains too many values");
    value.forEach((entry) => assertSafeData(entry, depth + 1));
    return;
  }
  if (!isObject(value)) {
    if (typeof value === "string" && value.length > 8000) fail("Workflow text values must be 8000 characters or fewer");
    if (typeof value === "number" && !Number.isFinite(value)) fail("Workflow numbers must be finite");
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) fail("Workflow definitions cannot contain credential or token fields");
    assertSafeData(entry, depth + 1);
  }
}

function validateBranchCondition(condition, depth = 0) {
  if (depth > 8 || !isObject(condition)) fail("Branch conditions must be objects nested no more than 8 levels");
  const keys = Object.keys(condition);
  if (keys.length === 1 && ["all", "any"].includes(keys[0])) {
    const clauses = condition[keys[0]];
    if (!Array.isArray(clauses) || clauses.length < 1 || clauses.length > 20) {
      fail(`Branch condition ${keys[0]} must contain between 1 and 20 clauses`);
    }
    clauses.forEach((clause) => validateBranchCondition(clause, depth + 1));
    return;
  }
  const operators = ["exists", "equals", "in", "includes"];
  const operatorKeys = keys.filter((key) => operators.includes(key));
  if (keys.length !== 2 || !keys.includes("field") || operatorKeys.length !== 1) {
    fail("Branch condition leaves must contain a field and exactly one supported operator");
  }
  const field = String(condition.field || "");
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(field)) fail("Branch condition field path is invalid");
  const operator = operatorKeys[0];
  const value = condition[operator];
  if (operator === "exists" && typeof value !== "boolean") fail("Branch condition exists must be boolean");
  if (operator === "includes" && (typeof value !== "string" || value.length > 256)) {
    fail("Branch condition includes must be a string of 256 characters or fewer");
  }
  if (operator === "in" && (!Array.isArray(value) || value.length < 1 || value.length > 50 || value.some((item) => !["string", "number", "boolean"].includes(typeof item)))) {
    fail("Branch condition in must contain 1 to 50 scalar values");
  }
  if (operator === "equals" && value !== null && !["string", "number", "boolean"].includes(typeof value)) {
    fail("Branch condition equals must be a scalar value");
  }
}

function normalizeWorkflowDefinition(input = {}) {
  if (!isObject(input)) fail("Workflow definition must be an object");
  assertOnlyKeys(input, ROOT_KEYS, "Workflow definition");
  if (input.schema_version !== WORKFLOW_SCHEMA_VERSION) {
    fail(`Workflow schema_version must be ${WORKFLOW_SCHEMA_VERSION}`);
  }
  const workflowId = String(input.workflow_id || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(workflowId)) fail("workflow_id is invalid");
  const name = String(input.name || "").trim();
  if (!name || name.length > 160) fail("Workflow name is required and must be 160 characters or fewer");
  const triggerEvent = String(input.trigger_event || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!/^[a-z][a-z0-9_.]{0,79}$/.test(triggerEvent)) fail("trigger_event is invalid");
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > MAX_STEPS) {
    fail(`Workflow steps must contain between 1 and ${MAX_STEPS} entries`);
  }

  const steps = input.steps.map((step) => {
    if (!isObject(step)) fail("Each workflow step must be an object");
    const type = String(step.type || "").trim().toLowerCase();
    const common = new Set(["id", "type"]);
    const typeKeys = {
      action: ["action_type", "config", "next_step_id"],
      approval: ["next_step_id"],
      branch: ["condition", "true_step_id", "false_step_id"],
      wait: ["seconds", "next_step_id"],
      end: [],
    }[type];
    if (!typeKeys) fail(`Unsupported workflow step type: ${type || "unknown"}`);
    assertOnlyKeys(step, new Set([...common, ...typeKeys]), `Workflow step ${step.id || "unknown"}`);
    const id = String(step.id || "").trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id)) fail("Workflow step id is invalid");
    const normalized = { id, type };
    if (type === "action") {
      const actionType = String(step.action_type || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (!SUPPORTED_ACTIONS.has(actionType)) fail(`Unsupported workflow action: ${actionType || "unknown"}`);
      if (step.config !== undefined && !isObject(step.config)) fail(`Action step ${id} config must be an object`);
      const config = step.config || {};
      if (Object.keys(config).some((key) => SENSITIVE_KEY_PATTERN.test(key))) {
        fail("Workflow definitions cannot contain credential or token fields");
      }
      assertOnlyKeys(config, ACTION_CONFIG_KEYS[actionType], `Action step ${id} config`);
      normalized.action_type = actionType;
      normalized.config = config;
      normalized.next_step_id = String(step.next_step_id || "").trim();
    } else if (type === "approval") {
      normalized.next_step_id = String(step.next_step_id || "").trim();
    } else if (type === "branch") {
      validateBranchCondition(step.condition);
      normalized.condition = step.condition;
      normalized.true_step_id = String(step.true_step_id || "").trim();
      normalized.false_step_id = String(step.false_step_id || "").trim();
    } else if (type === "wait") {
      const seconds = step.seconds;
      if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_TOTAL_WAIT_SECONDS) {
        fail(`Wait step ${id} must be between 1 second and 30 days`);
      }
      normalized.seconds = seconds;
      normalized.next_step_id = String(step.next_step_id || "").trim();
    }
    return normalized;
  });

  const ids = new Set();
  steps.forEach((step) => {
    if (ids.has(step.id)) fail(`Duplicate workflow step id: ${step.id}`);
    ids.add(step.id);
  });
  const startStepId = String(input.start_step_id || "").trim();
  if (!ids.has(startStepId)) fail("start_step_id must reference a workflow step");
  let totalWait = 0;
  const edges = new Map();
  for (const step of steps) {
    let targets = [];
    if (["action", "approval", "wait"].includes(step.type)) {
      if (!ids.has(step.next_step_id)) fail(`Workflow step ${step.id} must reference a next_step_id`);
      targets = [step.next_step_id];
    } else if (step.type === "branch") {
      if (!ids.has(step.true_step_id) || !ids.has(step.false_step_id)) {
        fail(`Branch step ${step.id} must reference existing true and false steps`);
      }
      targets = [step.true_step_id, step.false_step_id];
    }
    if (step.type === "wait") totalWait += step.seconds;
    edges.set(step.id, targets);
  }
  if (totalWait > MAX_TOTAL_WAIT_SECONDS) fail("Total workflow wait duration cannot exceed 30 days");

  const visited = new Set();
  const active = new Set();
  function visit(stepId) {
    if (active.has(stepId)) fail("Workflow paths cannot contain loops");
    if (visited.has(stepId)) return;
    active.add(stepId);
    for (const target of edges.get(stepId) || []) visit(target);
    active.delete(stepId);
    visited.add(stepId);
  }
  visit(startStepId);
  if (visited.size !== steps.length) fail("Every workflow step must be reachable from start_step_id");

  const definition = {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    workflow_id: workflowId,
    name,
    trigger_event: triggerEvent,
    start_step_id: startStepId,
    steps,
  };
  assertSafeData(definition);
  if (Buffer.byteLength(JSON.stringify(definition), "utf8") > MAX_DEFINITION_BYTES) {
    fail("Workflow definition must be 64 KiB or smaller");
  }
  return definition;
}

class PostCallWorkflowDefinitionService {
  constructor(options = {}) {
    this.db = options.db || null;
  }

  hydrate(row) {
    if (!row) return null;
    let definition = {};
    try {
      definition = JSON.parse(row.definition_json);
    } catch (_) {
      fail("Stored workflow definition is invalid", "service_unavailable");
    }
    return { ...row, definition };
  }

  async createDraft(input, actor = "admin_token") {
    const definition = normalizeWorkflowDefinition(input);
    if (!this.db || typeof this.db.createPostCallWorkflowDefinitionDraft !== "function") {
      fail("Workflow definition persistence is not available", "service_unavailable");
    }
    const row = await this.db.createPostCallWorkflowDefinitionDraft({
      workflow_id: definition.workflow_id,
      name: definition.name,
      trigger_event: definition.trigger_event,
      schema_version: definition.schema_version,
      definition_json: JSON.stringify(definition),
      created_by: actor,
    });
    return this.hydrate(row);
  }

  async listVersions(workflowId, limit = 100) {
    if (!this.db || typeof this.db.listPostCallWorkflowDefinitions !== "function") {
      fail("Workflow definition persistence is not available", "service_unavailable");
    }
    const normalizedId = workflowId ? String(workflowId).trim() : "";
    if (normalizedId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(normalizedId)) fail("workflow_id is invalid");
    const rows = await this.db.listPostCallWorkflowDefinitions({ workflow_id: normalizedId || undefined, limit });
    return rows.map((row) => this.hydrate(row));
  }

  async approveVersion(workflowId, version, actor = "admin_token") {
    const normalizedId = String(workflowId || "").trim();
    const normalizedVersion = Number(version);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(normalizedId)) fail("workflow_id is invalid");
    if (!Number.isSafeInteger(normalizedVersion) || normalizedVersion < 1) fail("workflow version is invalid");
    if (!this.db || typeof this.db.getPostCallWorkflowDefinition !== "function") {
      fail("Workflow definition persistence is not available", "service_unavailable");
    }
    const existing = await this.db.getPostCallWorkflowDefinition(normalizedId, normalizedVersion);
    if (!existing) fail("Workflow definition version was not found", "not_found");
    if (existing.status !== "draft") fail("Only draft workflow versions can be approved", "conflict");
    const changed = await this.db.approvePostCallWorkflowDefinition(normalizedId, normalizedVersion, actor);
    if (!changed) fail("Workflow definition changed before approval; refresh and review it", "conflict");
    return this.hydrate(await this.db.getPostCallWorkflowDefinition(normalizedId, normalizedVersion));
  }
}

module.exports = {
  PostCallWorkflowDefinitionService,
  WORKFLOW_SCHEMA_VERSION,
  normalizeWorkflowDefinition,
};
