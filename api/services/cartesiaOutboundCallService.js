"use strict";

const crypto = require("node:crypto");

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,180}$/;
const BUSINESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
const CARTESIA_CALL_STATUSES = new Set(["created", "started", "completed", "failed"]);
const MAX_RECONCILIATION_AGE_MS = 24 * 60 * 60 * 1000;
const DYNAMIC_VARIABLE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function normalizeDynamicVariables(value) {
  if (value === undefined || value === null || value === "") return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError("cartesia_dynamic_variables_invalid", "Dynamic variables must be a JSON object of scalar values", 400);
  }
  const entries = Object.entries(value);
  if (entries.length > 20) throw serviceError("cartesia_dynamic_variables_invalid", "No more than 20 dynamic variables are allowed", 400);
  const result = {};
  let totalLength = 0;
  for (const [key, rawValue] of entries) {
    if (!DYNAMIC_VARIABLE_PATTERN.test(key) || key.toLowerCase() === "voicednut_request_id") {
      throw serviceError("cartesia_dynamic_variables_invalid", "Dynamic variable names must be simple identifiers; the VOICEDNUT correlation key is reserved", 400);
    }
    if (!["string", "number", "boolean"].includes(typeof rawValue) || !String(rawValue).length || String(rawValue).length > 300) {
      throw serviceError("cartesia_dynamic_variables_invalid", "Dynamic variable values must be non-empty strings, numbers, or booleans up to 300 characters", 400);
    }
    const normalizedValue = typeof rawValue === "string" ? rawValue.trim() : rawValue;
    if (!String(normalizedValue).length || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(String(normalizedValue))) {
      throw serviceError("cartesia_dynamic_variables_invalid", "Dynamic variables cannot be empty or contain control characters", 400);
    }
    totalLength += key.length + String(normalizedValue).length;
    result[key] = normalizedValue;
  }
  if (totalLength > 2000) throw serviceError("cartesia_dynamic_variables_invalid", "Dynamic variables exceed the 2,000 character total limit", 400);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function serviceError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function buildCartesiaConfirmationPhrase(input = {}) {
  const phrase = `PLACE CARTESIA CALL TO ${String(input.destination || "").trim()} FROM ${String(input.fromNumberId || input.from_number_id || "").trim()} WITH AGENT ${String(input.agentId || input.agent_id || "").trim()}`;
  const variables = normalizeDynamicVariables(input.dynamicVariables || input.dynamic_variables);
  if (!Object.keys(variables).length) return phrase;
  const fingerprint = crypto.createHash("sha256").update(stableStringify(variables)).digest("hex").slice(0, 12);
  return `${phrase} WITH VARIABLES ${fingerprint}`;
}

function normalizeCallInput(input = {}) {
  const normalized = {
    businessId: String(input.businessId || input.business_id || "").trim(),
    actorId: String(input.actorId || input.actor_id || "").trim(),
    destination: String(input.destination || input.number || "").trim(),
    agentId: String(input.agentId || input.agent_id || "").trim(),
    fromNumberId: String(input.fromNumberId || input.from_number_id || "").trim(),
    idempotencyKey: String(input.idempotencyKey || input.idempotency_key || "").trim(),
    dynamicVariables: normalizeDynamicVariables(input.dynamicVariables || input.dynamic_variables),
  };
  if (!BUSINESS_ID_PATTERN.test(normalized.businessId) || !/^\d{1,20}$/.test(normalized.actorId) ||
      !PHONE_PATTERN.test(normalized.destination) || !ID_PATTERN.test(normalized.agentId) ||
      !ID_PATTERN.test(normalized.fromNumberId) || !IDEMPOTENCY_PATTERN.test(normalized.idempotencyKey)) {
    throw serviceError("cartesia_call_input_invalid", "Business, actor, E.164 destination, agent, number, and idempotency key are required", 400);
  }
  return normalized;
}

function hashRequest(input) {
  return crypto.createHash("sha256").update(stableStringify({
    businessId: input.businessId,
    destination: input.destination,
    agentId: input.agentId,
    fromNumberId: input.fromNumberId,
    ...(Object.keys(input.dynamicVariables || {}).length ? { dynamicVariables: input.dynamicVariables } : {}),
  })).digest("hex");
}

function buildCorrelationId(idempotencyKey) {
  return crypto.createHash("sha256").update(`cartesia-request:${idempotencyKey}`).digest("hex");
}

function parseStoredTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return NaN;
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(text) ? text : `${text.replace(" ", "T")}Z`);
}

function normalizeCartesiaCall(call = {}) {
  const callId = String(call.id || "").trim();
  const agentId = String(call.agent_id || "").trim();
  if (!ID_PATTERN.test(callId) || !ID_PATTERN.test(agentId)) return null;
  const rawStatus = String(call.status || "").trim().toLowerCase();
  return {
    callId,
    agentId,
    status: CARTESIA_CALL_STATUSES.has(rawStatus) ? rawStatus : "unknown",
    startTime: typeof call.start_time === "string" ? call.start_time.slice(0, 40) : null,
    endTime: typeof call.end_time === "string" ? call.end_time.slice(0, 40) : null,
    endReason: typeof call.end_reason === "string" ? call.end_reason.slice(0, 80) : null,
  };
}

function maskProviderNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? `••••${digits.slice(-4)}` : null;
}

function normalizeOperationsCall(call = {}, includeReviewDetails = false) {
  const normalized = normalizeCartesiaCall(call);
  if (!normalized) return null;
  const from = maskProviderNumber(call?.telephony_params?.from);
  const to = maskProviderNumber(call?.telephony_params?.to);
  const result = {
    ...normalized,
    agentName: typeof call.agent_name === "string" ? call.agent_name.slice(0, 120) : null,
    from,
    to,
    canCancel: normalized.status === "started",
  };
  if (includeReviewDetails) {
    const zdrEnabled = call.zdr_enabled === true;
    const redactedAt = typeof call.redacted_at === "string" ? call.redacted_at.slice(0, 40) : null;
    const unavailableContent = zdrEnabled || Boolean(redactedAt);
    const transcriptRows = Array.isArray(call.transcript) ? call.transcript.slice(0, 40) : [];
    result.agentVersionId = typeof call.agent_version_id === "string" && ID_PATTERN.test(call.agent_version_id) ? call.agent_version_id : null;
    result.zdrEnabled = zdrEnabled;
    result.redactedAt = redactedAt;
    result.summary = unavailableContent || typeof call.summary !== "string" ? null : call.summary.slice(0, 1200);
    result.toolNames = [...new Set(transcriptRows.flatMap((turn) => Array.isArray(turn?.tool_calls) ? turn.tool_calls : [])
      .map((tool) => String(tool?.name || "").trim().slice(0, 80)).filter(Boolean))].slice(0, 20);
  }
  return result;
}

function normalizeReviewRules(value = {}) {
  return {
    review_failed_calls: value.review_failed_calls !== false,
    review_tool_calls: value.review_tool_calls === true,
    review_missing_summary: value.review_missing_summary === true,
  };
}

function assessCallForReview(call, rules) {
  const reasons = [];
  if (rules.review_failed_calls && call.status === "failed") reasons.push("call_failed");
  if (rules.review_tool_calls && call.toolNames.length > 0) reasons.push("tool_used");
  if (rules.review_missing_summary && call.status === "completed" && !call.zdrEnabled && !call.redactedAt && !call.summary) {
    reasons.push("summary_missing");
  }
  return { required: reasons.length > 0, reasons };
}

function normalizeReviewTranscript(call = {}) {
  if (call.zdr_enabled === true || call.redacted_at || !Array.isArray(call.transcript)) return [];
  let remaining = 8000;
  return call.transcript.slice(0, 40).map((turn) => {
    const text = String(turn?.text || "").slice(0, Math.min(1200, remaining));
    remaining -= text.length;
    return {
      role: String(turn?.role || "unknown").slice(0, 24),
      text,
      toolNames: [...new Set((Array.isArray(turn?.tool_calls) ? turn.tool_calls : [])
        .map((tool) => String(tool?.name || "").trim().slice(0, 80)).filter(Boolean))].slice(0, 10),
    };
  }).filter((turn) => turn.text || turn.toolNames.length);
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && leftBuffer.length > 0 && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

class CartesiaOutboundCallService {
  constructor(options = {}) {
    this.client = options.client;
    this.db = options.db;
    this.outboundSafety = options.outboundSafety || null;
    this.approvalSecret = String(options.approvalSecret || "");
    this.approvalTtlMs = Math.min(5 * 60 * 1000, Math.max(30 * 1000, Number(options.approvalTtlMs) || 5 * 60 * 1000));
    this.now = options.now || Date.now;
  }

  assertDispatchReady() {
    if (!this.client?.isConfigured?.()) {
      throw serviceError("cartesia_not_configured", "Cartesia outbound calling is disabled or not configured", 503);
    }
    if (this.approvalSecret.length < 32) {
      throw serviceError("cartesia_approval_unavailable", "Cartesia approval signing is not configured", 503);
    }
  }

  async listAgentInventory() {
    const readConfigured = typeof this.client?.isReadConfigured === "function"
      ? this.client.isReadConfigured()
      : this.client?.isConfigured?.();
    if (!readConfigured || typeof this.client?.listAgents !== "function") {
      throw serviceError("cartesia_not_configured", "Cartesia agent inventory is unavailable", 503);
    }
    const response = await this.client.listAgents();
    const agents = Array.isArray(response?.data) ? response.data : response?.summaries;
    if (!Array.isArray(agents)) {
      throw serviceError("cartesia_agent_list_invalid", "Cartesia returned an invalid agent inventory", 502);
    }

    let numbersByAgent = null;
    if (typeof this.client.listPhoneNumbers === "function") {
      const phoneResponse = await this.client.listPhoneNumbers({ limit: 100 });
      if (!Array.isArray(phoneResponse?.data)) {
        throw serviceError("cartesia_phone_number_list_invalid", "Cartesia returned an invalid phone number inventory", 502);
      }
      numbersByAgent = new Map();
      for (const phone of phoneResponse.data.slice(0, 100)) {
        const phoneId = String(phone?.id || "").trim();
        const agentId = String(phone?.agent?.id || phone?.agent_id || "").trim();
        if (!ID_PATTERN.test(phoneId) || !ID_PATTERN.test(agentId)) continue;
        if (!numbersByAgent.has(agentId)) numbersByAgent.set(agentId, []);
        numbersByAgent.get(agentId).push({ id: phoneId, number: phone?.number });
      }
    }

    return agents.slice(0, 100).map((agent) => {
      const id = String(agent?.id || "").trim();
      if (!ID_PATTERN.test(id)) return null;
      const deleted = Boolean(agent?.deleted_at);
      const attachedNumbers = numbersByAgent ? numbersByAgent.get(id) || [] : agent?.phone_numbers;
      const phoneNumbers = (Array.isArray(attachedNumbers) ? attachedNumbers : []).slice(0, 50)
        .map((phone) => {
          const phoneId = String(phone?.id || "").trim();
          if (!ID_PATTERN.test(phoneId)) return null;
          return { id: phoneId, displayNumber: maskProviderNumber(phone?.number) };
        }).filter(Boolean);
      return {
        id,
        name: String(agent?.name || "Unnamed Cartesia agent").trim().slice(0, 120),
        deleted,
        deploymentCount: Math.max(0, Number(agent?.deployment_count) || 0),
        phoneNumbers,
        ready: !deleted && phoneNumbers.length > 0,
      };
    }).filter(Boolean);
  }

  async getAgentDeploymentHealth(input = {}) {
    const agentId = String(input.agentId || input.agent_id || "").trim();
    if (!ID_PATTERN.test(agentId)) {
      throw serviceError("cartesia_agent_id_invalid", "A valid Cartesia agent ID is required", 400);
    }
    const readConfigured = typeof this.client?.isReadConfigured === "function"
      ? this.client.isReadConfigured()
      : this.client?.isConfigured?.();
    if (!readConfigured || typeof this.client?.getAgent !== "function" || typeof this.client?.listAgentDeployments !== "function") {
      throw serviceError("cartesia_not_configured", "Cartesia agent health is unavailable", 503);
    }
    const [agent, deployments] = await Promise.all([
      this.client.getAgent(agentId),
      this.client.listAgentDeployments(agentId),
    ]);
    if (!agent || String(agent.id || "") !== agentId || !Array.isArray(deployments)) {
      throw serviceError("cartesia_agent_health_invalid", "Cartesia returned invalid agent health data", 502);
    }
    const deleted = Boolean(agent.deleted_at);
    const attachedNumberCount = (Array.isArray(agent.phone_numbers) ? agent.phone_numbers : [])
      .filter((phone) => ID_PATTERN.test(String(phone?.id || ""))).length;
    const normalizedDeployments = deployments.slice(0, 100).map((deployment) => {
      const id = String(deployment?.id || "").trim();
      if (!ID_PATTERN.test(id) || String(deployment?.agent_id || agentId) !== agentId) return null;
      const buildFailed = Boolean(deployment?.build_error);
      const deploymentFailed = Boolean(deployment?.deployment_error);
      return {
        id,
        versionId: ID_PATTERN.test(String(deployment?.version_id || "")) ? String(deployment.version_id) : null,
        status: String(deployment?.status || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40) || "unknown",
        isLive: deployment?.is_live === true,
        isPinned: deployment?.is_pinned === true,
        createdAt: typeof deployment?.created_at === "string" ? deployment.created_at.slice(0, 40) : null,
        updatedAt: typeof deployment?.updated_at === "string" ? deployment.updated_at.slice(0, 40) : null,
        buildCompletedAt: typeof deployment?.build_completed_at === "string" ? deployment.build_completed_at.slice(0, 40) : null,
        buildFailed,
        deploymentFailed,
      };
    }).filter(Boolean);
    const warnings = [];
    if (deleted) warnings.push("agent_deleted");
    if (attachedNumberCount === 0) warnings.push("no_attached_phone_number");
    if (normalizedDeployments.length === 0) warnings.push("no_deployments");
    if (!normalizedDeployments.some((deployment) => deployment.isLive)) warnings.push("no_live_deployment");
    if (normalizedDeployments.some((deployment) => deployment.buildFailed)) warnings.push("deployment_build_failed");
    if (normalizedDeployments.some((deployment) => deployment.deploymentFailed)) warnings.push("deployment_failed");
    return {
      agent: {
        id: agentId,
        name: String(agent.name || "Unnamed Cartesia agent").trim().slice(0, 120),
        deleted,
        attachedNumberCount,
        deploymentCount: Math.max(0, Number(agent.deployment_count) || normalizedDeployments.length),
      },
      deployments: normalizedDeployments,
      ready: warnings.length === 0,
      warnings,
    };
  }

  async assertAgentSourceReady(input = {}) {
    const agents = await this.listAgentInventory();
    const agent = agents.find((entry) => entry.id === input.agentId && entry.ready);
    if (!agent || !agent.phoneNumbers.some((phone) => phone.id === input.fromNumberId)) {
      throw serviceError("cartesia_agent_source_not_ready", "Select an active Cartesia agent and one of its attached phone numbers", 409);
    }
    if (typeof this.db?.getCartesiaPhoneNumberBusinessScope === "function") {
      const scope = await this.db.getCartesiaPhoneNumberBusinessScope(input.fromNumberId);
      if (scope && (scope.business_id !== input.businessId || scope.agent_id !== input.agentId)) {
        throw serviceError("cartesia_phone_business_scope_conflict", "This Cartesia phone number is assigned to a different business or agent", 409);
      }
    }
    return agent;
  }

  async listCallsForOperations(input = {}) {
    const agentId = String(input.agentId || input.agent_id || "").trim();
    const businessId = String(input.businessId || input.business_id || "").trim();
    const actorId = String(input.actorId || input.actor_id || "").trim();
    const startingAfter = String(input.startingAfter || input.starting_after || "").trim();
    const limit = Math.max(1, Math.min(25, Number(input.limit) || 25));
    const reviewQueue = input.reviewQueue === true || input.review_queue === true;
    if (!ID_PATTERN.test(agentId) || !BUSINESS_ID_PATTERN.test(businessId) || !/^\d{1,20}$/.test(actorId) ||
        (startingAfter && !ID_PATTERN.test(startingAfter))) {
      throw serviceError("cartesia_call_list_query_invalid", "A valid Cartesia agent, business, actor, and pagination cursor are required", 400);
    }
    if (typeof this.client?.listCalls !== "function" || typeof this.db?.getCartesiaCallBusinessScope !== "function" ||
        typeof this.outboundSafety?.authorizeActor !== "function") {
      throw serviceError("cartesia_call_dependencies_missing", "Cartesia call listing is unavailable", 503);
    }
    await this.outboundSafety.authorizeActor({ business_id: businessId, actor_id: actorId });
    const now = this.now();
    const startTimeGte = String(input.startTimeGte || input.start_time_gte || new Date(now - 24 * 60 * 60 * 1000).toISOString());
    const startTimeLte = String(input.startTimeLte || input.start_time_lte || new Date(now + 60_000).toISOString());
    const lower = Date.parse(startTimeGte);
    const upper = Date.parse(startTimeLte);
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper < lower || upper > now + 60_000 || upper - lower > 7 * 24 * 60 * 60 * 1000) {
      throw serviceError("cartesia_call_list_query_invalid", "Cartesia call history must use a valid time range of seven days or less", 400);
    }
    const reviewRules = reviewQueue ? normalizeReviewRules(await this.db.getCartesiaCallReviewRules(businessId)) : null;
    const expandTranscript = reviewQueue && reviewRules.review_tool_calls;
    const result = await this.client.listCalls({ agentId, startTimeGte: new Date(lower).toISOString(), startTimeLte: new Date(upper).toISOString(), limit, startingAfter, expandTranscript });
    if (!Array.isArray(result?.data)) {
      throw serviceError("cartesia_call_list_invalid", "Cartesia returned an invalid call list", 502);
    }
    const scopedCalls = [];
    for (const providerCall of result.data.slice(0, limit)) {
      const call = normalizeOperationsCall(providerCall, reviewQueue);
      if (!call || call.agentId !== agentId) continue;
      const scope = await this.db.getCartesiaCallBusinessScope(call.callId);
      if (scope !== businessId) continue;
      if (reviewQueue) {
        if (!['completed', 'failed'].includes(call.status)) continue;
        call.review = assessCallForReview(call, reviewRules);
        if (!call.review.required) continue;
      }
      scopedCalls.push(call);
    }
    return {
      calls: scopedCalls,
      reviewQueue,
      hasMore: result.has_more === true,
      nextPage: typeof result.next_page === "string" && ID_PATTERN.test(result.next_page) ? result.next_page : null,
    };
  }

  async getCallForOperations(callId, options = {}) {
    const id = String(callId || "").trim();
    if (!ID_PATTERN.test(id) || typeof this.client?.getCall !== "function") {
      throw serviceError("cartesia_call_id_invalid", "A valid Cartesia call ID is required", 400);
    }
    if (options.businessId || options.business_id || options.includeReviewDetails === true) {
      await this._assertCallBusinessAccess(id, options.businessId || options.business_id, options.actorId || options.actor_id);
    }
    const providerCall = await this.client.getCall(id);
    const call = normalizeOperationsCall(providerCall, options.includeReviewDetails === true);
    if (!call || call.callId !== id) {
      throw serviceError("cartesia_call_record_mismatch", "Cartesia returned a call record that does not match the requested call", 502);
    }
    if (options.includeTranscript === true && call.status !== "completed") {
      throw serviceError("cartesia_call_transcript_unavailable", "Transcript review is available only after a call has completed", 409);
    }
    if (options.includeReviewDetails === true) {
      if (typeof this.db?.getCartesiaCallReviewRules !== "function") {
        throw serviceError("cartesia_call_dependencies_missing", "Cartesia call review rules are unavailable", 503);
      }
      const savedRules = await this.db.getCartesiaCallReviewRules(String(options.businessId || options.business_id));
      call.review = assessCallForReview(call, normalizeReviewRules(savedRules || {}));
    }
    if (options.includeTranscript === true) {
      call.transcript = normalizeReviewTranscript(providerCall);
    }
    return call;
  }

  async getCallAudioForOperations(callId, options = {}) {
    await this._assertCallBusinessAccess(callId, options.businessId || options.business_id, options.actorId || options.actor_id);
    const call = await this.getCallForOperations(callId);
    if (!new Set(["completed", "failed"]).has(call.status)) {
      throw serviceError("cartesia_call_audio_unavailable", "Recording download is available only after a call has ended", 409);
    }
    if (call.zdrEnabled === true || call.redactedAt) {
      throw serviceError("cartesia_call_audio_unavailable", "This call has no retained recording", 409);
    }
    if (typeof this.client?.getCallAudio !== "function") throw serviceError("cartesia_call_dependencies_missing", "Cartesia call recording access is unavailable", 503);
    const result = await this.client.getCallAudio(call.callId);
    if (!Buffer.isBuffer(result?.bytes) || !result.bytes.length) throw serviceError("cartesia_call_audio_invalid", "Cartesia returned an invalid call recording", 502);
    return result;
  }

  async redactCallData(callId, options = {}) {
    await this._assertCallBusinessAccess(callId, options.businessId || options.business_id, options.actorId || options.actor_id);
    const call = await this.getCallForOperations(callId);
    if (!new Set(["completed", "failed"]).has(call.status)) {
      throw serviceError("cartesia_call_redaction_unavailable", "Call data can be deleted only after the call has ended", 409);
    }
    if (call.redactedAt || call.zdrEnabled === true) return { deleted: true, alreadyRemoved: true, callId: call.callId };
    if (typeof this.client?.deleteCall !== "function") throw serviceError("cartesia_call_dependencies_missing", "Cartesia call-data deletion is unavailable", 503);
    const result = await this.client.deleteCall(call.callId);
    if (result?.deleted !== true) throw serviceError("cartesia_call_redaction_unconfirmed", "Cartesia did not confirm call-data deletion; refresh the call record before retrying", 502);
    return { deleted: true, alreadyRemoved: false, callId: call.callId };
  }

  async _assertCallBusinessAccess(callId, businessId, actorId) {
    const business = String(businessId || "").trim();
    const actor = String(actorId || "").trim();
    if (!BUSINESS_ID_PATTERN.test(business) || !/^\d{1,20}$/.test(actor)) {
      throw serviceError("cartesia_call_business_scope_required", "A valid business and authenticated actor are required", 400);
    }
    if (typeof this.outboundSafety?.authorizeActor !== "function" || typeof this.db?.getCartesiaCallBusinessScope !== "function") {
      throw serviceError("cartesia_call_dependencies_missing", "Cartesia business call scope is unavailable", 503);
    }
    await this.outboundSafety.authorizeActor({ business_id: business, actor_id: actor });
    const callBusiness = await this.db.getCartesiaCallBusinessScope(callId);
    if (callBusiness !== business) throw serviceError("cartesia_call_not_found", "Cartesia call was not found in this business scope", 404);
    return business;
  }

  async getCallReviewRules(input = {}) {
    const businessId = String(input.businessId || input.business_id || "").trim();
    const actorId = String(input.actorId || input.actor_id || "").trim();
    if (typeof this.db?.getCartesiaCallReviewRules !== "function") {
      throw serviceError("cartesia_call_dependencies_missing", "Cartesia call review rules are unavailable", 503);
    }
    if (!BUSINESS_ID_PATTERN.test(businessId) || !/^\d{1,20}$/.test(actorId)) throw serviceError("cartesia_review_rules_invalid", "A valid business and authenticated actor are required", 400);
    if (typeof this.outboundSafety?.authorizeActor !== "function") throw serviceError("cartesia_call_dependencies_missing", "Cartesia business access checks are unavailable", 503);
    await this.outboundSafety.authorizeActor({ business_id: businessId, actor_id: actorId });
    const value = await this.db.getCartesiaCallReviewRules(businessId);
    return normalizeReviewRules(value || {});
  }

  async saveCallReviewRules(input = {}) {
    const rules = input.rules || input;
    const allowed = ["review_failed_calls", "review_tool_calls", "review_missing_summary"];
    if (!rules || typeof rules !== "object" || Array.isArray(rules) || Object.keys(rules).some((key) => !allowed.includes(key)) ||
        allowed.some((key) => typeof rules[key] !== "boolean")) {
      throw serviceError("cartesia_review_rules_invalid", "Provide all three Cartesia call review rules as true or false", 400);
    }
    if (typeof this.db?.saveCartesiaCallReviewRules !== "function") {
      throw serviceError("cartesia_call_dependencies_missing", "Cartesia call review rules are unavailable", 503);
    }
    const businessId = String(input.businessId || input.business_id || "").trim();
    const actorId = String(input.actorId || input.actor_id || "").trim();
    if (!BUSINESS_ID_PATTERN.test(businessId) || !/^\d{1,20}$/.test(actorId)) throw serviceError("cartesia_review_rules_invalid", "A valid business and authenticated actor are required", 400);
    if (typeof this.outboundSafety?.authorizeActor !== "function") throw serviceError("cartesia_call_dependencies_missing", "Cartesia business access checks are unavailable", 503);
    await this.outboundSafety.authorizeActor({ business_id: businessId, actor_id: actorId });
    return this.db.saveCartesiaCallReviewRules({ ...rules, business_id: businessId, updated_by: actorId });
  }

  async cancelStartedCall(callId, options = {}) {
    const call = await this.getCallForOperations(callId, options);
    if (call.status !== "started") {
      throw serviceError("cartesia_call_not_cancellable", "Only a currently started Cartesia call can be cancelled", 409);
    }
    if (typeof this.client?.cancelCall !== "function") {
      throw serviceError("cartesia_call_dependencies_missing", "Cartesia call cancellation is unavailable", 503);
    }
    const result = await this.client.cancelCall(call.callId);
    if (result?.cancelled !== true) {
      throw serviceError("cartesia_call_cancel_unconfirmed", "Cartesia did not confirm cancellation; refresh call status before retrying", 502);
    }
    return { cancelled: true, call: { ...call, status: "completed", endReason: "api_cancelled", canCancel: false } };
  }

  async createApproval(input = {}) {
    this.assertDispatchReady();
    const normalized = normalizeCallInput(input);
    const confirmationPhrase = String(input.confirmationPhrase || input.confirmation_phrase || "");
    if (!constantTimeEqual(confirmationPhrase, buildCartesiaConfirmationPhrase(normalized))) {
      throw serviceError("cartesia_confirmation_required", "The exact Cartesia call confirmation phrase is required", 400);
    }
    if (typeof this.outboundSafety?.authorizeActor !== "function") {
      throw serviceError("outbound_business_operator_required", "A verified business call operator is required", 403);
    }
    await this.outboundSafety.authorizeActor({ business_id: normalized.businessId, actor_id: normalized.actorId });
    await this.assertAgentSourceReady(normalized);
    const claims = {
      version: 1,
      actor_id: normalized.actorId,
      business_id: normalized.businessId,
      request_fingerprint: hashRequest(normalized),
      idempotency_key_hash: crypto.createHash("sha256").update(normalized.idempotencyKey).digest("hex"),
      expires_at: this.now() + this.approvalTtlMs,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = crypto.createHmac("sha256", this.approvalSecret).update(payload).digest("base64url");
    return { approvalToken: `${payload}.${signature}`, requestFingerprint: claims.request_fingerprint, expiresAt: claims.expires_at };
  }

  verifyApproval(token, normalized) {
    const [payload, signature, extra] = String(token || "").split(".");
    if (!payload || !signature || extra !== undefined) {
      throw serviceError("cartesia_approval_required", "A valid call approval is required", 403);
    }
    const expected = crypto.createHmac("sha256", this.approvalSecret).update(payload).digest("base64url");
    if (!constantTimeEqual(signature, expected)) {
      throw serviceError("cartesia_approval_invalid", "Call approval is invalid or expired", 403);
    }
    let claims;
    try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
    catch { throw serviceError("cartesia_approval_invalid", "Call approval is invalid or expired", 403); }
    const matches = claims?.version === 1 && claims.actor_id === normalized.actorId &&
      claims.business_id === normalized.businessId && claims.request_fingerprint === hashRequest(normalized) &&
      claims.idempotency_key_hash === crypto.createHash("sha256").update(normalized.idempotencyKey).digest("hex") &&
      Number.isSafeInteger(claims.expires_at) && claims.expires_at > this.now();
    if (!matches) throw serviceError("cartesia_approval_invalid", "Call approval is invalid or expired", 403);
  }

  resolveExisting(existing, normalized, requestHash) {
    if (!existing || existing.provider !== "cartesia" || existing.request_hash !== requestHash) {
      throw serviceError("cartesia_idempotency_conflict", "Idempotency key was already used for a different call", 409);
    }
    if (existing.status === "completed" && existing.response_payload) {
      let result = {};
      try { result = typeof existing.response_payload === "string" ? JSON.parse(existing.response_payload) : existing.response_payload; }
      catch {}
      if (result.providerCallId) return { ...result, idempotentReplay: true };
    }
    if (existing.status === "failed") {
      throw serviceError("cartesia_previous_call_failed", "The prior Cartesia call was rejected; use a new request key only after reviewing the failure", 409);
    }
    throw serviceError("cartesia_call_outcome_unresolved", "The prior Cartesia call outcome is unresolved; reconcile it before retrying", 409);
  }

  async createOutboundCall(input = {}) {
    this.assertDispatchReady();
    const normalized = normalizeCallInput(input);
    this.verifyApproval(input.approvalToken || input.approval_token, normalized);
    const requestHash = hashRequest(normalized);
    const idempotencyKey = `cartesia:${normalized.idempotencyKey}`;
    if (typeof this.db?.getOutboundCallIdempotency !== "function" ||
        typeof this.db?.reserveOutboundCallIdempotency !== "function" ||
        typeof this.db?.completeOutboundCallIdempotency !== "function") {
      throw serviceError("cartesia_call_dependencies_missing", "Cartesia idempotency storage is unavailable", 503);
    }

    const previous = await this.db.getOutboundCallIdempotency(idempotencyKey);
    if (previous) {
      if (typeof this.outboundSafety?.authorizeActor !== "function") {
        throw serviceError("outbound_business_operator_required", "A verified business call operator is required", 403);
      }
      await this.outboundSafety.authorizeActor({ business_id: normalized.businessId, actor_id: normalized.actorId });
      return this.resolveExisting(previous, normalized, requestHash);
    }
    if (typeof this.outboundSafety?.reserveDispatch !== "function") {
      throw serviceError("outbound_contact_policy_unavailable", "Outbound call safety is unavailable; no call was placed", 503);
    }

    const safetyReservation = await this.outboundSafety.reserveDispatch({
      business_id: normalized.businessId,
      actor_id: normalized.actorId,
      destination: normalized.destination,
      provider: "cartesia",
      idempotency_key: normalized.idempotencyKey,
    });
    let reservation;
    try {
      reservation = await this.db.reserveOutboundCallIdempotency({
        idempotency_key: idempotencyKey,
        provider: "cartesia",
        business_id: normalized.businessId,
        request_hash: requestHash,
      });
    } catch (error) {
      if (!safetyReservation?.idempotentReplay) await this.outboundSafety.completeDispatch(safetyReservation, "released");
      throw error;
    }
    if (!reservation?.reserved) {
      if (!safetyReservation?.idempotentReplay) await this.outboundSafety.completeDispatch(safetyReservation, "released");
      return this.resolveExisting(await this.db.getOutboundCallIdempotency(idempotencyKey), normalized, requestHash);
    }

    let result;
    try {
      result = await this.client.createOutboundCall({
        agentId: normalized.agentId,
        fromNumberId: normalized.fromNumberId,
        toNumber: normalized.destination,
        ringingTimeoutSeconds: 30,
        maxCallDurationMinutes: 30,
        dynamicVariables: { ...normalized.dynamicVariables, voicednut_request_id: buildCorrelationId(normalized.idempotencyKey) },
      });
    } catch (error) {
      const state = String(error?.providerSubmissionState || "unknown");
      if (state === "rejected" || state === "not_submitted") {
        await this.db.completeOutboundCallIdempotency({
          idempotency_key: idempotencyKey,
          provider: "cartesia",
          business_id: normalized.businessId,
          request_hash: requestHash,
          status: "failed",
          error_message: String(error?.code || "cartesia_call_rejected").slice(0, 100),
        });
        await this.outboundSafety.completeDispatch(safetyReservation, "released");
      }
      throw error;
    }

    const providerCallId = String(result?.providerCallId || "").trim();
    if (!providerCallId || providerCallId.length > 200) {
      throw serviceError("cartesia_call_outcome_unknown", "Cartesia accepted a request without a usable call ID; reconcile before retrying", 502);
    }
    const response = { providerCallId, status: String(result.status || "queued").toLowerCase() };
    await this.db.completeOutboundCallIdempotency({
      idempotency_key: idempotencyKey,
      provider: "cartesia",
      business_id: normalized.businessId,
      request_hash: requestHash,
      call_sid: providerCallId,
      status: "completed",
      response_payload: response,
    });
    await this.outboundSafety.completeDispatch(safetyReservation, "accepted");
    return { ...response, idempotentReplay: false };
  }

  async reconcileOutboundCall(input = {}) {
    const readConfigured = typeof this.client?.isReadConfigured === "function"
      ? this.client.isReadConfigured()
      : this.client?.isConfigured?.();
    if (!readConfigured) {
      throw serviceError("cartesia_not_configured", "Cartesia call lookup is disabled or not configured", 503);
    }
    const normalized = normalizeCallInput(input);
    if (typeof this.outboundSafety?.authorizeActor !== "function") {
      throw serviceError("outbound_business_operator_required", "A verified business call operator is required", 403);
    }
    await this.outboundSafety.authorizeActor({ business_id: normalized.businessId, actor_id: normalized.actorId });
    if (typeof this.db?.getOutboundCallIdempotency !== "function") {
      throw serviceError("cartesia_call_dependencies_missing", "Cartesia idempotency storage is unavailable", 503);
    }

    const idempotencyKey = `cartesia:${normalized.idempotencyKey}`;
    const existing = await this.db.getOutboundCallIdempotency(idempotencyKey);
    if (!existing || existing.provider !== "cartesia") {
      throw serviceError("cartesia_call_reservation_not_found", "No Cartesia request was found for this key", 404);
    }
    const submittedHash = hashRequest(normalized);
    const fingerprintMatches = typeof input.request_fingerprint === "string" && /^[a-f0-9]{64}$/.test(input.request_fingerprint) &&
      constantTimeEqual(input.request_fingerprint, existing.request_hash);
    const canRecoverWithoutVariables = Object.keys(normalized.dynamicVariables).length === 0 && fingerprintMatches;
    if (existing.request_hash !== submittedHash && !canRecoverWithoutVariables) {
      throw serviceError("cartesia_idempotency_conflict", "Request details do not match the saved Cartesia request", 409);
    }
    if (existing.status === "failed") {
      return { outcome: "rejected", status: "failed", call: null };
    }

    const verifyCall = async (providerCallId) => {
      const call = normalizeCartesiaCall(await this.client.getCall(providerCallId));
      if (!call || call.callId !== providerCallId || call.agentId !== normalized.agentId) {
        throw serviceError("cartesia_call_record_mismatch", "Cartesia returned a call record that does not match this request", 409);
      }
      return call;
    };

    if (existing.call_sid) {
      const call = await verifyCall(String(existing.call_sid));
      return { outcome: "reconciled", status: call.status, call };
    }
    if (existing.status !== "pending") {
      return { outcome: "unresolved", reason: "provider_call_id_unavailable", status: "unknown", call: null };
    }

    const createdAt = parseStoredTimestamp(existing.created_at);
    const ageMs = this.now() - createdAt;
    if (!Number.isFinite(createdAt) || ageMs < -60_000 || ageMs > MAX_RECONCILIATION_AGE_MS) {
      return { outcome: "unresolved", reason: "outside_reconciliation_window", status: "unknown", call: null };
    }
    if (typeof this.client.listCalls !== "function") {
      throw serviceError("cartesia_call_dependencies_missing", "Cartesia call-list lookup is unavailable", 503);
    }

    const lowerBound = createdAt - 5_000;
    const startTimeGte = new Date(lowerBound).toISOString();
    const candidates = new Map();
    let startingAfter = "";
    let searchComplete = false;
    for (let page = 0; page < 2; page += 1) {
      const result = await this.client.listCalls({
        agentId: normalized.agentId,
        startTimeGte,
        limit: 100,
        startingAfter,
      });
      const records = Array.isArray(result?.data) ? result.data : null;
      if (!records) throw serviceError("cartesia_call_list_invalid", "Cartesia returned an invalid call list", 502);
      for (const record of records) {
        const call = normalizeCartesiaCall(record);
        const destination = String(record?.telephony_params?.to || "").trim();
        const correlationId = String(record?.dynamic_variables?.voicednut_request_id || "").trim();
        const startedAt = Date.parse(String(record?.start_time || ""));
        if (call && call.agentId === normalized.agentId && destination === normalized.destination &&
            correlationId === buildCorrelationId(normalized.idempotencyKey) &&
            Number.isFinite(startedAt) && startedAt >= lowerBound && startedAt <= this.now() + 60_000) {
          candidates.set(call.callId, call);
        }
      }
      if (candidates.size > 1) {
        searchComplete = true;
        break;
      }
      if (result.has_more !== true) {
        searchComplete = true;
        break;
      }
      startingAfter = String(result.next_page || "").trim();
      if (!startingAfter) break;
    }

    if (!searchComplete) {
      return { outcome: "unresolved", reason: "search_incomplete", status: "unknown", call: null };
    }
    if (candidates.size === 0) {
      return { outcome: "unresolved", reason: "no_matching_call_yet", status: "unknown", call: null };
    }
    if (candidates.size > 1) {
      return { outcome: "unresolved", reason: "multiple_matching_calls", status: "unknown", call: null };
    }

    const call = candidates.values().next().value;
    await this.db.completeOutboundCallIdempotency({
      idempotency_key: idempotencyKey,
      provider: "cartesia",
      business_id: normalized.businessId,
      request_hash: existing.request_hash,
      call_sid: call.callId,
      status: "completed",
      response_payload: { providerCallId: call.callId, status: call.status, reconciled: true },
    });
    if (typeof this.outboundSafety?.completeDispatch === "function") {
      await this.outboundSafety.completeDispatch({ reservationKey: `cartesia:${crypto.createHash("sha256").update(normalized.idempotencyKey).digest("hex")}` }, "accepted");
    }
    return { outcome: "reconciled", status: call.status, call };
  }
}

module.exports = {
  CartesiaOutboundCallService,
  buildCartesiaConfirmationPhrase,
  normalizeCallInput,
  hashRequest,
  buildCorrelationId,
  normalizeDynamicVariables,
  normalizeCartesiaCall,
  normalizeOperationsCall,
  normalizeReviewRules,
  assessCallForReview,
  normalizeReviewTranscript,
  parseStoredTimestamp,
};
