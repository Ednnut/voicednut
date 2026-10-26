const crypto = require("node:crypto");

function webCallError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeAllowedOrigins(value) {
  return String(value || "").split(",").flatMap((item) => {
    try {
      const url = new URL(item.trim());
      const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
      if ((url.protocol !== "https:" && !localHttp) || url.username || url.password ||
          url.pathname !== "/" || url.search || url.hash) return [];
      return [url.origin];
    } catch {
      return [];
    }
  });
}

function isAllowedVapiWebOrigin(originValue, allowedOriginsValue) {
  const value = String(originValue || "").trim();
  try {
    const url = new URL(value);
    return url.origin === value && normalizeAllowedOrigins(allowedOriginsValue).includes(value);
  } catch {
    return false;
  }
}

function normalizeWebCall(call) {
  const id = String(call?.id || "").trim();
  const webCallUrl = String(call?.webCallUrl || call?.transport?.callUrl || "").trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(webCallUrl);
  } catch {
    return null;
  }
  if (!id || id.length > 200 || parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.hash) {
    return null;
  }
  const callToken = String(call?.transport?.callToken || "").trim();
  if (callToken.length > 4096) return null;
  const voiceProvider = String(call?.assistant?.voice?.provider || "").trim().slice(0, 100);
  return {
    id,
    webCallUrl: parsedUrl.toString(),
    transport: callToken ? { callToken } : {},
    ...(voiceProvider ? { assistant: { voice: { provider: voiceProvider } } } : {}),
  };
}

class VapiWebCallService {
  constructor(options = {}) {
    this.client = options.client;
    this.db = options.db;
    this.listEligibleAssistants = options.listEligibleAssistants;
  }

  async createWebCall(input = {}) {
    const mappingId = Number(input.mappingId);
    if (!Number.isSafeInteger(mappingId) || mappingId <= 0) {
      throw webCallError("vapi_web_mapping_invalid", "A valid Vapi template mapping ID is required");
    }
    const callerKey = String(input.idempotencyKey || "").trim();
    if (!/^[A-Za-z0-9._:-]{8,180}$/.test(callerKey)) {
      throw webCallError("vapi_web_idempotency_key_required", "A valid Vapi web-call idempotency key is required");
    }
    if (!this.client?.isConfigured?.()) {
      throw webCallError("vapi_not_configured", "Vapi calling is disabled or not configured");
    }
    if (typeof this.listEligibleAssistants !== "function" ||
        typeof this.db?.getOutboundCallIdempotency !== "function" ||
        typeof this.db?.reserveOutboundCallIdempotency !== "function" ||
        typeof this.db?.completeOutboundCallIdempotency !== "function") {
      throw webCallError("vapi_web_unavailable", "Vapi web calling is unavailable");
    }
    const rows = await this.listEligibleAssistants();
    const assistant = (Array.isArray(rows) ? rows : []).find((row) => Number(row?.id) === mappingId);
    if (!assistant || !/^[A-Za-z0-9_-]{1,200}$/.test(String(assistant.vapi_assistant_id || ""))) {
      throw webCallError("vapi_web_mapping_not_found", "No current live Vapi template mapping is available");
    }
    const idempotencyKey = `vapi-web:${callerKey}`;
    const requestHash = crypto.createHash("sha256").update(JSON.stringify({ mappingId })).digest("hex");
    const resolveExisting = (existing) => {
      if (existing && existing.provider === "vapi_web" && existing.request_hash === requestHash) {
        throw webCallError("vapi_web_call_outcome_unknown", "A prior request may already have created this web call; check Vapi call logs before retrying");
      }
      throw webCallError("vapi_web_idempotency_conflict", "Idempotency key was already used for a different web call");
    };
    const existing = await this.db.getOutboundCallIdempotency(idempotencyKey);
    if (existing) resolveExisting(existing);
    const reservation = await this.db.reserveOutboundCallIdempotency({
      idempotency_key: idempotencyKey,
      provider: "vapi_web",
      request_hash: requestHash,
    });
    if (!reservation?.reserved) {
      resolveExisting(await this.db.getOutboundCallIdempotency(idempotencyKey));
    }
    const providerCall = await this.client.createCall({
      assistantId: String(assistant.vapi_assistant_id),
      ...(String(assistant.vapi_assistant_version || "").trim()
        ? { assistantVersion: String(assistant.vapi_assistant_version).trim() }
        : {}),
      transport: { type: "web" },
    });
    const call = normalizeWebCall(providerCall);
    if (!call) throw webCallError("vapi_web_response_invalid", "Vapi returned an invalid web-call connection");
    try {
      const saved = await this.db.completeOutboundCallIdempotency({
        idempotency_key: idempotencyKey,
        provider: "vapi_web",
        request_hash: requestHash,
        call_sid: call.id,
        status: "completed",
        response_payload: {
          templateId: Number(assistant.template_id),
          templateVersion: Number(assistant.template_version),
          mappingId,
        },
      });
      if (!saved) throw new Error("local call record was not updated");
    } catch {
      throw webCallError("vapi_web_call_outcome_unknown", "Vapi created the call but its local correlation could not be confirmed; check Vapi call logs before retrying");
    }
    return {
      call,
      template: {
        mappingId,
        templateId: Number(assistant.template_id),
        templateName: String(assistant.template_name || `Template ${assistant.template_id}`).slice(0, 160),
        templateVersion: Number(assistant.template_version),
      },
    };
  }
}

module.exports = { VapiWebCallService, isAllowedVapiWebOrigin, normalizeAllowedOrigins, normalizeWebCall };
