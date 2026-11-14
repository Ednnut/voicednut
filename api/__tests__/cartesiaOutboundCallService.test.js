"use strict";

const assert = require("node:assert/strict");
const { CartesiaOutboundCallService, buildCartesiaConfirmationPhrase, buildCorrelationId, normalizeDynamicVariables } = require("../services/cartesiaOutboundCallService");

function makeHarness(overrides = {}) {
  const state = { calls: 0, safety: [], completions: [], idempotency: null, providerInput: null };
  const db = {
    async getOutboundCallIdempotency() { return state.idempotency; },
    async reserveOutboundCallIdempotency(input) {
      if (state.idempotency) return { reserved: false };
      state.idempotency = { provider: input.provider, request_hash: input.request_hash, status: "pending" };
      return { reserved: true };
    },
    async completeOutboundCallIdempotency(input) {
      state.idempotency = { ...state.idempotency, ...input };
      return 1;
    },
    ...overrides.db,
  };
  const service = new CartesiaOutboundCallService({
    client: {
      isConfigured: () => true,
      listAgents: async () => ({ summaries: [{
        id: "agent_1", name: "Support Agent", deployment_count: 2, deleted_at: null,
        phone_numbers: [{ id: "ap_number_1", number: "+14155550111" }],
      }] }),
      async createOutboundCall(input) { state.calls += 1; state.providerInput = input; return { providerCallId: "agent_call_1", status: "queued" }; },
      ...overrides.client,
    },
    db,
    outboundSafety: {
      async authorizeActor(input) { state.safety.push({ type: "authorize", ...input }); },
      async reserveDispatch(input) { state.safety.push({ type: "reserve", ...input }); return { reservationKey: "cartesia:reservation" }; },
      async completeDispatch(_reservation, status) { state.completions.push(status); return true; },
      ...overrides.outboundSafety,
    },
    approvalSecret: "test-approval-secret-which-is-long-enough-123",
    enabled: overrides.enabled,
    now: () => 1000,
  });
  return { service, state };
}

const input = {
  business_id: "biz-1", actor_id: "7001", destination: "+14155550123",
  agent_id: "agent_1", from_number_id: "ap_number_1", idempotency_key: "cartesia-request-001",
};

describe("CartesiaOutboundCallService", () => {
  it("writes accepted Cartesia calls to common activity history with actor and business scope", async () => {
    const writes = [];
    const { service } = makeHarness({ db: {
      async upsertCartesiaCallRecord(row) { writes.push(["cartesia", row]); },
      async getCall() { return null; },
      async createCall(row) { writes.push(["common", row]); },
      async updateCallState(...args) { writes.push(["state", ...args]); },
    } });
    await service.recordAcceptedCall({ actorId: "7001", businessId: "biz-1", destination: "+14155550123", agentId: "agent_1", fromNumberId: "ap_number_1" }, "agent_call_1");
    assert.equal(writes[0][1].local_call_id, "cartesia_agent_call_1");
    assert.equal(writes[1][1].call_sid, "cartesia_agent_call_1");
    assert.equal(writes[1][1].user_chat_id, "7001");
    assert.equal(writes[1][1].business_id, "biz-1");
    assert.equal(writes[2][3].provider_call_id, "agent_call_1");
  });

  it("keeps Managed Agent dispatch closed when its feature gate is off", async () => {
    const { service } = makeHarness({ enabled: false });
    await assert.rejects(service.createApproval({ ...input, confirmation_phrase: buildCartesiaConfirmationPhrase(input) }), { code: "cartesia_not_configured" });
  });

  it("requires exact typed confirmation and issues an actor- and request-bound approval", async () => {
    const { service, state } = makeHarness();
    await assert.rejects(service.createApproval({ ...input, confirmation_phrase: "yes" }), { code: "cartesia_confirmation_required" });
    const approval = await service.createApproval({ ...input, confirmation_phrase: buildCartesiaConfirmationPhrase(input) });
    assert.ok(approval.approvalToken);
    assert.equal(state.safety[0].type, "authorize");
    assert.equal(state.calls, 0);
  });

  it("masks account phone numbers and rejects an agent/source pair not attached in Cartesia", async () => {
    const { service } = makeHarness({ client: { listAgents: async () => ({ summaries: [
      { id: "agent_1", name: "Support", deployment_count: 1, phone_numbers: [{ id: "ap_number_1", number: "+14155550111" }] },
      { id: "agent_deleted", name: "Deleted", deleted_at: "2026-01-01T00:00:00Z", phone_numbers: [{ id: "ap_old", number: "+14155550112" }] },
      { id: "agent_empty", name: "No phone", phone_numbers: [] },
    ] }) } });
    assert.deepEqual(await service.listAgentInventory(), [
      { id: "agent_1", name: "Support", deleted: false, deploymentCount: 1, phoneNumbers: [{ id: "ap_number_1", displayNumber: "••••0111" }], ready: true },
      { id: "agent_deleted", name: "Deleted", deleted: true, deploymentCount: 0, phoneNumbers: [{ id: "ap_old", displayNumber: "••••0112" }], ready: false },
      { id: "agent_empty", name: "No phone", deleted: false, deploymentCount: 0, phoneNumbers: [], ready: false },
    ]);
    await assert.rejects(service.createApproval({
      ...input, from_number_id: "ap_other", confirmation_phrase: buildCartesiaConfirmationPhrase({ ...input, from_number_id: "ap_other" }),
    }), { code: "cartesia_agent_source_not_ready" });
  });

  it("accepts Cartesia's documented paginated agent-list envelope", async () => {
    const { service } = makeHarness({ client: { listAgents: async () => ({
      data: [{ id: "agent_1", name: "Support", description: null, version_id: "version_1" }],
      has_more: false,
      next_page: null,
    }), listPhoneNumbers: async () => ({
      data: [{ id: "ap_number_1", number: "+14155550111", agent: { id: "agent_1" } }],
      has_more: false,
    }) } });
    assert.deepEqual(await service.listAgentInventory(), [{
      id: "agent_1",
      name: "Support",
      deleted: false,
      deploymentCount: 0,
      phoneNumbers: [{ id: "ap_number_1", displayNumber: "••••0111" }],
      ready: true,
    }]);
  });

  it("blocks approval when an attached Cartesia agent has no live deployment", async () => {
    const { service, state } = makeHarness({ client: {
      async getAgent(agentId) { return { id: agentId, name: 'Support', phone_numbers: [{ id: 'ap_number_1' }] }; },
      async listAgentDeployments() { return [{ id: 'deploy_1', agent_id: 'agent_1', status: 'ready', is_live: false }]; },
    } });
    await assert.rejects(service.createApproval({
      ...input,
      confirmation_phrase: buildCartesiaConfirmationPhrase(input),
    }), (error) => error.code === 'cartesia_agent_deployment_not_ready');
    assert.equal(state.calls, 0);
  });

  it("writes accepted Cartesia call metadata immediately for shared provider history", async () => {
    const records = [];
    const { service } = makeHarness({ db: { async upsertCartesiaCallRecord(record) { records.push(record); } } });
    const approval = await service.createApproval({ ...input, confirmation_phrase: buildCartesiaConfirmationPhrase(input) });
    await service.createOutboundCall({ ...input, approval_token: approval.approvalToken });
    assert.equal(records.length, 1);
    assert.equal(records[0].provider_call_id, "agent_call_1");
    assert.equal(records[0].business_scope_resolved, true);
    assert.equal(records[0].direction, "outbound");
  });

  it("stores validated defaults by business, authorizes reads, and validates source ownership on writes", async () => {
    const settings = new Map();
    const authorized = [];
    const { service } = makeHarness({
      db: {
        async getSetting(key) { return settings.get(key) || null; },
        async setSetting(key, value) { settings.set(key, value); },
      },
      outboundSafety: {
        async authorizeActor(input) { authorized.push(input); },
      },
    });

    await service.setCallDefaults({
      business_id: "biz-1", actor_id: "7001", agent_id: "agent_1", from_number_id: "ap_number_1",
    });
    assert.deepEqual(await service.getCallDefaults({ business_id: "biz-1", actor_id: "7001" }), {
      agentId: "agent_1", fromNumberId: "ap_number_1",
    });
    assert.deepEqual(await service.getCallDefaults({ business_id: "biz-2", actor_id: "7001" }), {
      agentId: null, fromNumberId: null,
    });
    assert.equal(settings.size, 1);
    assert.deepEqual(JSON.parse(settings.get("cartesia_call_defaults:biz-1")), {
      agent_id: "agent_1", from_number_id: "ap_number_1",
    });
    assert.equal(authorized.length, 2);

    await assert.rejects(service.setCallDefaults({
      business_id: "biz-1", actor_id: "7001", agent_id: "agent_1", from_number_id: "ap_other",
    }), { code: "cartesia_agent_source_not_ready" });
    assert.equal(settings.size, 1);
  });

  it("prevents a business from placing outbound calls through another business's scoped number", async () => {
    const { service, state } = makeHarness({
      db: {
        async getCartesiaPhoneNumberBusinessScope() {
          return { business_id: "biz-other", agent_id: "agent_1" };
        },
      },
    });
    await assert.rejects(service.createApproval({
      ...input,
      confirmation_phrase: buildCartesiaConfirmationPhrase(input),
    }), { code: "cartesia_phone_business_scope_conflict" });
    assert.equal(state.calls, 0);
  });

  it("runs business safety and durable idempotency before one provider submission", async () => {
    const { service, state } = makeHarness();
    const approval = await service.createApproval({ ...input, confirmation_phrase: buildCartesiaConfirmationPhrase(input) });
    const result = await service.createOutboundCall({ ...input, approval_token: approval.approvalToken });
    assert.deepEqual(result, { providerCallId: "agent_call_1", status: "queued", idempotentReplay: false });
    assert.equal(state.calls, 1);
    assert.equal(state.safety.find((item) => item.type === "reserve").provider, "cartesia");
    assert.deepEqual(state.providerInput.dynamicVariables, { voicednut_request_id: buildCorrelationId(input.idempotency_key) });
    assert.deepEqual(state.completions, ["accepted"]);
    assert.equal(state.idempotency.provider, "cartesia");
    assert.equal(state.idempotency.status, "completed");
  });

  it("binds validated per-call dynamic variables to typed confirmation, approval, and idempotency", async () => {
    const { service, state } = makeHarness();
    const dynamicVariables = { first_name: "Ada", account_tier: "gold" };
    const phrase = buildCartesiaConfirmationPhrase({ ...input, dynamic_variables: dynamicVariables });
    assert.match(phrase, /WITH VARIABLES [a-f0-9]{12}$/);
    const approval = await service.createApproval({ ...input, dynamic_variables: dynamicVariables, confirmation_phrase: phrase });
    await assert.rejects(service.createOutboundCall({ ...input, dynamic_variables: { ...dynamicVariables, account_tier: "silver" }, approval_token: approval.approvalToken }), { code: "cartesia_approval_invalid" });
    const result = await service.createOutboundCall({ ...input, dynamic_variables: dynamicVariables, approval_token: approval.approvalToken });
    assert.equal(result.providerCallId, "agent_call_1");
    assert.deepEqual(state.providerInput.dynamicVariables, { ...dynamicVariables, voicednut_request_id: buildCorrelationId(input.idempotency_key) });
    assert.throws(() => normalizeDynamicVariables({ voicednut_request_id: "spoof" }), { code: "cartesia_dynamic_variables_invalid" });
    assert.throws(() => normalizeDynamicVariables({ foo: { nested: true } }), { code: "cartesia_dynamic_variables_invalid" });
  });

  it("replays a completed request without placing a second provider call", async () => {
    const { service, state } = makeHarness();
    const approval = await service.createApproval({ ...input, confirmation_phrase: buildCartesiaConfirmationPhrase(input) });
    await service.createOutboundCall({ ...input, approval_token: approval.approvalToken });
    const replay = await service.createOutboundCall({ ...input, approval_token: approval.approvalToken });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(state.calls, 1);
    assert.ok(state.safety.some((item) => item.type === "authorize"));
  });

  it("rejects approval reuse for another destination or actor", async () => {
    const { service } = makeHarness();
    const approval = await service.createApproval({ ...input, confirmation_phrase: buildCartesiaConfirmationPhrase(input) });
    await assert.rejects(service.createOutboundCall({ ...input, destination: "+14155550124", approval_token: approval.approvalToken }), { code: "cartesia_approval_invalid" });
    await assert.rejects(service.createOutboundCall({ ...input, actor_id: "7002", approval_token: approval.approvalToken }), { code: "cartesia_approval_invalid" });
  });

  it("keeps uncertain submissions pending and reserved for reconciliation", async () => {
    let providerCalls = 0;
    const { service, state } = makeHarness({
      client: { async createOutboundCall() { providerCalls += 1; const error = new Error("timeout"); error.providerSubmissionState = "unknown"; throw error; } },
    });
    const approval = await service.createApproval({ ...input, confirmation_phrase: buildCartesiaConfirmationPhrase(input) });
    await assert.rejects(service.createOutboundCall({ ...input, approval_token: approval.approvalToken }));
    assert.equal(state.idempotency.status, "pending");
    assert.deepEqual(state.completions, []);
    await assert.rejects(service.createOutboundCall({ ...input, approval_token: approval.approvalToken }), { code: "cartesia_call_outcome_unresolved" });
    assert.equal(providerCalls, 1);
  });

  it("lists only bounded, sanitized call operations fields", async () => {
    let query;
    const { service } = makeHarness({ db: { async getCartesiaCallBusinessScope(callId) { return callId === 'call_1' ? 'biz-1' : null; } }, client: {
      async listCalls(input) {
        query = input;
        return { data: [{
          id: "call_1", agent_id: "agent_1", agent_name: "Support", status: "started",
          start_time: "2026-10-31T10:00:00Z", telephony_params: { from: "+14155550111", to: "+14155550123" },
          transcript: [{ text: "private transcript" }], summary: "private summary", dynamic_variables: { secret: "private" },
        }], has_more: true, next_page: "call_1",
        };
      },
    } });
    const result = await service.listCallsForOperations({ agent_id: "agent_1", business_id: 'biz-1', actor_id: '7001', limit: 100 });
    assert.equal(query.limit, 25);
    assert.equal(query.agentId, "agent_1");
    assert.deepEqual(result, {
      calls: [{ callId: "call_1", agentId: "agent_1", status: "started", startTime: "2026-10-31T10:00:00Z", endTime: null, endReason: null,
        agentName: "Support", from: "••••0111", to: "••••0123", canCancel: true }],
      reviewQueue: false, hasMore: true, nextPage: "call_1",
    });
    assert.doesNotMatch(JSON.stringify(result), /private transcript|private summary|private/);
  });

  it('surfaces only business-scoped calls matched by review rules and asks Cartesia for transcript expansion only when needed', async () => {
    let providerQuery;
    const { service } = makeHarness({
      db: {
        async getCartesiaCallReviewRules(businessId) { assert.equal(businessId, 'biz-1'); return { review_failed_calls: false, review_tool_calls: true, review_missing_summary: false }; },
        async getCartesiaCallBusinessScope(callId) { return callId === 'call_flagged' ? 'biz-1' : 'biz-2'; },
      },
      client: { async listCalls(input) {
        providerQuery = input;
        return { data: [
          { id: 'call_flagged', agent_id: 'agent_1', status: 'completed', transcript: [{ text: 'private', tool_calls: [{ name: 'lookup', arguments: { secret: 'x' } }] }] },
          { id: 'call_other_business', agent_id: 'agent_1', status: 'failed', transcript: [{ text: 'private' }] },
        ], has_more: false };
      } },
    });
    const result = await service.listCallsForOperations({ agent_id: 'agent_1', business_id: 'biz-1', actor_id: '7001', review_queue: true });
    assert.equal(providerQuery.expandTranscript, true);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].callId, 'call_flagged');
    assert.deepEqual(result.calls[0].review.reasons, ['tool_used']);
    assert.equal(Object.hasOwn(result.calls[0], 'transcript'), false);
    assert.doesNotMatch(JSON.stringify(result), /private|secret/);
  });

  it('returns safe call review metadata by default and transcript text only after explicit opt-in', async () => {
    let detailRequests = 0;
    const { service } = makeHarness({
      db: { async getCartesiaCallBusinessScope() { return 'biz-1'; }, async getCartesiaCallReviewRules(businessId) {
        assert.equal(businessId, 'biz-1');
        return { review_failed_calls: true, review_tool_calls: true, review_missing_summary: true };
      } },
      client: { async getCall() {
        detailRequests += 1;
        return {
          id: 'call_review_1', agent_id: 'agent_1', agent_version_id: 'version_1', status: 'completed',
          start_time: '2026-10-31T10:00:00Z', summary: 'sensitive summary',
          transcript: [{ role: 'assistant', text: 'safe displayed text', tool_calls: [{ name: 'lookup', arguments: { secret: 'private argument' }, result: 'private result' }] }],
          telephony_params: { from: '+14155550111', to: '+14155550123' },
        };
      } },
    });
    const compact = await service.getCallForOperations('call_review_1', { businessId: 'biz-1', actorId: '7001', includeReviewDetails: true });
    assert.equal(compact.review.required, true);
    assert.deepEqual(compact.review.reasons, ['tool_used']);
    assert.equal(compact.summary, 'sensitive summary');
    assert.equal(Object.hasOwn(compact, 'transcript'), false);
    const reviewed = await service.getCallForOperations('call_review_1', { businessId: 'biz-1', actorId: '7001', includeReviewDetails: true, includeTranscript: true });
    assert.deepEqual(reviewed.transcript, [{ role: 'assistant', text: 'safe displayed text', toolNames: ['lookup'] }]);
    assert.doesNotMatch(JSON.stringify(reviewed), /private argument|private result/);
    assert.equal(detailRequests, 2);
  });

  it('suppresses call content for ZDR or redacted calls even after explicit transcript opt-in', async () => {
    const { service } = makeHarness({ db: { async getCartesiaCallBusinessScope() { return 'biz-1'; }, async getCartesiaCallReviewRules() { return {}; } }, client: { async getCall() {
      return { id: 'call_review_1', agent_id: 'agent_1', status: 'completed', zdr_enabled: true,
        summary: 'must not surface', transcript: [{ role: 'user', text: 'must not surface' }] };
    } } });
    const call = await service.getCallForOperations('call_review_1', { businessId: 'biz-1', actorId: '7001', includeReviewDetails: true, includeTranscript: true });
    assert.equal(call.zdrEnabled, true);
    assert.equal(call.summary, null);
    assert.deepEqual(call.transcript, []);
    assert.doesNotMatch(JSON.stringify(call), /must not surface/);
  });

  it('does not return an incomplete transcript even if the caller requests it', async () => {
    const { service } = makeHarness({ db: { async getCartesiaCallBusinessScope() { return 'biz-1'; } }, client: { async getCall() {
      return { id: 'call_review_1', agent_id: 'agent_1', status: 'started', transcript: [{ role: 'user', text: 'partial' }] };
    } } });
    await assert.rejects(service.getCallForOperations('call_review_1', { businessId: 'biz-1', actorId: '7001', includeReviewDetails: true, includeTranscript: true }), {
      code: 'cartesia_call_transcript_unavailable', status: 409,
    });
  });

  it("summarizes agent deployment readiness without returning provider secrets or build logs", async () => {
    const { service } = makeHarness({ client: {
      async getAgent() { return { id: "agent_1", name: "Support", deployment_count: 2, phone_numbers: [{ id: "number_1", number: "+14155550111" }], system_prompt: "private prompt" }; },
      async listAgentDeployments() { return [
        { id: "deploy_live", agent_id: "agent_1", version_id: "version_1", status: "running", is_live: true, is_pinned: true, build_error: "secret build path", build_logs: "private logs" },
        { id: "deploy_old", agent_id: "agent_1", version_id: "version_0", status: "failed", deployment_error: "private deployment details" },
      ]; },
    } });
    const health = await service.getAgentDeploymentHealth({ agent_id: "agent_1" });
    assert.equal(health.agent.name, "Support");
    assert.equal(health.ready, false);
    assert.deepEqual(health.warnings, ["deployment_build_failed"]);
    assert.deepEqual(health.deployments[0], {
      id: "deploy_live", versionId: "version_1", status: "running", isLive: true, isPinned: true,
      createdAt: null, updatedAt: null, buildCompletedAt: null, buildFailed: true, deploymentFailed: false,
    });
    assert.doesNotMatch(JSON.stringify(health), /private prompt|private logs|secret build path|private deployment details|\+14155550111/);
  });

  it("ignores failed historical Cartesia deployments when the current live deployment is healthy", async () => {
    const { service } = makeHarness({ client: {
      async getAgent() { return { id: "agent_1", name: "Support", phone_numbers: [{ id: "ap_number_1" }] }; },
      async listAgentDeployments() { return [
        { id: "deploy_live", agent_id: "agent_1", status: "running", is_live: true },
        { id: "deploy_old", agent_id: "agent_1", status: "failed", deployment_error: "old failure" },
      ]; },
    } });
    const health = await service.getAgentDeploymentHealth({ agent_id: "agent_1" });
    assert.equal(health.ready, true);
    assert.deepEqual(health.warnings, []);
  });

  it("rechecks status immediately before canceling and refuses inactive calls", async () => {
    let cancels = 0;
    const { service } = makeHarness({ client: {
      async getCall() { return { id: "call_1", agent_id: "agent_1", status: "completed" }; },
      async cancelCall() { cancels += 1; return { cancelled: true }; },
    } });
    await assert.rejects(service.cancelStartedCall("call_1"), { code: "cartesia_call_not_cancellable", status: 409 });
    assert.equal(cancels, 0);
  });

  it("requires business scope for audio downloads and limits access to retained, ended recordings", async () => {
    const audio = Buffer.from([1, 2, 3]);
    let downloads = 0;
    const { service } = makeHarness({ db: { async getCartesiaCallBusinessScope() { return 'biz-1'; } }, client: {
      async getCall() { return { id: 'call_1', agent_id: 'agent_1', status: 'completed', zdr_enabled: false }; },
      async getCallAudio() { downloads += 1; return { bytes: audio, contentType: 'audio/wav' }; },
    } });
    const result = await service.getCallAudioForOperations('call_1', { businessId: 'biz-1', actorId: '7001' });
    assert.deepEqual(result, { bytes: audio, contentType: 'audio/wav' });
    assert.equal(downloads, 1);
    await assert.rejects(service.getCallAudioForOperations('call_1', { businessId: 'biz-2', actorId: '7001' }), { code: 'cartesia_call_not_found', status: 404 });
    assert.equal(downloads, 1);
  });

  it("redacts only ended call data and treats already removed/ZDR content as complete", async () => {
    let deletes = 0;
    const { service } = makeHarness({ db: { async getCartesiaCallBusinessScope() { return 'biz-1'; } }, client: {
      async getCall() { return { id: 'call_1', agent_id: 'agent_1', status: 'completed', zdr_enabled: false, redacted_at: null }; },
      async deleteCall() { deletes += 1; return { deleted: true }; },
    } });
    assert.deepEqual(await service.redactCallData('call_1', { businessId: 'biz-1', actorId: '7001' }), { deleted: true, alreadyRemoved: false, callId: 'call_1' });
    assert.equal(deletes, 1);
    const { service: active } = makeHarness({ db: { async getCartesiaCallBusinessScope() { return 'biz-1'; } }, client: { async getCall() { return { id: 'call_1', agent_id: 'agent_1', status: 'started' }; }, async deleteCall() { deletes += 1; } } });
    await assert.rejects(active.redactCallData('call_1', { businessId: 'biz-1', actorId: '7001' }), { code: 'cartesia_call_redaction_unavailable', status: 409 });
    assert.equal(deletes, 1);
  });

  it("cancels a currently started call exactly once and returns a sanitized result", async () => {
    let cancels = 0;
    const { service } = makeHarness({ client: {
      async getCall() { return { id: "call_1", agent_id: "agent_1", status: "started", summary: "private", transcript: [{ text: "private" }] }; },
      async cancelCall() { cancels += 1; return { cancelled: true }; },
    } });
    const result = await service.cancelStartedCall("call_1");
    assert.equal(cancels, 1);
    assert.deepEqual(result, { cancelled: true, call: {
      callId: "call_1", agentId: "agent_1", status: "completed", startTime: null, endTime: null,
      endReason: "api_cancelled", agentName: null, from: null, to: null, canCancel: false,
    } });
    assert.doesNotMatch(JSON.stringify(result), /private/);
  });
});
