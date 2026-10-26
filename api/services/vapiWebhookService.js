const crypto = require("node:crypto");
const { MAPPING_METADATA_KEY } = require("./vapiTemplateSyncService");

const TRACKED_EVENT_TYPES = new Set([
  "assistant.started",
  "status-update",
  "end-of-call-report",
  "hang",
  "transfer-update",
]);
const MAX_VAPI_TOOL_CALLS_PER_MESSAGE = 50;

function createUnsupportedToolCallResponse(message = {}) {
  const toolCalls = message.toolCallList;
  if (!Array.isArray(toolCalls) || toolCalls.length > MAX_VAPI_TOOL_CALLS_PER_MESSAGE) return null;
  const seenIds = new Set();
  const results = [];
  for (const item of toolCalls) {
    const toolCallId = String(item?.id || "").trim();
    const name = String(item?.function?.name || "").trim();
    if (!toolCallId || toolCallId.length > 200 || !/^[A-Za-z0-9_.:-]{1,128}$/.test(name) || seenIds.has(toolCallId)) {
      return null;
    }
    seenIds.add(toolCallId);
    results.push({
      name,
      toolCallId,
      result: "This tool is not enabled in VOICEDNUT.",
    });
  }
  return { toolCallResponse: true, results };
}

function normalizeVapiCallEvent(payload = {}) {
  const message = payload?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const eventType = String(message.type || "").trim().toLowerCase();
  if (!TRACKED_EVENT_TYPES.has(eventType)) return { ignored: true, event_type: eventType || null };
  const call = message.call && typeof message.call === "object" ? message.call : {};
  const callId = String(call.id || "").trim().slice(0, 200);
  if (!callId) return null;

  const assistant = message.assistant && typeof message.assistant === "object"
    ? message.assistant
    : {};
  const marker = assistant.metadata?.[MAPPING_METADATA_KEY] || {};
  const status = String(message.status || call.status || (eventType === "end-of-call-report" ? "ended" : ""))
    .trim()
    .toLowerCase()
    .slice(0, 60);
  const endedReason = String(message.endedReason || "").trim().slice(0, 160);
  const rawDuration = call.duration ?? message.durationSeconds;
  const parsedDuration = Number(rawDuration);
  const durationSeconds = Number.isFinite(parsedDuration) && parsedDuration >= 0
    ? Math.min(86400, Math.floor(parsedDuration))
    : null;
  const eventTimestamp = String(message.timestamp || payload.timestamp || "").trim().slice(0, 80);
  const assistantId = String(assistant.id || call.assistantId || "").trim().slice(0, 200);
  const destinationType = ["number", "sip", "assistant"].includes(
    String(message.destination?.type || "").trim().toLowerCase(),
  ) ? String(message.destination.type).trim().toLowerCase() : null;
  const identity = JSON.stringify([
    callId,
    eventType,
    status,
    endedReason,
    durationSeconds,
    eventTimestamp,
    destinationType,
  ]);
  const eventKey = crypto.createHash("sha256").update(identity).digest("hex");

  return {
    event_key: eventKey,
    provider_call_id: callId,
    event_type: eventType,
    destination_type: destinationType,
    provider_status: status || null,
    ended_reason: endedReason || null,
    duration_seconds: durationSeconds,
    assistant_id: assistantId || null,
    template_id: marker.templateId,
    template_version: marker.templateVersion,
    config_fingerprint: marker.configFingerprint,
    event_timestamp: eventTimestamp || null,
  };
}

class VapiWebhookService {
  constructor(options = {}) {
    this.db = options.db;
  }

  async processEvent(payload) {
    const message = payload?.message;
    if (message?.type === "tool-calls") {
      const response = createUnsupportedToolCallResponse(message);
      if (!response) {
        const error = new Error("Vapi tool-call request is invalid");
        error.code = "vapi_tool_calls_invalid";
        throw error;
      }
      return response;
    }
    if (message?.type === "assistant-request") {
      const phoneNumberId = String(
        message.call?.phoneNumberId || message.phoneNumber?.id || payload?.phoneNumber?.id || "",
      ).trim();
      const mapping = phoneNumberId && this.db && typeof this.db.getVapiInboundAssistantByPhoneNumberId === "function"
        ? await this.db.getVapiInboundAssistantByPhoneNumberId(phoneNumberId)
        : null;
      const assistantId = String(mapping?.vapi_assistant_id || "").trim();
      return assistantId
        ? { assistantRequest: true, assistantId }
        : { assistantRequest: true, error: "This phone number is not configured for inbound service." };
    }
    if (!this.db || typeof this.db.recordVapiCallEvent !== "function") {
      const error = new Error("Vapi event persistence is unavailable");
      error.code = "vapi_event_store_unavailable";
      throw error;
    }
    const normalized = normalizeVapiCallEvent(payload);
    if (!normalized) {
      const error = new Error("Vapi server event payload is invalid");
      error.code = "vapi_event_invalid";
      throw error;
    }
    if (normalized.ignored) return { accepted: true, ignored: true };
    const result = await this.db.recordVapiCallEvent(normalized);
    return { accepted: true, duplicate: result?.inserted === false, event_type: normalized.event_type };
  }
}

module.exports = {
  TRACKED_EVENT_TYPES,
  VapiWebhookService,
  createUnsupportedToolCallResponse,
  normalizeVapiCallEvent,
};
