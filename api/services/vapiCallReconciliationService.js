const crypto = require("node:crypto");

function reconciliationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeCallSnapshot(call, localCall) {
  const callId = String(call?.id || "").trim();
  const status = String(call?.status || "").trim().toLowerCase().slice(0, 60);
  if (!callId || !/^[a-z0-9_-]+$/.test(status)) return null;
  const updatedAt = String(call.updatedAt || "").trim();
  const timestamp = updatedAt && Number.isFinite(Date.parse(updatedAt)) ? new Date(updatedAt).toISOString() : "";
  const endedReason = String(call.endedReason || "").trim().slice(0, 160);
  const startedMs = Date.parse(call.startedAt || "");
  const endedMs = Date.parse(call.endedAt || "");
  const duration = Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs
    ? Math.min(86400, Math.floor((endedMs - startedMs) / 1000))
    : null;
  const identity = JSON.stringify([callId, "reconciliation", status, endedReason, timestamp, duration]);
  return {
    event_key: crypto.createHash("sha256").update(identity).digest("hex"),
    provider_call_id: callId,
    event_type: "reconciliation",
    provider_status: status,
    ended_reason: endedReason || null,
    duration_seconds: duration,
    assistant_id: null,
    template_id: Number(localCall.template_id) || null,
    template_version: Number(localCall.template_version) || null,
    config_fingerprint: null,
    event_timestamp: timestamp || null,
  };
}

class VapiCallReconciliationService {
  constructor(options = {}) {
    this.client = options.client;
    this.getLocalCall = options.getLocalCall;
    this.recordEvent = options.recordEvent;
  }

  async reconcile(providerCallId) {
    const callId = String(providerCallId || "").trim();
    if (!callId || callId.length > 200) {
      throw reconciliationError("vapi_call_id_invalid", "A valid Vapi call ID is required");
    }
    if (typeof this.getLocalCall !== "function" || typeof this.recordEvent !== "function") {
      throw reconciliationError("vapi_call_reconciliation_unavailable", "Vapi call reconciliation is unavailable");
    }
    const localCall = await this.getLocalCall(callId);
    if (!localCall) throw reconciliationError("vapi_call_not_found", "Vapi call is not locally correlated");
    if (!this.client?.isConfigured?.()) {
      throw reconciliationError("vapi_not_configured", "Vapi calling is disabled or not configured");
    }
    const call = await this.client.getCall(callId);
    if (!call || String(call.id || "") !== callId) {
      throw reconciliationError("vapi_call_lookup_mismatch", "Vapi returned a different call record");
    }
    const normalized = normalizeCallSnapshot(call, localCall);
    if (!normalized) throw reconciliationError("vapi_call_snapshot_invalid", "Vapi returned an invalid call status");
    const result = await this.recordEvent(normalized);
    return {
      providerCallId: callId,
      status: normalized.provider_status,
      reconciled: true,
      duplicate: result?.inserted === false,
    };
  }
}

module.exports = { VapiCallReconciliationService, normalizeCallSnapshot };
