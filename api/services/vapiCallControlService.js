function callControlError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isTrustedVapiControlUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" &&
      url.hostname.endsWith(".vapi.ai") &&
      !url.username && !url.password && !url.port &&
      !url.search && !url.hash &&
      url.pathname.endsWith("/control");
  } catch {
    return false;
  }
}

class VapiCallControlService {
  constructor(options = {}) {
    this.client = options.client;
    this.getLocalCall = options.getLocalCall;
    this.listEvents = options.listEvents;
  }

  async endCall(providerCallId) {
    const callId = String(providerCallId || "").trim();
    if (!callId || callId.length > 200) {
      throw callControlError("vapi_call_id_invalid", "A valid Vapi call ID is required");
    }
    if (typeof this.getLocalCall !== "function" || typeof this.listEvents !== "function") {
      throw callControlError("vapi_call_control_dependencies_missing", "Vapi call lookup is unavailable");
    }
    const localCall = await this.getLocalCall(callId);
    if (!localCall) throw callControlError("vapi_call_not_found", "Vapi call is not locally correlated");
    if (!this.client?.isConfigured?.()) {
      throw callControlError("vapi_not_configured", "Vapi calling is disabled or not configured");
    }

    const events = await this.listEvents(callId);
    const latest = Array.isArray(events) ? events[0] : null;
    const remoteCall = await this.client.getCall(callId);
    if (!remoteCall || String(remoteCall.id || "") !== callId) {
      throw callControlError("vapi_call_lookup_mismatch", "Vapi returned a different call record");
    }
    const remoteStatus = String(remoteCall.status || "").trim().toLowerCase();
    if (["ended", "completed", "failed"].includes(remoteStatus) ||
        latest?.event_type === "end-of-call-report" ||
        ["ended", "completed", "failed"].includes(String(latest?.provider_status || "").toLowerCase())) {
      return { providerCallId: callId, accepted: true, alreadyEnded: true };
    }
    if (!new Set(["queued", "ringing", "in-progress", "forwarding"]).has(remoteStatus)) {
      throw callControlError("vapi_call_not_active", "Vapi call is not in a controllable active state");
    }
    const controlUrl = remoteCall.monitor?.controlUrl;
    if (!isTrustedVapiControlUrl(controlUrl)) {
      throw callControlError("vapi_control_url_invalid", "Vapi did not return a trusted live control URL");
    }
    await this.client.endCall(controlUrl);
    return { providerCallId: callId, accepted: true, alreadyEnded: false };
  }

  async transferCall(providerCallId, destination = {}, content) {
    const callId = String(providerCallId || "").trim();
    if (!callId || callId.length > 200) {
      throw callControlError("vapi_call_id_invalid", "A valid Vapi call ID is required");
    }
    const type = String(destination.type || "").trim().toLowerCase();
    let normalizedDestination;
    if (type === "number" && /^\+[1-9]\d{1,14}$/.test(String(destination.number || "").trim())) {
      normalizedDestination = { type: "number", number: String(destination.number).trim() };
    } else if (type === "sip" && /^sips?:[^\s@]+@[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(String(destination.sipUri || "").trim())) {
      normalizedDestination = { type: "sip", sipUri: String(destination.sipUri).trim() };
    } else {
      throw callControlError("vapi_transfer_destination_invalid", "Transfer destination must be an E.164 number or SIP URI");
    }
    if (content !== undefined && content !== null && typeof content !== "string") {
      throw callControlError("vapi_transfer_content_invalid", "Transfer message must be text");
    }
    const message = content === undefined || content === null ? "" : content.trim();
    if (message.length > 500) {
      throw callControlError("vapi_transfer_content_invalid", "Transfer message cannot exceed 500 characters");
    }
    if (typeof this.getLocalCall !== "function" || typeof this.listEvents !== "function") {
      throw callControlError("vapi_call_control_dependencies_missing", "Vapi call lookup is unavailable");
    }
    if (!await this.getLocalCall(callId)) {
      throw callControlError("vapi_call_not_found", "Vapi call is not locally correlated");
    }
    if (!this.client?.isConfigured?.()) {
      throw callControlError("vapi_not_configured", "Vapi calling is disabled or not configured");
    }
    const events = await this.listEvents(callId);
    const latest = Array.isArray(events) ? events[0] : null;
    const remoteCall = await this.client.getCall(callId);
    if (!remoteCall || String(remoteCall.id || "") !== callId) {
      throw callControlError("vapi_call_lookup_mismatch", "Vapi returned a different call record");
    }
    const remoteStatus = String(remoteCall.status || "").trim().toLowerCase();
    if (!new Set(["queued", "ringing", "in-progress", "forwarding"]).has(remoteStatus) ||
        latest?.event_type === "end-of-call-report" ||
        ["ended", "completed", "failed"].includes(String(latest?.provider_status || "").toLowerCase())) {
      throw callControlError("vapi_call_not_active", "Vapi call is not in a controllable active state");
    }
    const controlUrl = remoteCall.monitor?.controlUrl;
    if (!isTrustedVapiControlUrl(controlUrl)) {
      throw callControlError("vapi_control_url_invalid", "Vapi did not return a trusted live control URL");
    }
    await this.client.transferCall(controlUrl, normalizedDestination, message || undefined);
    return { providerCallId: callId, accepted: true };
  }
}

module.exports = { VapiCallControlService, isTrustedVapiControlUrl };
