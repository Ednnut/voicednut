const { normalizeCallId } = require("./callEClient");
const { normalizeCallResource } = require("./callEOutboundCallService");
const { validateCallEResult } = require("../adapters/callETemplateAdapter");

const MAX_PAGES_PER_RUN = 5;
const MAX_SEEN_EVENT_IDS = 500;
const MAX_EVENT_ID_LENGTH = 200;
const MAX_CURSOR_LENGTH = 512;
const OPERATOR_ROLES = new Set(["policy_manager", "call_operator"]);
const MAX_REVIEW_TRANSCRIPT_TURNS = 200;
const MAX_REVIEW_TURN_CHARACTERS = 1200;
const MAX_REVIEW_TRANSCRIPT_CHARACTERS = 30000;
const MAX_REVIEW_RESULT_BYTES = 24000;

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
    this.providerRegistry = options.providerRegistry || null;
    this.cancelTaskCall = options.cancelTaskCall || null;
    this.loadState = options.loadState || (this.db && typeof this.db.getCallEReconciliationState === "function"
      ? (callId) => this.db.getCallEReconciliationState(callId) : null);
    this.saveState = options.saveState || (this.db && typeof this.db.saveCallEReconciliationState === "function"
      ? (callId, state) => this.db.saveCallEReconciliationState(callId, state) : null);
    this.maxPages = Math.max(1, Math.min(MAX_PAGES_PER_RUN, Math.floor(Number(options.maxPages) || MAX_PAGES_PER_RUN)));
  }

  async listCallsForOperator(telegramId, filters = {}) {
    const actorId = String(telegramId || '').trim();
    if (!/^\d{1,20}$/.test(actorId) || typeof this.db?.listCallEReconciliationCallsForOperator !== 'function') {
      throw callEReconciliationError('call_e_reconciliation_storage_unavailable', 'CALL-E operations storage is unavailable');
    }
    const result = await this.db.listCallEReconciliationCallsForOperator({
      telegram_id: actorId,
      limit: filters.limit,
      offset: filters.offset,
      execution_status: filters.execution_status,
      call_outcome: filters.call_outcome,
      result_status: filters.result_status,
      query: filters.query,
      start_date: filters.start_date,
      end_date: filters.end_date,
    });
    if (result?.operator_access !== true) {
      const error = callEReconciliationError('call_e_business_operator_access_denied', 'CALL-E business operator access is required');
      error.status = 403;
      throw error;
    }
    const rows = Array.isArray(result.rows) ? result.rows : [];
    return Object.freeze({
      provider: 'call_e',
      rows: Object.freeze(rows.map((row) => Object.freeze({
        localCallId: String(row.local_call_id || ''),
        templateId: Number(row.template_id) || null,
        templateVersion: Number(row.template_version) || null,
        executionStatus: String(row.execution_status || 'unknown'),
        callOutcome: row.call_outcome == null ? null : String(row.call_outcome),
        resultStatus: String(row.result_status || 'pending'),
        errorCode: /^[a-z][a-z0-9_]{0,79}$/.test(String(row.error_code || '')) ? row.error_code : null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
      }))),
      total: Number(result.total) || 0,
      summary: Object.freeze({
        active: Number(result.summary?.active) || 0,
        failed: Number(result.summary?.failed) || 0,
        resultsReady: Number(result.summary?.results_ready) || 0,
      }),
      limit: Number(result.limit) || 20,
      offset: Number(result.offset) || 0,
    });
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
      const page = this.providerRegistry
        ? await this.providerRegistry.listCallEvents("call_e", { providerCallId: normalizedCallId, cursor: requestCursor, limit })
        : await this.client.listCallEvents(normalizedCallId, { cursor: requestCursor, limit });
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
    const rawCall = this.providerRegistry
      ? await this.providerRegistry.getCall("call_e", { providerCallId })
      : await this.client.getCall(providerCallId);
    const call = normalizeCallResource(rawCall, providerCallId);
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

  async reviewLocalCallForOperator(localCallId, telegramId) {
    const localId = String(localCallId || "").trim();
    const actorId = String(telegramId || "").trim();
    if (!/^call_e_[0-9a-f-]{36}$/i.test(localId) || !/^\d{1,20}$/.test(actorId) ||
        typeof this.db?.getCallEReconciliationRecord !== "function" ||
        typeof this.db?.getCallEBusinessOperator !== "function") {
      throw callEReconciliationError("call_e_call_not_found", "CALL-E call was not found");
    }
    const record = await this.db.getCallEReconciliationRecord(localId);
    const businessId = String(record?.business_id || "").trim();
    const providerCallId = normalizeCallId(record?.provider_call_id);
    if (!businessId || !providerCallId || !record?.result_schema) {
      throw callEReconciliationError("call_e_call_not_found", "CALL-E call was not found");
    }
    const membership = await this.db.getCallEBusinessOperator(businessId, actorId);
    if (!OPERATOR_ROLES.has(membership?.role)) {
      throw callEReconciliationError("call_e_call_not_found", "CALL-E call was not found");
    }
    if (!this.client?.isConfigured?.()) {
      throw callEReconciliationError("call_e_not_configured", "CALL-E review is disabled or unavailable");
    }
    const rawCall = this.providerRegistry
      ? await this.providerRegistry.getCall("call_e", { providerCallId })
      : await this.client.getCall(providerCallId);
    const call = normalizeCallResource(rawCall, providerCallId);
    if (call.resultStatus === "available" && !validateCallEResult(record.result_schema, call.result).valid) {
      throw callEReconciliationError("call_e_result_invalid", "CALL-E returned a result that does not match the pinned local schema");
    }

    let transcriptCharacters = 0;
    let transcriptTruncated = call.transcript.length > MAX_REVIEW_TRANSCRIPT_TURNS;
    const transcript = [];
    for (const turn of call.transcript.slice(0, MAX_REVIEW_TRANSCRIPT_TURNS)) {
      if (transcriptCharacters >= MAX_REVIEW_TRANSCRIPT_CHARACTERS) {
        transcriptTruncated = true;
        break;
      }
      const remaining = MAX_REVIEW_TRANSCRIPT_CHARACTERS - transcriptCharacters;
      const text = turn.text.slice(0, Math.min(MAX_REVIEW_TURN_CHARACTERS, remaining));
      if (text.length < turn.text.length) transcriptTruncated = true;
      transcriptCharacters += text.length;
      transcript.push(Object.freeze({
        offsetSeconds: turn.offsetSeconds,
        speaker: turn.speaker,
        text,
      }));
    }
    const resultAvailable = call.resultStatus === "available";
    const resultWithinLimit = !resultAvailable || Buffer.byteLength(JSON.stringify(call.result), "utf8") <= MAX_REVIEW_RESULT_BYTES;
    return Object.freeze({
      localCallId: localId,
      executionStatus: call.status,
      callOutcome: call.callOutcome,
      resultStatus: call.resultStatus,
      result: resultAvailable && resultWithinLimit ? call.result : null,
      resultOmittedForSize: resultAvailable && !resultWithinLimit,
      transcript: Object.freeze(transcript),
      transcriptTruncated,
      updatedAt: new Date().toISOString(),
    });
  }

  async cancelLocalCallForOperator(localCallId, telegramId, options = {}) {
    const localId = String(localCallId || "").trim();
    const actorId = String(telegramId || "").trim();
    if (!/^call_e_[0-9a-f-]{36}$/i.test(localId) || !/^\d{1,20}$/.test(actorId) ||
        typeof this.db?.getCallEReconciliationRecord !== "function" ||
        typeof this.db?.getCallEBusinessOperator !== "function") {
      throw callEReconciliationError("call_e_call_not_found", "CALL-E call was not found");
    }
    const record = await this.db.getCallEReconciliationRecord(localId);
    const businessId = String(record?.business_id || "").trim();
    const providerCallId = normalizeCallId(record?.provider_call_id);
    if (!businessId || !providerCallId || !record?.result_schema) {
      throw callEReconciliationError("call_e_call_not_found", "CALL-E call was not found");
    }
    const membership = await this.db.getCallEBusinessOperator(businessId, actorId);
    if (!OPERATOR_ROLES.has(membership?.role)) {
      throw callEReconciliationError("call_e_call_not_found", "CALL-E call was not found");
    }
    if (!this.client?.isConfigured?.()) {
      throw callEReconciliationError("call_e_not_configured", "CALL-E cancellation is disabled or unavailable");
    }
    const cancel = options.cancelTaskCall || this.cancelTaskCall || this.client.cancelCall?.bind(this.client);
    if (typeof cancel !== "function") {
      throw callEReconciliationError("call_e_not_configured", "CALL-E cancellation is unavailable");
    }
    if (typeof this.db.updateCallEReconciliationSnapshot !== "function") {
      throw callEReconciliationError("call_e_reconciliation_storage_unavailable", "CALL-E reconciliation storage is unavailable");
    }
    const response = await cancel({ providerCallId });
    const call = normalizeCallResource(response, providerCallId);
    if (call.resultStatus === "available" && !validateCallEResult(record.result_schema, call.result).valid) {
      throw callEReconciliationError("call_e_result_invalid", "CALL-E returned a result that does not match the pinned local schema");
    }
    await this.db.updateCallEReconciliationSnapshot(localId, {
      execution_status: call.status,
      call_outcome: call.callOutcome,
      result_status: call.resultStatus,
      error_code: call.errorCode,
    });
    return Object.freeze({
      localCallId: localId,
      provider: "call_e",
      executionStatus: call.status,
      callOutcome: call.callOutcome,
      resultStatus: call.resultStatus,
      resultAvailable: call.resultStatus === "available",
      errorCode: call.errorCode,
      updatedAt: new Date().toISOString(),
    });
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
