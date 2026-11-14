const crypto = require("node:crypto");

function readSummary(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function vapiCallError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeAssistantOverrides(input, template) {
  const firstMessage = input.firstMessage === undefined || input.firstMessage === null
    ? ""
    : String(input.firstMessage);
  if (firstMessage.length > 4000) {
    throw vapiCallError("vapi_first_message_invalid", "Vapi first message is too long");
  }
  const supplied = input.variableValues && typeof input.variableValues === "object" && !Array.isArray(input.variableValues)
    ? input.variableValues
    : {};
  if (Object.keys(supplied).length > 50) {
    throw vapiCallError("vapi_variables_invalid", "Vapi call has too many template variables");
  }
  const source = `${String(template?.prompt || "")} ${String(template?.first_message || "")}`;
  const allowed = new Set([...source.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((match) => match[1]));
  const variableValues = {};
  for (const [key, rawValue] of Object.entries(supplied)) {
    if (!allowed.has(key) || typeof rawValue !== "string" || rawValue.length > 1000) {
      throw vapiCallError("vapi_variables_invalid", "Vapi variables must match the selected script placeholders");
    }
    variableValues[key] = rawValue;
  }
  return {
    ...(firstMessage ? { firstMessage } : {}),
    ...(Object.keys(variableValues).length ? { variableValues } : {}),
  };
}

function resolveExistingRequest(existing, requestHash) {
  if (!existing || existing.provider !== "vapi" || existing.request_hash !== requestHash) {
    throw vapiCallError("vapi_idempotency_conflict", "Idempotency key was already used for a different request");
  }
  if (existing.status === "completed" && existing.response_payload) {
    let previous = {};
    try {
      previous = typeof existing.response_payload === "string"
        ? JSON.parse(existing.response_payload)
        : existing.response_payload;
    } catch {}
    if (previous.providerCallId) return { ...previous, idempotentReplay: true };
  }
  if (existing.status === "failed") {
    throw vapiCallError("vapi_previous_call_failed", "The call request previously failed; submit a new idempotency key to try again");
  }
  throw vapiCallError("vapi_call_outcome_unresolved", "The prior Vapi call outcome is unresolved; do not retry with a new key until reconciled");
}

class VapiOutboundCallService {
  constructor(options = {}) {
    this.client = options.client;
    this.db = options.db;
    this.getMapping = options.getMapping;
    this.getTemplate = options.getTemplate;
    this.outboundSafety = options.outboundSafety || null;
  }

  async createOutboundCall(input = {}) {
    const mappingId = Number(input.mappingId);
    const phoneNumberId = String(input.phoneNumberId || "").trim();
    const number = String(input.number || "").trim();
    const callerKey = String(input.idempotencyKey || "").trim();
    const requestedTemplateVersion = input.templateVersion === undefined || input.templateVersion === null
      ? null
      : Number(input.templateVersion);
    if (requestedTemplateVersion !== null && (!Number.isSafeInteger(requestedTemplateVersion) || requestedTemplateVersion <= 0)) {
      throw vapiCallError("vapi_mapping_stale", "Requested template version is invalid");
    }
    if (!Number.isSafeInteger(mappingId) || mappingId <= 0) {
      throw vapiCallError("vapi_mapping_required", "A Vapi template mapping ID is required");
    }
    if (!phoneNumberId || phoneNumberId.length > 200) {
      throw vapiCallError("vapi_phone_number_id_required", "A Vapi phone number ID is required");
    }
    if (!/^\+[1-9]\d{1,14}$/.test(number)) {
      throw vapiCallError("vapi_destination_invalid", "Destination number must use E.164 format");
    }
    if (!/^[A-Za-z0-9._:-]{8,180}$/.test(callerKey)) {
      throw vapiCallError("vapi_idempotency_key_required", "A valid idempotency key is required");
    }
    if (!this.client?.isConfigured?.()) {
      throw vapiCallError("vapi_not_configured", "Vapi calling is disabled or not configured");
    }
    if (typeof this.db?.reserveOutboundCallIdempotency !== "function" ||
        typeof this.db?.getOutboundCallIdempotency !== "function" ||
        typeof this.db?.completeOutboundCallIdempotency !== "function") {
      throw vapiCallError("vapi_call_dependencies_missing", "Vapi call idempotency storage is unavailable");
    }

    const idempotencyKey = `vapi:${callerKey}`;
    const rawVariableValues = input.variableValues && typeof input.variableValues === "object" && !Array.isArray(input.variableValues)
      ? Object.fromEntries(Object.entries(input.variableValues).sort(([left], [right]) => left.localeCompare(right)))
      : {};
    const requestHash = crypto.createHash("sha256").update(JSON.stringify({
      templateId: Number(input.templateId) || null,
      templateVersion: requestedTemplateVersion,
      mappingId,
      phoneNumberId,
      number,
      firstMessage: input.firstMessage || null,
      variableValues: rawVariableValues,
    })).digest("hex");
    const previous = await this.db.getOutboundCallIdempotency(idempotencyKey);
    if (previous) {
      const resolution = resolveExistingRequest(previous, requestHash);
      if (resolution.idempotentReplay === true) {
        const previousResult = resolution;
        const template = await this.getTemplate(Number(previousResult.templateId || input.templateId));
        if (!template || typeof this.outboundSafety?.authorizeActor !== "function") {
          throw vapiCallError("outbound_business_operator_required", "A verified business operator is required to access this call result");
        }
        await this.outboundSafety.authorizeActor({
          business_id: template.business_id || template.businessId,
          actor_id: input.actorId || input.actor_id,
        });
        await this.recordAcceptanceEvent(previousResult).catch(() => {});
      }
      return resolution;
    }

    if (typeof this.getMapping !== "function" || typeof this.getTemplate !== "function") {
      throw vapiCallError("vapi_call_dependencies_missing", "Vapi call mapping lookup is unavailable");
    }
    const mapping = await this.getMapping(mappingId);
    if (!mapping) throw vapiCallError("vapi_mapping_not_found", "Vapi template mapping was not found");
    if (input.templateId !== undefined && Number(input.templateId) !== Number(mapping.template_id)) {
      throw vapiCallError("vapi_mapping_template_mismatch", "Vapi mapping does not belong to the requested template");
    }
    if (requestedTemplateVersion !== null && requestedTemplateVersion !== Number(mapping.template_version)) {
      throw vapiCallError("vapi_mapping_stale", "Vapi mapping does not match the requested template version");
    }
    if (mapping.compatibility_status !== "compatible" || mapping.mapping_status !== "provisioned" || mapping.sync_status !== "synced" || !String(mapping.vapi_assistant_id || "").trim()) {
      throw vapiCallError("vapi_mapping_not_ready", "Vapi template mapping is not compatible and synced");
    }
    const template = await this.getTemplate(Number(mapping.template_id));
    if (!template || Number(template.id) !== Number(mapping.template_id) || Number(template.version || 1) !== Number(mapping.template_version)) {
      throw vapiCallError("vapi_mapping_stale", "Vapi template mapping does not match the current template version");
    }
    const summary = readSummary(mapping.summary);
    if (Array.isArray(summary.unsupported) && summary.unsupported.length) {
      throw vapiCallError("vapi_template_unsupported", "Vapi mapping contains behavior that is not supported for calls");
    }
    const assistantOverrides = normalizeAssistantOverrides(input, template);

    if (!this.outboundSafety || typeof this.outboundSafety.reserveDispatch !== "function") {
      throw vapiCallError("outbound_contact_policy_unavailable", "Outbound safety is unavailable; no call was placed");
    }
    const safetyReservation = await this.outboundSafety.reserveDispatch({
      business_id: template.business_id || template.businessId,
      actor_id: input.actorId || input.actor_id,
      destination: number,
      provider: "vapi",
      idempotency_key: callerKey,
    });

    let reservation;
    try {
      reservation = await this.db.reserveOutboundCallIdempotency({
        idempotency_key: idempotencyKey,
        provider: "vapi",
        request_hash: requestHash,
      });
    } catch (error) {
      if (!safetyReservation.idempotentReplay) await this.outboundSafety.completeDispatch(safetyReservation, "released");
      throw error;
    }
    if (!reservation?.reserved) {
      if (!safetyReservation.idempotentReplay) await this.outboundSafety.completeDispatch(safetyReservation, "released");
      const existing = await this.db.getOutboundCallIdempotency(idempotencyKey);
      const replay = resolveExistingRequest(existing, requestHash);
      if (replay.providerCallId) await this.recordCommonCall(input, template, number, replay).catch(() => {});
      return replay;
    }

    // A create-call timeout can have an unknown remote outcome. Do not retry here.
    const request = {
      assistantId: String(mapping.vapi_assistant_id).trim(),
      ...(String(mapping.vapi_assistant_version || "").trim()
        ? { assistantVersion: String(mapping.vapi_assistant_version).trim() }
        : {}),
      phoneNumberId,
      customer: { number },
      ...(Object.keys(assistantOverrides).length ? { assistantOverrides } : {}),
    };
    let call;
    try {
      call = await this.client.createCall(request);
    } catch (error) {
      if (!error?.retryable) {
        await this.db.completeOutboundCallIdempotency({
          idempotency_key: idempotencyKey,
          provider: "vapi",
          request_hash: requestHash,
          status: "failed",
          error_message: String(error?.code || "vapi_call_failed").slice(0, 100),
        });
        await this.outboundSafety.completeDispatch(safetyReservation, "released");
      }
      throw error;
    }
    const providerCallId = String(call?.id || "").trim();
    if (!providerCallId) {
      throw vapiCallError("vapi_call_id_missing", "Vapi did not return a call ID");
    }
    const result = {
      providerCallId,
      status: String(call.status || "queued").trim().toLowerCase() || "queued",
      templateId: Number(mapping.template_id),
      templateVersion: Number(mapping.template_version),
      mappingId: Number(mapping.id),
      localCallId: `vapi_${providerCallId}`,
    };
    await this.db.completeOutboundCallIdempotency({
      idempotency_key: idempotencyKey,
      provider: "vapi",
      request_hash: requestHash,
      call_sid: providerCallId,
      status: "completed",
      response_payload: result,
    });
    await this.outboundSafety.completeDispatch(safetyReservation, "accepted");
    await this.recordCommonCall(input, template, number, result).catch(() => {});
    await this.recordAcceptanceEvent(result).catch(() => {});
    return result;
  }

  async recordCommonCall(input, template, number, result) {
    if (typeof this.db?.createCall !== "function") return;
    const callSid = `vapi_${result.providerCallId}`;
    const existing = typeof this.db.getCall === "function" ? await this.db.getCall(callSid).catch(() => null) : null;
    if (existing) return;
    await this.db.createCall({
      call_sid: callSid,
      phone_number: number,
      user_chat_id: String(input.actorId || input.actor_id || ""),
      direction: "outbound",
      business_id: String(template.business_id || template.businessId || "") || null,
      status: result.status,
      provider: "vapi",
      provider_call_id: result.providerCallId,
      outbound_idempotency_key: input.idempotencyKey || input.idempotency_key || null,
    });
    await this.db.updateCallState?.(callSid, "call_created", {
      provider: "vapi",
      telephony_provider: "vapi",
      provider_call_id: result.providerCallId,
      business_id: String(template.business_id || template.businessId || "") || null,
      source: "vapi_outbound",
    });
  }

  async recordAcceptanceEvent(result = {}) {
    if (typeof this.db?.recordVapiCallEvent !== "function") return;
    const callId = String(result.providerCallId || "").trim();
    if (!callId) return;
    const eventKey = crypto.createHash("sha256").update(`vapi:accepted:${callId}`).digest("hex");
    await this.db.recordVapiCallEvent({
      event_key: eventKey,
      provider_call_id: callId,
      event_type: "call_created",
      provider_status: String(result.status || "queued").toLowerCase(),
      template_id: Number(result.templateId) || null,
      template_version: Number(result.templateVersion) || null,
      event_timestamp: new Date().toISOString(),
    });
  }
}

module.exports = { VapiOutboundCallService, normalizeAssistantOverrides };
