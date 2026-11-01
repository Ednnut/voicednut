"use strict";

const assert = require("node:assert/strict");
const { CartesiaOutboundCallService, buildCorrelationId, hashRequest } = require("../services/cartesiaOutboundCallService");

const input = {
  business_id: "biz-1", actor_id: "7001", destination: "+14155550123",
  agent_id: "agent_1", from_number_id: "ap_number_1", idempotency_key: "cartesia-request-001",
};
const now = Date.parse("2026-10-31T12:00:00.000Z");
const callRecord = {
  id: "call_1", agent_id: "agent_1", status: "started", start_time: "2026-10-31T11:59:58.000Z",
  telephony_params: { to: "+14155550123" }, dynamic_variables: { voicednut_request_id: buildCorrelationId(input.idempotency_key) },
  transcript: [{ text: "private transcript" }], summary: "private summary",
};

function makeHarness({ row = {}, pages, getCall, authorizeActor, completeDispatch } = {}) {
  const state = {
    row: { provider: "cartesia", request_hash: hashRequest({ businessId: "biz-1", destination: input.destination, agentId: input.agent_id, fromNumberId: input.from_number_id }), status: "pending", created_at: "2026-10-31 11:59:55", ...row },
    writes: [], lookups: [], pages: [],
  };
  const service = new CartesiaOutboundCallService({
    client: {
      isConfigured: () => true,
      async getCall(id) { state.lookups.push(id); return typeof getCall === "function" ? getCall(id) : { ...callRecord, id }; },
      async listCalls(query) {
        state.pages.push(query);
        return typeof pages === "function" ? pages(state.pages.length, query) : pages[state.pages.length - 1];
      },
    },
    db: {
      async getOutboundCallIdempotency() { return state.row; },
      async completeOutboundCallIdempotency(payload) { state.writes.push(payload); state.row = { ...state.row, ...payload }; return 1; },
    },
    outboundSafety: {
      async authorizeActor() { if (authorizeActor) throw authorizeActor; },
      async completeDispatch(reservation, status) { if (completeDispatch) completeDispatch(reservation, status); },
    },
    approvalSecret: "test-secret-unused-for-read-only-reconciliation",
    now: () => now,
  });
  return { service, state };
}

describe("Cartesia call reconciliation", () => {
  it("adopts and reads one unique exact destination match without returning transcript data", async () => {
    const { service, state } = makeHarness({
      pages: [{ data: [callRecord], has_more: false }],
    });
    let safetyCompletion;
    service.outboundSafety.completeDispatch = async (reservation, status) => { safetyCompletion = { reservation, status }; };
    const result = await service.reconcileOutboundCall(input);
    assert.equal(result.outcome, "reconciled");
    assert.equal(result.call.callId, "call_1");
    assert.equal(result.call.status, "started");
    assert.equal("transcript" in result.call, false);
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0].call_sid, "call_1");
    assert.deepEqual(safetyCompletion, {
      reservation: { reservationKey: `cartesia:${require("node:crypto").createHash("sha256").update(input.idempotency_key).digest("hex")}` },
      status: "accepted",
    });
  });

  it("keeps no-match, ambiguous, and incomplete searches unresolved", async () => {
    const cases = [
      { page: { data: [], has_more: false }, reason: "no_matching_call_yet" },
      { page: { data: [{ ...callRecord, dynamic_variables: { voicednut_request_id: "wrong-correlation" } }], has_more: false }, reason: "no_matching_call_yet" },
      { page: { data: [callRecord, { ...callRecord, id: "call_2" }], has_more: false }, reason: "multiple_matching_calls" },
      { page: { data: [callRecord], has_more: true, next_page: "cursor_2" }, reason: "search_incomplete" },
    ];
    for (const testCase of cases) {
      const { service, state } = makeHarness({ pages: [testCase.page, testCase.page] });
      const result = await service.reconcileOutboundCall(input);
      assert.equal(result.outcome, "unresolved");
      assert.equal(result.reason, testCase.reason);
      assert.equal(state.writes.length, 0);
    }
  });

  it("rechecks a saved call ID and requires actor authorization before provider reads", async () => {
    const { service, state } = makeHarness({ row: { status: "completed", call_sid: "call_saved" } });
    const result = await service.reconcileOutboundCall(input);
    assert.equal(result.call.callId, "call_saved");
    assert.deepEqual(state.lookups, ["call_saved"]);
    assert.equal(state.pages.length, 0);

    const unauthorized = makeHarness({ authorizeActor: Object.assign(new Error("denied"), { code: "outbound_business_operator_required", status: 403 }) });
    await assert.rejects(unauthorized.service.reconcileOutboundCall(input), { code: "outbound_business_operator_required" });
    assert.equal(unauthorized.state.pages.length, 0);
    assert.equal(unauthorized.state.lookups.length, 0);
  });

  it("rejects request details that do not match the saved idempotency hash", async () => {
    const { service, state } = makeHarness();
    await assert.rejects(service.reconcileOutboundCall({ ...input, destination: "+14155550124" }), { code: "cartesia_idempotency_conflict" });
    assert.equal(state.pages.length, 0);
    assert.equal(state.lookups.length, 0);
  });

  it("reconciles dynamic-variable calls using the saved fingerprint without resending private values", async () => {
    const dynamicVariables = { first_name: "Ada" };
    const requestHash = hashRequest({
      businessId: input.business_id, destination: input.destination, agentId: input.agent_id,
      fromNumberId: input.from_number_id, dynamicVariables,
    });
    const { service, state } = makeHarness({
      row: { request_hash: requestHash },
      pages: [{ data: [callRecord], has_more: false }],
    });
    const result = await service.reconcileOutboundCall({ ...input, request_fingerprint: requestHash });
    assert.equal(result.outcome, "reconciled");
    assert.equal(state.writes[0].request_hash, requestHash);
    assert.equal("dynamicVariables" in state.writes[0], false);
  });
});
