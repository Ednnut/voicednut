const { normalizeCallId } = require("./callEClient");

const TERMINAL_EVENT_TYPES = new Set(["call.completed", "call.failed", "call.canceled"]);

function normalizeCallEWebhookEnvelope(headers = {}, body) {
  const headerEventId = String(headers["call-e-event-id"] || "").trim();
  const eventId = typeof body?.id === "string" ? body.id.trim() : "";
  const eventType = typeof body?.type === "string" ? body.type.trim() : "";
  const providerCallId = normalizeCallId(body?.data?.id);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(eventId) || headerEventId !== eventId ||
      !TERMINAL_EVENT_TYPES.has(eventType) || body?.data?.object !== "call" || !providerCallId) {
    const error = new Error("CALL-E terminal webhook envelope is invalid");
    error.code = "call_e_webhook_invalid";
    error.status = 400;
    throw error;
  }
  return Object.freeze({ eventId, eventType, providerCallId });
}

function createCallEWebhookHandler(options = {}) {
  return async (req, res) => {
    try {
      const event = normalizeCallEWebhookEnvelope(req.headers, req.body);
      const db = options.db;
      if (!db || typeof db.getCallEWebhookReceipt !== "function") {
        return res.status(503).json({ success: false, code: "call_e_webhook_storage_unavailable" });
      }
      const existingReceipt = await db.getCallEWebhookReceipt(event.providerCallId);
      if (existingReceipt) return res.status(204).end();
      if (typeof db.getCallEReconciliationRecordByProviderId !== "function" || typeof db.recordCallEWebhookReceipt !== "function") {
        return res.status(503).json({ success: false, code: "call_e_webhook_storage_unavailable" });
      }
      const linkedCall = await db.getCallEReconciliationRecordByProviderId(event.providerCallId);
      if (!linkedCall?.local_call_id) return res.status(404).json({ success: false, code: "call_e_webhook_call_not_found" });

      const service = typeof options.createService === "function" ? options.createService() : options.service;
      if (!service || typeof service.reconcileLocalCall !== "function") {
        return res.status(503).json({ success: false, code: "call_e_not_configured" });
      }
      const state = await service.reconcileLocalCall(linkedCall.local_call_id);
      if (state.resultStatus === "pending") {
        return res.status(503).json({ success: false, code: "call_e_webhook_snapshot_not_ready" });
      }
      await db.recordCallEWebhookReceipt({
        provider_call_id: event.providerCallId,
        event_id: event.eventId,
        event_type: event.eventType,
      });
      return res.status(204).end();
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 503;
      return res.status(status).json({
        success: false,
        code: status === 400 ? "call_e_webhook_invalid" : "call_e_webhook_reconciliation_failed",
      });
    }
  };
}

module.exports = { createCallEWebhookHandler, normalizeCallEWebhookEnvelope, TERMINAL_EVENT_TYPES };
