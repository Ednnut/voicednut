const crypto = require("crypto");

const DEFAULT_TRIGGER_EVENT = "post_call_completed";
const SUPPORTED_ACTIONS = new Set([
  "send_email",
  "email",
  "crm_sync",
  "sync_crm",
  "create_ticket",
]);

const DEFAULT_AUTOMATION_RULES = Object.freeze([
  {
    rule_id: "default_payment_receipt_followup",
    name: "Default payment receipt follow-up",
    enabled: true,
    trigger_event: "payment_succeeded",
    priority: 10,
    conditions: {
      all: [
        { field: "customer.email", exists: true },
        {
          any: [
            { field: "payment_state", in: ["paid", "succeeded", "completed"] },
            { field: "payment_status", in: ["paid", "succeeded", "completed"] },
          ],
        },
      ],
    },
    actions: [
      {
        type: "send_email",
        select_template: true,
        template_context: {
          intent: "receipt",
          payment_state: "paid",
          customer_status: "paid",
        },
      },
      { type: "crm_sync" },
    ],
  },
  {
    rule_id: "default_missed_booking_link",
    name: "Default missed booking link follow-up",
    enabled: true,
    trigger_event: "post_call_completed",
    priority: 20,
    conditions: {
      all: [
        { field: "customer.email", exists: true },
        {
          any: [
            { field: "booking_state", in: ["missed", "incomplete", "not_booked", "needs_booking"] },
            { field: "call_outcome", includes: "missed appointment" },
          ],
        },
      ],
    },
    actions: [
      {
        type: "send_email",
        select_template: true,
        template_context: {
          intent: "booking",
          booking_state: "needs_booking",
        },
      },
      { type: "crm_sync" },
    ],
  },
  {
    rule_id: "default_escalation_case_summary",
    name: "Default escalation case summary",
    enabled: true,
    trigger_event: "post_call_completed",
    priority: 30,
    conditions: {
      all: [
        {
          any: [
            { field: "escalation_state", in: ["escalated", "needs_support", "support"] },
            { field: "ticket_state", in: ["needed", "create", "open"] },
            { field: "call_intent", includes: "support" },
            { field: "intent", includes: "support" },
          ],
        },
        {
          any: [
            { field: "customer.email", exists: true },
            { field: "customer.phone", exists: true },
            { field: "customer.contact_id", exists: true },
            { field: "contact.email", exists: true },
            { field: "contact.phone", exists: true },
          ],
        },
      ],
    },
    actions: [
      {
        type: "create_ticket",
        summary: "Post-call escalation summary",
      },
      { type: "crm_sync" },
    ],
  },
]);

function normalizeText(value, max = 240) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, max);
}

function normalizeEvent(value) {
  return normalizeText(value || DEFAULT_TRIGGER_EVENT, 120)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function getNestedValue(obj, path) {
  if (!obj || !path) return undefined;
  return String(path)
    .split(".")
    .reduce((acc, key) => {
      if (acc && Object.prototype.hasOwnProperty.call(acc, key)) {
        return acc[key];
      }
      return undefined;
    }, obj);
}

function valuesEqual(actual, expected) {
  if (Array.isArray(expected)) {
    return expected.some((entry) => valuesEqual(actual, entry));
  }
  if (typeof actual === "string" || typeof expected === "string") {
    return String(actual || "").toLowerCase() === String(expected || "").toLowerCase();
  }
  return actual === expected;
}

function matchesConditionSpec(context, spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return true;
  if (Array.isArray(spec.all)) {
    return spec.all.every((entry) => matchesConditionSpec(context, entry));
  }
  if (Array.isArray(spec.any)) {
    return spec.any.some((entry) => matchesConditionSpec(context, entry));
  }
  const field = spec.field || spec.path;
  if (field) {
    const actual = getNestedValue(context, field);
    if (Object.prototype.hasOwnProperty.call(spec, "exists")) {
      const exists = actual !== undefined && actual !== null && actual !== "";
      return spec.exists ? exists : !exists;
    }
    if (Object.prototype.hasOwnProperty.call(spec, "equals")) {
      return valuesEqual(actual, spec.equals);
    }
    if (Object.prototype.hasOwnProperty.call(spec, "in")) {
      return valuesEqual(actual, safeArray(spec.in));
    }
    if (Object.prototype.hasOwnProperty.call(spec, "includes")) {
      return String(actual || "")
        .toLowerCase()
        .includes(String(spec.includes || "").toLowerCase());
    }
  }
  return Object.entries(spec).every(([key, expected]) => {
    if (["all", "any", "field", "path", "exists", "equals", "in", "includes"].includes(key)) {
      return true;
    }
    return valuesEqual(getNestedValue(context, key), expected);
  });
}

function buildContext(payload = {}) {
  const context = {
    ...safeObject(payload.context),
    ...safeObject(payload.metadata),
  };
  [
    "call_sid",
    "callSid",
    "call_intent",
    "intent",
    "customer_status",
    "booking_state",
    "payment_state",
    "payment_status",
    "call_outcome",
    "outcome",
    "escalation_state",
    "ticket_state",
    "transcript_summary",
  ].forEach((key) => {
    if (payload[key] !== undefined && context[key] === undefined) {
      context[key] = payload[key];
    }
  });
  if (payload.customer || payload.contact) {
    context.customer = safeObject(payload.customer || payload.contact);
    context.contact = context.customer;
  }
  if (payload.variables) {
    context.variables = safeObject(payload.variables);
  }
  return context;
}

function buildRunId() {
  if (typeof crypto.randomUUID === "function") {
    return `postcall_run_${crypto.randomUUID()}`;
  }
  return `postcall_run_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

function buildIdempotencyKey(ruleId, payload = {}, triggerEvent) {
  const source = normalizeText(
    payload.idempotency_key ||
      payload.idempotencyKey ||
      payload.call_sid ||
      payload.callSid ||
      payload.call?.call_sid ||
      "",
    200,
  );
  if (!source) return "";
  return `postcall:${ruleId}:${triggerEvent}:${source}`;
}

class PostCallAutomationService {
  constructor(options = {}) {
    this.db = options.db || null;
    this.emailService = options.emailService || null;
    this.crmService = options.crmService || null;
    this.logger = options.logger || console;
  }

  normalizeRule(payload = {}) {
    const ruleId = normalizeText(payload.rule_id || payload.id || "", 160);
    const name = normalizeText(payload.name || ruleId || "Post-call automation rule", 160);
    const triggerEvent = normalizeEvent(payload.trigger_event || payload.trigger || DEFAULT_TRIGGER_EVENT);
    const conditions = parseJson(payload.conditions_json, payload.conditions || {});
    const actions = parseJson(payload.actions_json, payload.actions || []);
    const normalizedActions = safeArray(actions).map((action) => ({
      ...safeObject(action),
      type: normalizeEvent(action?.type || action?.action || ""),
    }));
    if (!ruleId) {
      const error = new Error("Automation rule_id is required");
      error.code = "validation_error";
      throw error;
    }
    if (!normalizedActions.length) {
      const error = new Error("Automation rule requires at least one action");
      error.code = "validation_error";
      throw error;
    }
    normalizedActions.forEach((action) => {
      if (!SUPPORTED_ACTIONS.has(action.type)) {
        const error = new Error(`Unsupported post-call automation action: ${action.type || "unknown"}`);
        error.code = "validation_error";
        throw error;
      }
    });
    return {
      rule_id: ruleId,
      name,
      enabled: payload.enabled === false || payload.enabled === 0 ? false : true,
      trigger_event: triggerEvent,
      conditions,
      actions: normalizedActions,
      priority: Number.isFinite(Number(payload.priority)) ? Number(payload.priority) : 100,
    };
  }

  serializeRule(rule) {
    return {
      rule_id: rule.rule_id,
      name: rule.name,
      enabled: rule.enabled ? 1 : 0,
      trigger_event: rule.trigger_event,
      conditions_json: JSON.stringify(rule.conditions || {}),
      actions_json: JSON.stringify(rule.actions || []),
      priority: rule.priority,
    };
  }

  hydrateRule(row = {}) {
    if (!row) return null;
    return {
      ...row,
      enabled: row.enabled === true || row.enabled === 1,
      conditions: parseJson(row.conditions_json, row.conditions || {}),
      actions: parseJson(row.actions_json, row.actions || []),
    };
  }

  hydrateRun(row = {}) {
    if (!row) return null;
    return {
      ...row,
      actions: parseJson(row.actions_json, row.actions || []),
      result: parseJson(row.result_json, row.result || null),
      payload: parseJson(row.payload_json, row.payload || {}),
      attempt: Number.isFinite(Number(row.attempt)) ? Number(row.attempt) : 1,
    };
  }

  getDefaultRules() {
    return DEFAULT_AUTOMATION_RULES.map((rule) => this.normalizeRule(rule));
  }

  async ensureDefaultRules(options = {}) {
    if (!this.db || typeof this.db.upsertPostCallAutomationRule !== "function") {
      const error = new Error("Post-call automation persistence is not available");
      error.code = "service_unavailable";
      throw error;
    }
    const overwrite = options.overwrite === true;
    const installed = [];
    const skipped = [];
    for (const rule of this.getDefaultRules()) {
      const existing =
        typeof this.db.getPostCallAutomationRule === "function"
          ? await this.db.getPostCallAutomationRule(rule.rule_id)
          : null;
      if (existing && !overwrite) {
        skipped.push(rule.rule_id);
        continue;
      }
      await this.db.upsertPostCallAutomationRule(this.serializeRule(rule));
      installed.push(rule.rule_id);
    }
    return {
      installed: installed.length,
      skipped: skipped.length,
      installed_rule_ids: installed,
      skipped_rule_ids: skipped,
      rules: this.getDefaultRules(),
    };
  }

  async upsertRule(payload = {}) {
    const rule = this.normalizeRule(payload);
    if (!this.db || typeof this.db.upsertPostCallAutomationRule !== "function") {
      const error = new Error("Post-call automation persistence is not available");
      error.code = "service_unavailable";
      throw error;
    }
    await this.db.upsertPostCallAutomationRule(this.serializeRule(rule));
    return rule;
  }

  async listRules(filters = {}) {
    if (!this.db || typeof this.db.listPostCallAutomationRules !== "function") {
      return [];
    }
    const rows = await this.db.listPostCallAutomationRules({
      ...filters,
      trigger_event: filters.trigger_event ? normalizeEvent(filters.trigger_event) : undefined,
    });
    return rows.map((row) => this.hydrateRule(row)).filter(Boolean);
  }

  async listRuns(filters = {}) {
    if (!this.db || typeof this.db.listPostCallAutomationRuns !== "function") {
      return [];
    }
    const rows = await this.db.listPostCallAutomationRuns({
      ...filters,
      trigger_event: filters.trigger_event ? normalizeEvent(filters.trigger_event) : undefined,
    });
    return rows.map((row) => this.hydrateRun(row)).filter(Boolean);
  }

  async getRun(runId) {
    if (!this.db || typeof this.db.getPostCallAutomationRun !== "function") {
      return null;
    }
    return this.hydrateRun(await this.db.getPostCallAutomationRun(normalizeText(runId, 200)));
  }

  ruleMatches(rule, context) {
    if (!rule.enabled) return false;
    return matchesConditionSpec(context, rule.conditions || {});
  }

  async preview(payload = {}) {
    const triggerEvent = normalizeEvent(payload.trigger_event || payload.trigger);
    const context = buildContext(payload);
    const rules = await this.listRules({ enabled: true, trigger_event: triggerEvent });
    const matchedRules = rules.filter((rule) => this.ruleMatches(rule, context));
    return {
      trigger_event: triggerEvent,
      matched_rules: matchedRules.map((rule) => ({
        rule_id: rule.rule_id,
        name: rule.name,
        priority: rule.priority,
        actions: safeArray(rule.actions).map((action) => action.type),
      })),
    };
  }

  async evaluateAndRun(payload = {}) {
    const triggerEvent = normalizeEvent(payload.trigger_event || payload.trigger);
    const context = buildContext(payload);
    const rules = await this.listRules({ enabled: true, trigger_event: triggerEvent });
    const matchedRules = rules.filter((rule) => this.ruleMatches(rule, context));
    const results = [];
    for (const rule of matchedRules) {
      results.push(await this.runRule(rule, payload, context, triggerEvent));
    }
    return {
      trigger_event: triggerEvent,
      matched: matchedRules.length,
      runs: results,
    };
  }

  async retryRun(runId, options = {}) {
    const originalRun = await this.getRun(runId);
    if (!originalRun) {
      const error = new Error("Post-call automation run was not found");
      error.code = "not_found";
      throw error;
    }
    if (originalRun.status !== "failed" && options.force !== true) {
      const error = new Error("Only failed post-call automation runs can be retried without force=true");
      error.code = "conflict";
      throw error;
    }
    if (!this.db || typeof this.db.getPostCallAutomationRule !== "function") {
      const error = new Error("Post-call automation rule persistence is not available");
      error.code = "service_unavailable";
      throw error;
    }
    const rule = this.hydrateRule(await this.db.getPostCallAutomationRule(originalRun.rule_id));
    if (!rule) {
      const error = new Error("Post-call automation rule for retry was not found");
      error.code = "not_found";
      throw error;
    }
    const payload = {
      ...safeObject(originalRun.payload),
      ...safeObject(options.payload_overrides),
    };
    const triggerEvent = normalizeEvent(options.trigger_event || originalRun.trigger_event || payload.trigger_event);
    payload.trigger_event = triggerEvent;
    const context = buildContext(payload);
    const baseIdempotencyKey =
      buildIdempotencyKey(rule.rule_id, payload, triggerEvent) ||
      normalizeText(originalRun.idempotency_key, 240).replace(/:retry:.+$/i, "");
    const retrySuffix = crypto.randomBytes(4).toString("hex");
    const retryRunKey = `${baseIdempotencyKey || `postcall:${rule.rule_id}:${triggerEvent}:${originalRun.run_id}`}:retry:${Date.now()}:${retrySuffix}`;
    const run = await this.runRule(rule, payload, context, triggerEvent, {
      retryOfRunId: originalRun.run_id,
      attempt: Number(originalRun.attempt || 1) + 1,
      baseIdempotencyKey,
      runIdempotencyKey: retryRunKey,
    });
    return {
      retried: true,
      original_run_id: originalRun.run_id,
      run,
    };
  }

  async runRule(rule, payload, context, triggerEvent, options = {}) {
    const baseIdempotencyKey =
      options.baseIdempotencyKey || buildIdempotencyKey(rule.rule_id, payload, triggerEvent);
    const idempotencyKey = options.runIdempotencyKey || baseIdempotencyKey;
    if (
      idempotencyKey &&
      !options.retryOfRunId &&
      this.db &&
      typeof this.db.getPostCallAutomationRunByIdempotency === "function"
    ) {
      const existing = await this.db.getPostCallAutomationRunByIdempotency(idempotencyKey);
      if (existing) {
        return {
          run_id: existing.run_id,
          rule_id: rule.rule_id,
          status: existing.status,
          deduped: true,
          result: parseJson(existing.result_json, null),
        };
      }
    }
    const runId = buildRunId();
    const callSid = normalizeText(payload.call_sid || payload.callSid || payload.call?.call_sid, 160) || null;
    const serializedActions = JSON.stringify(rule.actions || []);
    const serializedPayload = JSON.stringify(payload || {});
    const attempt = Number.isFinite(Number(options.attempt)) ? Number(options.attempt) : 1;
    await this.recordRun({
      run_id: runId,
      rule_id: rule.rule_id,
      call_sid: callSid,
      trigger_event: triggerEvent,
      status: "running",
      actions_json: serializedActions,
      result_json: null,
      error: null,
      idempotency_key: idempotencyKey || null,
      payload_json: serializedPayload,
      retry_of_run_id: options.retryOfRunId || null,
      attempt,
    });
    try {
      const actionResults = [];
      for (let index = 0; index < rule.actions.length; index += 1) {
        actionResults.push(
          await this.executeAction(
            rule.actions[index],
            payload,
            context,
            runId,
            index,
            baseIdempotencyKey || idempotencyKey || `postcall:${runId}`,
          ),
        );
      }
      const result = { actions: actionResults };
      await this.recordRun({
        run_id: runId,
        rule_id: rule.rule_id,
        call_sid: callSid,
        trigger_event: triggerEvent,
        status: "completed",
        actions_json: serializedActions,
        result_json: JSON.stringify(result),
        error: null,
        idempotency_key: idempotencyKey || null,
        payload_json: serializedPayload,
        retry_of_run_id: options.retryOfRunId || null,
        attempt,
      });
      return {
        run_id: runId,
        rule_id: rule.rule_id,
        status: "completed",
        deduped: false,
        result,
      };
    } catch (error) {
      await this.recordRun({
        run_id: runId,
        rule_id: rule.rule_id,
        call_sid: callSid,
        trigger_event: triggerEvent,
        status: "failed",
        actions_json: serializedActions,
        result_json: null,
        error: normalizeText(error?.message || "automation_run_failed", 1000),
        idempotency_key: idempotencyKey || null,
        payload_json: serializedPayload,
        retry_of_run_id: options.retryOfRunId || null,
        attempt,
      });
      throw error;
    }
  }

  async recordRun(record) {
    if (this.db && typeof this.db.recordPostCallAutomationRun === "function") {
      await this.db.recordPostCallAutomationRun(record);
    }
  }

  async executeAction(action, payload, context, runId, index, actionIdempotencyPrefix) {
    if (action.type === "send_email" || action.type === "email") {
      return this.executeEmailAction(action, payload, context, runId, index, actionIdempotencyPrefix);
    }
    if (action.type === "crm_sync" || action.type === "sync_crm") {
      return this.executeCrmSyncAction(action, payload, context);
    }
    if (action.type === "create_ticket") {
      return this.executeTicketAction(action, payload, context);
    }
    const error = new Error(`Unsupported post-call automation action: ${action.type}`);
    error.code = "validation_error";
    throw error;
  }

  async executeEmailAction(action, payload, context, runId, index, actionIdempotencyPrefix) {
    if (!this.emailService || typeof this.emailService.enqueueEmail !== "function") {
      const error = new Error("Email service is not available for post-call automation");
      error.code = "service_unavailable";
      throw error;
    }
    const customer = safeObject(payload.customer || payload.contact || context.customer);
    const variables = {
      ...safeObject(context.variables),
      ...safeObject(payload.variables),
      ...safeObject(action.variables),
      call_sid: payload.call_sid || payload.callSid || payload.call?.call_sid || context.call_sid || null,
      first_name: customer.first_name || customer.firstName || customer.name || "",
    };
    const templateContext = {
      ...context,
      ...safeObject(action.template_context),
    };
    const emailPayload = {
      to: action.to || customer.email || payload.to || context.email,
      from: action.from || payload.from,
      provider: action.provider || payload.email_provider || payload.provider,
      subject: action.subject,
      text: action.text,
      html: action.html,
      script_id: action.script_id || action.template_id,
      select_template: action.select_template !== false,
      template_context: templateContext,
      variables,
      metadata: {
        ...safeObject(payload.metadata),
        ...safeObject(action.metadata),
        post_call_automation: true,
        automation_run_id: runId,
        action_index: index,
      },
      is_marketing: action.is_marketing === true,
    };
    const queued = await this.emailService.enqueueEmail(emailPayload, {
      idempotencyKey: action.idempotency_key || `${actionIdempotencyPrefix || `postcall:${runId}`}:email:${index}`,
    });
    return {
      type: "send_email",
      status: "ok",
      message_id: queued?.message_id || null,
      deduped: queued?.deduped === true,
      suppressed: queued?.suppressed === true,
    };
  }

  async executeCrmSyncAction(action, payload, context) {
    if (!this.crmService || typeof this.crmService.syncPostCallRecord !== "function") {
      const error = new Error("CRM sync service is not available for post-call automation");
      error.code = "service_unavailable";
      throw error;
    }
    const result = await this.crmService.syncPostCallRecord({
      provider: action.provider || payload.crm_provider || payload.crmProvider,
      contact: payload.contact || payload.customer || context.customer,
      call: {
        ...safeObject(payload.call),
        call_sid: payload.call_sid || payload.callSid || payload.call?.call_sid || context.call_sid,
        summary: payload.summary || context.transcript_summary,
      },
      context,
      metadata: {
        ...safeObject(payload.metadata),
        ...safeObject(action.metadata),
        post_call_automation: true,
      },
    });
    return {
      type: "crm_sync",
      status: "ok",
      result,
    };
  }

  async executeTicketAction(action, payload, context) {
    if (!this.crmService || typeof this.crmService.createTicket !== "function") {
      return {
        type: "create_ticket",
        status: "stubbed",
        ticket_id: `ticket_${crypto.createHash("sha1").update(JSON.stringify({ action, context })).digest("hex").slice(0, 16)}`,
      };
    }
    const result = await this.crmService.createTicket({
      provider: action.provider || payload.crm_provider || payload.crmProvider,
      contact_id: action.contact_id,
      call_sid: payload.call_sid || payload.callSid || payload.call?.call_sid || context.call_sid,
      summary: action.summary || payload.summary || context.transcript_summary,
      context,
      metadata: {
        ...safeObject(payload.metadata),
        ...safeObject(action.metadata),
        post_call_automation: true,
      },
    });
    return {
      type: "create_ticket",
      status: "ok",
      result,
    };
  }
}

module.exports = {
  PostCallAutomationService,
  normalizeEvent,
  matchesConditionSpec,
};
