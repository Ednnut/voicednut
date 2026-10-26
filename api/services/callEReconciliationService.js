const { normalizeCallId } = require("./callEClient");
const { normalizeCallResource } = require("./callEOutboundCallService");
const { validateCallEResult } = require("../adapters/callETemplateAdapter");

const MAX_PAGES_PER_RUN = 5;
const MAX_SEEN_EVENT_IDS = 500;
const MAX_EVENT_ID_LENGTH = 200;
const MAX_CURSOR_LENGTH = 512;
const OPERATOR_ROLES = new Set(["policy_manager", "call_operator"]);

function callEReconciliationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeCallEEvent(event, expectedCallId) {
  const id = typeof event?.id === "string" ? event.id.trim() : "";
  const callId = normalizeCallId(event?.call_id);
  const type = typeof event?.type === "string" ? event.type.trim() : "";
  if (!id || id.length > MAX_EVENT_ID_LENGTH || !callId || callId !== expectedCallId || !type || type.length > 100) {
    throw callEReconciliationError("call_e_invalid_event", "CALL-E returned an invalid or foreign event");
  }
  const createdAt = typeof event.created_at === "string" && Number.isFinite(Date.parse(event.created_at))
    ? new Date(event.created_at).toISOString()
    : null;
  return Object.freeze({ id, callId, type, createdAt });
}

function normalizeCallEEventPage(page, expectedCallId, previous = {}) {
  if (!page || typeof page !== "object" || Array.isArray(page) || page.object !== "list" || !Array.isArray(page.data)) {
    throw callEReconciliationError("call_e_invalid_event_page", "CALL-E returned an invalid event page");
  }
  if (page.data.length > 100) {
    throw callEReconciliationError("call_e_invalid_event_page", "CALL-E returned an oversized event page");
  }
  const priorIds = Array.isArray(previous.seenEventIds)
    ? previous.seenEventIds.filter((id) => typeof id === "string" && id.length <= MAX_EVENT_ID_LENGTH).slice(-MAX_SEEN_EVENT_IDS)
    : [];
  const seen = new Set(priorIds);
  const events = [];
  for (const rawEvent of page.data) {
    const event = normalizeCallEEvent(rawEvent, expectedCallId);
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    events.push(event);
  }
  const cursor = page.next_cursor == null ? null : String(page.next_cursor);
  if (cursor !== null && (!cursor.trim() || cursor.length > MAX_CURSOR_LENGTH)) {
    throw callEReconciliationError("call_e_invalid_cursor", "CALL-E returned an invalid event cursor");
  }
  const lastEventId = page.data.length
    ? normalizeCallEEvent(page.data[page.data.length - 1], expectedCallId).id
    : (typeof previous.lastEventId === "string" ? previous.lastEventId : null);
  const seenEventIds = [...seen].slice(-MAX_SEEN_EVENT_IDS);
  return Object.freeze({
    events: Object.freeze(events),
    state: Object.freeze({
      lastEventId,
      nextCursor: page.data.length === 0 ? (previous.nextCursor || null) : cursor,
      seenEventIds: Object.freeze(seenEventIds),
    }),
  });
}

function createCallEReconciliationHandler(options = {}) {
  return async (req, res) => {
    const localCallId = String(req.params?.localCallId || "").trim();
    try {
      const service = typeof options.createService === "function" ? options.createService() : options.service;
      if (!service || typeof service.reconcileLocalCall !== "function") {
        return res.status(503).json({ success: false, code: "call_e_not_configured", error: "CALL-E reconciliation is unavailable" });
      }
      const result = await service.reconcileLocalCall(localCallId);
      return res.json({ success: true, result });
    } catch (error) {
      const code = String(error?.code || "call_e_reconciliation_failed");
      const status = code === "call_e_not_configured" || code === "call_e_reconciliation_storage_unavailable"
        ? 503
        : code === "call_e_call_not_found"
          ? 404
          : ["call_e_invalid_local_call_id", "call_e_invalid_call_id"].includes(code)
            ? 400
            : code === "call_e_result_invalid"
              ? 409
              : 502;
      return res.status(status).json({
        success: false,
        code,
        error: status === 502 ? "CALL-E reconciliation failed" : error.message,
      });
    }
  };
}

class CallEReconciliationService {
  constructor(options = {}) {
    this.client = options.client;
    this.db = options.db;
    this.loadState = options.loadState || (this.db && typeof this.db.getCallEReconciliationState === "function"
      ? (callId) => this.db.getCallEReconciliationState(callId) : null);
    this.saveState = options.saveState || (this.db && typeof this.db.saveCallEReconciliationState === "function"
      ? (callId, state) => this.db.saveCallEReconciliationState(callId, state) : null);
    this.maxPages = Math.max(1, Math.min(MAX_PAGES_PER_RUN, Math.floor(Number(options.maxPages) || MAX_PAGES_PER_RUN)));
  }

  async reconcileEventPages(callId, options = {}) {
    const normalizedCallId = normalizeCallId(callId);
    if (!normalizedCallId) throw callEReconciliationError("call_e_invalid_call_id", "CALL-E Call ID is invalid");
    if (!this.client?.isConfigured?.() || typeof this.client.listCallEvents !== "function") {
      throw callEReconciliationError("call_e_not_configured", "CALL-E event reads are disabled or unavailable");
    }
    if (typeof this.loadState !== "function" || typeof this.saveState !== "function") {
      throw callEReconciliationError("call_e_reconciliation_storage_unavailable", "CALL-E reconciliation storage is unavailable");
    }
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 50)));
    let state = await this.loadState(normalizedCallId) || {};
    const collected = [];
    let pagesRead = 0;
    for (; pagesRead < this.maxPages; pagesRead += 1) {
      const requestCursor = state.nextCursor || state.lastEventId || undefined;
      const page = await this.client.listCallEvents(normalizedCallId, { cursor: requestCursor, limit });
      const normalized = normalizeCallEEventPage(page, normalizedCallId, state);
      state = normalized.state;
      if (normalized.events.length) collected.push(...normalized.events);
      if (normalized.events.length || state.lastEventId || state.nextCursor) {
        await this.saveState(normalizedCallId, state);
      }
      if (!Array.isArray(page.data) || page.data.length === 0 || !page.next_cursor) {
        pagesRead += 1;
        break;
      }
    }
    return Object.freeze({
      callId: normalizedCallId,
      events: Object.freeze(collected),
      state,
      pagesRead,
      hasMore: Boolean(state.nextCursor),
    });
  }

  async reconcileLocalCall(localCallId) {
    const localId = String(localCallId || "").trim();
    if (!/^call_e_[0-9a-f-]{36}$/i.test(localId)) {
      throw callEReconciliationError("call_e_invalid_local_call_id", "VOICEDNUT call ID is invalid");
    }
    if (!this.db || typeof this.db.getCallEReconciliationRecord !== "function" ||
        typeof this.db.updateCallEReconciliationSnapshot !== "function") {
      throw callEReconciliationError("call_e_reconciliation_storage_unavailable", "CALL-E reconciliation storage is unavailable");
    }
    if (!this.client?.isConfigured?.() || typeof this.client.getCall !== "function") {
      throw callEReconciliationError("call_e_not_configured", "CALL-E status reads are disabled or unavailable");
    }
    const record = await this.db.getCallEReconciliationRecord(localId);
    const providerCallId = normalizeCallId(record?.provider_call_id);
    if (!record || !providerCallId) {
      throw callEReconciliationError("call_e_call_not_found", "No accepted CALL-E Call is linked to this VOICEDNUT call ID");
    }
    const call = normalizeCallResource(await this.client.getCall(providerCallId), providerCallId);
    if (call.resultStatus === "available" && !validateCallEResult(record.result_schema, call.result).valid) {
      throw callEReconciliationError("call_e_result_invalid", "CALL-E returned a result that does not match the pinned local schema");
    }
    await this.db.updateCallEReconciliationSnapshot(localId, {
      execution_status: call.status,
      call_outcome: call.callOutcome,
      result_status: call.resultStatus,
      error_code: call.errorCode,
    });
    const events = await this.reconcileEventPages(providerCallId);
    return Object.freeze({
      localCallId: localId,
      provider: "call_e",
      executionStatus: call.status,
      callOutcome: call.callOutcome,
      resultStatus: call.resultStatus,
      resultAvailable: call.resultStatus === "available",
      errorCode: call.errorCode,
      events: events.events,
      eventPagesRead: events.pagesRead,
      eventsHaveMore: events.hasMore,
      updatedAt: new Date().toISOString(),
    });
  }

  async reconcileLocalCallForOperator(localCallId, telegramId) {
    const localId = String(localCallId || "").trim();
    const actorId = String(telegramId || "").trim();
    if (!/^call_e_[0-9a-f-]{36}$/i.test(localId) || !/^\d{1,20}$/.test(actorId) ||
        typeof this.db?.getCallEReconciliationRecord !== "function" ||
        typeof this.db?.getCallEBusinessOperator !== "function") {
      throw callEReconciliationError("call_e_call_not_found", "CALL-E call was not found");
    }
    const record = await this.db.getCallEReconciliationRecord(localId);
    const businessId = String(record?.business_id || "").trim();
    if (!businessId) throw callEReconciliationError("call_e_call_not_found", "CALL-E call was not found");
    const membership = await this.db.getCallEBusinessOperator(businessId, actorId);
    if (!OPERATOR_ROLES.has(membership?.role)) {
      throw callEReconciliationError("call_e_call_not_found", "CALL-E call was not found");
    }
    return this.reconcileLocalCall(localId);
  }
}

module.exports = {
  CallEReconciliationService,
  createCallEReconciliationHandler,
  MAX_PAGES_PER_RUN,
  MAX_SEEN_EVENT_IDS,
  normalizeCallEEvent,
  normalizeCallEEventPage,
};
