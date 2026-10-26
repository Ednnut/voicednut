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
    const requestHash = crypto.createHash("sha256").update(JSON.stringify({
      templateId: Number(input.templateId) || null,
      templateVersion: requestedTemplateVersion,
      mappingId,
      phoneNumberId,
      number,
    })).digest("hex");
    const previous = await this.db.getOutboundCallIdempotency(idempotencyKey);
    if (previous) return resolveExistingRequest(previous, requestHash);

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

    const reservation = await this.db.reserveOutboundCallIdempotency({
      idempotency_key: idempotencyKey,
      provider: "vapi",
      request_hash: requestHash,
    });
    if (!reservation?.reserved) {
      const existing = await this.db.getOutboundCallIdempotency(idempotencyKey);
      return resolveExistingRequest(existing, requestHash);
    }

    // A create-call timeout can have an unknown remote outcome. Do not retry here.
    const request = {
      assistantId: String(mapping.vapi_assistant_id).trim(),
      ...(String(mapping.vapi_assistant_version || "").trim()
        ? { assistantVersion: String(mapping.vapi_assistant_version).trim() }
        : {}),
      phoneNumberId,
      customer: { number },
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
    };
    await this.db.completeOutboundCallIdempotency({
      idempotency_key: idempotencyKey,
      provider: "vapi",
      request_hash: requestHash,
      call_sid: providerCallId,
      status: "completed",
      response_payload: result,
    });
    return result;
  }
}

module.exports = { VapiOutboundCallService };
