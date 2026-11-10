<<<<<<< HEAD
const crypto = require("crypto");
const { buildContext, matchesConditionSpec } = require("./postCallAutomationService");
const { normalizeWorkflowDefinition, SUPPORTED_TRIGGER_EVENTS } = require("./postCallWorkflowDefinitionService");
const { validateCallEResult } = require("../adapters/callETemplateAdapter");

const MAX_PAYLOAD_BYTES = 24 * 1024;
const MAX_STEPS_PER_TICK = 50;
const DEFAULT_POLL_MS = 1500;
const LEASE_SECONDS = 90;
const DEFAULT_ACTION_TIMEOUT_MS = 60_000;
const RUN_STATUSES = new Set([
  "queued", "running", "waiting", "waiting_approval", "completed", "failed", "canceled", "needs_review",
]);
const SENSITIVE_KEY = /(?:secret|password|credential|token|api[_-]?key|authorization|private[_-]?key)/i;
const PRIVATE_CONTENT_KEY = /^(?:result|result_schema|transcript|transcripts|recording|audio|raw_body|provider_payload)$/i;
=======
const { randomUUID, createHash } = require("node:crypto");
const { normalizeWorkflowDefinition, assertSafeData } = require("./postCallWorkflowDefinitionService");
const { matchesConditionSpec } = require("./postCallAutomationService");

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_EMAIL_STEP_RETRIES = 1;
const SAFE_ERROR_CODES = new Set(["validation_error", "service_unavailable", "provider_error", "timeout"]);
>>>>>>> 95a068c (updated)

function fail(message, code = "validation_error") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

<<<<<<< HEAD
function safeErrorCode(error) {
  const code = String(error?.code || "workflow_step_failed").trim().toLowerCase();
  return /^[a-z][a-z0-9_.-]{0,79}$/.test(code) ? code : "workflow_step_failed";
}

function sanitizeValue(value, depth = 0) {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) return value.slice(0, 30).map((entry) => sanitizeValue(entry, depth + 1)).filter((entry) => entry !== undefined);
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key) || PRIVATE_CONTENT_KEY.test(key)) continue;
      const safe = sanitizeValue(entry, depth + 1);
      if (safe !== undefined) output[key] = safe;
    }
    return output;
  }
  if (typeof value === "string") return value.slice(0, 4000);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  return undefined;
}

function minimizePayload(payload = {}) {
  const input = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  let inputBytes;
  try {
    inputBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  } catch (_) {
    fail("Workflow trigger payload must be serializable", "validation_error");
  }
  if (inputBytes > MAX_PAYLOAD_BYTES) fail("Workflow trigger payload is too large", "validation_error");
  const safe = sanitizeValue(input) || {};
  const serialized = JSON.stringify(safe);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    fail("Workflow trigger payload is too large", "validation_error");
  }
  return { safe, serialized };
}

function toSqlDate(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function hydrateRun(row) {
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload_json || "{}"); } catch (_) { /* keep sanitized empty payload */ }
  return { ...row, payload };
}

function normalizeRunId(value) {
  const runId = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(runId)) fail("run_id is invalid");
  return runId;
=======
function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function publicRun(row) {
  if (!row) return null;
  return {
    run_id: row.run_id,
    workflow_id: row.workflow_id,
    workflow_version: row.workflow_version,
    trigger_event: row.trigger_event,
    status: row.status,
    current_step_id: row.current_step_id,
    state: parseJson(row.state_json, { steps: {} }),
    error_code: row.error_code || null,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    next_run_at: row.next_run_at || null,
    completed_at: row.completed_at || null,
    reviewed_by: row.reviewed_by || null,
    review_decision: row.review_decision || null,
    reviewed_at: row.reviewed_at || null,
  };
>>>>>>> 95a068c (updated)
}

class PostCallWorkflowExecutionService {
  constructor(options = {}) {
    this.db = options.db || null;
    this.definitionService = options.definitionService || null;
    this.automationService = options.automationService || null;
<<<<<<< HEAD
    this.enabled = options.enabled === true;
    this.logger = options.logger || console;
    this.pollMs = Math.max(500, Math.min(30000, Number(options.pollMs) || DEFAULT_POLL_MS));
    this.actionTimeoutMs = Math.max(1, Math.min(DEFAULT_ACTION_TIMEOUT_MS, Number(options.actionTimeoutMs) || DEFAULT_ACTION_TIMEOUT_MS));
    this.runnerId = `workflow-worker-${crypto.randomUUID()}`;
    this.timer = null;
    this.busy = false;
  }

  async trigger(payload = {}) {
    if (!this.enabled) return { skipped: true, reason: "workflow_execution_disabled", runs: [] };
    const triggerEvent = String(payload.trigger_event || "").trim().toLowerCase().replace(/[\s.-]+/g, "_");
    if (!SUPPORTED_TRIGGER_EVENTS.has(triggerEvent)) return { skipped: true, reason: "unsupported_trigger", runs: [] };
    if (triggerEvent === "call_e_result_ready") return { skipped: true, reason: "validated_result_required", runs: [] };
    const { safe, serialized } = minimizePayload({ ...payload, trigger_event: triggerEvent });
    const eventKey = String(safe.idempotency_key || safe.call_sid || safe.call?.call_sid || "").trim();
    if (!eventKey) return { skipped: true, reason: "missing_stable_event_id", runs: [] };
    if (!this.db || typeof this.db.listApprovedPostCallWorkflowDefinitions !== "function") {
      fail("Workflow execution persistence is not available", "service_unavailable");
    }
    const businessId = triggerEvent === "call_e_result_ready" ? safe.business_id : null;
    const definitions = await this.db.listApprovedPostCallWorkflowDefinitions(triggerEvent, businessId);
    const runs = [];
    const rawTriggerReference = safe.local_call_id ?? safe.call_sid ?? safe.call?.call_sid;
    const triggerReference = typeof rawTriggerReference === "string"
      && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(rawTriggerReference)
      ? rawTriggerReference
      : null;
    for (const row of definitions) {
      const definition = this.definitionService?.hydrate
        ? this.definitionService.hydrate(row).definition
        : JSON.parse(row.definition_json || "{}");
      const normalized = normalizeWorkflowDefinition(definition);
      const eventHash = crypto.createHash("sha256").update(eventKey).digest("hex");
      const scopeKey = businessId || "global";
      const idempotencyKey = `workflow:${row.workflow_id}:${triggerEvent}:${scopeKey}:${eventHash}`;
      const run = await this.db.createPostCallWorkflowRun({
        run_id: crypto.randomUUID(),
        workflow_id: row.workflow_id,
        workflow_version: Number(row.version),
        business_id: row.business_id || null,
        trigger_event: triggerEvent,
        trigger_reference: triggerReference,
        idempotency_key: idempotencyKey,
        current_step_id: normalized.start_step_id,
        payload_json: serialized,
        expires_at: toSqlDate(new Date(Date.now() + (90 * 24 * 60 * 60 * 1000))),
      });
      runs.push({ run_id: run.row?.run_id || null, status: run.row?.status || null, deduped: !run.created });
    }
    void this.drain().catch((error) => this.logError("workflow_trigger_drain_failed", error));
    return { skipped: false, trigger_event: triggerEvent, matched: definitions.length, runs };
  }

  async triggerCallEResultReady(payload = {}, resultSchema, result) {
    if (!this.enabled) return { skipped: true, reason: "workflow_execution_disabled", runs: [] };
    const businessId = String(payload.business_id || "").trim();
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) {
      return { skipped: true, reason: "missing_business_scope", runs: [] };
    }
    const resultValidation = validateCallEResult(resultSchema, result);
    if (!resultValidation.valid) fail("CALL-E result failed pinned schema validation", "call_e_result_invalid");
    const safeInput = { ...payload, trigger_event: "call_e_result_ready" };
    delete safeInput.result;
    delete safeInput.result_schema;
    delete safeInput.business_result_classifications;
    const { safe } = minimizePayload(safeInput);
    const eventKey = String(safe.idempotency_key || safe.local_call_id || "").trim();
    if (!eventKey) return { skipped: true, reason: "missing_stable_event_id", runs: [] };
    if (!this.db || typeof this.db.listApprovedPostCallWorkflowDefinitions !== "function") {
      fail("Workflow execution persistence is not available", "service_unavailable");
    }
    const definitions = await this.db.listApprovedPostCallWorkflowDefinitions("call_e_result_ready", businessId);
    const runs = [];
    const rawTriggerReference = safe.local_call_id;
    const triggerReference = typeof rawTriggerReference === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(rawTriggerReference) ? rawTriggerReference : null;
    const eventHash = crypto.createHash("sha256").update(eventKey).digest("hex");
    for (const row of definitions) {
      const storedDefinition = this.definitionService?.hydrate
        ? this.definitionService.hydrate(row).definition
        : JSON.parse(row.definition_json || "{}");
      const definition = normalizeWorkflowDefinition(storedDefinition);
      if (row.business_id !== businessId || definition.business_id !== businessId) continue;
      if (definition.template_id !== null &&
          (Number(payload.template_id) !== definition.template_id || Number(payload.template_version) !== definition.template_version)) continue;

      const businessResultClassifications = {};
      for (const rule of definition.result_classifications) {
        const property = resultSchema?.properties?.[rule.field];
        const enumValue = Array.isArray(property?.enum) ? property.enum[rule.enum_index] : undefined;
        businessResultClassifications[rule.id] = enumValue !== undefined && result?.[rule.field] === enumValue
          ? rule.label
          : "unknown";
      }
      const runPayload = {
        ...safe,
        ...(definition.result_classifications.length ? { business_result_classifications: businessResultClassifications } : {}),
      };
      const { serialized } = minimizePayload(runPayload);
      const scopeKey = businessId;
      const idempotencyKey = `workflow:${row.workflow_id}:call_e_result_ready:${scopeKey}:${eventHash}`;
      const run = await this.db.createPostCallWorkflowRun({
        run_id: crypto.randomUUID(),
        workflow_id: row.workflow_id,
        workflow_version: Number(row.version),
        business_id: businessId,
        trigger_event: "call_e_result_ready",
        trigger_reference: triggerReference,
        idempotency_key: idempotencyKey,
        current_step_id: definition.start_step_id,
        payload_json: serialized,
        expires_at: toSqlDate(new Date(Date.now() + (90 * 24 * 60 * 60 * 1000))),
      });
      runs.push({ run_id: run.row?.run_id || null, status: run.row?.status || null, deduped: !run.created });
    }
    if (runs.length) void this.drain().catch((error) => this.logError("workflow_trigger_drain_failed", error));
    return { skipped: false, trigger_event: "call_e_result_ready", matched: runs.length, runs };
  }

  start() {
    if (this.timer || !this.db) return false;
    this.timer = setInterval(() => {
      this.drain().catch((error) => this.logError("workflow_worker_failed", error));
    }, this.enabled ? this.pollMs : 60_000);
    this.timer.unref?.();
    void this.drain().catch((error) => this.logError("workflow_worker_start_failed", error));
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async drain() {
    if (this.busy || !this.db) return { processed: 0 };
    this.busy = true;
    let processed = 0;
    try {
      if (typeof this.db.expirePostCallWorkflowRuns === "function") {
        await this.db.expirePostCallWorkflowRuns();
      }
      await this.db.recoverStalePostCallWorkflowRuns();
      if (!this.enabled) return { processed: 0 };
      for (let index = 0; index < 5; index += 1) {
        const run = await this.db.claimNextPostCallWorkflowRun(this.runnerId, LEASE_SECONDS);
        if (!run) break;
        await this.advanceRun(run);
        processed += 1;
      }
      return { processed };
    } finally {
      this.busy = false;
    }
  }

  async advanceRun(run) {
    const workflowRow = await this.db.getPostCallWorkflowDefinition(run.workflow_id, run.workflow_version);
    if (!workflowRow || workflowRow.status !== "approved") {
      await this.db.updatePostCallWorkflowRun(run.run_id, {
        status: "failed", error_code: "approved_definition_unavailable", completed_at: toSqlDate(new Date()),
        payload_json: "{}", runner_id: null, lease_expires_at: null,
      }, { runner_id: this.runnerId });
      return;
    }
    const definition = normalizeWorkflowDefinition(JSON.parse(workflowRow.definition_json || "{}"));
    const steps = new Map(definition.steps.map((step) => [step.id, step]));
    const payload = hydrateRun(run).payload;
    const context = buildContext(payload);

    try {
      for (let count = 0; count < MAX_STEPS_PER_TICK; count += 1) {
        const step = steps.get(run.current_step_id);
        if (!step) fail("Workflow run cursor is invalid", "workflow_cursor_invalid");
        await this.db.heartbeatPostCallWorkflowRun(run.run_id, this.runnerId, LEASE_SECONDS);

        if (step.type === "end") {
          await this.finishNonActionStep(run.run_id, step, "completed");
          await this.db.updatePostCallWorkflowRun(run.run_id, {
            status: "completed", error_code: null, next_run_at: null, completed_at: toSqlDate(new Date()),
            payload_json: "{}", runner_id: null, lease_expires_at: null,
          }, { runner_id: this.runnerId });
          return;
        }

        if (step.type === "branch") {
          const existing = await this.getStep(run.run_id, step.id);
          if (existing?.status === "completed") {
            await this.markNeedsReview(run.run_id, "branch_step_already_completed");
            return;
          }
          const matched = matchesConditionSpec(context, step.condition);
          const started = await this.startStep(run.run_id, step, null);
          if (!started) { await this.markNeedsReview(run.run_id, "branch_step_state_conflict"); return; }
          await this.db.finishPostCallWorkflowStep(run.run_id, step.id, {
            status: "completed", result_json: JSON.stringify({ matched }),
          });
          run.current_step_id = matched ? step.true_step_id : step.false_step_id;
          await this.queueNextStep(run.run_id, run.current_step_id);
          return;
        }

        if (step.type === "wait") {
          const audit = await this.getStep(run.run_id, step.id);
          if (audit?.status === "waiting") {
            await this.db.finishPostCallWorkflowStep(run.run_id, step.id, { status: "completed" });
            run.current_step_id = step.next_step_id;
            await this.queueNextStep(run.run_id, run.current_step_id);
            return;
          }
          const started = await this.startStep(run.run_id, step, null, "waiting");
          if (!started) { await this.markNeedsReview(run.run_id, "wait_step_state_conflict"); return; }
          const dueAt = toSqlDate(new Date(Date.now() + (step.seconds * 1000)));
          await this.db.updatePostCallWorkflowRun(run.run_id, {
            status: "waiting", next_run_at: dueAt, runner_id: null, lease_expires_at: null,
          }, { runner_id: this.runnerId });
          return;
        }

        if (step.type === "approval") {
          const audit = await this.getStep(run.run_id, step.id);
          if (audit?.status === "approved") {
            run.current_step_id = step.next_step_id;
            await this.queueNextStep(run.run_id, run.current_step_id);
            return;
          }
          if (!audit) await this.startStep(run.run_id, step, null, "waiting_approval");
          await this.db.updatePostCallWorkflowRun(run.run_id, {
            status: "waiting_approval", next_run_at: null, runner_id: null, lease_expires_at: null,
          }, { runner_id: this.runnerId });
          return;
        }

        if (step.type === "action") {
          const action = { ...step.config, type: step.action_type };
          const key = `workflow:${run.workflow_id}:${run.workflow_version}:${run.run_id}:${step.id}`.slice(0, 240);
          const started = await this.startStep(run.run_id, step, key);
          if (!started) { await this.markNeedsReview(run.run_id, "action_step_state_conflict"); return; }
          const heartbeat = setInterval(() => {
            this.db.heartbeatPostCallWorkflowRun(run.run_id, this.runnerId, LEASE_SECONDS)
              .catch((error) => this.logError("workflow_heartbeat_failed", error, run.run_id));
          }, Math.max(10000, Math.floor((LEASE_SECONDS * 1000) / 3)));
          heartbeat.unref?.();
          try {
            if (!this.automationService || typeof this.automationService.executeAction !== "function") {
              fail("Workflow action executor is not available", "service_unavailable");
            }
            let timeoutId;
            await Promise.race([
              Promise.resolve().then(() => this.automationService.executeAction(
                action, payload, context, run.run_id, step.id, key,
              )),
              new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(Object.assign(
                  new Error("Workflow action timed out; inspect its external outcome before continuing"),
                  { code: "workflow_action_timeout" },
                )), this.actionTimeoutMs);
              }),
            ]).finally(() => clearTimeout(timeoutId));
          } finally {
            clearInterval(heartbeat);
          }
          await this.db.finishPostCallWorkflowStep(run.run_id, step.id, { status: "completed" });
          run.current_step_id = step.next_step_id;
          await this.queueNextStep(run.run_id, run.current_step_id);
          return;
        }
      }
      await this.markNeedsReview(run.run_id, "workflow_step_limit_exceeded");
    } catch (error) {
      const step = steps.get(run.current_step_id);
      if (step) {
        await this.db.finishPostCallWorkflowStep(run.run_id, step.id, {
          status: "needs_review", error_code: safeErrorCode(error),
        }).catch(() => {});
      }
      await this.markNeedsReview(run.run_id, safeErrorCode(error));
      this.logError("workflow_run_needs_review", error, run.run_id);
    }
  }

  async finishNonActionStep(runId, step, status) {
    if (await this.getStep(runId, step.id)) return;
    await this.startStep(runId, step, null);
    await this.db.finishPostCallWorkflowStep(runId, step.id, { status });
  }

  async startStep(runId, step, idempotencyKey, status = "running") {
    return this.db.startPostCallWorkflowStep({
      run_id: runId,
      step_id: step.id,
      next_step_id: step.next_step_id || null,
      step_type: step.type,
      action_type: step.action_type,
      idempotency_key: idempotencyKey,
      status,
    });
  }

  async getStep(runId, stepId) {
    const rows = await this.db.listPostCallWorkflowStepRuns(runId);
    return rows.find((row) => row.step_id === stepId) || null;
  }

  async queueNextStep(runId, stepId) {
    await this.db.updatePostCallWorkflowRun(runId, {
      status: "queued", current_step_id: stepId, error_code: null, next_run_at: null,
      runner_id: null, lease_expires_at: null,
    }, { runner_id: this.runnerId });
  }

  async markNeedsReview(runId, errorCode) {
    await this.db.updatePostCallWorkflowRun(runId, {
      status: "needs_review", error_code: safeErrorCode({ code: errorCode }),
      payload_json: "{}", runner_id: null, lease_expires_at: null,
    }, { runner_id: this.runnerId });
  }

  async approveRun(runId, actor = "admin_token") {
    runId = normalizeRunId(runId);
    const run = await this.db.getPostCallWorkflowRun(runId);
    if (!run) fail("Workflow run was not found", "not_found");
    if (run.status !== "waiting_approval") fail("Only runs waiting for human approval can be approved", "conflict");
    const definition = await this.db.getPostCallWorkflowDefinition(run.workflow_id, run.workflow_version);
    let parsed;
    try { parsed = normalizeWorkflowDefinition(JSON.parse(definition?.definition_json || "{}")); }
    catch (_) { fail("Workflow definition is unavailable", "service_unavailable"); }
    const current = parsed.steps.find((step) => step.id === run.current_step_id);
    if (!current || current.type !== "approval") fail("Workflow approval cursor is invalid", "conflict");
    const changed = await this.db.approvePostCallWorkflowRunStep(runId, current.id, actor, current.next_step_id);
    if (!changed) fail("Workflow run changed before approval; refresh and review it", "conflict");
    return this.getRun(runId);
  }

  async cancelRun(runId, actor = "admin_token") {
    runId = normalizeRunId(runId);
    const changed = await this.db.cancelPostCallWorkflowRun(runId, actor);
    if (!changed) {
      const existing = await this.db.getPostCallWorkflowRun(runId);
      if (!existing) fail("Workflow run was not found", "not_found");
      fail("Only queued or paused workflow runs can be canceled", "conflict");
    }
    return this.getRun(runId);
  }

  async listRuns(filters = {}) {
    const workflowId = String(filters.workflow_id || "").trim();
    if (workflowId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(workflowId)) fail("workflow_id is invalid");
    const status = String(filters.status || "").trim().toLowerCase();
    if (status && !RUN_STATUSES.has(status)) fail("Workflow run status is invalid");
    const triggerReference = String(filters.trigger_reference || "").trim();
    if (triggerReference && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(triggerReference)) fail("trigger_reference is invalid");
    const rows = await this.db.listPostCallWorkflowRuns({
      ...filters,
      workflow_id: workflowId || undefined,
      status: status || undefined,
      trigger_reference: triggerReference || undefined,
    });
    return rows;
  }

  async getRun(runId) {
    runId = normalizeRunId(runId);
    const row = await this.db.getPostCallWorkflowRun(runId);
    if (!row) return null;
    return {
      ...row,
      payload_json: undefined,
      steps: await this.db.listPostCallWorkflowStepRuns(runId),
    };
  }

  logError(event, error, runId) {
    this.logger?.error?.(event, {
      run_id: runId || null,
      error_code: safeErrorCode(error),
    });
  }
}

module.exports = {
  PostCallWorkflowExecutionService,
  minimizePayload,
};
=======
    this.clock = options.clock || (() => new Date());
    this.ownerId = options.ownerId || randomUUID();
    this.leaseMs = Math.max(30_000, Math.min(10 * 60_000, Number(options.leaseMs) || 120_000));
  }

  assertReady(method) {
    if (!this.db || typeof this.db[method] !== "function") fail("Workflow execution persistence is not available", "service_unavailable");
  }

  async start(input = {}, actor = "admin_token", businessId = undefined) {
    const workflowId = String(input.workflow_id || "").trim();
    const version = Number(input.version);
    const idempotencyKey = String(input.idempotency_key || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(workflowId)) fail("workflow_id is invalid");
    if (!Number.isSafeInteger(version) || version < 1) fail("workflow version is invalid");
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/.test(idempotencyKey)) fail("A valid idempotency_key of 8 to 128 characters is required");
    const definitionRow = await this.definitionService?.db?.getPostCallWorkflowDefinition(workflowId, version, businessId);
    if (!definitionRow) fail("Workflow definition version was not found", "not_found");
    if (definitionRow.status !== "approved") fail("Only approved workflow versions can be executed", "conflict");
    const definition = normalizeWorkflowDefinition(parseJson(definitionRow.definition_json, null));
    const triggerEvent = String(input.trigger_event || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (triggerEvent !== definition.trigger_event) fail("trigger_event must match the approved workflow definition");
    const payload = input.payload === undefined ? {} : input.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("payload must be an object");
    assertSafeData(payload);
    const payloadJson = JSON.stringify(payload);
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) fail("payload must be 64 KiB or smaller");
    this.assertReady("createPostCallWorkflowRun");
    const row = await this.db.createPostCallWorkflowRun({
      run_id: randomUUID(), workflow_id: workflowId, workflow_version: version,
      idempotency_key: idempotencyKey, trigger_event: triggerEvent,
      current_step_id: definition.start_step_id, payload_json: payloadJson,
      state_json: JSON.stringify({ steps: {} }), created_by: actor,
    });
    if (row.workflow_id !== workflowId || Number(row.workflow_version) !== version || row.payload_json !== payloadJson || row.trigger_event !== triggerEvent) {
      fail("idempotency_key is already associated with a different workflow request", "conflict");
    }
    if (row.status === "queued") await this.resumeRun(row.run_id);
    return this.getRun(row.run_id, businessId);
  }

  async triggerEvent(payload = {}, selectedVersions = null) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("event payload must be an object");
    assertSafeData(payload);
    const triggerEvent = String(payload.trigger_event || payload.trigger || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!/^[a-z][a-z0-9_.]{0,79}$/.test(triggerEvent)) fail("trigger_event is invalid");
    const sourceKey = String(payload.idempotency_key || "").trim();
    if (!sourceKey || sourceKey.length > 512) fail("event idempotency_key is required and must be 512 characters or fewer");
    const businessId = this.#normalizeBusinessId(payload.business_id);
    if (!this.db || typeof this.db.listApprovedPostCallWorkflowDefinitionsByEvent !== "function") {
      fail("Workflow trigger persistence is not available", "service_unavailable");
    }
    let definitions;
    if (selectedVersions === null) {
      definitions = await this.db.listApprovedPostCallWorkflowDefinitionsByEvent(triggerEvent, businessId);
    } else {
      if (!Array.isArray(selectedVersions) || selectedVersions.length > 100) fail("Stored workflow event selection is invalid", "service_unavailable");
      definitions = [];
      for (const selected of selectedVersions) {
        const workflowId = String(selected?.workflow_id || "");
        const version = Number(selected?.version);
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(workflowId) || !Number.isSafeInteger(version) || version < 1) {
          fail("Stored workflow event selection is invalid", "service_unavailable");
        }
        const definition = await this.db.getPostCallWorkflowDefinition(workflowId, version, businessId);
        if (!definition || definition.status !== "approved" || definition.trigger_event !== triggerEvent) {
          fail("Stored workflow event selection is no longer executable", "service_unavailable");
        }
        definitions.push(definition);
      }
    }
    const runs = [];
    for (const version of definitions) {
      const digest = createHash("sha256")
        .update(`${businessId || ""}\n${triggerEvent}\n${sourceKey}\n${version.workflow_id}\n${version.version}`)
        .digest("hex");
      const idempotencyKey = `event:${digest}`;
      try {
        let existing = await this.db.getPostCallWorkflowRunByIdempotencyKey(idempotencyKey);
        if (existing && (existing.workflow_id !== version.workflow_id || Number(existing.workflow_version) !== Number(version.version) || existing.trigger_event !== triggerEvent)) {
          fail("Workflow event idempotency key is associated with a different run", "conflict");
        }
        let run;
        if (existing) {
          if (existing.status === "queued") await this.resumeRun(existing.run_id);
          run = await this.getRun(existing.run_id);
        } else {
          try {
            run = await this.start({
              workflow_id: version.workflow_id,
              version: version.version,
              trigger_event: triggerEvent,
              idempotency_key: idempotencyKey,
              payload,
            }, "system_event", businessId);
          } catch (error) {
            existing = await this.db.getPostCallWorkflowRunByIdempotencyKey(idempotencyKey);
            if (!existing || existing.workflow_id !== version.workflow_id || Number(existing.workflow_version) !== Number(version.version) || existing.trigger_event !== triggerEvent) throw error;
            run = await this.getRun(existing.run_id);
          }
        }
        runs.push({
          workflow_id: run.workflow_id,
          workflow_version: run.workflow_version,
          run_id: run.run_id,
          status: run.status,
        });
      } catch (error) {
        runs.push({
          workflow_id: version.workflow_id,
          workflow_version: version.version,
          status: "failed",
          error_code: SAFE_ERROR_CODES.has(error?.code) ? error.code : "workflow_trigger_failed",
        });
      }
    }
    return { trigger_event: triggerEvent, matched: definitions.length, runs };
  }

  async enqueueEvent(payload = {}) {
    const normalized = this.#normalizeEventPayload(payload);
    if (!this.db || typeof this.db.createPostCallWorkflowEvent !== "function") {
      fail("Workflow event persistence is not available", "service_unavailable");
    }
    const eventKey = createHash("sha256")
      .update(`${normalized.businessId || ""}\n${normalized.trigger_event}\n${normalized.sourceKey}`)
      .digest("hex");
    const selectedVersions = await this.db.listApprovedPostCallWorkflowDefinitionsByEvent(normalized.trigger_event, normalized.businessId);
    const event = await this.db.createPostCallWorkflowEvent({
      event_id: randomUUID(),
      event_key: eventKey,
      business_id: normalized.businessId,
      trigger_event: normalized.trigger_event,
      definition_versions_json: JSON.stringify(selectedVersions.map((version) => ({
        workflow_id: version.workflow_id,
        version: Number(version.version),
      }))),
      payload_json: JSON.stringify(payload),
    });
    if (!event || event.trigger_event !== normalized.trigger_event || (event.business_id || null) !== normalized.businessId) {
      fail("Workflow event idempotency key conflicts with another event", "conflict");
    }
    const now = this.clock();
    const reserved = event.status === "pending"
      ? await this.db.reservePostCallWorkflowEventDispatch(event.event_id, {
          now: now.toISOString(),
          staleBefore: new Date(now.getTime() - 60_000).toISOString(),
        })
      : 0;
    if (reserved) {
      await this.db.createCallJob("post_call_workflow_event", { event_id: event.event_id });
    }
    return { accepted: true, event_id: event.event_id, status: event.status, trigger_event: event.trigger_event };
  }

  async processEvent(eventId) {
    this.assertReady("getPostCallWorkflowEvent");
    const event = await this.db.getPostCallWorkflowEvent(String(eventId || ""));
    if (!event) fail("Workflow event was not found", "not_found");
    const now = this.clock();
    const claimed = await this.db.claimPostCallWorkflowEvent(event.event_id, {
      now: now.toISOString(),
      staleBefore: new Date(now.getTime() - this.leaseMs).toISOString(),
    });
    if (!claimed) return { event_id: event.event_id, status: event.status };
    try {
      const payload = parseJson(event.payload_json, null);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("Stored workflow event is invalid");
      if (this.#normalizeBusinessId(payload.business_id) !== (event.business_id || null)) fail("Stored workflow event scope is invalid");
      const selectedVersions = parseJson(event.definition_versions_json, null);
      const result = await this.triggerEvent(payload, selectedVersions);
      const completed = await this.db.completePostCallWorkflowEvent(event.event_id);
      if (!completed) fail("Workflow event changed before completion", "conflict");
      return { event_id: event.event_id, status: "completed", result };
    } catch (_) {
      await this.db.resetPostCallWorkflowEvent(event.event_id).catch(() => {});
      const error = new Error("Workflow event processing failed");
      error.code = "workflow_event_processing_failed";
      throw error;
    }
  }

  async reconcilePendingEvents() {
    this.assertReady("listPendingPostCallWorkflowEvents");
    const now = this.clock();
    await this.db.requeueStalePostCallWorkflowEvents({
      now: now.toISOString(),
      staleBefore: new Date(now.getTime() - this.leaseMs).toISOString(),
    });
    const events = await this.db.listPendingPostCallWorkflowEvents(100);
    let queued = 0;
    for (const event of events) {
      const reserved = await this.db.reservePostCallWorkflowEventDispatch(event.event_id, {
        now: now.toISOString(),
        staleBefore: new Date(now.getTime() - 60_000).toISOString(),
      });
      if (reserved) {
        await this.db.createCallJob("post_call_workflow_event", { event_id: event.event_id });
        queued += 1;
      }
    }
    return queued;
  }

  #normalizeEventPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("event payload must be an object");
    assertSafeData(payload);
    const triggerEvent = String(payload.trigger_event || payload.trigger || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!/^[a-z][a-z0-9_.]{0,79}$/.test(triggerEvent)) fail("trigger_event is invalid");
    const sourceKey = String(payload.idempotency_key || "").trim();
    if (!sourceKey || sourceKey.length > 512) fail("event idempotency_key is required and must be 512 characters or fewer");
    return { trigger_event: triggerEvent, sourceKey, businessId: this.#normalizeBusinessId(payload.business_id) };
  }

  #normalizeBusinessId(value) {
    if (value === undefined || value === null || value === "") return null;
    const businessId = String(value).trim();
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) fail("business_id is invalid");
    return businessId;
  }

  async listRuns(limit = 100, businessId = undefined) {
    this.assertReady("listPostCallWorkflowRuns");
    return (await this.db.listPostCallWorkflowRuns(limit, businessId)).map(publicRun);
  }

  async getRun(runId, businessId = undefined) {
    this.assertReady("getPostCallWorkflowRun");
    const row = await this.db.getPostCallWorkflowRun(String(runId || ""), businessId);
    if (!row) fail("Workflow run was not found", "not_found");
    return publicRun(row);
  }

  async cancelRun(runId, businessId = undefined) {
    this.assertReady("cancelPostCallWorkflowRun");
    const changed = await this.db.cancelPostCallWorkflowRun(String(runId || ""), businessId);
    if (!changed) {
      const row = await this.db.getPostCallWorkflowRun(String(runId || ""), businessId);
      if (!row) fail("Workflow run was not found", "not_found");
      fail("Only queued, waiting, or approval-paused workflow runs can be canceled", "conflict");
    }
    return this.getRun(runId, businessId);
  }

  async retryFailedEmailStep(runId, stepId, actor = "admin_token", businessId = undefined) {
    this.assertReady("queuePostCallWorkflowEmailRetry");
    if (typeof this.db.createCallJob !== "function") fail("Workflow retry queue is not available", "service_unavailable");
    const row = await this.db.getPostCallWorkflowRun(String(runId || ""), businessId);
    if (!row) fail("Workflow run was not found", "not_found");
    if (row.status !== "failed" || row.current_step_id !== String(stepId || "")) {
      fail("Only the current failed email step can be retried", "conflict");
    }

    const definitionRow = await this.definitionService?.db?.getPostCallWorkflowDefinition(row.workflow_id, row.workflow_version, businessId);
    if (!definitionRow || definitionRow.status !== "approved") fail("Approved workflow definition is unavailable", "conflict");
    const definition = normalizeWorkflowDefinition(parseJson(definitionRow.definition_json, null));
    const step = definition.steps.find((entry) => entry.id === row.current_step_id);
    const state = parseJson(row.state_json, { steps: {} });
    const previous = state.steps?.[row.current_step_id];
    if (step?.type !== "action" || step.action_type !== "send_email" || previous?.status !== "failed") {
      fail("Only a failed email action with a stable idempotency key can be retried", "conflict");
    }
    const retryCount = Number.isSafeInteger(previous.retry_count) && previous.retry_count >= 0 ? previous.retry_count : 0;
    if (retryCount >= MAX_EMAIL_STEP_RETRIES) fail("The permitted email retry has already been used", "conflict");

    const retryAt = this.clock();
    state.steps[row.current_step_id] = {
      ...previous,
      status: "retry_queued",
      retry_count: retryCount + 1,
      retry_requested_by: String(actor || "admin_token").slice(0, 80),
      retry_requested_at: retryAt.toISOString(),
    };
    // Persist the job before making the run claimable. If the process stops
    // between these writes, the job sees a failed run and safely becomes a no-op.
    await this.db.createCallJob(
      "post_call_workflow_resume",
      { run_id: row.run_id },
      new Date(retryAt.getTime() + 1_000).toISOString(),
    );
    const changed = await this.db.queuePostCallWorkflowEmailRetry(
      row.run_id,
      row.current_step_id,
      row.updated_at,
      JSON.stringify(state),
      businessId,
    );
    if (!changed) fail("Workflow run changed before retry was queued; refresh before retrying", "conflict");
    return this.getRun(row.run_id, businessId);
  }

  async reconcileInterruptedRuns() {
    this.assertReady("reconcileExpiredPostCallWorkflowRuns");
    const now = this.clock();
    return this.db.reconcileExpiredPostCallWorkflowRuns({
      now: now.toISOString(),
      staleBefore: new Date(now.getTime() - this.leaseMs).toISOString(),
    });
  }

  async reviewRun(runId, decision, actor = "admin_token", businessId = undefined) {
    const outcomes = {
      confirm_completed: "completed",
      confirm_failed: "failed",
      confirm_canceled: "canceled",
    };
    if (!Object.prototype.hasOwnProperty.call(outcomes, decision)) fail("Review decision is invalid");
    const row = await this.db.getPostCallWorkflowRun(String(runId || ""), businessId);
    if (!row) fail("Workflow run was not found", "not_found");
    if (row.status !== "needs_review") fail("Only workflow runs awaiting review can be resolved", "conflict");
    const state = parseJson(row.state_json, { steps: {} });
    state.operator_review = { decision, reviewed_by: actor, reviewed_at: this.clock().toISOString() };
    const changed = await this.db.reviewPostCallWorkflowRun(row.run_id, outcomes[decision], decision, actor, JSON.stringify(state), businessId);
    if (!changed) fail("Workflow run changed before review; refresh and review it", "conflict");
    return this.getRun(row.run_id, businessId);
  }

  async approveStep(runId, stepId, actor = "admin_token", businessId = undefined) {
    const row = await this.db.getPostCallWorkflowRun(String(runId || ""), businessId);
    if (!row) fail("Workflow run was not found", "not_found");
    const definitionRow = await this.definitionService.db.getPostCallWorkflowDefinition(row.workflow_id, row.workflow_version, businessId);
    const definition = normalizeWorkflowDefinition(parseJson(definitionRow?.definition_json, null));
    const step = definition.steps.find((entry) => entry.id === stepId);
    if (!step || step.type !== "approval" || row.current_step_id !== step.id || row.status !== "awaiting_approval") {
      fail("Workflow run is not awaiting approval for this step", "conflict");
    }
    const state = parseJson(row.state_json, { steps: {} });
    state.steps[step.id] = { status: "approved", approved_by: actor, approved_at: this.clock().toISOString() };
    const changed = await this.db.approvePostCallWorkflowRun(row.run_id, step.id, JSON.stringify(state), step.next_step_id, businessId);
    if (!changed) fail("Workflow run changed before approval; refresh and review it", "conflict");
    await this.resumeRun(row.run_id);
    return this.getRun(row.run_id, businessId);
  }

  async resumeRun(runId) {
    const row = await this.db.getPostCallWorkflowRun(String(runId || ""));
    if (!row) fail("Workflow run was not found", "not_found");
    const claimed = await this.db.claimPostCallWorkflowRun(row.run_id, this.ownerId, this.#leaseExpiresAt());
    if (!claimed) return this.getRun(row.run_id);
    const heartbeat = setInterval(() => {
      this.db.renewPostCallWorkflowRunLease(row.run_id, this.ownerId, this.#leaseExpiresAt()).catch(() => {});
    }, Math.max(5_000, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();
    try {
      return await this.#resumeClaimed(row);
    } finally {
      clearInterval(heartbeat);
    }
  }

  #leaseExpiresAt() {
    return new Date(this.clock().getTime() + this.leaseMs).toISOString();
  }

  async #resumeClaimed(row) {
    const definitionRow = await this.definitionService.db.getPostCallWorkflowDefinition(row.workflow_id, row.workflow_version);
    if (!definitionRow || definitionRow.status !== "approved") {
      await this.#save(row, { status: "failed", error_code: "approved_definition_unavailable" });
      return this.getRun(row.run_id);
    }
    const definition = normalizeWorkflowDefinition(parseJson(definitionRow.definition_json, null));
    const payload = parseJson(row.payload_json, {});
    const state = parseJson(row.state_json, { steps: {} });
    const byId = new Map(definition.steps.map((step) => [step.id, step]));
    let currentId = row.current_step_id;
    for (let count = 0; count < definition.steps.length; count += 1) {
      const step = byId.get(currentId);
      if (!step) return this.#finish(row, state, currentId, "failed", "invalid_current_step");
      if (step.type === "end") return this.#finish(row, state, null, "completed", null);
      if (step.type === "approval") {
        state.steps[step.id] = { status: "awaiting_approval", requested_at: this.clock().toISOString() };
        await this.#save(row, { status: "awaiting_approval", current_step_id: step.id, state });
        return this.getRun(row.run_id);
      }
      if (step.type === "branch") {
        const context = { ...payload, ...(payload.context && typeof payload.context === "object" ? payload.context : {}) };
        state.steps[step.id] = { status: "completed", selected: matchesConditionSpec(context, step.condition) ? "true" : "false", completed_at: this.clock().toISOString() };
        currentId = state.steps[step.id].selected === "true" ? step.true_step_id : step.false_step_id;
        await this.#save(row, { status: "running", current_step_id: currentId, state });
        continue;
      }
      if (step.type === "wait") {
        const dueAt = new Date(this.clock().getTime() + step.seconds * 1000).toISOString();
        const nextJob = await this.db.createCallJob("post_call_workflow_resume", { run_id: row.run_id }, dueAt);
        state.steps[step.id] = { status: "waiting", due_at: dueAt, resume_job_id: nextJob };
        await this.#save(row, { status: "waiting", current_step_id: step.next_step_id, state, next_run_at: dueAt });
        return this.getRun(row.run_id);
      }
      if (step.type === "action") {
        const priorStepState = state.steps[step.id] || {};
        state.steps[step.id] = { ...priorStepState, status: "running", started_at: this.clock().toISOString() };
        await this.#save(row, { status: "running", current_step_id: step.id, state });
        try {
          if (!this.automationService || typeof this.automationService.executeAction !== "function") fail("Workflow action service is not available", "service_unavailable");
          const result = await this.automationService.executeAction(
            { ...step.config, type: step.action_type }, payload, payload.context || {}, row.run_id,
            step.id, `workflow:${row.run_id}:${step.id}`,
          );
          if (result?.status === "stubbed") fail("Workflow action is configured in mock mode", "service_unavailable");
          state.steps[step.id] = { ...priorStepState, status: "completed", action_type: step.action_type, completed_at: this.clock().toISOString(), result: this.#safeResult(result, step.action_type) };
          currentId = step.next_step_id;
          await this.#save(row, { status: "running", current_step_id: currentId, state });
        } catch (error) {
          const code = SAFE_ERROR_CODES.has(error?.code) ? error.code : "action_failed";
          state.steps[step.id] = { ...priorStepState, status: step.action_type === "send_email" ? "failed" : "needs_review", action_type: step.action_type, failed_at: this.clock().toISOString(), error_code: code };
          const status = step.action_type === "send_email" ? "failed" : "needs_review";
          await this.#save(row, { status, current_step_id: step.id, state, error_code: code });
          return this.getRun(row.run_id);
        }
        continue;
      }
      return this.#finish(row, state, step.id, "failed", "unsupported_step");
    }
    return this.#finish(row, state, currentId, "failed", "step_limit_exceeded");
  }

  #safeResult(result, actionType) {
    return {
      type: actionType,
      status: result?.status === "ok" ? "ok" : "unknown",
      deduped: result?.deduped === true,
      suppressed: result?.suppressed === true,
    };
  }

  async #save(row, update) {
    const running = update.status === "running";
    const changed = await this.db.savePostCallWorkflowRun(row.run_id, {
      status: update.status,
      current_step_id: update.current_step_id,
      state_json: JSON.stringify(update.state || parseJson(row.state_json, { steps: {} })),
      error_code: update.error_code,
      next_run_at: update.next_run_at,
      execution_owner: running ? this.ownerId : null,
      lease_expires_at: running ? this.#leaseExpiresAt() : null,
      lock_owner: this.ownerId,
    });
    if (!changed) fail("Workflow run changed while execution was in progress", "conflict");
  }

  async #finish(row, state, currentStepId, status, errorCode) {
    await this.#save(row, { status, current_step_id: currentStepId, state, error_code: errorCode });
    return this.getRun(row.run_id);
  }
}

module.exports = { PostCallWorkflowExecutionService, publicRun };
>>>>>>> 95a068c (updated)
