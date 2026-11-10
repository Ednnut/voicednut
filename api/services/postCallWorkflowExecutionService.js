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

function fail(message, code = "validation_error") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

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
}

class PostCallWorkflowExecutionService {
  constructor(options = {}) {
    this.db = options.db || null;
    this.definitionService = options.definitionService || null;
    this.automationService = options.automationService || null;
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
    const businessId = safe.business_id == null || safe.business_id === ""
      ? null
      : String(safe.business_id).trim();
    if (businessId && !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) fail("business_id is invalid");
    if (triggerEvent === "call_e_result_ready" && !businessId) {
      return { skipped: true, reason: "missing_business_scope", runs: [] };
    }
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
      this.reconcilePendingEvents().catch((error) => this.logError("workflow_event_reconciliation_failed", error));
    }, this.enabled ? this.pollMs : 60_000);
    this.timer.unref?.();
    void this.drain().catch((error) => this.logError("workflow_worker_start_failed", error));
    void this.reconcilePendingEvents().catch((error) => this.logError("workflow_event_reconciliation_start_failed", error));
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

  async resumeRun(runId) {
    const normalizedRunId = normalizeRunId(runId);
    const row = await this.db?.getPostCallWorkflowRun?.(normalizedRunId);
    if (!row) fail("Workflow run was not found", "not_found");
    await this.drain();
    return this.getRun(normalizedRunId);
  }

  async processEvent(eventId) {
    if (!this.db || typeof this.db.getPostCallWorkflowEvent !== "function") {
      fail("Workflow event persistence is not available", "service_unavailable");
    }
    const normalizedEventId = String(eventId || "").trim();
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(normalizedEventId)) fail("event_id is invalid");
    const event = await this.db.getPostCallWorkflowEvent(normalizedEventId);
    if (!event) fail("Workflow event was not found", "not_found");
    const now = new Date();
    const claimed = await this.db.claimPostCallWorkflowEvent(event.event_id, {
      now: now.toISOString(),
      staleBefore: new Date(now.getTime() - 90_000).toISOString(),
    });
    if (!claimed) return { event_id: event.event_id, status: event.status };

    try {
      const payload = JSON.parse(event.payload_json || "null");
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("Stored workflow event is invalid");
      const triggerEvent = String(event.trigger_event || "").trim().toLowerCase().replace(/[\s.-]+/g, "_");
      if (!SUPPORTED_TRIGGER_EVENTS.has(triggerEvent) || payload.trigger_event !== triggerEvent) {
        fail("Stored workflow event trigger is invalid");
      }
      const businessId = event.business_id == null ? null : String(event.business_id);
      if ((businessId && !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) ||
          (payload.business_id || null) !== businessId ||
          (triggerEvent === "call_e_result_ready" && !businessId)) {
        fail("Stored workflow event scope is invalid");
      }
      const eventKey = String(payload.idempotency_key || payload.call_sid || payload.call?.call_sid || "").trim();
      if (!eventKey) fail("Stored workflow event idempotency key is missing");
      const { serialized } = minimizePayload(payload);
      const selectedVersions = JSON.parse(event.definition_versions_json || "null");
      if (!Array.isArray(selectedVersions) || selectedVersions.length > 100) {
        fail("Stored workflow event selection is invalid");
      }
      const rawReference = payload.local_call_id || payload.call_sid;
      const triggerReference = typeof rawReference === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(rawReference) ? rawReference : null;
      const runs = [];
      for (const selected of selectedVersions) {
        const workflowId = String(selected?.workflow_id || "");
        const version = Number(selected?.version);
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(workflowId) || !Number.isSafeInteger(version) || version < 1) {
          fail("Stored workflow event selection is invalid");
        }
        const definitionRow = await this.db.getPostCallWorkflowDefinition(workflowId, version, businessId);
        if (!definitionRow || definitionRow.status !== "approved" || definitionRow.trigger_event !== triggerEvent) {
          fail("Stored workflow event definition is no longer executable", "service_unavailable");
        }
        const definition = this.definitionService?.hydrate
          ? this.definitionService.hydrate(definitionRow).definition
          : JSON.parse(definitionRow.definition_json || "{}");
        const normalized = normalizeWorkflowDefinition(definition);
        if ((normalized.business_id || null) !== businessId) fail("Stored workflow event definition scope is invalid");
        const digest = crypto.createHash("sha256")
          .update(`${businessId || ""}\n${triggerEvent}\n${eventKey}\n${workflowId}\n${version}`)
          .digest("hex");
        const idempotencyKey = `event:${digest}`;
        const run = await this.db.createPostCallWorkflowRun({
          run_id: crypto.randomUUID(),
          workflow_id: workflowId,
          workflow_version: version,
          business_id: businessId,
          trigger_event: triggerEvent,
          trigger_reference: triggerReference,
          idempotency_key: idempotencyKey,
          current_step_id: normalized.start_step_id,
          payload_json: serialized,
          expires_at: toSqlDate(new Date(now.getTime() + (90 * 24 * 60 * 60 * 1000))),
        });
        if (!run.row || run.row.workflow_id !== workflowId ||
            Number(run.row.workflow_version) !== version || run.row.trigger_event !== triggerEvent) {
          fail("Workflow event idempotency key conflicts with an existing run", "conflict");
        }
        runs.push({ run_id: run.row.run_id, status: run.row.status, deduped: !run.created });
      }
      if (!await this.db.completePostCallWorkflowEvent(event.event_id)) {
        fail("Workflow event changed before completion", "conflict");
      }
      void this.drain().catch((error) => this.logError("workflow_event_drain_failed", error));
      return { event_id: event.event_id, status: "completed", runs };
    } catch (error) {
      await this.db.resetPostCallWorkflowEvent(event.event_id, safeErrorCode(error)).catch(() => {});
      throw error;
    }
  }

  async reconcilePendingEvents() {
    if (!this.db || typeof this.db.listPendingPostCallWorkflowEvents !== "function") return 0;
    const now = new Date();
    await this.db.requeueStalePostCallWorkflowEvents({
      now: now.toISOString(),
      staleBefore: new Date(now.getTime() - 90_000).toISOString(),
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

  async reconcileInterruptedRuns() {
    if (!this.db || typeof this.db.recoverStalePostCallWorkflowRuns !== "function") return 0;
    return this.db.recoverStalePostCallWorkflowRuns();
  }

  async advanceRun(run) {
    const workflowRow = await this.db.getPostCallWorkflowDefinition(
      run.workflow_id,
      run.workflow_version,
      run.business_id == null ? undefined : run.business_id,
    );
    if (!workflowRow || workflowRow.status !== "approved" ||
      (workflowRow.business_id || null) !== (run.business_id || null)) {
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

  async getRun(runId, businessId = undefined) {
    runId = normalizeRunId(runId);
    const row = await this.db.getPostCallWorkflowRun(runId, businessId);
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
