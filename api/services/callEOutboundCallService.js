const crypto = require("node:crypto");
const { buildTask, previewCallETemplate, validateCallEResult } = require("../adapters/callETemplateAdapter");
const { normalizeCallId } = require("./callEClient");

const CALL_E_IDEMPOTENCY_PREFIX = "voicednut:call-e:";
const NO_CALL_CREATED_MARKER = "call_e_no_call_created";
const CALL_STATUSES = new Set(["queued", "in_progress", "completed", "failed", "canceled"]);
const CALL_OUTCOMES = new Set(["completed", "no_answer", "busy", "declined"]);
const RESULT_STATUSES = new Set(["pending", "available", "unavailable", "not_applicable"]);

function callEError(code, message, status = null) {
  const error = new Error(message);
  error.code = code;
  if (Number.isFinite(status)) error.status = status;
  return error;
}

function parseAllowedDestinations(value = process.env.CALLE_ALLOWED_DESTINATIONS) {
  const entries = Array.isArray(value) ? value : String(value || "").split(",");
  return new Set(entries.map((entry) => String(entry || "").trim())
    .filter((entry) => /^\+[1-9]\d{7,14}$/.test(entry)));
}

function readResponsePayload(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeCallResource(call, expectedCallId = null) {
  const providerCallId = normalizeCallId(call?.id);
  if (!providerCallId || (expectedCallId && providerCallId !== expectedCallId) || call?.object !== "call") {
    throw callEError("call_e_invalid_response", "CALL-E returned an invalid Call resource");
  }
  const status = String(call.status || "").trim().toLowerCase();
  const callOutcome = call.call_outcome == null ? null : String(call.call_outcome).trim().toLowerCase();
  const resultStatus = String(call.result_status || "").trim().toLowerCase();
  if (!CALL_STATUSES.has(status) || (callOutcome !== null && !CALL_OUTCOMES.has(callOutcome)) || !RESULT_STATUSES.has(resultStatus)) {
    throw callEError("call_e_invalid_response", "CALL-E returned an invalid Call state");
  }
  const result = resultStatus === "available" && call.result && typeof call.result === "object" && !Array.isArray(call.result)
    ? call.result
    : null;
  const rawErrorCode = call.error && typeof call.error === "object" && !Array.isArray(call.error)
    ? String(call.error.code || "").trim()
    : "";
  const errorCode = /^[a-z][a-z0-9_]{0,79}$/.test(rawErrorCode) ? rawErrorCode : (rawErrorCode ? "provider_error" : null);
  const transcript = Array.isArray(call.transcript) ? call.transcript.map((turn) => ({
    offsetSeconds: Number.isFinite(Number(turn?.offset_seconds)) ? Number(turn.offset_seconds) : null,
    speaker: ["bot", "user"].includes(String(turn?.speaker || "").toLowerCase()) ? String(turn.speaker).toLowerCase() : "unknown",
    text: typeof turn?.text === "string" ? turn.text : "",
  })) : [];

  return Object.freeze({
    provider: "call_e",
    providerCallId,
    status,
    callOutcome,
    resultStatus,
    result,
    errorCode,
    transcript,
    callId: normalizeCallId(call.call_id) || null,
    createdAt: typeof call.created_at === "string" ? call.created_at : null,
    completedAt: typeof call.completed_at === "string" ? call.completed_at : null,
  });
}

function resolveReplay(row, requestHash) {
  if (!row || row.provider !== "call_e") {
    throw callEError("call_e_idempotency_conflict", "Idempotency key is already reserved by another provider", 409);
  }
  if (row.request_hash !== requestHash) {
    if (row.status !== "failed" || row.error_message !== NO_CALL_CREATED_MARKER) {
      throw callEError("call_e_idempotency_conflict", "Idempotency key was already used for a different request", 409);
    }
    return { canCorrectRejectedRequest: true, stored: readResponsePayload(row.response_payload) };
  }
  if (row.status === "completed" && row.response_payload) {
    return { replay: { ...readResponsePayload(row.response_payload), idempotentReplay: true } };
  }
  if (row.status === "failed" && row.error_message !== NO_CALL_CREATED_MARKER) {
    throw callEError("call_e_previous_call_failed", "The prior CALL-E request failed; inspect its status before starting another call", 409);
  }
  return { canRetrySameRequest: true, stored: readResponsePayload(row.response_payload) };
}

class CallEOutboundCallService {
  constructor(options = {}) {
    this.client = options.client;
    this.db = options.db;
    this.allowedDestinations = parseAllowedDestinations(options.allowedDestinations);
  }

  async createOutboundCall(input = {}) {
    const template = input.template && typeof input.template === "object" && !Array.isArray(input.template)
      ? input.template
      : null;
    const idempotencyKey = String(input.idempotencyKey || "").trim();
    if (!template) throw callEError("call_e_template_required", "A pinned VOICEDNUT template snapshot is required", 400);
    if (!/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey)) {
      throw callEError("call_e_idempotency_key_required", "A valid idempotency key is required", 400);
    }
    if (String(template.lifecycle_state || "").toLowerCase() !== "live") {
      throw callEError("call_e_template_not_live", "CALL-E execution requires a live, pinned template version", 409);
    }
    if (!this.client?.isConfigured?.()) {
      throw callEError("call_e_not_configured", "CALL-E calling is disabled or not configured", 503);
    }
    if (!this.db || typeof this.db.reserveCallEOutboundCall !== "function" ||
        typeof this.db.getOutboundCallIdempotency !== "function" ||
        typeof this.db.completeOutboundCallIdempotency !== "function" ||
        typeof this.db.resetCallERejectedOutboundCall !== "function") {
      throw callEError("call_e_dependencies_missing", "CALL-E idempotency storage is unavailable", 503);
    }

    const preview = previewCallETemplate(template, {
      phone: input.phone,
      region: input.region,
      locale: input.locale,
      resultSchema: input.resultSchema,
    });
    if (!preview.compatible) {
      throw callEError("call_e_template_incompatible", "The selected template version is not compatible with CALL-E", 409);
    }
    const confirmedFingerprint = String(input.confirmedFingerprint || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(confirmedFingerprint) || confirmedFingerprint !== preview.fingerprint) {
      throw callEError("call_e_confirmation_mismatch", "CALL-E confirmation does not match the current request", 409);
    }
    const destination = String(input.phone || "").trim();
    if (!this.allowedDestinations.has(destination)) {
      throw callEError("call_e_destination_not_allowlisted", "CALL-E destination is not allowlisted", 403);
    }
    const idempotencyKeyForProvider = `${CALL_E_IDEMPOTENCY_PREFIX}${idempotencyKey}`;
    const requestHash = preview.fingerprint;
    const persistReconciliation = async (localId, accepted = null) => {
      if (typeof this.db.upsertCallEReconciliationRecord !== "function") return;
      await this.db.upsertCallEReconciliationRecord({
        local_call_id: localId,
        provider_call_id: accepted?.providerCallId || null,
        template_id: Number(template.id ?? template.template_id),
        template_version: Number(template.version ?? template.template_version),
        request_hash: requestHash,
        result_schema: input.resultSchema,
        execution_status: accepted?.status || null,
        call_outcome: accepted?.callOutcome || null,
        result_status: accepted?.resultStatus || null,
      });
    };
    const repairReplayRecord = async (replay) => {
      const replayLocalId = String(replay?.localCallId || "").trim();
      if (replayLocalId) {
        await persistReconciliation(replayLocalId, replay.providerCallId ? replay : null);
      }
      return replay;
    };
    const existing = await this.db.getOutboundCallIdempotency(idempotencyKeyForProvider);
    let localCallId = null;

    if (existing) {
      const resolution = resolveReplay(existing, requestHash);
      if (resolution.replay) return repairReplayRecord(resolution.replay);
      localCallId = String(resolution.stored.localCallId || "").trim() || null;
      if (resolution.canCorrectRejectedRequest) {
        localCallId = localCallId || `call_e_${crypto.randomUUID()}`;
        const reset = await this.db.resetCallERejectedOutboundCall({
          idempotency_key: idempotencyKeyForProvider,
          request_hash: requestHash,
          local_call_id: localCallId,
        });
        if (!reset?.reset) {
          const latest = await this.db.getOutboundCallIdempotency(idempotencyKeyForProvider);
          const retry = resolveReplay(latest, requestHash);
          if (retry.replay) return repairReplayRecord(retry.replay);
          if (!retry.canRetrySameRequest) {
            throw callEError("call_e_idempotency_conflict", "CALL-E request is already being recovered", 409);
          }
          localCallId = String(retry.stored.localCallId || "").trim() || null;
        }
      }
      if (existing.status === "failed" && existing.error_message === NO_CALL_CREATED_MARKER &&
          existing.request_hash === requestHash) {
        localCallId = localCallId || `call_e_${crypto.randomUUID()}`;
        const reset = await this.db.resetCallERejectedOutboundCall({
          idempotency_key: idempotencyKeyForProvider,
          request_hash: requestHash,
          local_call_id: localCallId,
        });
        if (!reset?.reset) {
          const latest = await this.db.getOutboundCallIdempotency(idempotencyKeyForProvider);
          const retry = resolveReplay(latest, requestHash);
          if (retry.replay) return repairReplayRecord(retry.replay);
          localCallId = String(retry.stored.localCallId || "").trim() || localCallId;
        }
      }
    } else {
      localCallId = `call_e_${crypto.randomUUID()}`;
      const reservation = await this.db.reserveCallEOutboundCall({
        idempotency_key: idempotencyKeyForProvider,
        request_hash: requestHash,
        local_call_id: localCallId,
      });
      if (!reservation?.reserved) {
        const latest = await this.db.getOutboundCallIdempotency(idempotencyKeyForProvider);
        const resolution = resolveReplay(latest, requestHash);
        if (resolution.replay) return repairReplayRecord(resolution.replay);
        localCallId = String(resolution.stored.localCallId || "").trim() || null;
      }
    }

    if (!localCallId || !/^call_e_[0-9a-f-]{36}$/i.test(localCallId)) {
      throw callEError("call_e_idempotency_state_invalid", "CALL-E request recovery state is invalid", 409);
    }

    const request = {
      task: buildTask(template),
      phone: destination,
      result_schema: input.resultSchema,
      ...(preview.requestSummary.region ? { region: preview.requestSummary.region } : {}),
      ...(preview.requestSummary.locale ? { locale: preview.requestSummary.locale } : {}),
      metadata: {
        voicednut_call_id: localCallId,
        template_id: Number(template.id ?? template.template_id),
        template_version: Number(template.version ?? template.template_version),
      },
    };
    await this.db.completeOutboundCallIdempotency({
      idempotency_key: idempotencyKeyForProvider,
      provider: "call_e",
      request_hash: requestHash,
      status: "pending",
      response_payload: { localCallId, requestFingerprint: requestHash },
    });
    await persistReconciliation(localCallId);

    let call;
    try {
      call = await this.client.createCall(request, idempotencyKeyForProvider);
    } catch (error) {
      const noCallCreated = error?.noCallCreated === true;
      await this.db.completeOutboundCallIdempotency({
        idempotency_key: idempotencyKeyForProvider,
        provider: "call_e",
        request_hash: requestHash,
        status: noCallCreated ? "failed" : "pending",
        response_payload: { localCallId, requestFingerprint: requestHash },
        error_message: noCallCreated ? NO_CALL_CREATED_MARKER : "call_e_outcome_unknown",
      });
      if (noCallCreated) {
        throw callEError(String(error?.code || "call_e_request_rejected"), "CALL-E rejected the request before creating a Call", error?.status || 422);
      }
      throw callEError("call_e_call_outcome_unknown", "CALL-E acceptance is uncertain; retry only with the same request and idempotency key", 409);
    }

    let normalized;
    try {
      normalized = normalizeCallResource(call);
    } catch {
      await this.db.completeOutboundCallIdempotency({
        idempotency_key: idempotencyKeyForProvider,
        provider: "call_e",
        request_hash: requestHash,
        status: "pending",
        response_payload: { localCallId, requestFingerprint: requestHash },
        error_message: "call_e_response_unresolved",
      });
      throw callEError("call_e_call_outcome_unknown", "CALL-E returned an unresolved response; retry only with the same request and idempotency key", 409);
    }

    const result = {
      localCallId,
      provider: "call_e",
      providerCallId: normalized.providerCallId,
      status: normalized.status,
      callOutcome: normalized.callOutcome,
      resultStatus: normalized.resultStatus,
      requestFingerprint: requestHash,
      idempotentReplay: false,
    };
    await this.db.completeOutboundCallIdempotency({
      idempotency_key: idempotencyKeyForProvider,
      provider: "call_e",
      request_hash: requestHash,
      call_sid: normalized.providerCallId,
      status: "completed",
      response_payload: result,
    });
    await persistReconciliation(localCallId, result);
    return result;
  }

  async getCall(providerCallId, resultSchema) {
    const id = normalizeCallId(providerCallId);
    if (!id) throw callEError("call_e_invalid_call_id", "CALL-E Call ID is invalid", 400);
    if (!this.client?.isConfigured?.()) throw callEError("call_e_not_configured", "CALL-E reads are disabled or not configured", 503);
    try {
      const call = normalizeCallResource(await this.client.getCall(id), id);
      if (call.resultStatus === "available") {
        if (!resultSchema) throw callEError("call_e_result_schema_required", "The pinned local result schema is required to validate this Call", 409);
        if (!validateCallEResult(resultSchema, call.result).valid) {
          throw callEError("call_e_result_invalid", "CALL-E returned a result that does not match the pinned local schema", 502);
        }
      }
      return call;
    } catch (error) {
      if (error?.code) throw error;
      throw callEError("call_e_read_failed", "Unable to read the CALL-E Call", 502);
    }
  }
}

module.exports = {
  CallEOutboundCallService,
  normalizeCallResource,
  parseAllowedDestinations,
};
